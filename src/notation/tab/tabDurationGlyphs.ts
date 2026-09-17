/**
 * notation/tab —— TAB 时值装饰的几何构造（M2 方案 §3.3，T6.2）。
 *
 * 时值**从哪来**是 Domain 事实、本层不重算（`tabNote` → `event.note.duration`、
 * `tabGroup` → `event.duration`【组时值取末音，spec §26.8 CONFIRMED】、`rest` →
 * `event.rest.duration`）；但**画成什么样**——符干、减时线、延音短横线、附点的
 * 具体形状与位置——spec §26 从未规定，是产品决定，不是格式事实（见下方每个分支的
 * 注释）。参照通行吉他六线谱的最小形态：装饰画在**第 6 弦下方**。
 *
 * 依赖方向：本文件依赖 `tabGlyphs.ts` 的 `stringY`（一个值导入）；`tabGlyphs.ts`
 * 反过来只用 `import type` 引用本文件的 `TabDurationGlyphs`——类型导入在编译期
 * 被整个擦除，不构成运行时循环依赖，两个文件之间仍是单向的运行时依赖图。
 *
 * 尺寸一律取自 `layout/metrics.ts` 的 `TAB_METRICS`（唯一来源），单位是 abstract
 * unit（D6，不是像素）。
 */

import type { Rational } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { Point } from '../layout/primitives';
import { decomposeDuration } from '../model/duration';
import type { DurationDecomposition } from '../model/duration';
import { stringY } from './tabGlyphs';
import type { TabSegment } from './tabGlyphs';

/**
 * 一个事件的时值装饰。`unrepresentable` 为真时四者**全为空**——方案约定「分解
 * 失败不画任何时值装饰」，不退到某个近似写法（那是在编造作者没写的时值）；
 * `duration === undefined`（`L:` 不可知）与之视觉后果相同（同样全空），但走的是
 * 另一条判据（见 `tabEventNodes.ts` 的 `durationGlyphsOf`），`unrepresentable`
 * 字段本身只反映 `decomposeDuration` 的判定结果。
 */
export interface TabDurationGlyphs {
  /** `base ≤ 1/4`（四分及更短）或 `base = 1/2`（二分，短符干）时存在；`base ≥ 1` 时不画符干。 */
  readonly stem?: TabSegment;
  /** 仅 `base ≤ 1/4` 时非空（产品决定：二分音符不画减时线，见 `baseCategory`）。 */
  readonly beams: readonly TabSegment[];
  /** 仅 `base ≥ 1`（全音符、breve）时非空。 */
  readonly dashes: readonly TabSegment[];
  readonly augmentationDots: readonly Point[];
  readonly unrepresentable: boolean;
}

/**
 * `decomposeDuration` 的 `base` 只可能是 `2^-k`（`k ∈ [0, 10]`）或 breve 的 `2/1`
 * （`model/duration.ts` 的 `BREVE_EXPONENT` 单点例外），因此 `num / den` 的浮点除法
 * 不存在精度问题——两个操作数都是不超过 1024 的 2 的幂。
 *
 * 三个视觉分类（产品决定，spec §26 未规定）：
 * - `'short'`（`base ≤ 1/4`）：画符干 + `decomposition.beams` 条减时线；
 * - `'half'`（`base = 1/2`）：画短符干，**不画**减时线，也**不画**延音短横线——
 *   `decomposeDuration` 对 `1/2` 算出的 `dashes = 1`（它是简谱「延音线」概念的
 *   通用算法，不区分记谱），TAB 侧的短符干已经承担了「比四分长一半」这个视觉
 *   差异，此处**特意不采用**该 `dashes` 值，避免二分音符同时又短符干又带一条线；
 * - `'long'`（`base ≥ 1`）：不画符干，画 `decomposition.dashes` 条延音短横线
 *   （全音符 3 条、breve 7 条，与简谱共用同一套 `decomposeDuration` 计数，只是
 *   画法从「延音线」换成「独立短横线」——两种记谱各自的产品决定）。
 */
function baseCategory(base: Rational): 'short' | 'half' | 'long' {
  const value = base.num / base.den;
  if (value <= 0.25) return 'short';
  if (value < 1) return 'half';
  return 'long';
}

function buildAugmentationDots(dots: number, startX: number, y: number): readonly Point[] {
  const points: Point[] = [];
  for (let index = 0; index < dots; index += 1) {
    points.push({ x: startX + index * TAB_METRICS.augmentationDotGap, y });
  }
  return points;
}

/** `decomposition.dashes` 条延音短横线；`long` 分支专用，`dashes` 在该分支恒 ≥ 3（全音符起步）。 */
function buildDashes(x: number, y: number, count: number): readonly TabSegment[] {
  const dashes: TabSegment[] = [];
  const step = TAB_METRICS.dashLength + TAB_METRICS.dashGap;
  for (let index = 0; index < count; index += 1) {
    const startX = x + TAB_METRICS.dashFirstOffset + index * step;
    dashes.push({ x1: startX, y1: y, x2: startX + TAB_METRICS.dashLength, y2: y });
  }
  return dashes;
}

