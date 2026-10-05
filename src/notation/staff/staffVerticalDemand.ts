/**
 * notation/staff —— Staff 层的**纵向需求**（M2.5 T9b.S，用户裁决 A–M5，2026-10-05）。
 *
 * 与 `jianpu/jianpuVerticalDemand.ts` / `tab/tabVerticalDemand.ts` 平行：只凭 measure → system 归属与音高事实，
 * 在任何 y 确定之前算出每行谱需要在 96 之外上 / 下补多少。纯函数、不发诊断，不 import 渲染器 / VexFlow /
 * `layoutStaff` / `system/**`。目标是**包住**音高相关的纵向墨迹（containment），不复制渲染器的 SVG bbox。
 *
 * 几何（abstract unit；y 相对第一线、向下为正；全部尺寸取自 `STAFF_METRICS`）：
 * - 谱表位置 `p`：第五线 = 0、中线 = `lineCount − 1`、第一线 = `2 × (lineCount − 1)`，每级半个线距
 *   （谱号的第五线音高见 `staffClef.ts`）；符头中心 `y = (第一线位置 − p) × lineGap / 2`。
 * - 每个音高的上 / 下包络 = max(符头半高, 升降号, 附点（上下双向）, tie 端点保守包络)。加线由符头包络覆盖。
 * - 符干（breve / whole 无符干）：方向按标准记谱——离中线最远的音决定，平局向下；长 `stemLength`，
 *   离中线超过一个八度时延长到中线；32 / 64 / 128 分另按 `flagStemExtension` 延长。
 * - `topExtra = max(0, padding − (staffTopOffset + 墨迹顶))`，
 *   `bottomExtra = max(0, staffTopOffset + 墨迹底 + padding − systemHeight)`，层高 = `systemHeight + 两者`。
 *
 * 事件语义只经 `planStaffNode`（只看 `kind === 'note'` 的 `pitches`，占位 / 休止 / 和弦符号不计音高墨迹）；
 * 谱号只经 `resolveStaffClef`；tie 端点只经 `resolveVoiceRelations`——三者都不在这里重新解释。
 */

import type { Accidental, DomainIndex, EventId } from '../../domain';
import { STAFF_METRICS } from '../layout/metrics';
import { splitMeasures } from '../layout/systems';
import { resolveVoiceRelations } from '../model/relations';
import type { RenderVoice } from '../model/types';
import { resolveStaffClef, staffClefBottomLine } from './staffClef';
import { planStaffNode } from './staffEventNodes';
import type { StaffAccidentalDisplay, StaffClef, StaffDuration, StaffDurationBase, StaffNotePitch, StaffPitch } from './staffTypes';

const INK = STAFF_METRICS.verticalInk;

/** 一行谱的 Staff 纵向需求：`height = systemHeight + topExtra + bottomExtra`。 */
export interface StaffSystemDemand {
  readonly topExtra: number;
  readonly bottomExtra: number;
  readonly height: number;
}

/** 墨迹的上下界（相对第一线，向下为正）。 */
interface InkSpan {
  readonly top: number;
  readonly bottom: number;
}

/** tie 端点：`undefined` = 整个事件；否则 = Domain 原始成员下标集合。 */
type TiedMembers = ReadonlySet<number> | undefined;

function diatonicIndex(letter: StaffPitch['letter'], octave: number): number {
  return octave * 7 + 'CDEFGAB'.indexOf(letter);
}

/** 谱表位置：第五线 = 0，每个音级 + 1。 */
export function staffPosition(pitch: StaffPitch, clef: StaffClef): number {
  const bottom = staffClefBottomLine(clef);
  return diatonicIndex(pitch.letter, pitch.octave) - diatonicIndex(bottom.letter, bottom.octave);
}

function topLinePosition(): number {
  return 2 * (STAFF_METRICS.lineCount - 1);
}

function middleLinePosition(): number {
  return STAFF_METRICS.lineCount - 1;
}

/** 谱表位置 → 符头中心相对第一线的 y。 */
export function staffLineOffset(position: number): number {
  return ((topLinePosition() - position) * STAFF_METRICS.lineGap) / 2;
}

function accidentalDisplay(accidental: Accidental): StaffAccidentalDisplay {
  switch (accidental) {
    case '^':
      return 'sharp';
    case '^^':
      return 'doubleSharp';
    case '_':
      return 'flat';
    case '__':
      return 'doubleFlat';
    case '=':
      return 'natural';
  }
}

function hasStem(base: StaffDurationBase): boolean {
  return base !== 'breve' && base !== 'whole';
}

function flagExtension(base: StaffDurationBase): number {
  switch (base) {
    case 'thirtySecond':
    case 'sixtyFourth':
    case 'hundredTwentyEighth':
      return INK.flagStemExtension[base];
    default:
      return 0;
  }
}

/** 符干末端 y；无符干时 `undefined`。方向：离中线最远的音决定，平局向下。 */
export function staffStemTip(positions: readonly number[], base: StaffDurationBase): number | undefined {
  if (!hasStem(base) || positions.length === 0) return undefined;
  const low = Math.min(...positions);
  const high = Math.max(...positions);
  const middle = staffLineOffset(middleLinePosition());
  const extension = flagExtension(base);
  return low + high < 2 * middleLinePosition()
    ? Math.min(staffLineOffset(high) - INK.stemLength, middle) - extension
    : Math.max(staffLineOffset(low) + INK.stemLength, middle) + extension;
}

