/**
 * JCX Lexer —— 文档行切分与行级 token 化骨架（M1.4 方案 §7 T3）。
 *
 * T3 范围：
 * 1. `splitLines`：仅按行尾把文本切成 `RawLine[]`，不做任何语义分类。
 * 2. `lexDocument`：在 `splitLines` 基础上产出每行的 token 骨架 —— 本任务只切出
 *    `[bom?] [leading whitespace?] [content(raw)] [trailing whitespace?] [eol?]`，
 *    真正的行分类（field / directive / body / ...）留给 T4。
 *
 * 行尾规则（docs/JCX_SPEC.md §5.1 / §5.2 / §5.11）：
 * - 只有 `\n` 会触发切行；`\r\n` 作为一个整体 eol 保留。
 * - 孤立的 `\r`（不紧跟 `\n`）不是行尾，留在 `content` 内部。
 * - 末行若无换行符，`eol === ''`；`hasTrailingNewline` 反映这一点。
 */

import { createPositionTracker } from './sourceSpan';
import type { SourcePosition, SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxLexLine, JcxLineKind, JcxPlainToken, JcxToken } from './token';

/** 无附属字段的 plain kind（T1 `JcxPlainToken['kind']` 派生），不含 rest/fieldKey 等需要附属字段的 kind。 */
type PlainTokenKind = JcxPlainToken['kind'];

export type JcxEol = '' | '\n' | '\r\n';

export interface RawLine {
  /** 0-based 行下标。 */
  readonly index: number;
  /** 行内容起点位置（不含任何 BOM）。 */
  readonly start: SourcePosition;
  /** 行内容，不含行尾符（孤立 `\r` 除外，它留在 content 内）。 */
  readonly content: string;
  /** 该行的行尾符；末行无换行时为 `''`。 */
  readonly eol: JcxEol;
  /** 覆盖 `content + eol` 的完整 span。 */
  readonly span: SourceSpan;
}

const WS = /[ \t]/;

/**
 * 判断文本是否以换行符结尾（§5.2）。
 *
 * 空文本视为「无末尾换行」——空文本本身不含任何字节，谈不上「以换行结尾」，
 * 且与下方 `splitLines('')` 返回 0 行的决定保持一致（见该函数注释）。
 */
export function hasTrailingNewline(text: string): boolean {
  return text.length > 0 && text.endsWith('\n');
}

/**
 * 按行尾切分文本，逐行记录其原始行尾符与 span。
 *
 * 关键决定（docs/JCX_SPEC.md §5.4 / §5.11，方案 §7 T3 要求写明依据）：
 *
 * - **空文本 → 0 行**，而不是 1 行空行。理由：`RawLine` 代表「文本中确实存在的一行」，
 *   空文本没有任何字节可归属为一行；这与 `hasTrailingNewline('') === false`、
 *   `flattenTokens([]) → []`、`rawOf([]) === ''` 的既有约定一致（见 token.ts 测试），
 *   且避免凭空产生一个 span 长度为 0、无法对应任何源字节的「幽灵行」。
 * - **文本恰好以换行符结尾时，不会在末尾再多切出一个空行。**
 *   例如 `'a\n'` 只产生 1 行（`content: 'a', eol: '\n'`），而不是
 *   `['a\n', '']` 两行——那个假想的「第二行」不对应任何字符，是 `String.split('\n')`
 *   风格 API 的常见陷阱。换行符本身作为上一行的 `eol` 记录，不需要再造一行来承载它。
 *   仅当文本以换行符结尾但整体只有换行符本身（如 `'\n'`）时，产生 1 行
 *   （`content: '', eol: '\n'`），因为这一个换行符确实归属某一行的 eol。
 * - 孤立 `\r`（后面不是 `\n`）不识别为行尾，留在 `content` 内部，交由更上层
 *   （或 T4 的分类逻辑）决定如何处理。
 */
