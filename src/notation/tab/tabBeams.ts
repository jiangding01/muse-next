/**
 * notation/tab —— TAB 的 beam 刻印（M2.5 T3.5，§Q8.2 / §Q8.3 / F-10 + 用户裁决 Q7 / Q8 / Q9 / Q11）。
 *
 * 分组判定在 `layout/beamGroups.ts`（与记谱无关，P1-3 窄化的三条写在那里）；本文件只把分组计划
 * 落成 TAB 几何，并给出 TAB 的 notation-local 列宽需求：
 * - **组不进 `layout.nodes`**（C1）：横梁住在 `TabLayout.beams`；组成员节点只做原位替换——符干从
 *   `stemTop` 延长到主梁、自身的逐音减时线清空，节点数量 / 顺序 / anchor 不变；
 * - **纵向**（Q8-a）：主梁 y = 本组最深成员在逐音画法下最深那条减时线的 y，次级横梁朝谱线方向以
 *   `beamGap` 向上叠；组内符干因此等长、底端共线，横梁水平不倾斜；行高（`requiredSystemDepth`）不变；
 * - **层级**（F-10 + Q7-a）：`1..commonBeams` 整组连续，更高 level 按最大连续段，单成员段画 beamlet
 *   （长度 = `beamLength`，组首向右、其余向左）；
 * - **粗细**（Q9-d）：仍是线段，粗细取 `TAB_METRICS.beamThickness`（= 既有 `.tab-beam` 的 1.4）；
 * - **宽度**（Q11）：组成员不再各自承担逐音减时线的 `beamLength + beamGap` 宽度项，组级间距由
 *   `equalizeGroupSpacing` 表达；`tabMeasureSpacing` 是这一 measure 的需求出口（T4 一次性消费）。
 * 组外单音、以及 `M:` raw / 缺席时，一切与改造前逐字段相同。
 */

import type { EventId, Meter, MusicEvent } from '../../domain';
import { equalizeGroupSpacing, planVoiceBeams } from '../layout/beamGroups';
import { engraveBeamGroups } from '../layout/beamEngraving';
import type { BeamGroupPlan, BeamLevelSegment, MeasureBeamPlan } from '../layout/beamGroups';
import { TAB_METRICS } from '../layout/metrics';
import type { MeasureSpacing } from '../layout/spacing';
import { spaceItems } from '../layout/spacing';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderVoice } from '../model/types';
import { stringY } from './tabGlyphs';
import type { TabNode, TabSegment } from './tabGlyphs';
import { widenForTabGlyphs } from './tabSlotWidths';

export interface TabBeamLine {
  /** 1 = 主梁（最靠下），越大越靠近第 6 弦。 */
  readonly level: number;
  readonly kind: 'span' | 'beamlet';
  readonly segment: TabSegment;
}

export interface TabBeamGroup {
  readonly measureIndex: number;
  readonly systemIndex: number;
  /** 成员事件，事件序。 */
  readonly eventIds: readonly EventId[];
  readonly equalSpacing: boolean;
  readonly lines: readonly TabBeamLine[];
}

/** TAB 会画时值装饰、且可以连梁的事件：单音与组合（休止断组，pitch 模式事件是文本占位）。 */
export function isTabBeamable(event: MusicEvent): boolean {
  return event.kind === 'tabNote' || event.kind === 'tabGroup';
}

export function planTabBeams(
  measures: readonly MeasureSlice[], voice: RenderVoice, meter: Meter | undefined,
): readonly MeasureBeamPlan[] {
  return planVoiceBeams(measures, voice.voice, meter, isTabBeamable);
}

/**
 * 一个 measure 的 TAB 列宽需求：`spaceItems` → 字形兜底（组成员免逐音减时线项）→ 组级间距。
 * `plan` 缺席（或没有组）时与改造前的 `widenForTabGlyphs(spaceItems(...))` 完全相同。
 */