/** tie 端点能否唯一落到这个音高：成员下标在 `pitches` 里恰好出现一次才算唯一，否则整个事件保守扩张。 */
function isTiedPitch(entry: StaffNotePitch, pitches: readonly StaffNotePitch[], tied: TiedMembers): boolean {
  if (tied === undefined) return true;
  const unique = [...tied].every((member) => pitches.filter((other) => other.memberIndex === member).length === 1);
  return unique ? tied.has(entry.memberIndex) : true;
}

/** 一个音符 / 和弦事件的纵向墨迹。`tie`：缺席 = 不是 tie 端点；`members` 的含义见 `TiedMembers`。 */
export function staffNoteInk(
  pitches: readonly StaffNotePitch[],
  duration: StaffDuration,
  clef: StaffClef,
  tie: { readonly members: TiedMembers } | undefined,
): InkSpan {
  let top = Infinity;
  let bottom = -Infinity;
  for (const entry of pitches) {
    const center = staffLineOffset(staffPosition(entry.pitch, clef));
    const accidental = entry.pitch.accidental === undefined ? undefined : INK.accidental[accidentalDisplay(entry.pitch.accidental)];
    const tied = tie !== undefined && isTiedPitch(entry, pitches, tie.members);
    const dot = duration.dots > 0 ? INK.dotVerticalPadding : 0;
    const tieReach = tied ? STAFF_METRICS.tieVerticalPadding : 0;
    const above = Math.max(INK.noteheadHalfHeight, accidental?.above ?? 0, dot, tieReach);
    const below = Math.max(INK.noteheadHalfHeight, accidental?.below ?? 0, dot, tieReach);
    top = Math.min(top, center - above);
    bottom = Math.max(bottom, center + below);
  }
  const tip = staffStemTip(pitches.map((entry) => staffPosition(entry.pitch, clef)), duration.base);
  return tip === undefined ? { top, bottom } : { top: Math.min(top, tip), bottom: Math.max(bottom, tip) };
}

/** 本声部全部 tie 的端点（resolved 的两端、unresolved 的首端；成员下标按 Domain 原始下标）。 */
function tieEndpoints(voice: RenderVoice, index: DomainIndex): ReadonlyMap<EventId, { readonly members: TiedMembers }> {
  const out = new Map<EventId, { readonly members: TiedMembers }>();
  for (const resolved of resolveVoiceRelations(voice.voice, index)) {
    if (resolved.relation.kind !== 'tie') continue;
    for (const endpoint of resolved.resolved) {
      const id = endpoint.event.id;
      const member = endpoint.ref.memberIndex;
      const previous = out.get(id);
      if (previous !== undefined && previous.members === undefined) continue;
      out.set(id, { members: member === undefined ? undefined : new Set([...(previous?.members ?? []), member]) });
    }
  }
  return out;
}

/** 一行谱的需求：墨迹缺席时只有谱表本身（不触发任何补高）。 */
function demandOf(span: InkSpan | undefined): StaffSystemDemand {
  const top = Math.min(0, span?.top ?? 0);
  const bottom = Math.max(staffLineOffset(0), span?.bottom ?? 0);
  const topExtra = Math.max(0, INK.padding - (STAFF_METRICS.staffTopOffset + top));
  const bottomExtra = Math.max(0, STAFF_METRICS.staffTopOffset + bottom + INK.padding - STAFF_METRICS.systemHeight);
  return { topExtra, bottomExtra, height: STAFF_METRICS.systemHeight + topExtra + bottomExtra };
}

/**
 * 一个 Staff 声部在给定各行谱上的纵向需求（`systemIndices` 每项都有条目；本行没有本声部 measure 时 = 基础 96、
 * 两个 extra 都为 0）。`systemOfMeasure`：本地 measure 下标 → 全局 systemIndex（absent 不出条目）。
 * 每个 `(声部, 行谱)` 独立计算，不与其它声部或其它行谱取全局最大。
 */
export function staffLayerDemands(
  voice: RenderVoice,
  index: DomainIndex,
  systemOfMeasure: ReadonlyMap<number, number>,
  systemIndices: readonly number[],
): ReadonlyMap<number, StaffSystemDemand> {
  const clef = resolveStaffClef(voice.voice.clef).clef;
  const ties = tieEndpoints(voice, index);
  const spans = new Map<number, InkSpan>();
  for (const measure of splitMeasures(voice.items)) {
    const systemIndex = systemOfMeasure.get(measure.index);
    if (systemIndex === undefined) continue;
    for (const item of measure.items) {
      const plan = planStaffNode(item.event);
      if (plan.kind !== 'note') continue;
      const ink = staffNoteInk(plan.pitches, plan.duration, clef, ties.get(item.eventId));
      const current = spans.get(systemIndex);
      spans.set(systemIndex, current === undefined ? ink : { top: Math.min(current.top, ink.top), bottom: Math.max(current.bottom, ink.bottom) });
    }
  }
  return new Map(systemIndices.map((systemIndex) => [systemIndex, demandOf(spans.get(systemIndex))]));
}
