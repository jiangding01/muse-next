/**
 * JCX Lexer —— 模式 B（TAB）正文词法器（M1.4 方案 §2.3 / §7 T6，决策 D1）。
 *
 * 规格依据：docs/JCX_SPEC.md §26（全章）、§13.2、§13.4、§16.3、§21、§23、§25、§29.3。
 *
 * 切分优先级（方案 §2.3 末尾，**不可交换**）：
 *   whitespace → chordSymbol → decoration → grace → barline（最长匹配）
 *   → rest / tupletStart / slur（§26.9 共享构造）
 *   → tabRelation → tie → strokePrefix → tabGroup → stringLetter → fret
 *   → tabDurSep + duration → raw
 *
 * 为什么顺序不可交换（每一条都对应一个真实误判）：
 * - `"..."` / `!...!` 最先切：否则内部的 `$` `'` 字母会被当成弦号或拨弦符号（§23.2 / §25）。
 * - barline 先于 `[`：否则 `[|]` `|]` 被拆成 `tabGroupOpen` + `barline`（§18）。
 * - `-S-` / `-H-` / `-P-` 先于 `-`：§26.6 明文要求，否则 `-S-` 切成 `-` + `S` + `-`，
 *   而 `S` 又恰好是 §26.4 拨弦符号表中的「反复记号」。
 * - strokePrefix 先于 stringLetter：`B[` 中的 `B` 是下琶音而不是弦号（§26.4 C8 修正）。
 * - rest / tuplet / slur 先于弦号与弦组：`z` 若落到 raw 会误报未知 token（§26.9 语料
 *   28+1 处）；`(3:0:3` 的 `(` 若落到 tabGroup / raw 会切碎三连音头（§20）；
 *   `tupletStart` 又必须先于 `slurOpen`，否则 `(3` 的括号被当成连音线起始。
 * - fret 先于 duration：TAB 中紧跟弦号的数字是**品位**不是时值，时值必须由
 *   `*` / `/` 引出（§26.5 / §26.10）—— 所以 `tabDurSep` 与其后的数值**一次性成对切出**，
 *   否则 `a1*2` 的 `2` 会被 `fret` 规则抢走。
 *
 * 与模式 A 的根本分歧（§26.10）：小写字母是弦号不是音高；紧跟的数字是品位不是时值；
 * `x` 是「由和弦图决定品位的右手拨弦」；`'` 是加重装饰而非八度修饰。
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

/**
 * §26.6：同弦相邻音关系标记 `-S-`（滑奏）/ `-H-`（敲击）/ `-P-`（钩弦）。
 *
 * 只收录语料印证过的 3 种；其他 `-X-` 形态不猜，留给 `tie` + raw 的组合暴露出来。
 */
const TAB_RELATION_FORMS: readonly string[] = ['-S-', '-H-', '-P-'];

/**
 * §26.4：拨弦 / 扫弦方向前缀（help 2.1.4 符号表的可实现部分）。
 *
 * `V` 上扫、`U` 下扫、`A` 上琶音、`B` 下琶音、`P` 延长音、`H` 延长、
 * `'` 加重、`S` 反复记号、`T` 颤音。
 *
 * 被 help 提取为**中文句号**的「切音」符号按 §26.4 / Appendix A U34 判定为
 * Word→文本提取伪影，真实字符未知，**不实现** —— 因此不在此表内。
 */
const STROKE_PREFIX_CHARS = new Set(['V', 'U', 'A', 'B', 'P', 'H', "'", 'S', 'T']);

/** §26.2：`a`–`f` = 第 1–6 弦。大写 `A`–`F` 在 TAB 中含义 UNVERIFIED（U33），不当弦号。 */
const STRING_LETTER_RE = /^[a-f]/;

/** §26.3：`fret = digit+ | "x"`。多位品位必须整体匹配（`a10` 是 10 品，不是 `1` + `0`）。 */
const FRET_RE = /^(?:\d+|x)/;

/** §26.5：时值分隔符，`//` 必须先于 `/`（最长匹配）。 */
const TAB_DUR_SEP_FORMS: readonly string[] = ['//', '*', '/'];

/** §26.5：分隔符之后的时值数值，`N/N`（附点，DOC-ONLY）必须先于 `N`。 */
const TAB_DURATION_RE = /^(?:\d+\/\d+|\d+)/;

/**
 * §26.4：拨弦前缀只有写在音符 / 音符组**左边**才成立。
 *
 * 判定：字母紧跟 `[`（音符组，§26.8）或弦字母（单音）→ 确定是前缀。
 * 否则视为「悬空前缀」：§26.4 的符号表仍然承认这些字符（例如 I15 推断的独立 `H`
 * 表示延长），所以照常产出 `strokePrefix`，但发 `info` 记录该位置无法确证，
 * 交由 Parser / 人工复核。既不误判为弦号，也不污染 warning 级别。
 */