export function tabMeasureSpacing(slice: MeasureSlice, plan: MeasureBeamPlan | undefined, measurer: TextMeasurer): MeasureSpacing {
  const beamed = new Set(plan?.groups.flatMap((group) => group.members.map((member) => member.itemIndex)) ?? []);
  const widened = widenForTabGlyphs(spaceItems(slice.items, slice.startIndex), slice.items, measurer, beamed);
  return plan === undefined ? widened : equalizeGroupSpacing(widened, plan);
}

type DurationNode = Extract<TabNode, { readonly kind: 'tabNote' | 'tabGroup' }>;

function isDurationNode(node: TabNode | undefined): node is DurationNode {
  return node !== undefined && (node.kind === 'tabNote' || node.kind === 'tabGroup');
}

/** 主梁 y：`maxBeams` 条减时线在逐音画法下最深那一条的 y（相对该行谱第 1 弦 `staffTop`）。 */
function primaryBeamY(staffTop: number, maxBeams: number): number {
  return (
    stringY(staffTop, TAB_METRICS.stringCount) +
    TAB_METRICS.stemOffsetY +
    TAB_METRICS.stemLength +
    TAB_METRICS.beamFirstOffset +
    (maxBeams - 1) * TAB_METRICS.beamGap
  );
}

function lineOf(segment: BeamLevelSegment, xs: readonly number[], primaryY: number): TabBeamLine {
  const y = primaryY - (segment.level - 1) * TAB_METRICS.beamGap;
  if (segment.kind === 'span') {
    const x1 = xs[segment.from] ?? 0;
    const x2 = xs[segment.to] ?? x1;
    return { level: segment.level, kind: 'span', segment: { x1, y1: y, x2, y2: y } };
  }
  const x = xs[segment.member] ?? 0;
  const x2 = segment.direction === 'right' ? x + TAB_METRICS.beamLength : x - TAB_METRICS.beamLength;
  return { level: segment.level, kind: 'beamlet', segment: { x1: Math.min(x, x2), y1: y, x2: Math.max(x, x2), y2: y } };
}

/** 一组的横梁；组成员节点缺失或不是时值节点时（防御性）整组不画，节点保持逐音画法。 */
function engraveGroup(
  group: BeamGroupPlan, measureIndex: number, members: readonly (TabNode | undefined)[],
): { readonly beam: TabBeamGroup; readonly nodes: readonly DurationNode[] } | undefined {
  const nodes = members.filter(isDurationNode);
  const [head] = nodes;
  if (head === undefined || nodes.length !== group.members.length) return undefined;
  const primaryY = primaryBeamY(head.y, Math.max(...group.members.map((member) => member.beams)));
  const xs = nodes.map((node) => node.x);
  const stemmed = nodes.map((node): DurationNode => {
    const top = node.duration.stem?.y1 ?? stringY(node.y, TAB_METRICS.stringCount) + TAB_METRICS.stemOffsetY;
    const stem: TabSegment = { x1: node.x, y1: top, x2: node.x, y2: primaryY };
    return { ...node, duration: { ...node.duration, stem, beams: [] } };
  });
  return {
    nodes: stemmed,
    beam: {
      measureIndex,
      systemIndex: head.systemIndex,
      eventIds: group.members.map((member) => member.eventId),
      equalSpacing: group.equalSpacing,
      lines: group.segments.map((segment) => lineOf(segment, xs, primaryY)),
    },
  };
}

/**
 * 节点建好之后落横梁：返回替换了组成员的新节点数组（同长同序，`layout/beamEngraving.ts`）与
 * `beams`。没有任何组时原样返回同一个节点数组。
 */
export function engraveTabBeams(
  nodes: readonly TabNode[], plans: readonly MeasureBeamPlan[],
): { readonly nodes: readonly TabNode[]; readonly beams: readonly TabBeamGroup[] } {
  return engraveBeamGroups(nodes, plans, engraveGroup);
}
