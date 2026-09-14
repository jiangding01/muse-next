/**
 * JCX Lexer —— pitch / TAB 两模式共享的正文词法工具（M1.4 方案 §7 T5）。
 *
 * 规格依据：docs/JCX_SPEC.md §18（小节线最长匹配）、§23.1 / §23.2（两种装饰记号）、
 * §25.1 / §25.2（和弦符号与空引号）、§13.4（空白有语义，不得 collapse）。
 *
 * 统一约定（方案 §2.3「切分优先级」的落地契约）：
 * 每个 `lexXxx(ctx)` 函数都在 `ctx.offset` 处尝试匹配 ——
 * **成功则 push 一个 token 并返回消费长度；失败则不改动任何状态并返回 0。**
 * 调用方据返回值决定是否继续尝试下一条规则，因此这些函数必须是「要么全做、要么不做」。
 *
 * 全部为纯函数 + 普通对象，无 class；不依赖 Node / Electron。
 */

import type { SourcePosition, SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxPlainToken, JcxToken } from './token';

/** 无附属字段的 plain kind，`emit` 直接构造合法 `JcxPlainToken`，无需强转。 */
export type PlainBodyTokenKind = JcxPlainToken['kind'];

/**
 * 正文词法共享上下文。
 *
 * `offset` / `position` 是可变游标（两者始终同步推进），`tokens` 是收集器。
 * 刻意不用 class：状态就是一个普通对象，推进逻辑集中在本文件的 `takeSpan`。
 */
export interface BodyLexContext {
  /** 被切分的正文片段（单行，已剥离 eol）。 */
  readonly text: string;
  readonly bag: DiagnosticBag;
  readonly tokens: JcxToken[];
  /** 相对 `text` 的游标。 */
  offset: number;
  /** 与 `offset` 对应的绝对源位置（含行号 / 列号）。 */
  position: SourcePosition;
}

export function createBodyLexContext(
  text: string,
  base: SourcePosition,
  bag: DiagnosticBag,
): BodyLexContext {
  return { text, bag, tokens: [], offset: 0, position: base };
}

/** 当前游标处剩余的文本（含当前字符）。 */
export function restOf(ctx: BodyLexContext): string {
  return ctx.text.slice(ctx.offset);
}

/** 推进游标 `length` 个 code unit，返回被消费的原文与其 span。 */
function takeSpan(ctx: BodyLexContext, length: number): { raw: string; span: SourceSpan } {
  const start = ctx.position;
  const raw = ctx.text.slice(ctx.offset, ctx.offset + length);
  let { line, column } = start;
  for (const ch of raw) {
    // 正文片段理论上不含 `\n`（行切分已完成），这里仍按 sourceSpan 的规则兜底。
    if (ch === '\n') {
      line += 1;
      column = 0;
    } else {
      column += ch.length;
    }
  }
  ctx.offset += raw.length;
  ctx.position = { offset: start.offset + raw.length, line, column };
  return { raw, span: { start, end: ctx.position } };
}

/** 产出一个无附属字段的 token，返回消费长度（length <= 0 时不产出、返回 0）。 */
export function emit(
  ctx: BodyLexContext,
  kind: PlainBodyTokenKind,
  length: number,
): number {
  if (length <= 0) {
    return 0;
  }
  const { raw, span } = takeSpan(ctx, length);
  ctx.tokens.push({ kind, raw, span });
  return raw.length;
}

/** 产出一个带附属字段的 token（rest / decorationComplex 等），返回消费长度。 */
export function emitCustom(
  ctx: BodyLexContext,
  length: number,
  make: (raw: string, span: SourceSpan) => JcxToken,
): number {
  if (length <= 0) {
    return 0;
  }
  const { raw, span } = takeSpan(ctx, length);
  ctx.tokens.push(make(raw, span));
  return raw.length;
}

/** §13.4：空白在正文中有语义（影响连梁），必须独立成 token 且不得 collapse。 */
export function lexWhitespace(ctx: BodyLexContext): number {
  const text = ctx.text;
  let i = ctx.offset;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== ' ' && ch !== '\t') {
      break;
    }
    i += 1;
  }
  return emit(ctx, 'whitespace', i - ctx.offset);
}