/** 延音短横线组的右边界——附点画在它之后（`count` 恒 ≥ 1，见 `buildDashes` 的前提）。 */
function dashesEndX(x: number, count: number): number {
  const step = TAB_METRICS.dashLength + TAB_METRICS.dashGap;
  return x + TAB_METRICS.dashFirstOffset + (count - 1) * step + TAB_METRICS.dashLength;
}

/** `decomposition.beams` 条减时线：从符干底端向下、向右等距排列（见 `TAB_METRICS.beamFirstOffset`）。 */
function buildBeams(x: number, stemBottom: number, count: number): readonly TabSegment[] {
  const beams: TabSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const y = stemBottom + TAB_METRICS.beamFirstOffset + index * TAB_METRICS.beamGap;
    beams.push({ x1: x, y1: y, x2: x + TAB_METRICS.beamLength, y2: y });
  }
  return beams;
}

/**
 * 时值装饰的几何。`x` 是事件列左边界（与 `buildFretGlyph` 的 `x` 同一基准），
 * `staffTop` 是所属 system 第 1 弦线的 y——两者都与调用方（`tabEventNodes.ts`）
 * 传给 `buildFretGlyph` 的完全一致，装饰与品位数字画在同一条列上。
 */
export function buildTabDurationGlyphs(
  decomposition: DurationDecomposition,
  x: number,
  staffTop: number,
): TabDurationGlyphs {
  if (decomposition.kind === 'unrepresentable') {
    return { beams: [], dashes: [], augmentationDots: [], unrepresentable: true };
  }

  const string6Y = stringY(staffTop, TAB_METRICS.stringCount);
  const category = baseCategory(decomposition.base);

  if (category === 'long') {
    const y = string6Y + TAB_METRICS.stemOffsetY;
    const dashes = buildDashes(x, y, decomposition.dashes);
    const dotsX = dashesEndX(x, decomposition.dashes) + TAB_METRICS.augmentationDotOffsetX;
    return {
      beams: [],
      dashes,
      augmentationDots: buildAugmentationDots(decomposition.dots, dotsX, y),
      unrepresentable: false,
    };
  }

  const stemTop = string6Y + TAB_METRICS.stemOffsetY;
  const stemLength = category === 'half' ? TAB_METRICS.halfStemLength : TAB_METRICS.stemLength;
  const stemBottom = stemTop + stemLength;
  const stem: TabSegment = { x1: x, y1: stemTop, x2: x, y2: stemBottom };
  const beams = category === 'short' ? buildBeams(x, stemBottom, decomposition.beams) : [];
  const dotsX = x + TAB_METRICS.augmentationDotOffsetX;

  return {
    stem,
    beams,
    dashes: [],
    augmentationDots: buildAugmentationDots(decomposition.dots, dotsX, stemBottom),
    unrepresentable: false,
  };
}

/**
 * `duration` 缺失（`L:` 不可知）→ 不画任何时值装饰，视觉后果与 `unrepresentable`
 * 相同（全空），但走的是另一条判据（`unrepresentable` 只反映 `decomposeDuration`
 * 的判定结果，见 `TabDurationGlyphs` 的字段注释）。写法与
 * `jianpu/jianpuEventNodes.ts` 的 `durationGlyphsOf` 同构。调用方（`tabEventNodes.ts`
 * 的 tabNote / tabGroup / rest 三个分支）共用本函数，不各写一遍。
 */
export function durationGlyphsOf(
  duration: Rational | undefined,
  x: number,
  staffTop: number,
): TabDurationGlyphs {
  return duration === undefined
    ? { beams: [], dashes: [], augmentationDots: [], unrepresentable: false }
    : buildTabDurationGlyphs(decomposeDuration(duration), x, staffTop);
}

/**
 * 时值降级路径的判据：`duration` 缺失，**或** `decomposeDuration` 判定
 * `unrepresentable`（两者视觉后果相同，都不画任何时值装饰）。`durationUnresolved`
 * / `durationUnrepresentable` 两条诊断都已由 `buildRenderScore` 在 event 级发出
 * （§4.2：同一件事只由一层报告一次），调用方不重复报，只据此置位 `fallback`
 * （契约 C2）。写法与 `jianpu/jianpuEventNodes.ts` 的 `isDurationFallback` 同构。
 */
export function isDurationFallback(
  duration: Rational | undefined,
  glyphs: TabDurationGlyphs,
): boolean {
  return duration === undefined || glyphs.unrepresentable;
}

