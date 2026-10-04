/**
 * notation/jianpu —— 简谱减时线按 beam 分组（M2.5 T3.5，§Q8.2 / F-10 + 用户裁决 Q7 / Q9 / Q10 / Q11；
 * Brief §2.7.2 第 3 层「减时线按 beam 分组」）。
 *
 * 分组判定在 `layout/beamGroups.ts`（与记谱无关，P1-3 窄化三条写在那里），条数规则与 TAB 一致；
 * 本文件只把计划落成简谱几何：
 * - **组不进 `layout.nodes`**（C1）：横线住在 `JianpuLayout.beams`；组成员节点只把自己的逐音减时线
 *   清空，数字 / 八度点（按成员**自己的**减时线条数避让，构造时已算定）/ 附点 / 延音线一概不动；
 * - **纵向**：第 k 层 y 与逐音画法相同（`baseline + beamFirstOffset + (k−1) × beamGap`，第 1 层最贴数字）；
 * - **横向**（Q10-a）：数字以 `x` 为中心绘制，横线覆盖 `[x首 − h, x末 + h]`，`h` = 数字视觉半宽
 *   （`digitFontSize × digitGlyphWidthRatio / 2`）；secondary 段同理；孤立的多出层级只画在该数字下、
 *   以数字中心对称（简谱没有 beamlet 方向）；
 * - **粗细**（Q9-d）：仍是线段，`JIANPU_METRICS.beamThickness`（= 既有 `.jianpu-beam` 的 1.4）；
 * - **宽度**（Q11）：简谱逐音减时线本来就不占列宽，组级只加 `equalizeGroupSpacing` 的间距约束。
 * 组外单音保持逐音画法 `[x, x + beamLength]`（raw / 缺席 `M:` 回归门要求逐字段不变）。
 */

import type { EventId, Meter, MusicEvent } from '../../domain';
import { equalizeGroupSpacing, planVoiceBeams } from '../layout/beamGroups';
import { engraveBeamGroups } from '../layout/beamEngraving';
import type { BeamGroupPlan, BeamLevelSegment, MeasureBeamPlan } from '../layout/beamGroups';
import { JIANPU_METRICS } from '../layout/metrics';
import type { MeasureSpacing } from '../layout/spacing';
import { spaceItems } from '../layout/spacing';
import type { MeasureSlice } from '../layout/systems';
import type { RenderVoice } from '../model/types';
import type { JianpuNode, JianpuSegment } from './jianpuGlyphs';
import { widenForJianpuGlyphs } from './jianpuSlotWidths';

export interface JianpuBeamLine {
  /** 1 = 最贴数字的第一条，越大越靠下。 */
  readonly level: number;
  readonly kind: 'span' | 'beamlet';
  readonly segment: JianpuSegment;
}

export interface JianpuBeamGroup {
  readonly measureIndex: number;
  readonly systemIndex: number;
  /** 成员事件，事件序。 */
  readonly eventIds: readonly EventId[];
  readonly equalSpacing: boolean;
  readonly lines: readonly JianpuBeamLine[];
}

/** 数字视觉半宽：与 `metrics/jianpu.ts` 推导 `dashFirstOffset` 用的是同一个量。 */
const DIGIT_HALF_WIDTH = (JIANPU_METRICS.digitFontSize * JIANPU_METRICS.digitGlyphWidthRatio) / 2;

/** 简谱会画减时线、且可以连梁的事件：音符与和弦块（休止断组，TAB 事件是文本占位）。 */
export function isJianpuBeamable(event: MusicEvent): boolean {
  return event.kind === 'note' || event.kind === 'chord';
}

export function planJianpuBeams(
  measures: readonly MeasureSlice[], voice: RenderVoice, meter: Meter | undefined,
): readonly MeasureBeamPlan[] {
  return planVoiceBeams(measures, voice.voice, meter, isJianpuBeamable);
}

/** 一个 measure 的简谱列宽需求：`spaceItems` → 延音线兜底 → 组级间距（T4 一次性消费的出口）。 */
export function jianpuMeasureSpacing(slice: MeasureSlice, plan: MeasureBeamPlan | undefined): MeasureSpacing {
  const widened = widenForJianpuGlyphs(spaceItems(slice.items, slice.startIndex), slice.items);
  return plan === undefined ? widened : equalizeGroupSpacing(widened, plan);
}

type BeamedNode = Extract<JianpuNode, { readonly kind: 'note' | 'chord' }>;

function isBeamedNode(node: JianpuNode | undefined): node is BeamedNode {
  return node !== undefined && (node.kind === 'note' || node.kind === 'chord');
}

function lineOf(segment: BeamLevelSegment, xs: readonly number[], baselineY: number): JianpuBeamLine {
  const y = baselineY + JIANPU_METRICS.beamFirstOffset + (segment.level - 1) * JIANPU_METRICS.beamGap;
  const from = segment.kind === 'span' ? segment.from : segment.member;
  const to = segment.kind === 'span' ? segment.to : segment.member;
  const x1 = (xs[from] ?? 0) - DIGIT_HALF_WIDTH;
  const x2 = (xs[to] ?? 0) + DIGIT_HALF_WIDTH;
  return { level: segment.level, kind: segment.kind, segment: { x1, y1: y, x2, y2: y } };
}

function engraveGroup(
  group: BeamGroupPlan, measureIndex: number, members: readonly (JianpuNode | undefined)[],
): { readonly beam: JianpuBeamGroup; readonly nodes: readonly BeamedNode[] } | undefined {
  const nodes = members.filter(isBeamedNode);
  const [head] = nodes;
  if (head === undefined || nodes.length !== group.members.length) return undefined;
  const xs = nodes.map((node) => node.x);
  return {
    nodes: nodes.map((node): BeamedNode => ({ ...node, duration: { ...node.duration, beams: [] } })),
    beam: {
      measureIndex,
      systemIndex: head.systemIndex,
      eventIds: group.members.map((member) => member.eventId),
      equalSpacing: group.equalSpacing,
      lines: group.segments.map((segment) => lineOf(segment, xs, head.y)),
    },
  };
}

/**
 * 节点建好之后落横梁：返回替换了组成员的新节点数组（同长同序，`layout/beamEngraving.ts`）与
 * `beams`。没有任何组时原样返回同一个节点数组。
 */
export function engraveJianpuBeams(
  nodes: readonly JianpuNode[], plans: readonly MeasureBeamPlan[],
): { readonly nodes: readonly JianpuNode[]; readonly beams: readonly JianpuBeamGroup[] } {
  return engraveBeamGroups(nodes, plans, engraveGroup);
}
