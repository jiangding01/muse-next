/**
 * JCX Lexer —— 文档入口：行切分 + §13.3 行分类分派 + 模式状态机驱动。
 *
 * T7 批次 C 起本文件只保留「主循环 + 分类优先级」，具体实现分布在：
 * - `lineSplit.ts`     —— 行切分与 `hasTrailingNewline`
 * - `tokenBuilder.ts`  —— 带 span 的 token 构造器
 * - `lexLineKinds.ts`  —— 各行类别的 token 化与 KNOWN_* 白名单
 * - `lexModes.ts`      —— voice style 预扫描与正文词法模式状态机
 *
 * 分类优先级（§13.3，本实现按此顺序短路）：
 *   1. 处于 `%%begintext`…`%%endtext` 之间          → textBlockContent（§11.3）
 *   2. `%%begintext` / `%%endtext` 本身              → textBlockBegin / textBlockEnd（§10.3/§10.4）
 *   3. 整行为空或纯空白                              → blank（§5.4）
 *   4. 行首 `%%`（允许其后空白）                     → directive（§5.7, §10）
 *   5. 行首 `%`                                      → magicHeader（仅首行，§7.3）否则 comment（§5.6）
 *   6. `^[A-Za-z]:`                                  → field（§8.0）
 *   7. `^\[[A-Za-z]:`（容忍异常空格）                → inlineField（§9.1）
 *   8. `^[A-Za-z]：`（全角冒号）                      → raw（§8.0 / §29.4）
 *   9. 其余                                          → body（§13）
 *
 * 说明：§13.3 把 blank 排在 `%%` 之前、text block 之后，本实现与之等价 ——
 * text block 内的空行按 §11.3 第 1/2 条仍是内容行，故 blank 判定必须在 text block 之后。
 */

import { createPositionTracker } from './sourceSpan';
import type { SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxLexLine, JcxLineKind, JcxToken } from './token';
import { splitLines } from './lineSplit';
import { createModeState, prescanVoices, resolveMode } from './lexModes';
import { ZERO_POSITION, createTokenBuilder } from './tokenBuilder';
import type { TokenBuilder } from './tokenBuilder';
import {
  DIRECTIVE_RE,
  FIELD_RE,
  FULLWIDTH_COLON_FIELD_RE,
  INLINE_FIELD_RE,
  isBlankText,
  leadingWhitespaceLength,
  lexDirectiveLine,
  lexFieldLine,
  lexInlineFieldLine,
  lexPercentLine,
  splitContentTokens,
} from './lexLineKinds';
import type { LineContext } from './lexLineKinds';

// 兼容既有 import 路径：拆分是纯搬运，对外导出面不变（T7 批次 C 约束）。
export { hasTrailingNewline, splitLines } from './lineSplit';
export type { JcxEol, RawLine } from './lineSplit';
export { KNOWN_DIRECTIVE_NAMES, KNOWN_FIELD_KEYS } from './lexLineKinds';

const BOM = '﻿';

/**
 * 单行分类 + token 化，返回该行的 `JcxLineKind`。
 *
 * `content` 已剥离 BOM 与 eol；`builder` 的游标恰好停在 `content` 起点。
 */
