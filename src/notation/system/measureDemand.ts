/**
 * notation/system —— 每个对齐 measure 的公共 minimum width demand（M2.5 T4 §Q4.1 ①②、§Q3.6 段宽；用户
 * 裁决 D/E / J / M / O，2026-10-05）。纯函数；所有宽度在这里量化成整数 tick（`geometryTicks.ts`）。
 *
 * **唯一需求来源**：每个 voice / measure 的需求就是该记谱 T3.5 之后的最终 `MeasureSpacing`——TAB
 * `tabMeasureSpacing`、简谱 `jianpuMeasureSpacing`（均已含字形兜底、beam 组成员豁免与组级间距）、Staff
 * `staffMeasureSpacing`；fallback（未知 style）恒 0。本文件**不再**调 `spaceItems` / `widenFor*`，也不额外
 * 叠加 beam 需求（防 double-count）。每个 voice 只算一次（按 `RenderVoice` 缓存）。
 *
 * - **tier 3**（T3 `not-compatible` / `degraded`）：`demand = ⌈max_v voice 整小节宽⌉`，无段；
 * - **shared**（含 `offsets = []`）：逐 voice 把每一列归到 `lead`（首个 timed 之前）/ `segment[k]`（onset k
 *   的列及其后直到下一个 onset 之前的全部 local 列）/ `tail`（收尾 barline 列）；零宽 chordSymbol 列不新增
 *   位置、不贡献宽度；归属只用 T3 的 `itemIndex → offsetIndex`，不重新推导时值。各分量跨 voice 取 max
 *   （段内求和、再跨 voice 取 max，§Q4.2），各自向上量化；`demand = lead + Σsegment + tail`，且再与
 *   `⌈max_v 整小节宽⌉` 取 max（差额补进 tail，保证 ≥ 每个 raw voice demand）。absent voice 不参与。
 */

import type { KeySignature, Meter, VoiceId } from '../../domain';
import { isKnownVoiceStyle } from '../../domain';
import { jianpuMeasureSpacing, planJianpuBeams } from '../jianpu/jianpuBeams';
import type { MeasureSpacing } from '../layout/spacing';
import { splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderVoice } from '../model/types';
import { staffLineHeaderReserve } from '../staff/staffHeader';
import { staffMeasureSpacing } from '../staff/staffSlotWidths';
import { planTabBeams, tabMeasureSpacing } from '../tab/tabBeams';
import type { VoiceLayerNotation } from './contracts';
import { ceilTicks } from './geometryTicks';
import type { AlignedMeasure, AlignedMember } from './measureIdentity';
import type { SharedMeasureTiming } from './timeline';

/** 文档级事实：只读 `K:` / `M:`（beam 分组的拍号与 Staff 行首预留）。 */
export interface DemandScore {
  readonly key?: KeySignature;
  readonly meter?: Meter;
}

/** shared measure 的段分量（tick）；`segments.length === offsets.length`。 */
export interface MeasureComponents {
  readonly lead: number;
  readonly segments: readonly number[];
  readonly tail: number;
}

export interface MeasureDemand {
  readonly measureOrdinal: number;
  /** 量化后的 operational minimum（tick，不含行首预留）；shared 时 = lead + Σsegments + tail。 */
  readonly demandTicks: number;
  /** 仅 T3 `shared`（含零 timed）时存在；tier 3 缺席。 */
  readonly components?: MeasureComponents;
}

export type VoiceSpacings = (voice: RenderVoice) => readonly MeasureSpacing[];

type PresentMember = Extract<AlignedMember, { readonly renderVoice: RenderVoice }>;

/** voice 的记谱种类，判据与 renderer 分派同源（`isKnownVoiceStyle`；未知 / 缺省 → fallback）。 */
export function voiceNotation(voice: RenderVoice): VoiceLayerNotation {
  const style = voice.voice.style;
  return isKnownVoiceStyle(style) ? style : 'fallback';
}

function zeroSpacing(slice: MeasureSlice): MeasureSpacing {
  const slots = slice.items.map((_, i) => ({ slot: { index: slice.startIndex + i, x: 0, width: 0 }, widthKind: 'untimed' as const }));
  return { slots, width: 0, equidistant: false };
}

function computeSpacings(voice: RenderVoice, score: DemandScore, measurer: TextMeasurer): readonly MeasureSpacing[] {
  const measures = splitMeasures(voice.items);
  const notation = voiceNotation(voice);
  switch (notation) {
    case 'tab': {
      const plans = planTabBeams(measures, voice, score.meter);
      return measures.map((slice, i) => tabMeasureSpacing(slice, plans[i], measurer));
    }
    case 'jianpu': {
      const plans = planJianpuBeams(measures, voice, score.meter);
      return measures.map((slice, i) => jianpuMeasureSpacing(slice, plans[i]));
    }
    case 'staff':
      return measures.map((slice) => staffMeasureSpacing(slice, measurer));
    case 'fallback':
      return measures.map(zeroSpacing);
    default: {
      const exhaustive: never = notation;
      return exhaustive;
    }
  }
}

