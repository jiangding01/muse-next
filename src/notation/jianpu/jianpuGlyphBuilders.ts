/**
 * notation/jianpu —— 简谱**字形构造函数**（M2 方案 v1.1.1 §3.2；U-Polish Phase A 自
 * `jianpuGlyphs.ts` 拆出）。
 *
 * 拆分理由：`jianpuGlyphs.ts` 已经 350 行（工程上限），Phase A 需要给附点/延音线/八度点/
 * 小节线补几何规则（见各函数注释），只能先做**纯机械拆分**——把「给定基准点画出具体
 * 字形」的构造函数整体搬到本文件，不留任何兼容壳、不改函数签名以外的行为（除本任务明确
 * 要改的那几处）。类型定义、`digitTop`/`digitBottom`/`digitMidline`/`barlineTop`/
 * `barlineBottom` 这些跨构造函数共用的基准几何仍留在 `jianpuGlyphs.ts`（依赖方向单向
 * `jianpuGlyphBuilders.ts → jianpuGlyphs.ts`，无环）。尺寸一律取自 `metrics/jianpu.ts` 的
 * `JIANPU_METRICS`（唯一来源），单位是 abstract unit（D6，不是像素）。
 *
 * **Phase A 改动**（其余照旧搬运，逻辑不变）：
 * - `buildDurationGlyphs`：附点 / 延音线改用 `digitMidline` 而不是排印基线 `baselineY`
 *   （数字无下伸部，基线不是字形的视觉纵向中心）；常量本身在 `metrics/jianpu.ts` 收紧。
 * - `buildPitchGlyphs`：新增 `beamCount` 形参。低方向（八度点 below）的起点现在取
 *   `lowOctaveDotBaseY(baselineY, beamCount)`——固定层序「数字 → 减时线 → 低八度点」，
 *   `beamCount` 只用来算「减时线画到多深」这一个数，从不反过来改变分层顺序本身（U06 边界
 *   裁决 4：不引入按 case 翻转的动态规则）。高方向（above）不变。
 * - `buildBarlineGlyphs`：改用小节线专属的 `barlineTop`/`barlineBottom`（不再借用
 *   `digitTop`/`digitBottom`），小节线高度独立于未知占位框等其它消费者。
 */

import type { Accidental, Rational } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { Point } from '../layout/primitives';
import type { DurationDecomposition, DurationGlyph } from '../model/duration';
import {
  barlineBottom,
  barlineTop,
  digitBottom,
  digitMidline,
  digitTop,
  glyph,
} from './jianpuGlyphs';
import type {
  BarlineForm,
  JianpuBarlineGlyphs,
  JianpuDurationGlyphs,
  JianpuPitchGlyphs,
  JianpuSegment,
  JianpuTextGlyph,
} from './jianpuGlyphs';
import type { JianpuPitch } from './pitchToNumber';

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * `q = duration ÷ 四分音符`（不是「拍」——四分音符只是一个固定的换算基准，P1-3 仍然
 * 成立，本函数不读 `Meter`）。用整数 `bigint` 精确判定 `q` 是否为整数、或
 * `k + 1/2`（`k` 为整数），避免浮点误差；不满足其一时返回 `'other'`，调用方原样使用
 * `decomposeDuration` 的结果（不改写）。
 *
 * 推导：`q = duration × 4`，`duration = base × (2 − 2^-dots)`，`base = 2^exponent`
 * （`DurationGlyph.base` 就是这个 `Rational`），故
 * `q = base × 4 × (2 − 2^-dots) = base.num × (2 × 2^dots − 1) × 4 ÷ (base.den × 2^dots)`。
 */
function classifyQuarterMultiple(
  base: Rational,
  dots: DurationGlyph['dots'],
): { readonly kind: 'integer'; readonly q: number }
  | { readonly kind: 'half'; readonly k: number }
  | { readonly kind: 'other' } {
  const dotsScale = 1n << BigInt(dots);
  const numerator = BigInt(base.num) * (2n * dotsScale - 1n) * 4n;
  const denominator = BigInt(base.den) * dotsScale;
  const g = gcdBig(numerator, denominator);
  const num = numerator / g;
  const den = denominator / g;
  if (den === 1n) return { kind: 'integer', q: Number(num) };
  if (den === 2n && num % 2n === 1n) {
    const k = (num - 1n) / 2n;
    if (k >= 1n) return { kind: 'half', k: Number(k) };
  }
  return { kind: 'other' };
}

