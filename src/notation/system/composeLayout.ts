/**
 * notation/system —— 最终 score layout 的编排（M2.5 T8，用户裁决 A–L，2026-10-05）。**唯一**允许 import 三个 voice
 * layout 入口的 system 文件（裁决 J）。
 *
 * 管线（顺序即契约，每一步只跑一次）：
 * 1. T4 `composeSystemGeometry` → T6 `planChordOverlays`；
 * 2. vertical prepass（`verticalDemand.ts`，裁决 A）→ 纵向堆叠与 box（`verticalLayout.ts`）；
 * 3. 每个已知记谱声部的 external 布局**恰好调用一次**：`systems` = 它所在 group 的全部行（层 box，`origin.x` = 最终
 *    box 左界），`measures` = 同一批 rebase 后的公共 measure（`x + dx`，裁决 F）；fallback 不调用任何 layout、绝不
 *    回退 Staff，也不进 `voiceLayouts`（裁决 I）；
 * 4. 和弦 overlay 直接由 T6 plan 映射（不重新查表 / 判碰撞），x 与 measure 一起 rebase，y 取块顶（裁决 E）。
 *
 * 诊断（裁决 H）= composed（已含 renderScore + T1 / T2 / T3）→ T6 → 各 voice layout（group 顺序、组内 `voiceIds`
 * 顺序），只拼接、不重排、不去重，也不再合并 `renderScore.diagnostics`。纯函数，不改输入。
 */

import type { DomainIndex, VoiceId } from '../../domain';
import { layoutJianpu } from '../jianpu/layoutJianpu';
import type { JianpuLayout } from '../jianpu/layoutJianpu';
import type { System } from '../layout/primitives';
import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderDiagnostic, RenderScore, RenderVoice } from '../model/types';
import { layoutStaff } from '../staff/layoutStaff';
import type { StaffLayout } from '../staff/staffTypes';
import { layoutTab } from '../tab/layoutTab';
import type { TabLayout } from '../tab/layoutTab';
import { planChordOverlays } from './chordOverlay';
import type { ChordOverlayPlan } from './chordOverlay';
import { composeSystemGeometry } from './composeSystem';
import type {
  ChordDiagramOverlay,
  ComposedSystemLayout,
  PackingPolicy,
  ScoreSystemLayout,
  SystemMeasureGeometry,
  VoiceLayerNotation,
} from './contracts';
import { planVoiceLayers, systemDemands } from './verticalDemand';
import type { VoicePlan } from './verticalDemand';
import { overlayTop, stackSystems } from './verticalLayout';
import type { SystemFrame } from './verticalLayout';

/** 已知记谱声部的最终 layout（判别联合；contracts 是叶子层，不能引用 voice layout 类型，所以住在这里）。 */
export type VoiceLayoutEntry =
  | { readonly notation: 'jianpu'; readonly voiceId: VoiceId; readonly layout: JianpuLayout }
  | { readonly notation: 'tab'; readonly voiceId: VoiceId; readonly layout: TabLayout }
  | { readonly notation: 'staff'; readonly voiceId: VoiceId; readonly layout: StaffLayout };

export interface ScoreLayout {
  readonly composed: ComposedSystemLayout;
  /** 已知记谱声部各一项，group 顺序、组内 `voiceIds` 顺序；fallback 声部不出现（裁决 I）。 */
  readonly voiceLayouts: readonly VoiceLayoutEntry[];
  /** composed → T6 → voice layouts（裁决 H）。 */
  readonly diagnostics: readonly RenderDiagnostic[];
}

type KnownNotation = Exclude<VoiceLayerNotation, 'fallback'>;

interface ExternalInput {
  readonly measures: readonly SystemMeasureGeometry[];
  readonly systems: readonly System[];
}

interface VoiceContext {
  readonly renderScore: RenderScore;
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  readonly availableWidth: number;
}

function frameAt(frameOf: ReadonlyMap<number, SystemFrame>, systemIndex: number): SystemFrame {
  const frame = frameOf.get(systemIndex);
  if (frame === undefined) throw new RangeError(`score layout: system ${String(systemIndex)} 缺少纵向 frame`);
  return frame;
}

/** rebase 后的公共 measure；缺失 = 结构不变量被破坏（每个 T4 行都已 rebase）。 */
function measuresAt(
  measuresOf: ReadonlyMap<number, readonly SystemMeasureGeometry[]>,
  systemIndex: number,
): readonly SystemMeasureGeometry[] {
  const measures = measuresOf.get(systemIndex);
  if (measures === undefined) throw new RangeError(`score layout: system ${String(systemIndex)} 缺少 rebase 后的 measure`);
  return measures;
}

