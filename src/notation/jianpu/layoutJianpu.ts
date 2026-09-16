/**
 * notation/jianpu —— `RenderVoice` → `JianpuLayout`（M2 方案 v1.1.1 §3.2 / §2.6 / §6 T4）。
 *
 * 本文件负责**判定与编排**（measure 切分、换行、关系、歌词、标签、诊断）；单个事件怎么
 * 画在 `jianpuEventNodes.ts`，几何与节点类型在 `jianpuGlyphs.ts`，列宽与换行在
 * `layout/spacing.ts` / `layout/systems.ts`。`JianpuLayout` 是简谱**自己的** layout
 * model，不继承任何万能基类（§2.7）。
 *
 * **两趟布局**（T5.2-A）：`layoutSystems` 先只做横向打包（哪个 measure 落在第几行谱、
 * 行内 x 多少）——它只取决于 measure 宽度与容器宽度，与行高无关；据此把歌词音节归属到
 * 各行谱，数出每行谱实际用掉几行歌词，再用 `restackSystems` 回填行高。歌词基线因此是
 * **行谱局部**的（`system.origin.y + baselineOffset + lyricFirstOffset +
 * verseIndex × lyricLineGap`），而不是压在文末的一条全局基线；行谱之间也因为预留了
 * 歌词带而不会互相重叠。两趟都是纯函数，合起来仍然确定性。
 *
 * UNVERIFIED 一律**保守呈现 + 诊断**，从不静默：`Z` 按普通休止画 `0`（不画多小节休止、
 * 不占多小节宽度）、`@` 照常画并占位（绝不隐藏）、tuplet 不做任何时值缩放、混合方向
 * 八度只按 `register` 画、`UnknownEvent` **恰好一个**可见占位节点（契约 C1）。
 *
 * 调号一律以 `K: <值>` 转述事实：**全文件没有生成 `1=<tonic>` 的代码路径**（P1-2）——
 * 那个标签在简谱惯例里表示「X 是 do」，与固定 C 映射直接冲突，画出来会误导读谱；
 * `KeySignature.alter` 也**从不被读取**（据它反推主音在大小调间二义，属臆造）。
 */

import type { DomainIndex, EventId, KeySignature, Meter, VoiceId } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import { spaceItems } from '../layout/spacing';
import type { SpacedSlot } from '../layout/spacing';
import { layoutSystems, restackSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic, RenderVoice } from '../model/types';
import { buildUnitLengthMark, draftOf } from './jianpuGlyphs';
import type {
  DraftSink,
  JianpuArc,
  JianpuLabel,
  JianpuLyricNode,
  JianpuNode,
  JianpuTupletBracket,
  JianpuUnitLengthMark,
} from './jianpuGlyphs';
import { buildNode, eventAnchor } from './jianpuEventNodes';
import type { Cursor, Placed } from './jianpuEventNodes';
import {
  assignLyricSyllables,
  buildHeaderLabels,
  buildLyricNodes,
  lyricRowsBySystem,
  relationLayout,
} from './jianpuSections';
import type { LyricColumn } from './jianpuSections';
import { pitchToNumber } from './pitchToNumber';

/** 布局输入。`measurer` **显式注入**：无模块级单例、无全局兜底（§2.8）。 */
export interface JianpuContext {
  /** 只取头部标签需要的两项；`Score` 本体不被本层修改。 */
  readonly score: { readonly key?: KeySignature; readonly meter?: Meter };
  /** 与 `score` 同源的 `DomainIndex`（§2.4.1）：关系反查只查它，本层零自建 Domain lookup。 */
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  /** 容器可用宽度（abstract unit）：贪心换行的唯一阈值（D7）。 */
  readonly availableWidth: number;
}

export interface JianpuLayout {
  readonly voiceId: VoiceId;
  readonly systems: readonly System[];
  readonly measures: readonly MeasureSlice[];
  readonly slots: readonly SpacedSlot[];
  readonly nodes: readonly JianpuNode[];
  readonly tuplets: readonly JianpuTupletBracket[];
  readonly arcs: readonly JianpuArc[];
  readonly lyrics: readonly JianpuLyricNode[];
  readonly labels: readonly JianpuLabel[];
  readonly unitLengthMarks: readonly JianpuUnitLengthMark[];
  readonly width: number;
  readonly height: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}

/**
 * 一行谱为 `rows` 行歌词预留的额外高度。`rows === 0` 时不留任何余量——「这一行没有
 * 歌词」和「有歌词但空着」是两件事。
 */
function lyricBandHeight(rows: number): number {
  return rows === 0 ? 0 : JIANPU_METRICS.lyricFirstOffset + rows * JIANPU_METRICS.lyricLineGap;
}

