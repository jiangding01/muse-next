/**
 * JCX Lexer —— 模式 A（pitch）正文词法器（M1.4 方案 §2.2 / §7 T5）。
 *
 * 规格依据：docs/JCX_SPEC.md §13.4、§14–§25、§29.3。
 *
 * 切分优先级（方案 §2.3 末尾，**不可交换**）：
 *   whitespace → chordSymbol → decoration → grace → barline（最长匹配）
 *   → repeatEnding / tupletStart（`[` / `(` 后是否紧跟数字）
 *   → 模式专有 token → raw
 *
 * 为什么顺序不可交换（每一条都有对应的误判）：
 * - `"..."` 与 `!...!` 必须最先切：否则内部的 `@`（§15.3）、字母（§14.1）、
 *   `$` `'` 会被当成正文 token（§23.2 规范要求）。
 * - `{@` 必须先于 `@`：§21 的后倚音与 §15.3 的隐藏休止符共用 `@`，靠位置消歧。
 * - barline 必须先于 `[` / `]` / `:`：否则 `|]` 被切成 `|` + `]`，`[|` 被切成 `[` + `|`（§18）。
 * - `[1` / `(3` 必须先于 chordOpen / slurOpen：靠「后面是否紧跟数字」消歧（§19.2 / §20）。
 *
 * 铁律：永不抛异常；任何无法归类的字符按「最短可疑片段」切成 raw + warning，
 * 继续向后解析，不中止整行（§29.3）。
 */

import type { SourcePosition } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxToken } from './token';
import {
  createBodyLexContext,
  emit,
  emitCustom,
  lexBarline,
  lexChordSymbol,
  lexDecoration,
  lexWhitespace,
  restOf,
} from './lexBodyCommon';
import type { BodyLexContext } from './lexBodyCommon';

/** §21：`{` / `{@`（后倚音）/ `}`。`{@` 必须整体匹配，见文件头消歧说明。 */
function lexGrace(ctx: BodyLexContext): number {
  const ch = ctx.text[ctx.offset];
  if (ch === '{') {
    return emit(ctx, 'graceOpen', ctx.text[ctx.offset + 1] === '@' ? 2 : 1);
  }
  if (ch === '}') {
    return emit(ctx, 'graceClose', 1);
  }
  return 0;
}