/** 本声部的 external 输入：所在 group 每一行一个层 box（裁决 B：本行没有 measure 也传）。 */
function externalOf(
  voicePlan: VoicePlan,
  frameOf: ReadonlyMap<number, SystemFrame>,
  measuresOf: ReadonlyMap<number, readonly SystemMeasureGeometry[]>,
): ExternalInput {
  const systems = voicePlan.lines.map((line): System => {
    const frame = frameAt(frameOf, line.systemIndex);
    const layer = frame.layers.find((entry) => entry.voiceId === voicePlan.voice.voiceId);
    if (layer === undefined) throw new RangeError(`score layout: system ${String(line.systemIndex)} 缺少声部层`);
    const { origin, width } = frame.box;
    return { index: line.systemIndex, box: { origin: { x: origin.x, y: origin.y + layer.top }, width, height: layer.height } };
  });
  return { measures: voicePlan.lines.flatMap((line) => measuresAt(measuresOf, line.systemIndex)), systems };
}

/** 已知记谱声部的 layout（fallback 已由调用方在唯一一处排除，这里的 `notation` 不含它）。 */
function layoutVoice(
  voice: RenderVoice,
  notation: KnownNotation,
  external: ExternalInput,
  ctx: VoiceContext,
): VoiceLayoutEntry {
  const { index, measurer, availableWidth } = ctx;
  const { key, meter } = ctx.renderScore.score;
  const voiceId = voice.voiceId;
  switch (notation) {
    case 'jianpu': {
      const score = { ...(key === undefined ? {} : { key }), ...(meter === undefined ? {} : { meter }) };
      return { notation, voiceId, layout: layoutJianpu(voice, { score, index, measurer, availableWidth, external }) };
    }
    case 'tab': {
      // T6 HANDOFF：TAB 必须拿到文档 `meter`（beam 分组），缺席时不传。
      const tabCtx = { index, measurer, availableWidth, ...(meter === undefined ? {} : { meter }), external };
      return { notation, voiceId, layout: layoutTab(voice, tabCtx) };
    }
    case 'staff': {
      const staffCtx = { score: ctx.renderScore.score, index, measurer, availableWidth, external };
      return { notation, voiceId, layout: layoutStaff(voice, staffCtx) };
    }
  }
}

function finalOverlay(chordPlan: ChordOverlayPlan, frame: SystemFrame): ChordDiagramOverlay {
  const base = {
    anchor: chordPlan.anchor,
    displayText: chordPlan.displayText,
    x: chordPlan.x + frame.dx,
    y: overlayTop(frame.bandHeight, chordPlan.footprint.height),
    systemIndex: chordPlan.systemIndex,
  };
  return chordPlan.shapeIndex === undefined ? base : { ...base, shapeIndex: chordPlan.shapeIndex };
}

/** 整份文档的最终 score layout（T8 产物；本期不接 renderer）。 */
export function composeScoreLayout(
  renderScore: RenderScore,
  index: DomainIndex,
  measurer: TextMeasurer,
  policy: PackingPolicy,
): ScoreLayout {
  const geometry = composeSystemGeometry(renderScore, measurer, policy);
  const planning = planChordOverlays(renderScore, geometry, measurer);
  const chordPlansOf = new Map<number, ChordOverlayPlan[]>();
  for (const chordPlan of planning.plans) {
    chordPlansOf.set(chordPlan.systemIndex, [...(chordPlansOf.get(chordPlan.systemIndex) ?? []), chordPlan]);
  }

  const voicePlans = planVoiceLayers(renderScore, geometry);
  const frames = stackSystems(systemDemands(geometry, voicePlans, chordPlansOf));
  const frameOf = new Map(frames.map((frame) => [frame.systemIndex, frame]));
  // rebase 只做一次：最终 system 与各声部 external 输入共用同一批 measure 对象。
  const measuresOf = new Map(geometry.lines.map((line) => {
    const { dx } = frameAt(frameOf, line.systemIndex);
    return [line.systemIndex, line.measures.map((g): SystemMeasureGeometry => ({ ...g, x: g.x + dx }))] as const;
  }));

  const ctx: VoiceContext = {
    renderScore,
    index,
    measurer,
    availableWidth: policy.kind === 'screen' ? policy.availableWidth : policy.contentWidth,
  };
  const voiceLayouts = voicePlans.flatMap((voicePlan) => {
    const { notation } = voicePlan;
    // fallback 唯一的排除点（裁决 I）：不调用任何 layout、不进 voiceLayouts。
    if (notation === 'fallback') return [];
    return [layoutVoice(voicePlan.voice, notation, externalOf(voicePlan, frameOf, measuresOf), ctx)];
  });

  const systems = geometry.lines.map((line): ScoreSystemLayout => {
    const frame = frameAt(frameOf, line.systemIndex);
    return {
      index: line.systemIndex,
      box: frame.box,
      groupIndex: line.groupIndex,
      measures: measuresAt(measuresOf, line.systemIndex),
      layers: frame.layers,
      chordOverlays: (chordPlansOf.get(line.systemIndex) ?? []).map((chordPlan) => finalOverlay(chordPlan, frame)),
      justified: line.justified,
    };
  });

  return {
    composed: { target: geometry.target, systems },
    voiceLayouts,
    diagnostics: [...geometry.diagnostics, ...planning.diagnostics, ...voiceLayouts.flatMap((entry) => entry.layout.diagnostics)],
  };
}