function lexLineContent(
  builder: TokenBuilder,
  content: string,
  isFirstLine: boolean,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
  ctx: LineContext,
): JcxLineKind {
  // 1. §11.3：text block 内容行压过一切其他分类（含 `%`、`%%`、`T:`）。
  if (ctx.inTextBlock) {
    if (content.startsWith('%%')) {
      const rest = DIRECTIVE_RE.exec(content);
      if ((rest?.[2] ?? '') === 'endtext') {
        return lexDirectiveLine(builder, content, 0, lineSpan, bag, ctx);
      }
    }
    // §11.3 第 1 条：禁止 trim，前导空白留在内容 token 内。
    builder.push('textBlockContent', content);
    return 'textBlockContent';
  }

  // 2. §5.4：空行 / 纯空白行。
  if (isBlankText(content)) {
    builder.push('whitespace', content);
    return 'blank';
  }

  const leadingEnd = leadingWhitespaceLength(content);
  const rest = content.slice(leadingEnd);

  // 3. §5.7 / §10：`%%` 指令（含 `%%begintext` / `%%endtext`）。
  if (rest.startsWith('%%')) {
    return lexDirectiveLine(builder, content, leadingEnd, lineSpan, bag, ctx);
  }

  // 4. §5.6 / §7.3：`%` 注释，首行整行 `%MUSE<ver>` 例外为 magic header。
  if (rest.startsWith('%')) {
    return lexPercentLine(builder, content, leadingEnd, isFirstLine);
  }

  // 5. §8.0：单字母字段行（§5.8：允许前导空白，body 中的 ` L: 1/4` 依赖这一条）。
  const fieldMatch = FIELD_RE.exec(rest);
  if (fieldMatch) {
    return lexFieldLine(builder, content, leadingEnd, fieldMatch[1] as string, lineSpan, bag, ctx);
  }

  // 6. §9.1 / §9.5：行首内联字段（`^\[[A-Za-z]:`，容忍异常空格）。
  const inlineMatch = INLINE_FIELD_RE.exec(rest);
  if (inlineMatch) {
    return lexInlineFieldLine(builder, content, leadingEnd, inlineMatch, lineSpan, bag, ctx);
  }

  // 7. §8.0 / §29.4：全角冒号行按未知行保留原文并发 diagnostic。
  if (FULLWIDTH_COLON_FIELD_RE.test(rest)) {
    bag.report(
      'jcx.field.fullwidth-colon',
      'warning',
      'full-width colon in a field-like line; only half-width ":" is recognized',
      lineSpan,
    );
    splitContentTokens(builder, content);
    return 'raw';
  }

  // 8. §13：其余为正文行，按当前生效的 voice style 模式切分（§13.2）。
  builder.pushBody(content, bag, resolveMode(ctx.modeState, ctx.prescan, { type: 'bodyLine' }, bag));
  return 'body';
}

/**
 * 行切分 + §13.3 行分类 + 行级 token 化（M1.4 方案 §7 T4）。
 *
 * 契约：
 * - 永不抛异常；所有异常写法一律降级为 raw + diagnostic。
 * - 逐行不变量（§29.5）：`rawOf(line.tokens) === text.slice(line.span)`。
 * - body 行（`kind: 'body'`）的 `mode` 字段是 `lexModes` 状态机判定的实际模式（§13.2）。
 */
export function lexDocument(text: string, bag: DiagnosticBag): JcxLexLine[] {
  const rawLines = splitLines(text);
  const hasBom = text.startsWith(BOM);
  const tracker = createPositionTracker(text);
  const lines: JcxLexLine[] = [];
  const ctx: LineContext = {
    inTextBlock: false,
    textBlockBeginSpan: null,
    // §13.2：模式判定必须先看全文（§9.4 的 `V:` 散布在 body 中），故先预扫描。
    prescan: prescanVoices(text),
    modeState: createModeState(),
  };

  for (const rawLine of rawLines) {
    const tokens: JcxToken[] = [];
    const builder = createTokenBuilder(tracker, tokens);

    // §7.3：BOM 不单独占一行，magic header 仍以第 0 行（剥 BOM 后的内容）为准。
    const isFirstLine = rawLine.index === 0;
    let content = rawLine.content;
    if (isFirstLine && hasBom) {
      builder.push('bom', content.slice(0, 1));
      content = content.slice(1);
    }

    const kind = lexLineContent(builder, content, isFirstLine, rawLine.span, bag, ctx);
    builder.push('eol', rawLine.eol);

    lines.push(
      kind === 'body'
        ? { index: rawLine.index, span: rawLine.span, kind, tokens, mode: ctx.modeState.mode }
        : { index: rawLine.index, span: rawLine.span, kind, tokens },
    );
  }

  if (ctx.inTextBlock) {
    // §11.3 第 4 条：未闭合的 `%%begintext` 延伸到文件末尾，不报错，只发 warning。
    bag.report(
      'jcx.textblock.unterminated',
      'warning',
      "'%%begintext' is not closed by '%%endtext' before end of file",
      ctx.textBlockBeginSpan ?? rawLines[rawLines.length - 1]?.span ?? {
        start: ZERO_POSITION,
        end: ZERO_POSITION,
      },
    );
  }

  return lines;
}