/**
 * 附点/延音线的**简谱惯例换算**（U-Polish Phase A 用户裁决补充，INFERRED——参考谱与
 * 简谱惯例转述，spec 未记载这条规则，`decomposeDuration` 本身不改）：延音线表示「整拍
 * 数」，附点只用于「不足一拍的余数」，而不是像 `decomposeDuration` 那样机械按
 * `base × {1, 3/2, 7/4}` 找最小 `dots`。例：附点二分音符在 3/4 拍号下占满一整小节
 * （`duration = 3/4` 全音符，`q = 3`），`decomposeDuration` 给出 `base=1/2, dots=1`
 * （画成「附点 + 一条延音线」，即 `6•—`），但按简谱惯例应画「两条延音线、不画附点」
 * （`6 – –`，延音线数 = 整拍数 − 1）。
 *
 * 只在 `beams === 0`（`q ≥ 1`，见下）且 `q` 恰为整数或 `k + 1/2`（`k ≥ 1`）时才改写：
 * - `q` 为整数（`q ≥ 1`）→ `dashes = q − 1`，`dots = 0`；
 * - `q = k + 1/2`（`k ≥ 1`）→ `dashes = k − 1`，`dots = 1`（`k = 1`，即 `q = 1.5`，
 *   附点四分音符，`dashes = 0` 只画一个附点——与 `decomposeDuration` 原结果一致，
 *   不是新行为）；
 * - 其余情形（`q < 1`、`q` 含 `1/4` 余数等）**原样使用 `decomposition`**，不改写——
 *   `beams > 0` 时 `q` 必然 `< 1`（`base < 1/4` 时 `duration < 7/16`），因此这条规则
 *   从不触碰减时线，天然不越出「不碰减时线分组」的边界。
 *
 * **附点与延音线的相对顺序**（用户核对结论）：附点紧跟数字，延音线在其后（`3· –`，
 * 不是 `3 –·`）——`buildDurationGlyphs` 里附点固定用 `augmentationDotFirstOffset`，
 * 延音线在两者都存在时改从「附点右边缘 + `dashGap`」起画，见该函数。
 */
/**
 * 导出给 `jianpuSlotWidths.ts` 用：槽宽加宽必须按**实际会画出的**延音线条数核实
 * （见该文件 `dashesOf`/`requiredSlotWidth` 的调用点），不能再用
 * `decomposeDuration` 的原始 `dashes`——两者在 `half`/`integer` 分支下条数不同，用
 * 旧值核实会算出偏窄的槽宽，导致新画法右溢压线（回归测试已覆盖，见
 * `jianpu.slotWidth.test.ts`）。
 */
export function jianpuDashDotPlan(
  decomposition: DurationGlyph,
): { readonly dashes: number; readonly dots: number } {
  if (decomposition.beams > 0) {
    return { dashes: decomposition.dashes, dots: decomposition.dots };
  }
  const classified = classifyQuarterMultiple(decomposition.base, decomposition.dots);
  if (classified.kind === 'integer' && classified.q >= 1) {
    return { dashes: classified.q - 1, dots: 0 };
  }
  if (classified.kind === 'half') {
    return { dashes: classified.k - 1, dots: 1 };
  }
  return { dashes: decomposition.dashes, dots: decomposition.dots };
}

/**
 * 减时线 / 延音线 / 附点：减时线条数直接取 `decomposeDuration` 的 `beams`，**不重新
 * 解释时值**、不涉及「拍」（P1-3）；延音线 / 附点条数改走 `jianpuDashDotPlan`（见上，
 * 用户裁决补充的简谱惯例换算）；tuplet 成员同路径、**不缩放**（P1-C）。
 *
 * 减时线画在数字下方、随条数向下延展（Phase B 才调整其粗细/间距，本次不动）。延音线与
 * 附点**锚定到 `digitMidline`**（Phase A item 2/1）：两者都应贴着数字的视觉中线，而不是
 * 排印基线。两者同时出现时（`jianpuDashDotPlan` 的 `half` 分支，`k ≥ 2`），延音线改从
 * 「附点右边缘 + `dashGap`」起画而不是固定的 `dashFirstOffset`——保证「附点紧跟数字、
 * 延音线在其后」不重叠（纯延音线场景不受影响，`dashFirstOffset` 仍是「与数字等距」的
 * 起点，见 `metrics/jianpu.ts` 的推导）。
 */