/**
 * §25.1 / §25.2：和弦符号 `"..."`（含 `""` 空占位与 `^` 前缀）。
 *
 * 缺少闭合引号时返回 0 —— 交由调用方降级为 raw（§29.3），绝不吞到行尾。
 */
export function lexChordSymbol(ctx: BodyLexContext): number {
  if (ctx.text[ctx.offset] !== '"') {
    return 0;
  }
  const close = ctx.text.indexOf('"', ctx.offset + 1);
  if (close === -1) {
    return 0;
  }
  return emit(ctx, 'chordSymbol', close - ctx.offset + 1);
}

/** §23.2 观测形态的参数片段：`@x'N'` / `@y'N'` / `$f'name'` / `$s'N'`。 */
const COMPLEX_PARAM_RE = /^(?:@[xy]'[^']*'|\$[a-zA-Z]'[^']*')/;

/**
 * §23.2：对复合装饰的内容做 best-effort 参数拆解。
 *
 * 返回 `undefined` 表示拆解失败 —— 按规格「解析失败时降级为 unknown decoration，
 * 保留 raw」，失败绝不影响 token 本身的产出。
 */
export function parseDecorationParts(content: string): readonly string[] | undefined {
  const parts: string[] = [];
  let rest = content;
  while (rest.length > 0) {
    const match = COMPLEX_PARAM_RE.exec(rest);
    if (!match) {
      break;
    }
    parts.push(match[0]);
    rest = rest.slice(match[0].length);
  }
  if (parts.length === 0) {
    return undefined;
  }
  // 参数串之后若仍以 `@` / `$` 开头，说明存在本实现无法识别的参数形态 → 判定失败。
  if (rest.startsWith('@') || rest.startsWith('$')) {
    return undefined;
  }
  if (rest.length > 0) {
    parts.push(rest);
  }
  return parts;
}

/**
 * §23.1 / §23.2 / §23.3：`!...!` 装饰记号，整体一个 token。
 *
 * - 从左向右成对匹配：`!` 之后的**第一个** `!` 即闭合符，绝不跨越已闭合的记号。
 *   这正是 §23.1 修正说明要求的做法 —— `!st!E!st!` 必须切成
 *   `!st!` + `E` + `!st!`，而不是被贪婪正则误配成 `!st!` `E` `!st!` 之外的 `!E!`。
 * - §23.3 判别：`!` 后紧跟 `@` 或 `$` → `decorationComplex`，否则 `decorationSimple`。
 * - 装饰记号必须**先于**正文 token 切分，否则内部的 `@`（§15.3）与字母（§14.1）会被误判。
 * - 无闭合 `!` 时返回 0，降级为 raw。
 */
export function lexDecoration(ctx: BodyLexContext): number {
  if (ctx.text[ctx.offset] !== '!') {
    return 0;
  }
  const close = ctx.text.indexOf('!', ctx.offset + 1);
  if (close === -1) {
    return 0;
  }
  const content = ctx.text.slice(ctx.offset + 1, close);
  const length = close - ctx.offset + 1;
  const isComplex = content.startsWith('@') || content.startsWith('$');
  if (!isComplex) {
    return emit(ctx, 'decorationSimple', length);
  }
  const parts = parseDecorationParts(content);
  return emitCustom(ctx, length, (raw, span) =>
    // exactOptionalPropertyTypes：拆解失败时必须整个省略 `parts` 字段，而不是写 undefined。
    parts === undefined
      ? { kind: 'decorationComplex', raw, span }
      : { kind: 'decorationComplex', raw, span, parts },
  );
}

/**
 * §18 记载的全部小节线形态，**按长度降序排列**。
 *
 * 顺序即最长匹配优先的实现：`|]` 必须先于 `|`，否则会被切成 `|` + `]`，
 * 而 `]` 又会与和弦块闭括号（§14.4）混淆。
 */
export const BARLINE_FORMS: readonly string[] = ['[|]', '[:]', '|]', '||', '[|', '|:', ':|', '::', '|'];

/** §18：小节线，最长匹配优先。 */
export function lexBarline(ctx: BodyLexContext): number {
  const rest = restOf(ctx);
  for (const form of BARLINE_FORMS) {
    if (rest.startsWith(form)) {
      return emit(ctx, 'barline', form.length);
    }
  }
  return 0;
}