/** 每个 voice 的逐 measure 需求，一次 compose 内按 `RenderVoice` 缓存（只算一次）。 */
export function createVoiceSpacings(score: DemandScore, measurer: TextMeasurer): VoiceSpacings {
  const cache = new Map<RenderVoice, readonly MeasureSpacing[]>();
  return (voice) => {
    const cached = cache.get(voice);
    if (cached !== undefined) return cached;
    const spacings = computeSpacings(voice, score, measurer);
    cache.set(voice, spacings);
    return spacings;
  };
}

/** group 行首预留（tick）= 各层行首预留的 max（§Q4.4）：Staff 谱号 / 调号 / 拍号；TAB、简谱、fallback 当前为 0。 */
export function lineStartReserveTicks(voices: readonly RenderVoice[], score: DemandScore): number {
  const reserves = voices.map((voice) => (voiceNotation(voice) === 'staff' ? staffLineHeaderReserve(score) : 0));
  return ceilTicks(Math.max(0, ...reserves));
}

function spacingOf(member: PresentMember, spacingsOf: VoiceSpacings): MeasureSpacing | undefined {
  return spacingsOf(member.renderVoice)[member.slice.index];
}

/** 一个 voice 的 raw 分量：lead / 每段 / tail（tail = 收尾 barline 列）。 */
function voiceComponents(member: PresentMember, spacing: MeasureSpacing, offsetOf: ReadonlyMap<number, number>, k: number) {
  const segments = new Array<number>(k).fill(0);
  let lead = 0;
  let tail = 0;
  let current = -1;
  const last = member.slice.items.length - 1;
  for (const [j, item] of member.slice.items.entries()) {
    current = offsetOf.get(j) ?? current;
    const width = spacing.slots[j]?.slot.width ?? 0;
    if (j === last && item.event.kind === 'barline') tail += width;
    else if (current < 0) lead += width;
    else segments[current] = (segments[current] ?? 0) + width;
  }
  return { lead, segments, tail };
}

function sharedComponents(
  measure: AlignedMeasure, timing: Extract<SharedMeasureTiming, { status: 'shared' }>, spacingsOf: VoiceSpacings,
): MeasureComponents {
  const k = timing.offsets.length;
  const raw = { lead: 0, segments: new Array<number>(k).fill(0), tail: 0 };
  for (const voice of timing.voices) {
    const member = measure.members[voice.memberIndex];
    if (member === undefined || !('renderVoice' in member)) continue;
    const spacing = spacingOf(member, spacingsOf);
    if (spacing === undefined) continue;
    const offsetOf = new Map(voice.timed.map((timed) => [timed.itemIndex, timed.offsetIndex]));
    const own = voiceComponents(member, spacing, offsetOf, k);
    raw.lead = Math.max(raw.lead, own.lead);
    raw.tail = Math.max(raw.tail, own.tail);
    own.segments.forEach((width, i) => {
      raw.segments[i] = Math.max(raw.segments[i] ?? 0, width);
    });
  }
  return { lead: ceilTicks(raw.lead), segments: raw.segments.map(ceilTicks), tail: ceilTicks(raw.tail) };
}

/** 一个 group 逐 ordinal 的 demand（`timings` 与 `alignment.measures` 同下标）。 */
export function groupMeasureDemands(
  measures: readonly AlignedMeasure[], timings: readonly SharedMeasureTiming[], spacingsOf: VoiceSpacings,
): readonly MeasureDemand[] {
  return measures.map((measure, k): MeasureDemand => {
    const present = measure.members.flatMap((member) => ('renderVoice' in member ? [member] : []));
    const fullTicks = ceilTicks(Math.max(0, ...present.map((member) => spacingOf(member, spacingsOf)?.width ?? 0)));
    const timing = timings[k];
    if (timing === undefined || timing.status !== 'shared') return { measureOrdinal: measure.measureOrdinal, demandTicks: fullTicks };
    const parts = sharedComponents(measure, timing, spacingsOf);
    const sum = parts.lead + parts.segments.reduce((a, b) => a + b, 0) + parts.tail;
    const components = sum >= fullTicks ? parts : { ...parts, tail: parts.tail + (fullTicks - sum) };
    return { measureOrdinal: measure.measureOrdinal, demandTicks: Math.max(sum, fullTicks), components };
  });
}

/** 防御性：调用方按 `SystemGroup.voiceIds` 取 voice 时用；找不到的 id（输入被破坏）静默跳过。 */
export function voicesOf(ids: readonly VoiceId[], voices: readonly RenderVoice[]): readonly RenderVoice[] {
  return ids.flatMap((id) => voices.filter((voice) => voice.voiceId === id).slice(0, 1));
}
