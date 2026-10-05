/**
 * notation/tab —— `RenderVoice` → `TabLayout`（M2 方案 §3.3，T6.1）。
 *
 * 本文件负责**判定与编排**（measure 切分、换行、弦线、事件节点放置、诊断）；单个事件
 * 怎么画在 `tabEventNodes.ts`，几何与节点类型在 `tabGlyphs.ts`，列宽与换行复用
 * `layout/spacing.ts` / `layout/systems.ts`。`TabLayout` 是 TAB **自己的** layout
 * model，不继承任何万能基类、不与 `JianpuLayout` 互相转换（§2.7）。
 *
 * 纯函数、确定性、**零 Domain 修改**：同一 `(voice, ctx)` 必然得到逐字段相等的输出
 * （`ctx.measurer` 按 §2.8 的契约也必须是纯函数）。
 *
 * UNVERIFIED 一律**保守呈现 + 诊断**，从不静默：pitch 模式事件落进 TAB 声部画可见
 * 文本占位（不猜弦品）、`UnknownEvent` **恰好一个**可见节点、`Z` / `@` 照常占位、
 * 表外小节线画普通单线。`H` 前缀的「延长 vs 敲击」消歧（spec §26.4 `INFERRED`）
 * 由 `tabStrokes.ts` 在 T6.3 处理（按「延长」解释 + info 诊断）。
 *
 * **两趟布局**（T6.2 追加，写法照搬 `jianpu/layoutJianpu.ts` 按歌词行数回填行高的
 * 手法）：`layoutSystems` 先只做横向打包（哪个 measure 落在第几行谱、行内 x 多少）
 * ——这一步只取决于 measure 宽度与容器宽度，与行高无关；据此按每行谱里实际出现的
 * 最深时值装饰（`tabDurationGlyphs.ts` 的 `requiredSystemDepth`，是一个只取决于
 * `duration` 本身、与绝对 y 无关的纯函数）算出每行谱需要的额外高度，再用
 * `restackSystems` 回填。`TAB_METRICS.systemHeight` 只覆盖到十六分音符
 * （`beams ≤ 2`）；更细的时值（`decomposeDuration` 允许 `beams` 到 8）不再靠加大
 * 常量兜底，而是按实际深度补高——绝大多数行谱因此不必为极端情形平白留出空白。
 * 两趟都是纯函数，合起来仍然确定性。
 *
 * **关系连线 / stroke 记号**（T6.3 追加）：节点建好、`systems` 回填之后，分别交给
 * `tabRelations.ts`（`-S-`/`-H-`/`-P-`）与 `tabStrokes.ts`（单音拨弦/扫弦方向）——
 * 两者都只消费「节点的位置」这一个已算好的结果，不参与事件排布，因此放在节点循环
 * 之后一次性调用即可，不影响两趟布局本身。
 *
 * **beam 刻印**（M2.5 T3.5）：`ctx.meter` 给出拍单位时，`tabBeams.ts` 先出分组计划与组级列宽需求，
 * 节点建好后再落横梁（只替换组成员的符干 / 逐音减时线，组本身住在 `TabLayout.beams`，不进 `nodes`）。
 *
 * 本步**不做**：`toSvg`、renderer 接入（T6.4）。
 */

import type { DomainIndex, Meter, VoiceId } from '../../domain';
import { externalExtent, mapExternalMeasures, placeExternalMeasure } from '../layout/measurePlacement';
import { TAB_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import type { MeasureSpacing, SpacedSlot } from '../layout/spacing';
import { layoutSystems, restackSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice, SystemGeometry } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic, RenderItem, RenderVoice } from '../model/types';
import type { SystemMeasureGeometry } from '../system/contracts';
import { requiredSystemDepth } from './tabDurationGlyphs';
import { engraveTabBeams, planTabBeams, tabMeasureSpacing } from './tabBeams';
import type { TabBeamGroup } from './tabBeams';
import { buildStaffLines } from './tabGlyphs';
import type { DraftSink, TabNode, TabStaffLines } from './tabGlyphs';
import { buildTabNode } from './tabEventNodes';
import type { Cursor } from './tabEventNodes';
import { buildTabRelations } from './tabRelations';
import type { TabRelationLine } from './tabRelations';
import { durationOf } from './tabSlotWidths';
import { buildTabStrokes } from './tabStrokes';
import type { TabStrokeMark } from './tabStrokes';

/**
 * 布局输入。`measurer` **显式注入**：无模块级单例、无全局兜底（§2.8）。
 *
 * `index` 与 `voice` 必须来自同一次 `loadJcx()`（§2.4.1）：本步还没有关系反查，
 * 但 T6.3 的 `-S-/-H-/-P-` 连线只查它，不自建 Domain lookup——契约在地基这一步就位，
 * 免得到时再改签名。
 */