/** §19.2：`[` 紧跟数字 → 跳房子段号；这是与和弦块 `[CEG]`、内联字段 `[V:` 的唯一区分。 */
const REPEAT_ENDING_RE = /^\[\d+/;
/**
 * §20：`(` 紧跟数字 → tuplet；这是与 slur 起始 `(`（§22.2）的唯一区分。
 *
 * grammar 为 `"(" digit [ ":" digit [ ":" digit ] ]`，**不含闭合括号** ——
 * 因此 `(3:2:3)` 会切成 `tupletStart('(3:2:3')` + `slurClose(')')`，这是规格的直接结论。
 * 数字按多位宽容处理（语料只有单位数，多位不发 diagnostic，留待 Parser 判断）。
 */
const TUPLET_START_RE = /^\(\d+(?::\d+){0,2}/;

function lexRepeatOrTuplet(ctx: BodyLexContext): number {
  const rest = restOf(ctx);
  const repeat = REPEAT_ENDING_RE.exec(rest);
  if (repeat) {
    return emit(ctx, 'repeatEnding', repeat[0].length);
  }
  const tuplet = TUPLET_START_RE.exec(rest);
  if (tuplet) {
    return emit(ctx, 'tupletStart', tuplet[0].length);
  }
  return 0;
}

/** §17：`^^` / `__` 必须先于 `^` / `_`（最长匹配）。 */
const ACCIDENTAL_FORMS: readonly string[] = ['^^', '__', '^', '_', '='];
/** §16.2：`>>>` / `<<<` 必须先于 `>>` / `>`（最长匹配）。 */
const BROKEN_RHYTHM_FORMS: readonly string[] = ['>>>', '>>', '<<<', '<<', '>', '<'];
/** §14.1：`A`–`G` / `a`–`g`。 */
const PITCH_LETTER_RE = /^[A-Ga-g]/;
/** §14.2：连续的 `,` / `'` 串整体一个 token（不实现 ABC 的抵消逻辑）。 */
const OCTAVE_MARK_RE = /^[,']+/;
/** §16.1：`N/N` 必须先于 `N`，`//` 必须先于 `/N` 与 `/`。 */
const DURATION_RE = /^(?:\d+\/\d+|\d+|\/\/|\/\d+|\/)/;

function matchOneOf(rest: string, forms: readonly string[]): string | undefined {
  for (const form of forms) {
    if (rest.startsWith(form)) {
      return form;
    }
  }
  return undefined;
}

/** 模式 A 专有 token（§14–§22）。返回 0 表示本规则组未命中。 */
function lexPitchSpecific(ctx: BodyLexContext, bag: DiagnosticBag): number {
  const rest = restOf(ctx);
  const ch = rest[0];
  if (ch === undefined) {
    return 0;
  }

  const accidental = matchOneOf(rest, ACCIDENTAL_FORMS);
  if (accidental !== undefined) {
    return emit(ctx, 'accidental', accidental.length);
  }

  // §15.1 / §15.2：`z` 与 `Z` 都是 rest，但语义不合并，仅记录原字母。
  if (ch === 'z' || ch === 'Z') {
    const letter = ch;
    const start = ctx.position;
    const consumed = emitCustom(ctx, 1, (raw, span) => ({ kind: 'rest', raw, span, letter }));
    if (letter === 'Z') {
      // §15.2：`Z` 的精确语义 UNVERIFIED，禁止按 ABC 多小节休止实现 → 只发 info。
      bag.report(
        'jcx.rest.uppercase-z',
        'info',
        "rest 'Z' has unverified semantics; it is not ABC's multi-measure rest",
        { start, end: ctx.position },
      );
    }
    return consumed;
  }

  if (PITCH_LETTER_RE.test(rest)) {
    return emit(ctx, 'pitchLetter', 1);
  }

  const octave = OCTAVE_MARK_RE.exec(rest);
  if (octave) {
    return emit(ctx, 'octaveMark', octave[0].length);
  }

  const duration = DURATION_RE.exec(rest);
  if (duration) {
    return emit(ctx, 'duration', duration[0].length);
  }

  const broken = matchOneOf(rest, BROKEN_RHYTHM_FORMS);
  if (broken !== undefined) {
    return emit(ctx, 'brokenRhythm', broken.length);
  }

  if (ch === '@') {
    // §15.3：`!...!` 内的 `@` 与 `{@` 都已在更高优先级被吃掉，这里只剩隐藏休止符。
    const start = ctx.position;
    const consumed = emit(ctx, 'hiddenRest', 1);
    bag.report(
      'jcx.rest.hidden',
      'info',
      "hidden rest '@' is DOC-ONLY (zero corpus samples)",
      { start, end: ctx.position },
    );
    return consumed;
  }

  // §14.4：走到这里的 `[` / `]` 一定不是小节线、跳房子或内联字段 → 和弦块。
  if (ch === '[') {
    return emit(ctx, 'chordOpen', 1);
  }
  if (ch === ']') {
    return emit(ctx, 'chordClose', 1);
  }
  // §22.2：走到这里的 `(` 一定不紧跟数字 → slur 起始。
  if (ch === '(') {
    return emit(ctx, 'slurOpen', 1);
  }
  if (ch === ')') {
    return emit(ctx, 'slurClose', 1);
  }
  if (ch === '-') {
    return emit(ctx, 'tie', 1);
  }
  return 0;
}

/** 所有会被上面任一规则消费的起始字符；`raw` 分组时据此判断「未知」。 */
const KNOWN_START_CHARS = new Set([
  ' ', '\t', '"', '!', '{', '}', '|', '[', ']', ':', '(', ')',
  '^', '_', '=', '@', '-', '>', '<', ',', "'", '/',
]);

function isKnownStart(ch: string): boolean {
  return (
    KNOWN_START_CHARS.has(ch) ||
    (ch >= '0' && ch <= '9') ||
    ch === 'z' ||
    ch === 'Z' ||
    PITCH_LETTER_RE.test(ch)
  );
}

/** 未知字符的「同类」判定：字母归一类（可跨中西文），其余按字符本身归类。 */
function unknownClassOf(ch: string): string {
  return /\p{L}/u.test(ch) ? 'letter' : ch;
}

/**
 * §29.3 兜底：按「最短可疑片段」切出 raw —— 单个字符，或连续的同类未知字符。
 *
 * 注意它必须至少消费 1 个字符，否则主循环会死循环（例如孤立的 `:`：它是
 * 小节线的起始字符，但 `::` / `:|` 均未命中，最终只能落到这里）。
 */
function lexRawFallback(ctx: BodyLexContext, bag: DiagnosticBag): number {
  const text = ctx.text;
  const first = text[ctx.offset] as string;
  const cls = unknownClassOf(first);
  let length = 1;
  while (ctx.offset + length < text.length) {
    const next = text[ctx.offset + length] as string;
    if (isKnownStart(next) || unknownClassOf(next) !== cls) {
      break;
    }
    length += 1;
  }
  const snippet = text.slice(ctx.offset, ctx.offset + length);
  const start = ctx.position;
  const consumed = emit(ctx, 'raw', length);
  bag.report(
    'jcx.body.unknown-token',
    'warning',
    `unrecognized body token '${snippet}'`,
    { start, end: ctx.position },
  );
  return consumed;
}

/**
 * 模式 A（pitch）正文切分入口。
 *
 * @param text 正文片段（单行，已剥离 eol 与 BOM）。
 * @param base 该片段首字符的绝对源位置。
 * @param bag  diagnostic 收集器（本函数只产出 info / warning，绝不抛异常）。
 */
export function lexBodyPitch(
  text: string,
  base: SourcePosition,
  bag: DiagnosticBag,
): JcxToken[] {
  const ctx = createBodyLexContext(text, base, bag);

  while (ctx.offset < text.length) {
    if (lexWhitespace(ctx) > 0) continue;
    if (lexChordSymbol(ctx) > 0) continue;
    if (lexDecoration(ctx) > 0) continue;
    if (lexGrace(ctx) > 0) continue;
    if (lexBarline(ctx) > 0) continue;
    if (lexRepeatOrTuplet(ctx) > 0) continue;
    if (lexPitchSpecific(ctx, bag) > 0) continue;
    lexRawFallback(ctx, bag);
  }

  return ctx.tokens;
}
