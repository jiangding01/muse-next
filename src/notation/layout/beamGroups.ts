/**
 * notation/layout —— TAB / 简谱共用的 **beam 分组核心**（M2.5 T3.5；§Q8.2 / F-9 / F-10 + 用户裁决
 * Q3–Q7、Q11）。与记谱无关，几何归 `tab/tabBeams.ts` / `jianpu/jianpuBeams.ts`。
 *
 * **P1-3 的窄化（F-9 裁决，原样照录）**：
 * 1. **`Meter` 仍不得直接决定 spacing / 拍宽**：不存在「一拍 = N 单位宽」这类计算，
 *    列宽的直接来源仍只有 `duration` 与字形需求（`spacing.ts:9-10` 原意保持）；
 * 2. **允许 `Meter` 用于 engraving grouping**（哪些音连成一个 beam 组）；
 * 3. **允许 engraving 产生的 glyph minimum demand 反过来约束最小宽度**——这本来就
 *    是既有模型的一部分（`widenFor*Glyphs` 系列已经在做「字形需求抬高列宽」），
 *    beam 只是把这个需求从**逐列**变成**组级**。
 *
 * 判据（§Q8.2 + Q3–Q6）：拍单位只取冻结表（`x/4`→1/4、`x/8` 且 `x%3===0`→3/8、`x/2`→1/2，其余
 * 不分组、不类推）；同拍 = `floor(onset / beatUnit)` 相等（BigInt 精确整除，只看 onset）；onset 只来自
 * `voiceMeasureOnsets`；不可知 / 溢出 / 含 tuplet 成员的 measure 整体不分组；`chordSymbol` 跳过不断组，
 * grace / barline / decoration / unknown / 休止 / 不可连梁或 `beams===0` / `unrepresentable` 断组。
 * 层级（F-10 + Q7）与组级间距（Q11）见 `segmentsOf` / `equalizeGroupSpacing`；本文件只给
 * notation-local 约束，不做跨声部取 max。
 */

import type { EventId, Meter, MusicEvent, Rational, Voice } from '../../domain';
import { equals, fromParts } from '../../domain';
import { decomposeDuration } from '../model/duration';
import type { UnresolvedReason } from './measureOnsets';
import { voiceMeasureOnsets } from './measureOnsets';
import { SLOT_SPACING_METRICS } from './metrics';
import type { MeasureSpacing, SpacedSlot } from './spacing';
import type { MeasureSlice } from './systems';

/** 组内相邻成员（符干到符干）的最小间距：复用「再窄就画不下减时线」的 `minSlotWidth`（Q11）。 */
export const BEAM_MIN_STEM_GAP = SLOT_SPACING_METRICS.minSlotWidth;

/** `itemIndex` = 在 `slice.items` 中的下标；`beams` = `decomposeDuration` 的减时线条数（≥ 1）。 */
export interface BeamMember {
  readonly itemIndex: number;
  readonly eventId: EventId;
  readonly onset: Rational;
  readonly duration: Rational;
  readonly beams: number;
}

/** `from` / `to` / `member` 都是 `members` 下标；`level` 从 1 起，1 = 主梁。 */
export type BeamLevelSegment =
  | { readonly kind: 'span'; readonly level: number; readonly from: number; readonly to: number }
  | { readonly kind: 'beamlet'; readonly level: number; readonly member: number; readonly direction: 'left' | 'right' };

export interface BeamGroupPlan {
  readonly members: readonly BeamMember[];
  readonly commonBeams: number;
  readonly segments: readonly BeamLevelSegment[];
  /** 全部成员 `duration` 相等 → 组内强制等距（F-10）。 */
  readonly equalSpacing: boolean;
}

export type MeasureBeamStatus = 'grouped' | 'meter-not-grouped' | UnresolvedReason | 'tuplet';

export interface MeasureBeamPlan {
  readonly status: MeasureBeamStatus;
  readonly groups: readonly BeamGroupPlan[];
}

/** 该记谱会画时值装饰、且可以连梁的事件类（TAB：tabNote / tabGroup；简谱：note / chord）。 */
export type Beamable = (event: MusicEvent) => boolean;

const NOT_GROUPED: MeasureBeamPlan = { status: 'meter-not-grouped', groups: [] };

/** 冻结表里的拍单位；表外一律 `undefined`（不分组）。 */
export function beatUnitOf(meter: Meter | undefined): Rational | undefined {
  if (meter === undefined || meter.kind === 'raw' || !Number.isSafeInteger(meter.num) || meter.num <= 0) {
    return undefined;
  }
  if (meter.den === 4) return fromParts(1, 4);
  if (meter.den === 2) return fromParts(1, 2);
  return meter.den === 8 && meter.num % 3 === 0 ? fromParts(3, 8) : undefined;
}

/** `floor(onset / unit)`，BigInt 精确整除（向负无穷取整），零浮点。 */
export function beatIndex(onset: Rational, unit: Rational): bigint {
  const a = BigInt(onset.num) * BigInt(unit.den);
  const b = BigInt(onset.den) * BigInt(unit.num);
  const q = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? q - 1n : q;
}

export function tupletMemberSet(voice: Voice): ReadonlySet<EventId> {
  return new Set(voice.tuplets.flatMap((tuplet) => tuplet.members));
}

function beamsOf(duration: Rational): number {
  const decomposition = decomposeDuration(duration);
  return decomposition.kind === 'glyph' ? decomposition.beams : 0;
}