/**
 * 简谱布局入口。纯函数：同一 `(voice, ctx)` 必然得到逐字段相等的输出
 * （`ctx.measurer` 按 §2.8 的契约也必须是纯函数）。
 */
export function layoutJianpu(voice: RenderVoice, ctx: JianpuContext): JianpuLayout {
  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) => spaceItems(measure.items, measure.startIndex));
  const geometry = {
    availableWidth: ctx.availableWidth,
    systemHeight: JIANPU_METRICS.systemHeight,
    systemGap: JIANPU_METRICS.systemGap,
    originY: JIANPU_METRICS.headerHeight,
  };
  const packed = layoutSystems(spacings.map((spacing) => spacing.width), geometry);

  // 第一趟：只定横向（哪一行谱、行内 x）。行高还不知道——它取决于各行谱用掉几行歌词。
  const placed: Placed[] = [];
  for (const [measureIndex, measure] of measures.entries()) {
    const spacing = spacings[measureIndex];
    const placement = packed.placements[measureIndex];
    if (spacing === undefined || placement === undefined) continue;
    for (const [offset, item] of measure.items.entries()) {
      const slot = spacing.slots[offset];
      if (slot === undefined) continue;
      placed.push({
        item, slot, measureIndex,
        systemIndex: placement.systemIndex, x: placement.x + slot.slot.x,
      });
    }
  }

  // 歌词归属：`skip`（`*`）在这一步就被滤掉，既不画也不参与行尾顺排（T5.2-A）。
  const columnByEvent = new Map<string, LyricColumn>();
  for (const item of placed) {
    columnByEvent.set(item.item.eventId, { x: item.x, systemIndex: item.systemIndex });
  }
  const lyricLines = assignLyricSyllables(voice, (id) => columnByEvent.get(id));
  const rowsBySystem = lyricRowsBySystem(lyricLines, packed.systems.length);
  // 第二趟：按各行谱实际的歌词行数补高度重排，下一行谱的数字行才不会压到上一行的歌词。
  const systems = restackSystems(packed.systems, rowsBySystem.map(lyricBandHeight), geometry);

  const nodes: JianpuNode[] = [];
  const slots: SpacedSlot[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: DraftSink = (item) => { drafts.push(item); };
  // 布局用途的位置索引（`EventId → node`）：§2.4.1 明确允许，它不是 Domain lookup。
  const nodeByEvent = new Map<string, JianpuNode>();

  for (const item of placed) {
    const system = systems[item.systemIndex];
    if (system === undefined) continue;
    slots.push(item.slot);
    const cursor: Cursor = { ...item, y: system.box.origin.y + JIANPU_METRICS.baselineOffset };
    const node = buildNode(cursor, voice.voiceId, ctx.measurer, sink);
    nodes.push(node);
    nodeByEvent.set(item.item.eventId, node);
  }

  const lastSystem = systems[systems.length - 1];
  const relations = relationLayout(voice, ctx.index, nodeByEvent, sink);
  const lyrics = buildLyricNodes(
    lyricLines,
    voice.voiceId,
    (systemIndex, verseIndex) => {
      const system = systems[systemIndex];
      const top = system === undefined
        ? JIANPU_METRICS.headerHeight
        : system.box.origin.y + JIANPU_METRICS.baselineOffset;
      return top + JIANPU_METRICS.lyricFirstOffset + verseIndex * JIANPU_METRICS.lyricLineGap;
    },
    ctx.measurer,
    sink,
  );
  const labels = buildHeaderLabels(ctx.score.key, ctx.score.meter, ctx.measurer, sink);

  const unitLengthMarks: JianpuUnitLengthMark[] = [];
  for (const change of voice.voice.unitLengthChanges) {
    const node = nodeByEvent.get(change.beforeEventId);
    if (node === undefined) continue;
    const anchor = eventAnchor(voice.voiceId, change.beforeEventId);
    unitLengthMarks.push({ anchor, raw: change.raw, segment: buildUnitLengthMark(node.x, node.y) });
    sink(draftOf(CODES.unitLengthChanged, 'info', `此处 L: 变为 ${change.raw}：渲染直接用已解算好的 duration，不重新解释作用域（spec §8.5，U06 已由 Domain 选定）`, anchor, change.origin));
  }

  return {
    voiceId: voice.voiceId, systems, measures, slots, nodes,
    tuplets: relations.tuplets, arcs: relations.arcs, lyrics, labels, unitLengthMarks,
    width: systems.reduce((max, system) => Math.max(max, system.box.width), 0),
    height: lastSystem === undefined
      ? JIANPU_METRICS.headerHeight
      : lastSystem.box.origin.y + lastSystem.box.height,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