export function buildDurationGlyphs(
  decomposition: DurationDecomposition,
  x: number,
  baselineY: number,
): JianpuDurationGlyphs {
  if (decomposition.kind === 'unrepresentable') {
    return { beams: [], dashes: [], augmentationDots: [], unrepresentable: true };
  }

  const midY = digitMidline(baselineY);
  const plan = jianpuDashDotPlan(decomposition);

  const beams: JianpuSegment[] = [];
  for (let i = 0; i < decomposition.beams; i += 1) {
    const y = baselineY + JIANPU_METRICS.beamFirstOffset + i * JIANPU_METRICS.beamGap;
    beams.push({ x1: x, y1: y, x2: x + JIANPU_METRICS.beamLength, y2: y });
  }

  const augmentationDots: Point[] = [];
  for (let i = 0; i < plan.dots; i += 1) {
    const dx = JIANPU_METRICS.augmentationDotFirstOffset + i * JIANPU_METRICS.augmentationDotGap;
    augmentationDots.push({ x: x + dx, y: midY });
  }

  const dashes: JianpuSegment[] = [];
  const dotRightEdge =
    JIANPU_METRICS.augmentationDotFirstOffset + JIANPU_METRICS.augmentationDotRadius;
  const dashStartOffset = plan.dots > 0
    ? Math.max(JIANPU_METRICS.dashFirstOffset, dotRightEdge + JIANPU_METRICS.dashGap)
    : JIANPU_METRICS.dashFirstOffset;
  const dashStep = JIANPU_METRICS.dashLength + JIANPU_METRICS.dashGap;
  for (let i = 0; i < plan.dashes; i += 1) {
    const sx = x + dashStartOffset + i * dashStep;
    dashes.push({ x1: sx, y1: midY, x2: sx + JIANPU_METRICS.dashLength, y2: midY });
  }

  return { beams, dashes, augmentationDots, unrepresentable: false };
}

/**
 * 低方向八度点的起点：固定层序「数字 → 减时线 → 低八度点」（U06 边界裁决 4）。没有
 * 减时线时退回 `digitBottom + octaveDotGap`（数字视觉框底边起留一个 `octaveDotGap` 的
 * 呼吸空间，与上方 `buildPitchGlyphs` 的「顶距数字顶 == octaveDotGap」对称，同一个常量
 * 同时表达「数字→第一个点」与「点→点」两段间距，不另立标准）；有减时线时取「最深一条
 * 减时线的 y + `octaveDotBeamClearance` 余量」与前者两者中更深的一个——`beamCount` 只
 * 改变这一个数值，分层顺序（点永远在减时线之下）不因 `beamCount` 或点数而翻转。
 */
function lowOctaveDotBaseY(baselineY: number, beamCount: number): number {
  const bottom = digitBottom(baselineY) + JIANPU_METRICS.octaveDotGap;
  if (beamCount <= 0) return bottom;
  const deepestBeamY =
    baselineY + JIANPU_METRICS.beamFirstOffset + (beamCount - 1) * JIANPU_METRICS.beamGap;
  return Math.max(bottom, deepestBeamY + JIANPU_METRICS.octaveDotBeamClearance);
}

/**
 * 八度点与临时记号：点数与方向已由 `pitchToNumber` 判定，这里**不再判断**，只摆坐标。
 *
 * `beamCount`（Phase A 新增形参）：该事件的减时线条数（`duration.beams.length`），驱动
 * `lowOctaveDotBaseY` 的避让计算，见该函数注释。高方向（above）不受减时线影响（减时线
 * 画在数字下方，与上方八度点不共享空间），但同样从 `digitTop` 退一个 `octaveDotGap`
 * 再放第一个点——「顶距数字顶 == octaveDotGap」是本层的显式几何不变量（见
 * `jianpu.clearance.test.ts` 断言 E），不是巧合贴边。
 */
export function buildPitchGlyphs(
  pitch: JianpuPitch,
  x: number,
  baselineY: number,
  beamCount: number,
): JianpuPitchGlyphs {
  const above = pitch.octaveDotDirection === 'above';
  const direction = above ? -1 : 1;
  const dotBaseY = above
    ? digitTop(baselineY) - JIANPU_METRICS.octaveDotGap
    : lowOctaveDotBaseY(baselineY, beamCount);
  const octaveDots: Point[] = [];
  for (let i = 0; i < pitch.octaveDots; i += 1) {
    octaveDots.push({ x, y: dotBaseY + direction * i * JIANPU_METRICS.octaveDotGap });
  }
  const glyphs = { octaveDots };
  return pitch.accidental === undefined
    ? glyphs
    : { ...glyphs, accidental: buildAccidentalGlyph(pitch.accidental, x, baselineY) };
}

