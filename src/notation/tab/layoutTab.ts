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
 * **不进本步的布局行为**——它随 `-S-/-H-/-P-` 连线一起留给 T6.3。
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
 * 本步**不做**：关系连线、stroke 方向记号、`toSvg`、renderer 接入（T6.3–T6.4）。
 */

import type { DomainIndex, VoiceId } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import { spaceItems } from '../layout/spacing';
import type { SpacedSlot } from '../layout/spacing';
import { layoutSystems, restackSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic, RenderItem, RenderVoice } from '../model/types';
import { requiredSystemDepth } from './tabDurationGlyphs';
import { buildStaffLines } from './tabGlyphs';
import type { DraftSink, TabNode, TabStaffLines } from './tabGlyphs';
import { buildTabNode } from './tabEventNodes';
import type { Cursor } from './tabEventNodes';
import { durationOf, widenForTabGlyphs } from './tabSlotWidths';

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
}

export interface TabLayout {
  readonly voiceId: VoiceId;
  readonly systems: readonly System[];
  readonly measures: readonly MeasureSlice[];
  readonly slots: readonly SpacedSlot[];
  readonly nodes: readonly TabNode[];
  readonly staffLines: readonly TabStaffLines[];
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

/** TAB 布局入口。 */
export function layoutTab(voice: RenderVoice, ctx: TabContext): TabLayout {
  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) =>
    widenForTabGlyphs(spaceItems(measure.items, measure.startIndex), measure.items, ctx.measurer),
  );
  const geometry = {
    availableWidth: ctx.availableWidth,
    systemHeight: TAB_METRICS.systemHeight,
    systemGap: TAB_METRICS.systemGap,
    originY: TAB_METRICS.headerHeight,
  };
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

  const nodes: TabNode[] = [];
  const slots: SpacedSlot[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: DraftSink = (draft) => {
    drafts.push(draft);
  };

  for (const [measureIndex, measure] of measures.entries()) {
    const spacing = spacings[measureIndex];
    const placement = packed.placements[measureIndex];
    if (spacing === undefined || placement === undefined) continue;
    const system = systems[placement.systemIndex];
    if (system === undefined) continue;
    const staffTop = system.box.origin.y + TAB_METRICS.staffTopOffset;

    for (const [offset, item] of measure.items.entries()) {
      const slot = spacing.slots[offset];
      if (slot === undefined) continue;
      slots.push(slot);
      const cursor: Cursor = {
        item,
        slot,
        measureIndex,
        systemIndex: placement.systemIndex,
        x: placement.x + slot.slot.x,
        staffTop,
      };
      nodes.push(buildTabNode(cursor, voice.voiceId, ctx.measurer, sink));
    }
  }

  const lastSystem = systems[systems.length - 1];
  return {
    voiceId: voice.voiceId,
    systems,
    measures,
    slots,
    nodes,
    staffLines: systems.map((system) => buildStaffLines(system)),
    width: systems.reduce((max, system) => Math.max(max, system.box.width), 0),
    height: lastSystem === undefined
      ? TAB_METRICS.headerHeight
      : lastSystem.box.origin.y + lastSystem.box.height,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