function lexStrokePrefix(ctx: BodyLexContext, bag: DiagnosticBag): number {
  const rest = restOf(ctx);
  const ch = rest[0];
  if (ch === undefined || !STROKE_PREFIX_CHARS.has(ch)) {
    return 0;
  }
  const next = rest[1] ?? '';
  const attached = next === '[' || STRING_LETTER_RE.test(next);
  const start = ctx.position;
  const consumed = emit(ctx, 'strokePrefix', 1);
  if (!attached) {
    bag.report(
      'jcx.tab.dangling-stroke-prefix',
      'info',
      `stroke prefix '${ch}' is not followed by a note or note group`,
      { start, end: ctx.position },
    );
  }
  return consumed;
}

/**
 * §26.5：`tabDurSep` 与其后的时值数值一次性切出。
 *
 * 必须成对处理：主循环里 `fret` 先于本规则，若分开切，`a1*2` 的 `2` 会在下一轮
 * 被 `fret` 抢走，切成「品位 2」而不是「时值 2」。
 * 数值可缺省（语料中 `ax//bx//` 的 `//` 后直接接下一个音），此时只产出分隔符。
 */
function lexTabDuration(ctx: BodyLexContext): number {
  const sep = matchOneOf(restOf(ctx), TAB_DUR_SEP_FORMS);
  if (sep === undefined) {
    return 0;
  }
  let consumed = emit(ctx, 'tabDurSep', sep.length);
  const value = TAB_DURATION_RE.exec(restOf(ctx));
  if (value) {
    consumed += emit(ctx, 'duration', value[0].length);
  }
  return consumed;
}

/**
 * §26.9：TAB 声部中同样出现的 pitch 模式共享构造。
 *
 * 语料证据（`CONFIRMED BY CORPUS ONLY`）：`z` / `zzz` 休止 29 处、`(3:0:3` 三连音 9 处、
 * `(...)` 连音线 5 处，全部落在 `style=tab` 声部内。词法形态与 §15 / §20 / §22.2 完全一致，
 * 因此直接复用共享匹配函数，不在 TAB 侧分叉实现。
 */
function lexSharedConstructs(ctx: BodyLexContext, bag: DiagnosticBag): number {
  if (lexRest(ctx, bag) > 0) {
    return 1;
  }
  // §20 必须先于 §22.2：`(3` 的括号属于三连音而不是连音线。
  const tuplet = lexTupletStart(ctx);
  if (tuplet > 0) {
    return tuplet;
  }
  return lexSlur(ctx);
}

/** 模式 B 专有 token（§26.2 / §26.3 / §26.8）。返回 0 表示本规则组未命中。 */
function lexTabSpecific(ctx: BodyLexContext, bag: DiagnosticBag): number {
  const rest = restOf(ctx);
  const ch = rest[0];
  if (ch === undefined) {
    return 0;
  }

  // §26.6 先于 §22.1：最长匹配，见文件头说明。
  const relation = matchOneOf(rest, TAB_RELATION_FORMS);
  if (relation !== undefined) {
    return emit(ctx, 'tabRelation', relation.length);
  }
  if (ch === '-') {
    return emit(ctx, 'tie', 1);
  }

  const stroke = lexStrokePrefix(ctx, bag);
  if (stroke > 0) {
    return stroke;
  }

  // §26.8：走到这里的 `[` / `]` 一定不是小节线（已在更高优先级排除）→ 同时拨响的弦组。
  if (ch === '[') {
    return emit(ctx, 'tabGroupOpen', 1);
  }
  if (ch === ']') {
    return emit(ctx, 'tabGroupClose', 1);
  }

  if (STRING_LETTER_RE.test(rest)) {
    return emit(ctx, 'stringLetter', 1);
  }

  // §26.3 grammar：`fret` 只出现在弦号**之后**（`tab-note = [prefix] string-letter fret …`）。
  // 不加这条约束，`z2` 里的 `2` 会被当成品位 —— 而 TAB 中脱离弦号的裸数字没有定义。
  if (ctx.tokens[ctx.tokens.length - 1]?.kind === 'stringLetter') {
    const fret = FRET_RE.exec(rest);
    if (fret) {
      return emit(ctx, 'fret', fret[0].length);
    }
  }

  return lexTabDuration(ctx);
}

/** 所有会被上面任一规则消费的起始字符；`raw` 分组时据此判断「未知」。 */
const KNOWN_START_CHARS = new Set([
  ' ', '\t', '"', '!', '{', '}', '|', '[', ']', ':', '-', '*', '/', 'x',
  'z', 'Z', '(', ')',
]);

function isKnownStart(ch: string): boolean {
  return (
    KNOWN_START_CHARS.has(ch) ||
    STROKE_PREFIX_CHARS.has(ch) ||
    (ch >= '0' && ch <= '9') ||
    STRING_LETTER_RE.test(ch)
  );
}

/**
 * 模式 B（TAB）正文切分入口。
 *
 * @param text 正文片段（单行，已剥离 eol 与 BOM）。
 * @param base 该片段首字符的绝对源位置。
 * @param bag  diagnostic 收集器（本函数只产出 info / warning，绝不抛异常）。
 */
export function lexBodyTab(
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
    if (lexSharedConstructs(ctx, bag) > 0) continue;
    if (lexTabSpecific(ctx, bag) > 0) continue;
    lexRawFallback(ctx, bag, isKnownStart);
  }

  return ctx.tokens;
}
