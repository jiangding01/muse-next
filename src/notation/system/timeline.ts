/**
 * notation/system —— 小节内 shared timing（`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q3，T3 + 用户裁决
 * R1–R6 / N1 / N2，2026-10-04）。**纯 timing 数据层**：只产出 offsets / total / 逐声部 onset 映射 /
 * chordSymbol overlay 位置 / 退化状态；**不求 x、不求 endX、不构造 `MeasureTimeline`**（T4 再合成）。
 *
 * - T2 `verdict !== 'compatible'`（含 `desynced`）→ `not-compatible`，不重判 D3 / D4 / desync、不发诊断；
 * - D1 / overflow 直接沿用 T2 的 `SliceTotal` 原因（不再累计）；D2 = 本小节切片里有事件属于该声部
 *   `Voice.tuplets[].members`（经 T2 的 `renderVoice` 取得，不做 VoiceId 查找）；任一原因 → `degraded`；
 * - 否则逐声部 `voiceMeasureOnsets`（唯一实现），onset 并集 `cmp` 排序、`equals` 去重（与声部顺序无关），
 *   无 timed 时 `offsets = []`（R3）；chordSymbol 贴同一声部后续第一个 timed 的 offset，否则 `measure-end`（R1）。
 *
 * 诊断（R2/R4/R5）：`measure-timing-degraded`（info）只挂原因声部、每（声部, 小节）一条、多原因合并，
 * 本 ordinal ≥ 2 个在场声部且未 `diagnosticsSuppressed` 时才发。`memberIndex` 恒指原始 members 下标。
 */

import type { EventId, Rational, VoiceId } from '../../domain';
import { ZERO, cmp, equals } from '../../domain';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnostic, RenderVoice } from '../model/types';
import type { UnresolvedReason, VoiceMeasureOnsets } from './measureFeatures';
import { voiceMeasureOnsets } from './measureFeatures';
import type { AlignedMeasure, AlignedMember, MeasureAlignment } from './measureIdentity';

export interface TimedOnset {
  readonly itemIndex: number;
  readonly onset: Rational;
  readonly offsetIndex: number;
}

export type OverlayPosition = { readonly kind: 'onset'; readonly offsetIndex: number } | { readonly kind: 'measure-end' };

export interface OverlayOnset {
  readonly itemIndex: number;
  readonly onset: Rational;
  readonly position: OverlayPosition;
}

export interface VoiceMeasureTiming {
  readonly voiceId: VoiceId;
  /** 原始 `AlignedMeasure.members` 下标（过滤 absent 后不重新编号）。 */
  readonly memberIndex: number;
  readonly timed: readonly TimedOnset[];
  readonly overlays: readonly OverlayOnset[];
}

export type TimingDegradation = UnresolvedReason | 'tuplet';

export interface DegradationCause {
  readonly voiceId: VoiceId;
  readonly memberIndex: number;
  readonly reasons: readonly TimingDegradation[];
}

export type SharedMeasureTiming =
  | {
      readonly status: 'shared';
      /** 并集 onset，升序去重；非空时首项为 ZERO，无 timed 事件时为空。 */
      readonly offsets: readonly Rational[];
      readonly total: Rational;
      readonly voices: readonly VoiceMeasureTiming[];
    }
  | { readonly status: 'not-compatible' }
  | { readonly status: 'degraded'; readonly causes: readonly DegradationCause[] };

export interface GroupMeasureTiming {
  readonly groupIndex: number;
  /** 与 T2 `GroupMeasureAlignment.measures` 同下标。 */
  readonly measures: readonly SharedMeasureTiming[];
}