/**
 * 一个事件的时值装饰在垂直方向最深画到哪——**相对 system box 顶边**
 * （`origin.y`），不是相对 `staffTop`。写成「相对 box 顶边」是刻意的：一行谱内
 * 所有事件共用同一个 `staffTop = origin.y + staffTopOffset`，而 `stemOffsetY` /
 * `stemLength` / `beamGap` 等都是相对 `staffTop`（进而相对 `origin.y`）的固定
 * 偏移量，因此这个深度只取决于 `duration` 本身，与该事件、该 system 实际落在
 * 页面哪个绝对 y 无关——`layoutTab.ts` 据此在**横向打包完成、纵向重排之前**
 * 就能算出每个 system 需要多少额外高度（两趟布局，写法与
 * `jianpu/layoutJianpu.ts` 的歌词行数回填同构）。
 *
 * `duration === undefined` 或分解 `unrepresentable` 时不画任何装饰，返回 0——此时
 * 本函数不对行高表达任何意见。附点固定画在符干底端 / 延音短横线行的同一个 y
 * （`buildTabDurationGlyphs` 的画法），不再向下探，故不参与本函数（半径极小，
 * 已被 `decorationBottomMargin` 覆盖）。
 */
export function requiredSystemDepth(duration: Rational | undefined): number {
  if (duration === undefined) {
    return 0;
  }
  const decomposition = decomposeDuration(duration);
  if (decomposition.kind === 'unrepresentable') {
    return 0;
  }

  const category = baseCategory(decomposition.base);
  const string6Offset =
    TAB_METRICS.staffTopOffset + (TAB_METRICS.stringCount - 1) * TAB_METRICS.lineGap;

  const belowString6 =
    category === 'long'
      ? TAB_METRICS.stemOffsetY
      : category === 'half'
        ? TAB_METRICS.stemOffsetY + TAB_METRICS.halfStemLength
        : decomposition.beams > 0
          ? TAB_METRICS.stemOffsetY +
            TAB_METRICS.stemLength +
            TAB_METRICS.beamFirstOffset +
            (decomposition.beams - 1) * TAB_METRICS.beamGap
          : TAB_METRICS.stemOffsetY + TAB_METRICS.stemLength;

  return string6Offset + belowString6 + TAB_METRICS.decorationBottomMargin;
}

/**
 * 附点组的水平延展（相对它们自己的锚点：0 = 附点从锚点起的第一个位置）——
 * `augmentationDotOffsetX` 到最后一个附点的右边缘（`+ (dots-1)×augmentationDotGap`
 * 移到最后一个附点的圆心，再 `+ augmentationDotRadius` 到它的右边缘）。`dots === 0`
 * 返回 0：此时附点不对延展表达任何意见。
 */
function dotsExtentFromAnchor(dots: number): number {
  if (dots === 0) {
    return 0;
  }
  return (
    TAB_METRICS.augmentationDotOffsetX +
    (dots - 1) * TAB_METRICS.augmentationDotGap +
    TAB_METRICS.augmentationDotRadius
  );
}

/**
 * 一个渲染项在 TAB 记谱下，时值装饰的水平延展（`x` 之右延伸多远）；不画任何装饰
 * （`unrepresentable`，或 `beams`/`dashes`/`dots` 皆为 0）时返回 0——此时本函数不对
 * 槽宽表达任何意见，调用方仍以原槽宽为准。写法与 `jianpu/jianpuSlotWidths.ts` 的
 * `requiredDashExtent` 同构：尾部留白复用 `dashGap`，没有另立标准的理由。
 *
 * 附点画在各自锚点之后（`buildTabDurationGlyphs` 的画法）：`long` 分支锚点是
 * 延音短横线组的右边界（`dashesEndX`），`short` / `half` 分支锚点是符干本身
 * （事件 `x`）。三个分支都要把「锚点 + 附点延展」并入下界，否则附点会画出槽外
 * （P1 缺陷，2026-09-17 review 发现：`7/4` 双附点全音符——`dashes = 3`、
 * `dots = 2`——最右附点边缘在 `dashesEndX(0,3) + augmentationDotOffsetX +
 * augmentationDotGap + augmentationDotRadius = 42 + 4 + 4 + 1.5 = 51.5`，而旧实现
 * 只报告 `dashesEndX(0,3) + dashGap = 48`，附点整个漏在槽外）。
 */
export function requiredDurationExtent(decomposition: DurationDecomposition): number {
  if (decomposition.kind === 'unrepresentable') {
    return 0;
  }
  const category = baseCategory(decomposition.base);
  const dots = decomposition.dots;

  if (category === 'long') {
    const dashEnd = dashesEndX(0, decomposition.dashes);
    const rightEdge = dots === 0 ? dashEnd : dashEnd + dotsExtentFromAnchor(dots);
    return rightEdge + TAB_METRICS.dashGap;
  }

  const beamExtent =
    category === 'short' && decomposition.beams > 0
      ? TAB_METRICS.beamLength + TAB_METRICS.beamGap
      : 0;
  const dotsAnchorExtent = dotsExtentFromAnchor(dots);
  const dotsExtent = dotsAnchorExtent === 0 ? 0 : dotsAnchorExtent + TAB_METRICS.dashGap;
  return Math.max(beamExtent, dotsExtent);
}