export interface TabContext {
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  /** 容器可用宽度（abstract unit）：贪心换行的唯一阈值（D7）。 */
  readonly availableWidth: number;
  /**
   * 文档拍号（M2.5 T3.5，用户裁决 Q2-a）：只用于 beam 分组（`layout/beamGroups.ts`），不参与列宽。
   * 缺席 / raw / 表外拍号 → 不分组，输出与改造前逐字段相同（`beams` 恒为 `[]`）。
   */
  readonly meter?: Meter;
  /**
   * M2.5 T5 external 几何（用户裁决 A1）：两项原子成对。缺席 = 走 M2 默认路径（逐字段不变）；存在 = 不换行、
   * 不 restack（最深时值的补高归 T8），measure 的 system / x / width 与 shared onset 的 x 全取自公共几何
   * （`layout/measurePlacement.ts`）；弦线只覆盖本声部在该行谱上真实 measure 的范围（G-2a）。任何不变量
   * 失败抛 `RangeError`，绝不回退。`availableWidth` 此时不使用。
   */
  readonly external?: {
    readonly measures: readonly SystemMeasureGeometry[];
    readonly systems: readonly System[];
  };
}

export interface TabLayout {
  readonly voiceId: VoiceId;
  readonly systems: readonly System[];
  readonly measures: readonly MeasureSlice[];
  readonly slots: readonly SpacedSlot[];
  readonly nodes: readonly TabNode[];
  readonly staffLines: readonly TabStaffLines[];
  /** `-S-`/`-H-`/`-P-` 关系连线（T6.3，spec §26.6）。 */
  readonly relations: readonly TabRelationLine[];
  /** 单音 stroke 记号（T6.3，spec §26.4）。 */
  readonly strokes: readonly TabStrokeMark[];
  /** beam 组（M2.5 T3.5）：组级 engraving 数据，**不进 `nodes`**（C1）；不分组时为 `[]`。 */
  readonly beams: readonly TabBeamGroup[];
  readonly width: number;
  readonly height: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/**
 * 一行谱内出现过的最深时值装饰，转换成该行谱需要的**额外**高度
 * （`TAB_METRICS.systemHeight` 之外还差多少）；不够深（含没有任何计时事件）时为 0
 * ——`restackSystems` 对 `extra === 0` 不产生任何效果，行高原样等于 `systemHeight`。
 */
function extraSystemHeight(measureItems: readonly (readonly RenderItem[])[]): number {
  let deepest = 0;
  for (const items of measureItems) {
    for (const item of items) {
      deepest = Math.max(deepest, requiredSystemDepth(durationOf(item)));
    }
  }
  return Math.max(0, deepest - TAB_METRICS.systemHeight);
}

/** 一个 measure 的横向归属：行谱、左缘、逐项 slot（默认路径 = 本声部 spacing；external = 最终分配）。 */
interface MeasureFrame {
  readonly systemIndex: number;
  readonly left: number;
  readonly slots: readonly SpacedSlot[];
}

interface FirstPass {
  readonly frames: readonly (MeasureFrame | undefined)[];
  readonly systems: readonly System[];
  readonly staffLines: readonly TabStaffLines[];
}

/** M2 默认路径：`layoutSystems` 横向打包 → 按最深时值装饰 `restackSystems`（逐字段不变）。 */
function defaultPass(measures: readonly MeasureSlice[], spacings: readonly MeasureSpacing[], geometry: SystemGeometry): FirstPass {
  const packed = layoutSystems(spacings.map((spacing) => spacing.width), geometry);

  // 第一趟只定横向（哪一行谱、行内 x），与 `jianpu/layoutJianpu.ts` 按歌词行数
  // 回填同一套两趟布局手法：`requiredSystemDepth` 只取决于 `duration` 本身、与
  // system 落在哪个绝对 y 无关，因此不必等节点建好、只按 measure→system 的归属
  // 就能算出每行谱需要补多少高度。
  const measureItemsBySystem: (readonly RenderItem[])[][] = packed.systems.map(() => []);
  for (const [measureIndex, measure] of measures.entries()) {
    const placement = packed.placements[measureIndex];
    if (placement === undefined) continue;
    measureItemsBySystem[placement.systemIndex]?.push(measure.items);
  }
  const extraHeights = measureItemsBySystem.map((items) => extraSystemHeight(items));
  // 第二趟：按各行谱实际的最深装饰补高度重排，下一行谱的弦线才不会压到上一行的
  // 符干 / 减时线。`extra === 0` 的行谱（覆盖到十六分音符的常规情形）不受影响。
  const systems = restackSystems(packed.systems, extraHeights, geometry);
  const frames = measures.map((_, measureIndex): MeasureFrame | undefined => {
    const spacing = spacings[measureIndex];
    const placement = packed.placements[measureIndex];
    return spacing === undefined || placement === undefined
      ? undefined
      : { systemIndex: placement.systemIndex, left: placement.x, slots: spacing.slots };
  });
  return { frames, systems, staffLines: systems.map((system) => buildStaffLines(system)) };
}

/** M2.5 T5 external 路径：measure → 公共框只按 participation 映射；**不 restack**（H-a）。 */
function externalPass(
  voice: RenderVoice, measures: readonly MeasureSlice[], spacings: readonly MeasureSpacing[],
  external: NonNullable<TabContext['external']>,
): FirstPass {
  const mapped = mapExternalMeasures(voice.voiceId, measures, external);
  const spans = new Map<number, { left: number; right: number }>();
  const frames = measures.map((measure, measureIndex): MeasureFrame | undefined => {
    const spacing = spacings[measureIndex];
    const box = mapped.byLocal.get(measureIndex);
    if (spacing === undefined || box === undefined) return undefined;
    const left = (mapped.systemByIndex.get(box.systemIndex)?.box.origin.x ?? 0) + box.x;
    const span = spans.get(box.systemIndex);
    spans.set(box.systemIndex, { left: Math.min(span?.left ?? left, left), right: Math.max(span?.right ?? left, left + box.width) });
    return { systemIndex: box.systemIndex, left, slots: placeExternalMeasure(measure, spacing, box) };
  });
  // G-2a：弦线只覆盖本声部在该行谱上真实 measure 的范围；本声部没有 measure 的行谱不画弦线（不造空小节）。
  const staffLines = mapped.systems.flatMap((system) => {
    const span = spans.get(system.index);
    return span === undefined
      ? []
      : [buildStaffLines({ index: system.index, box: { ...system.box, origin: { x: span.left, y: system.box.origin.y }, width: span.right - span.left } })];
  });
  return { frames, systems: mapped.systems, staffLines };
}

/** TAB 布局入口。 */
export function layoutTab(voice: RenderVoice, ctx: TabContext): TabLayout {
  const measures = splitMeasures(voice.items);
  const plans = planTabBeams(measures, voice, ctx.meter);
  const spacings = measures.map((measure, i) => tabMeasureSpacing(measure, plans[i], ctx.measurer));
  const geometry = {
    availableWidth: ctx.availableWidth,
    systemHeight: TAB_METRICS.systemHeight,
    systemGap: TAB_METRICS.systemGap,
    originY: TAB_METRICS.headerHeight,
  };
  const { frames, systems, staffLines } = ctx.external === undefined
    ? defaultPass(measures, spacings, geometry)
    : externalPass(voice, measures, spacings, ctx.external);
  // 行谱一律按 `System.index` 查（T5）：external 模式的 index 是全文档全局序号，不是本数组下标。
  const systemByIndex = new Map(systems.map((system) => [system.index, system]));

  const nodes: TabNode[] = [];
  const nodeByEvent = new Map<string, TabNode>();
  const slots: SpacedSlot[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: DraftSink = (draft) => {
    drafts.push(draft);
  };

  for (const [measureIndex, measure] of measures.entries()) {
    const frame = frames[measureIndex];
    if (frame === undefined) continue;
    const system = systemByIndex.get(frame.systemIndex);
    if (system === undefined) continue;
    const staffTop = system.box.origin.y + TAB_METRICS.staffTopOffset;

    for (const [offset, item] of measure.items.entries()) {
      const slot = frame.slots[offset];
      if (slot === undefined) continue;
      slots.push(slot);
      const cursor: Cursor = {
        item,
        slot,
        measureIndex,
        systemIndex: frame.systemIndex,
        x: frame.left + slot.slot.x,
        staffTop,
      };
      const node = buildTabNode(cursor, voice.voiceId, ctx.measurer, sink);
      nodes.push(node);
      nodeByEvent.set(item.eventId, node);
    }
  }

  // 关系连线 / stroke 记号都只消费「节点已经建好」这一个结果，用回填后的 `systems`
  // 与刚建好的 `nodeByEvent`——与节点构造本身顺序无关，放在节点循环之后即可。
  const { lines: relations } = buildTabRelations(voice, ctx.index, nodeByEvent, systems, sink);
  const { strokes } = buildTabStrokes(voice, nodeByEvent, sink);
  // beam 只替换组成员节点的符干 / 逐音减时线（x、y、宽度与 anchor 不变），关系与 stroke 不受影响。
  const engraved = engraveTabBeams(nodes, plans);

  const lastSystem = systems[systems.length - 1];
  // external 模式（I）：宽高取全部行谱的最大外沿，不依赖数组顺序；没有行谱时取默认路径的空值。
  const extent = ctx.external === undefined ? undefined : externalExtent(systems);
  return {
    voiceId: voice.voiceId,
    systems,
    measures,
    slots,
    nodes: engraved.nodes,
    staffLines,
    relations,
    strokes,
    beams: engraved.beams,
    width: ctx.external === undefined
      ? systems.reduce((max, system) => Math.max(max, system.box.width), 0)
      : extent?.width ?? 0,
    height: ctx.external === undefined
      ? lastSystem === undefined
        ? TAB_METRICS.headerHeight
        : lastSystem.box.origin.y + lastSystem.box.height
      : extent?.height ?? TAB_METRICS.headerHeight,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
