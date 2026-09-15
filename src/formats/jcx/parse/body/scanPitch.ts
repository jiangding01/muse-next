/**
 * Parse 层 —— pitch 形态的值对象构建（M1.6 T6；spec §14–§17、§15、§16.1、§26.5）。
 *
 * 只负责把 AST 的 `note` / `rest` 组合节点翻译成 Domain 的 `Note` / `Rest` **值对象**，
 * 不产出事件、不消费 marker、不看前后文——`-` / `>` / `(` 之类的配对语义全部是 T7 的事。
 *
 * 时值：`duration = parseDurationRaw(原文) × 该位置生效的 unitLength`；`unitLength`
 * 未知时（方案 §7 E1）只保留 `durationRaw`，绝不兜底。
 */

import type { JcxNoteNode, JcxRestNode } from '../../ast';
import type {
  Accidental,
  Note,
  PitchLetter,
  Rational,
  Rest,
  SourceRef,
} from '../../../../domain';
import type { ParseContext } from '../header';
import { parseDurationRaw, parseTabDurationRaw, resolveDuration } from '../duration';

/** §14.1：大写为较低八度区，小写为其上一个八度。字母集合封闭，越界即不是音符。 */
const PITCH_LETTERS: ReadonlyMap<string, PitchLetter> = new Map([
  ['A', 'A'],
  ['B', 'B'],
  ['C', 'C'],
  ['D', 'D'],
  ['E', 'E'],
  ['F', 'F'],
  ['G', 'G'],
]);

/** §17：五种记号，值域封闭；不在表内的原文不构造 accidental（不猜）。 */
const ACCIDENTALS: ReadonlySet<string> = new Set<Accidental>(['^', '^^', '_', '__', '=']);

function toAccidental(raw: string): Accidental | undefined {
  if (!ACCIDENTALS.has(raw)) {
    return undefined;
  }
  // 值域已由上面的封闭集合校验，这里按字面量逐一映射，避免 `as`。
  switch (raw) {
    case '^':
      return '^';
    case '^^':
      return '^^';
    case '_':
      return '_';
    case '__':
      return '__';
    case '=':
      return '=';
    default:
      return undefined;
  }
}

/** 一组 children 中某个 token kind 的原文拼接（`octaveMark` 可能有多枚叶子）。 */
interface Leafish {
  readonly token: { readonly kind: string };
  readonly raw: string;
}

function rawOf(children: readonly Leafish[], kind: string): string {
  let text = '';
  for (const child of children) {
    if (child.token.kind === kind) {
      text += child.raw;
    }
  }
  return text;
}

/**
 * §14.2：`'` 升八度、`,` 降八度，可叠加。
 *
 * **混合方向（`C,'`）不派生位移**：spec §14.2 明文「不实现抵消逻辑，保留原文」，
 * 语料 0 次。此时返回 `undefined`，调用方只留 `octaveRaw` 并发一次 info。
 */
function octaveShiftOf(text: string): number | undefined {
  const up = text.split("'").length - 1;
  const down = text.split(',').length - 1;
  if (up > 0 && down > 0) {
    return undefined;
  }
  return up - down;
}

/** 值对象构建的共同上下文：诊断去处 + 该位置生效的单位音长。 */
export interface ScanValueContext {
  readonly ctx: ParseContext;
  readonly unitLength: Rational | undefined;
}

/**
 * pitch 形态的时值：原文直接是 §16.1 的形态。
 * 无时值原文时既无 `duration` 也无 `durationRaw`（缺省即 1 倍单位音长，由 M2 解释）。
 */
function pitchDuration(
  raw: string,
  node: { readonly span: DurationSpan; readonly path: SourceRef },
  dur: ScanValueContext,
): { readonly duration?: Rational; readonly durationRaw?: string } {
  if (raw === '') {
    return {};
  }
  const value = resolveDuration(parseDurationRaw(raw), raw, dur.unitLength, dur.ctx.bag, node.span, node.path);
  return { durationRaw: raw, ...(value === undefined ? {} : { duration: value }) };
}

type DurationSpan = JcxNoteNode['span'];

/**
 * §26.5 的 TAB 时值：分隔符 `*` / `/` / `//` 携带语义，必须与数值一起解析。
 * `durationRaw` 存原文（含分隔符），保持「事实字段 = 原文」。
 */
export function tabDuration(
  children: readonly Leafish[],
  node: { readonly span: DurationSpan; readonly path: SourceRef },
  dur: ScanValueContext,
): { readonly duration?: Rational; readonly durationRaw?: string } {
  const sep = rawOf(children, 'tabDurSep');
  const value = rawOf(children, 'duration');
  if (sep === '') {
    return pitchDuration(value, node, dur);
  }
  const raw = `${sep}${value}`;
  const parsed = resolveDuration(
    parseTabDurationRaw(sep, value),
    raw,
    dur.unitLength,
    dur.ctx.bag,
    node.span,
    node.path,
  );
  return { durationRaw: raw, ...(parsed === undefined ? {} : { duration: parsed }) };
}

/**
 * AST `note` → Domain `Note`。
 *
 * 返回 `undefined` 只在「音名不在 A–G」时发生——AST 的 `note` 节点必含一枚
 * `pitchLetter`，故正常流程不可达；保留该分支是为了不用 `as` 伪造 `PitchLetter`。
 */
export function buildNote(node: JcxNoteNode, dur: ScanValueContext): Note | undefined {
  const letterRaw = rawOf(node.children, 'pitchLetter');
  const letter = PITCH_LETTERS.get(letterRaw.toUpperCase());
  if (letter === undefined) {
    return undefined;
  }
  const accidental = toAccidental(rawOf(node.children, 'accidental'));
  const duration = pitchDuration(rawOf(node.children, 'duration'), node, dur);
  const octaveRaw = rawOf(node.children, 'octaveMark');
  const octaveShift = octaveShiftOf(octaveRaw);
  if (octaveShift === undefined) {
    dur.ctx.once.reportOnce(
      'pitch.mixed-octave-marks',
      'jcx.parse.pitch.mixed-octave-marks',
      'info',
      `八度修饰 ${JSON.stringify(octaveRaw)} 同时含 ' 与 ,（spec §14.2 UNVERIFIED）：不实现抵消，只保留 octaveRaw`,
      node.span,
      node.path,
    );
  }
  return {
    pitch: {
      letter,
      register: letterRaw === letterRaw.toUpperCase() ? 'upper' : 'lower',
      octaveRaw,
      ...(octaveShift === undefined ? {} : { octaveShift }),
    },
    ...(accidental === undefined ? {} : { accidental }),
    ...duration,
    origin: node.path,
  };
}

/**
 * AST `rest` → Domain `Rest`。
 *
 * `variant` 三分不合并：`Z` 不赋 ABC 的多小节休止语义（§15.2 UNVERIFIED），
 * `@` 不赋隐藏行为（§15.3 DOC-ONLY）——两者的 info 由调用方每文档发一次。
 */
export function buildRest(node: JcxRestNode, dur: ScanValueContext): Rest {
  const hidden = node.children.some((child) => child.token.kind === 'hiddenRest');
  const letter = rawOf(node.children, 'rest');
  const variant: Rest['variant'] = hidden ? '@' : letter === 'Z' ? 'Z' : 'z';
  return { variant, ...tabDuration(node.children, node, dur), origin: node.path };
}