/** 1..commonBeams 整组连续；更高 level 取最大连续段：≥ 2 → secondary span，= 1 → beamlet（组首向右，其余向左）。 */
function segmentsOf(members: readonly BeamMember[], commonBeams: number): BeamLevelSegment[] {
  const maxBeams = Math.max(...members.map((member) => member.beams));
  const segments: BeamLevelSegment[] = [];
  for (let level = 1; level <= maxBeams; level += 1) {
    if (level <= commonBeams) {
      segments.push({ kind: 'span', level, from: 0, to: members.length - 1 });
      continue;
    }
    let start = -1;
    for (let i = 0; i <= members.length; i += 1) {
      const has = (members[i]?.beams ?? 0) >= level;
      if (has && start < 0) start = i;
      if (has || start < 0) continue;
      segments.push(
        i - start >= 2
          ? { kind: 'span', level, from: start, to: i - 1 }
          : { kind: 'beamlet', level, member: start, direction: start === 0 ? 'right' : 'left' },
      );
      start = -1;
    }
  }
  return segments;
}

function groupOf(members: readonly BeamMember[]): BeamGroupPlan {
  const commonBeams = Math.min(...members.map((member) => member.beams));
  const [first] = members;
  return {
    members,
    commonBeams,
    segments: segmentsOf(members, commonBeams),
    equalSpacing: members.every((member) => first !== undefined && equals(member.duration, first.duration)),
  };
}

/** 一个声部的一个 measure 的分组计划（纯函数）。 */
export function planMeasureBeams(
  slice: MeasureSlice, beatUnit: Rational | undefined, tupletMembers: ReadonlySet<EventId>, isBeamable: Beamable,
): MeasureBeamPlan {
  if (beatUnit === undefined) return NOT_GROUPED;
  const onsets = voiceMeasureOnsets(slice);
  if (!onsets.resolved) return { status: onsets.reason, groups: [] };
  if (slice.items.some((item) => tupletMembers.has(item.eventId))) return { status: 'tuplet', groups: [] };

  const timedByItem = new Map(onsets.timed.map((timed) => [timed.itemIndex, timed]));
  const groups: BeamGroupPlan[] = [];
  let run: BeamMember[] = [];
  let runBeat = 0n;
  const flush = (): void => {
    if (run.length >= 2) groups.push(groupOf(run));
    run = [];
  };
  for (const [itemIndex, item] of slice.items.entries()) {
    if (item.event.kind === 'chordSymbol') continue;
    const timed = timedByItem.get(itemIndex);
    const beams = timed !== undefined && isBeamable(item.event) ? beamsOf(timed.duration) : 0;
    if (timed === undefined || beams < 1) { flush(); continue; }
    const beat = beatIndex(timed.onset, beatUnit);
    if (run.length > 0 && beat !== runBeat) flush();
    runBeat = beat;
    run.push({ itemIndex, eventId: item.eventId, onset: timed.onset, duration: timed.duration, beams });
  }
  flush();
  return { status: 'grouped', groups };
}

/** 整个声部逐 measure 的分组计划；拍单位与 tuplet 成员集合只算一次。 */
export function planVoiceBeams(
  measures: readonly MeasureSlice[], voice: Voice, meter: Meter | undefined, isBeamable: Beamable,
): readonly MeasureBeamPlan[] {
  const beatUnit = beatUnitOf(meter);
  if (beatUnit === undefined) return measures.map(() => NOT_GROUPED);
  const tuplets = tupletMemberSet(voice);
  return measures.map((slice) => planMeasureBeams(slice, beatUnit, tuplets, isBeamable));
}

/**
 * 组级间距（Q11）：同时值组全部 gap 只加宽到 `max(现有 gap, G_min)`；不同时值组只补足 `G_min − gap > 0`
 * 的部分。加宽落在前一成员自己的列上，只加宽不缩窄，无变化返回同一引用；`slots` 与 `slice.items` 同序同长。
 */
export function equalizeGroupSpacing(spacing: MeasureSpacing, plan: MeasureBeamPlan): MeasureSpacing {
  const widths = spacing.slots.map((spaced) => spaced.slot.width);
  for (const group of plan.groups) {
    // 每个 gap = 成员自己的列宽 + 其后到下一成员之间的列宽（rest，只可能是零宽 chordSymbol 列）。
    const gaps = group.members.slice(0, -1).map((member, i) => {
      const next = group.members[i + 1]?.itemIndex ?? member.itemIndex;
      const rest = widths.slice(member.itemIndex + 1, next).reduce((sum, width) => sum + width, 0);
      return { column: member.itemIndex, rest, gap: (widths[member.itemIndex] ?? 0) + rest };
    });
    const target = group.equalSpacing ? Math.max(BEAM_MIN_STEM_GAP, ...gaps.map(({ gap }) => gap)) : BEAM_MIN_STEM_GAP;
    // 写成 `target − rest` 而不是 `width + (target − gap)`：后者的浮点加减可能差 1 ulp，等距就不再精确相等。
    for (const { column, rest, gap } of gaps) {
      if (gap < target) widths[column] = target - rest;
    }
  }
  if (widths.every((width, i) => width === spacing.slots[i]?.slot.width)) return spacing;
  const slots: SpacedSlot[] = [];
  let x = 0;
  for (const [i, spaced] of spacing.slots.entries()) {
    const width = widths[i] ?? spaced.slot.width;
    slots.push({ slot: { index: spaced.slot.index, x, width }, widthKind: spaced.widthKind });
    x += width;
  }
  return { slots, width: x, equidistant: spacing.equidistant };
}
