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
  lexBarline,
  lexChordSymbol,
  lexDecoration,
  lexGrace,
  lexRawFallback,
  lexRest,
  lexSlur,
  lexTupletStart,
  lexWhitespace,
  matchOneOf,
  restOf,
} from './lexBodyCommon';
import type { BodyLexContext } from './lexBodyCommon';

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
  const repeat = REPEAT_ENDING_RE.exec(restOf(ctx));
  if (repeat) {
    return emit(ctx, 'repeatEnding', repeat[0].length);
  }
  return lexTupletStart(ctx);
}

/** §17：`^^` / `__` 必须先于 `^` / `_`（最长匹配）。 */
const ACCIDENTAL_FORMS: readonly string[] = ['^^', '__', '^', '_', '='];
/** §16.2：`>>>` / `<<<` 必须先于 `>>` / `>`（最长匹配）。 */
const BROKEN_RHYTHM_FORMS: readonly string[] = ['>>>', '>>', '<<<', '<<', '>', '<'];
/** §14.1：`A`–`G` / `a`–`g`。 */
const PITCH_LETTER_RE = /^[A-Ga-g]/;
/** §14.2：连续的 `,` / `'` 串整体一个 token（不实现 ABC 的抵消逻辑）。 */
const OCTAVE_MARK_RE = /^[,']+/;
/**
 * §16.1：`N/N` 必须先于 `N/`，`N/` 必须先于 `N`（`3/` = `3/2`，ABC 2.1 §4.3）；
 * `//` 必须先于 `/N` 与 `/`。
 */
const DURATION_RE = /^(?:\d+\/\d+|\d+\/|\d+|\/\/|\/\d+|\/)/;

/** 模式 A 专有 token（§14–§22）。返回 0 表示本规则组未命中。 */
function lexPitchSpecific(ctx: BodyLexContext, bag: DiagnosticBag): number {
  const rest = restOf(ctx);
  const ch = rest[0];
  if (ch === undefined) {
    return 0;
  }

  if (lexRest(ctx, bag) > 0) {
    return 1;
  }

  const accidental = matchOneOf(rest, ACCIDENTAL_FORMS);
  if (accidental !== undefined) {
    return emit(ctx, 'accidental', accidental.length);
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
  if (lexSlur(ctx) > 0) {
    return 1;
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
    lexRawFallback(ctx, bag, isKnownStart);
  }

  return ctx.tokens;
}