/** 临时记号**原样渲染**：不因调号增删，也不做小节内延续推断（前提 P3）。 */
export function buildAccidentalGlyph(
  accidental: Accidental,
  x: number,
  baselineY: number,
): JianpuTextGlyph {
  const { accidentalOffsetX: dx, accidentalOffsetY: dy, annotationFontSize: size } = JIANPU_METRICS;
  return glyph(accidental, x + dx, baselineY + dy, size);
}

/**
 * `BarlineEvent.raw` → 形态。表内只有四种 `CONFIRMED` 写法，其余一律 `unrecognized`：
 * 不按前缀/后缀去猜「它大概是个反复」——猜错等于把作者没写的反复语义画上谱面。
 */
export function classifyBarline(raw: string): BarlineForm {
  switch (raw) {
    case '|':
      return 'single';
    case '|]':
      return 'final';
    case '|:':
      return 'repeat-start';
    case ':|':
      return 'repeat-end';
    default:
      // `||` / `::` / `[|` / `[:]` / `[|]` 以及任何表外组合都走这里（spec §18 DOC-ONLY，语料 0）。
      return 'unrecognized';
  }
}

/**
 * 形态 → 几何。`unrecognized` 与 `single` 共用同一根普通竖线（§3.2）。
 *
 * Phase A：线段纵向范围改用 `barlineTop`/`barlineBottom`（小节线专属参照，见
 * `jianpuGlyphs.ts` 顶部注释），不再借用 `digitTop`/`digitBottom`——反复记号（`‖:`/`:‖`）
 * 与终止线（`|]`）共用同一套形态分支，高度改动因此对三者一次生效（Phase A item 5/6）。
 * 二次裁决（Electron 实机截图复核）：反复点改围绕 `digitMidline`（数字中线）对称，不再
 * 围绕排印基线——见 `repeatDots` 与 `metrics/jianpu.ts` 的 `repeatDotOffsetY` 注释。
 * `|:`/`:|` 镜像一致：两种形态共用同一个 `pair`/`leftDots`/`rightDots`，只是
 * `thickLineIndices` 与取左/取右两处互换，结构上天然对称（见下方断言）。
 */
export function buildBarlineGlyphs(
  form: BarlineForm,
  x: number,
  baselineY: number,
): JianpuBarlineGlyphs {
  const top = barlineTop(baselineY);
  const bottom = barlineBottom(baselineY);
  const line = (lx: number): JianpuSegment => ({ x1: lx, y1: top, x2: lx, y2: bottom });
  const secondX = x + JIANPU_METRICS.barlineCompositeGap;
  const pair = [line(x), line(secondX)];
  const dotCenterY = digitMidline(baselineY);
  const leftDots = repeatDots(x - JIANPU_METRICS.repeatDotOffsetX, dotCenterY);
  const rightDots = repeatDots(secondX + JIANPU_METRICS.repeatDotOffsetX, dotCenterY);

  switch (form) {
    case 'final':
      return { lines: pair, repeatDots: [], thickLineIndices: [1] };
    case 'repeat-start':
      return { lines: pair, repeatDots: rightDots, thickLineIndices: [0] };
    case 'repeat-end':
      return { lines: pair, repeatDots: leftDots, thickLineIndices: [1] };
    case 'single':
    case 'unrecognized':
      return { lines: [line(x)], repeatDots: [], thickLineIndices: [] };
    default: {
      const exhaustive: never = form;
      return exhaustive;
    }
  }
}

function repeatDots(x: number, y: number): readonly Point[] {
  const dy = JIANPU_METRICS.repeatDotOffsetY;
  return [
    { x, y: y - dy },
    { x, y: y + dy },
  ];
}

/** `L:` 变化点的细标记：一段短竖线，画在列的左边界（§3.2）。未改动，沿用 `digitTop`。 */
export function buildUnitLengthMark(x: number, baselineY: number): JianpuSegment {
  const top = digitTop(baselineY);
  return { x1: x, y1: top - JIANPU_METRICS.unitLengthMarkHeight, x2: x, y2: top };
}
