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
 * 本步**不做**：时值装饰、关系连线、stroke 方向记号、`toSvg`、renderer 接入
 * （T6.2–T6.4）。
 */

import type { DomainIndex, VoiceId } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import { spaceItems } from '../layout/spacing';
import type { SpacedSlot } from '../layout/spacing';
import { layoutSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic, RenderVoice } from '../model/types';
import { buildStaffLines } from './tabGlyphs';
import type { DraftSink, TabNode, TabStaffLines } from './tabGlyphs';
import { buildTabNode } from './tabEventNodes';
import type { Cursor } from './tabEventNodes';
import { widenForTabGlyphs } from './tabSlotWidths';

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

/** TAB 布局入口。 */
export function layoutTab(voice: RenderVoice, ctx: TabContext): TabLayout {
  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) =>
    widenForTabGlyphs(spaceItems(measure.items, measure.startIndex), measure.items, ctx.measurer),
  );
  const packed = layoutSystems(
    spacings.map((spacing) => spacing.width),
    {
      availableWidth: ctx.availableWidth,
      systemHeight: TAB_METRICS.systemHeight,
      systemGap: TAB_METRICS.systemGap,
      originY: TAB_METRICS.headerHeight,
    },
  );

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
    const system = packed.systems[placement.systemIndex];
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

  const lastSystem = packed.systems[packed.systems.length - 1];
  return {
    voiceId: voice.voiceId,
    systems: packed.systems,
    measures,
    slots,
    nodes,
    staffLines: packed.systems.map((system) => buildStaffLines(system)),
    width: packed.systems.reduce((max, system) => Math.max(max, system.box.width), 0),
    height: lastSystem === undefined
      ? TAB_METRICS.headerHeight
      : lastSystem.box.origin.y + lastSystem.box.height,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