export function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  if (text.length === 0) {
    return lines;
  }

  const tracker = createPositionTracker(text);
  let searchFrom = 0;
  let index = 0;

  while (searchFrom < text.length) {
    const start = tracker.current();
    const nlIndex = text.indexOf('\n', searchFrom);

    if (nlIndex === -1) {
      // 末行，无换行符。
      const content = text.slice(searchFrom);
      const end = tracker.advance(content.length);
      lines.push({ index, start, content, eol: '', span: { start, end } });
      break;
    }

    const isCrlf = nlIndex > searchFrom && text[nlIndex - 1] === '\r';
    const contentEnd = isCrlf ? nlIndex - 1 : nlIndex;
    const content = text.slice(searchFrom, contentEnd);
    const eol: JcxEol = isCrlf ? '\r\n' : '\n';

    tracker.advance(content.length);
    const end = tracker.advance(eol.length);
    lines.push({ index, start, content, eol, span: { start, end } });

    searchFrom = nlIndex + 1;
    index += 1;
  }

  return lines;
}

const BOM = '﻿';

interface TokenBuilder {
  /** 仅接受无附属字段的 plain kind，直接构造合法 `JcxPlainToken`，无需强转。 */
  push(kind: PlainTokenKind, raw: string): void;
  /** 需要附属字段（如 rest、fieldKey）的 token 由调用方自行构造完整对象后传入。 */
  pushToken(token: JcxToken): void;
}

function createTokenBuilder(
  tracker: ReturnType<typeof createPositionTracker>,
  tokens: JcxToken[],
): TokenBuilder {
  const commit = (token: JcxToken): void => {
    tokens.push(token);
  };

  return {
    push(kind, raw) {
      if (raw.length === 0) {
        return;
      }
      const start = tracker.current();
      const end = tracker.advance(raw.length);
      commit({ kind, raw, span: { start, end } });
    },
    pushToken(token) {
      const start = tracker.current();
      const end = tracker.advance(token.raw.length);
      commit({ ...token, span: { start, end } });
    },
  };
}

/**
 * 对单行 `content`（已剥离 BOM 与 eol）切出
 * `[leading whitespace?] [content-as-raw] [trailing whitespace?]` 三段。
 *
 * 纯空白（含空字符串）视为空行，交由调用方决定 `blank` 分支。
 */
function splitContentTokens(builder: TokenBuilder, content: string): boolean {
  const isBlank = content.length === 0 || [...content].every((ch) => WS.test(ch));
  if (isBlank) {
    builder.push('whitespace', content);
    return true;
  }

  let leadingEnd = 0;
  while (leadingEnd < content.length && WS.test(content[leadingEnd] as string)) {
    leadingEnd += 1;
  }
  let trailingStart = content.length;
  while (trailingStart > leadingEnd && WS.test(content[trailingStart - 1] as string)) {
    trailingStart -= 1;
  }

  const leading = content.slice(0, leadingEnd);
  const middle = content.slice(leadingEnd, trailingStart);
  const trailing = content.slice(trailingStart);

  builder.push('whitespace', leading);
  builder.push('raw', middle);
  builder.push('whitespace', trailing);
  return false;
}

/**
 * 行切分 + 行级 token 骨架（M1.4 方案 §7 T3）。
 *
 * 本任务只做：
 * - BOM 单独一个 `bom` token（仅第 0 行，不计入 content）；
 * - 每行拆成 `[leading whitespace?] [content-as-raw] [trailing whitespace?] [eol?]`；
 * - 纯空白行（含空字符串）`line.kind = 'blank'`，tokens 只含 `whitespace`（若非空）与 `eol`（若有）；
 * - 其余行 `line.kind = 'raw'`，content 段 token kind 为 `'raw'`；真正的行分类留给 T4。
 *
 * `lexDocument` 不抛异常；`bag` 参数为 T4+ 预留，本任务不产生 diagnostic。
 */
export function lexDocument(text: string, bag: DiagnosticBag): JcxLexLine[] {
  void bag;

  const rawLines = splitLines(text);
  const hasBom = text.startsWith(BOM);
  const tracker = createPositionTracker(text);
  const lines: JcxLexLine[] = [];

  for (const rawLine of rawLines) {
    const tokens: JcxToken[] = [];
    const builder = createTokenBuilder(tracker, tokens);

    let content = rawLine.content;
    if (rawLine.index === 0 && hasBom) {
      builder.push('bom', content.slice(0, 1));
      content = content.slice(1);
    }

    const isBlank = splitContentTokens(builder, content);
    builder.push('eol', rawLine.eol);

    const kind: JcxLineKind = isBlank ? 'blank' : 'raw';
    lines.push({
      index: rawLine.index,
      span: rawLine.span,
      kind,
      tokens,
    });
  }

  return lines;
}