export interface MeasureTimings {
  readonly groups: readonly GroupMeasureTiming[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

type PresentMember = Extract<AlignedMember, { readonly renderVoice: RenderVoice }>;
type ResolvedOnsets = Extract<VoiceMeasureOnsets, { readonly resolved: true }>;
type Sink = (draft: RenderDiagnosticDraft) => void;
type TupletCache = Map<RenderVoice, ReadonlySet<EventId>>;

interface Present {
  readonly member: PresentMember;
  readonly memberIndex: number;
}

const REASON_TEXT: Readonly<Record<TimingDegradation, string>> = {
  'duration-undefined': '时值不可知的事件',
  'arithmetic-overflow': '超出精确表示范围的时值累加',
  tuplet: '实际时值未建模的连音成员',
};

function tupletMembers(renderVoice: RenderVoice, cache: TupletCache): ReadonlySet<EventId> {
  const cached = cache.get(renderVoice);
  if (cached !== undefined) {
    return cached;
  }
  const members = new Set(renderVoice.voice.tuplets.flatMap((tuplet) => tuplet.members));
  cache.set(renderVoice, members);
  return members;
}

/** D1 / overflow 沿用 T2 原因；D2 只看本小节切片里的事件是否为该声部 tuplet 成员。 */
function reasonsOf({ member }: Present, cache: TupletCache): TimingDegradation[] {
  const reasons: TimingDegradation[] = member.total.resolved ? [] : [member.total.reason];
  const tuplet = tupletMembers(member.renderVoice, cache);
  return member.slice.items.some((item) => tuplet.has(item.eventId)) ? [...reasons, 'tuplet'] : reasons;
}

function causeOf({ member, memberIndex }: Present, reasons: readonly TimingDegradation[]): DegradationCause {
  return { voiceId: member.participation.voiceId, memberIndex, reasons };
}

/** 无 cause 时逐声部算 onset 并合成 shared timing；若意外 unresolved，按实际原因防御性降级（不 throw）。 */
function share(present: readonly Present[]): SharedMeasureTiming {
  const causes: DegradationCause[] = [];
  const locals: { readonly entry: Present; readonly onsets: ResolvedOnsets }[] = [];
  for (const entry of present) {
    const onsets = voiceMeasureOnsets(entry.member.slice);
    if (onsets.resolved) {
      locals.push({ entry, onsets });
    } else {
      causes.push(causeOf(entry, [onsets.reason]));
    }
  }
  if (causes.length > 0) {
    return { status: 'degraded', causes };
  }
  // offsets 由各声部 onset 自身排序去重而来，下面的 findIndex 必然命中。
  const sorted = locals.flatMap(({ onsets }) => onsets.timed.map((timed) => timed.onset)).sort(cmp);
  const offsets = sorted.filter((onset, i) => {
    const previous = sorted[i - 1];
    return previous === undefined || !equals(onset, previous);
  });
  const indexOf = (onset: Rational): number => offsets.findIndex((offset) => equals(offset, onset));
  const voices = locals.map(({ entry, onsets: { timed, overlays } }): VoiceMeasureTiming => ({
    voiceId: entry.member.participation.voiceId,
    memberIndex: entry.memberIndex,
    timed: timed.map(({ itemIndex, onset }) => ({ itemIndex, onset, offsetIndex: indexOf(onset) })),
    overlays: overlays.map(({ itemIndex, onset }) => {
      const next = timed.find((candidate) => candidate.itemIndex > itemIndex);
      const position: OverlayPosition =
        next === undefined ? { kind: 'measure-end' } : { kind: 'onset', offsetIndex: indexOf(next.onset) };
      return { itemIndex, onset, position };
    }),
  }));
  return { status: 'shared', offsets, total: locals[0]?.onsets.total ?? ZERO, voices };
}

function report(measure: AlignedMeasure, cause: DegradationCause, sink: Sink): void {
  const member = measure.members[cause.memberIndex];
  if (member === undefined || !('slice' in member)) {
    return;
  }
  const message =
    `本声部第 ${String(member.slice.index + 1)} 小节含${cause.reasons.map((reason) => REASON_TEXT[reason]).join('、')}，` +
    '该小节不做跨声部时间对齐，各声部在公共小节框内各自排列';
  const draft = { code: CODES.systemMeasureTimingDegraded, level: 'info' as const, message };
  const [head] = member.slice.items;
  sink(
    head === undefined
      ? { ...draft, anchor: { kind: 'voice', voiceId: cause.voiceId } }
      : { ...draft, anchor: { kind: 'event', voiceId: cause.voiceId, eventId: head.eventId }, sourceRef: head.sourceRef },
  );
}

function timeMeasure(measure: AlignedMeasure, suppressed: boolean, cache: TupletCache, sink: Sink): SharedMeasureTiming {
  if (measure.verdict !== 'compatible') {
    return { status: 'not-compatible' };
  }
  const present = measure.members.flatMap((member, memberIndex): Present[] =>
    'renderVoice' in member ? [{ member, memberIndex }] : [],
  );
  const causes = present.flatMap((entry) => {
    const reasons = reasonsOf(entry, cache);
    return reasons.length === 0 ? [] : [causeOf(entry, reasons)];
  });
  const timing: SharedMeasureTiming = causes.length > 0 ? { status: 'degraded', causes } : share(present);
  // R2 / R4 / R5：只有跨声部共享本应成立（≥ 2 个在场声部）且未抑制时才发 system 诊断。
  if (timing.status === 'degraded' && present.length >= 2 && !suppressed) {
    for (const cause of timing.causes) {
      report(measure, cause, sink);
    }
  }
  return timing;
}

/** T2 `MeasureAlignment` → 每个 compatible measure 的 shared timing（纯函数，不改入参）。 */
export function buildMeasureTimings(alignment: MeasureAlignment): MeasureTimings {
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: Sink = (draft) => {
    drafts.push(draft);
  };
  const cache: TupletCache = new Map();
  const groups = alignment.groups.map((group) => ({
    groupIndex: group.groupIndex,
    measures: group.measures.map((measure) => timeMeasure(measure, group.diagnosticsSuppressed, cache, sink)),
  }));
  return { groups, diagnostics: collectRenderDiagnostics(drafts) };
}
