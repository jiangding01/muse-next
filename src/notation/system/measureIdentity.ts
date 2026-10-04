/**
 * notation/system —— 跨声部 measure identity（`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q2，T2 +
 * 用户 2026-10-04 裁决 A–H）。`measureOrdinal` 只是 group 内候选序号，**不是 Domain 身份**。
 * measure 一律由 `splitMeasures` 切出，按 ordinal **前缀对齐**，超出范围记 `absent`（F-1：
 * 不做 LCS / DTW / 局部搜索，不插入、不移动 measure）。每个 ordinal 只在在场声部之间判定：
 * S1 raw 去重后 > 1 或 S2 一方孤立线一方不是 → `structure-conflict`（无等价表；tail 不单独
 * 冲突）；否则已知绝对 `Rational` 总量不全等 → `total-mismatch`（unresolved 不参与）。任一冲突
 * 即整个 measure 不兼容，在场者全标 `incompatible`，不做多数投票。不读 `Meter`、不做比例换算。
 *
 * 诊断（裁决 B）：count 不等 → `measure-count-mismatch`（warning，每声部一条 voice anchor）；
 * D3 → `measure-structure-conflict`（warning）；D4 → `measure-timing-degraded`（info），后两者挂
 * 首事件 event anchor。group 含找不到的 VoiceId 时该 group 的全部 T2 诊断抑制（裁决 H）。
 * D1 / D2 / 溢出归 T3，T3 跳过 `verdict !== 'compatible'` 的 ordinal，不重复报。
 */

import type { Rational, VoiceId } from '../../domain';
import { ZERO, add, equals } from '../../domain';
import type { MeasureSlice } from '../layout/systems';
import { splitMeasures } from '../layout/systems';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnostic, RenderVoice } from '../model/types';
import type { MeasureParticipation, SystemGroup } from './contracts';
import { eventTiming } from './timedDuration';

/** S3：measure 内 timed 事件的绝对时值总量；不可知时保留原因（裁决 G）。 */
export type SliceTotal =
  | { readonly resolved: true; readonly value: Rational }
  | { readonly resolved: false; readonly reason: 'duration-undefined' | 'arithmetic-overflow' };

/** 一个声部在某 ordinal 上的参与：在场则携带原切片（引用）与 S3，T3 直接复用。 */
export type AlignedMember =
  | {
      readonly participation: Extract<MeasureParticipation, { readonly kind: 'present' | 'incompatible' }>;
      readonly slice: MeasureSlice;
      readonly total: SliceTotal;
    }
  | { readonly participation: Extract<MeasureParticipation, { readonly kind: 'absent' }> };

/** measure 级判定：`compatible` 之外的 ordinal 由 T2 报告并退出 shared timing，T3 跳过。 */
export type MeasureVerdict = 'compatible' | 'structure-conflict' | 'total-mismatch';

export interface AlignedMeasure {
  readonly measureOrdinal: number;
  readonly verdict: MeasureVerdict;
  /** 顺序 = `SystemGroup.voiceIds`。 */
  readonly members: readonly AlignedMember[];
}

export interface GroupMeasureAlignment {
  readonly groupIndex: number;
  /** 长度 = group 内各声部 measure 数的最大值。 */
  readonly measures: readonly AlignedMeasure[];
}

export interface MeasureAlignment {
  readonly groups: readonly GroupMeasureAlignment[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

type Sink = (draft: RenderDiagnosticDraft) => void;

/** S3。只捕获 `RangeError`、其它照抛；`arithmetic-overflow` 统称 `add` 拒绝（越过安全整数或不变式被破坏）。 */
function sliceTotal(slice: MeasureSlice): SliceTotal {
  let value: Rational = ZERO;
  for (const item of slice.items) {
    const timing = eventTiming(item.event);
    if (!timing.timed) {
      continue;
    }
    if (timing.duration === undefined) {
      return { resolved: false, reason: 'duration-undefined' };
    }
    try {
      value = add(value, timing.duration);
    } catch (error) {
      if (error instanceof RangeError) {
        return { resolved: false, reason: 'arithmetic-overflow' };
      }
      throw error;
    }
  }
  return { resolved: true, value };
}

/** S1：最后一项是小节线时取其 raw；否则缺席（tail）。 */
function trailingBarline(slice: MeasureSlice): string | undefined {
  const last = slice.items[slice.items.length - 1];
  return last !== undefined && last.event.kind === 'barline' ? last.event.raw : undefined;
}

/** S2：只含一根小节线的 measure（开头孤立 barline 的形态）。 */
function isIsolatedLine(slice: MeasureSlice): boolean {
  const [only] = slice.items;
  return slice.items.length === 1 && only !== undefined && only.event.kind === 'barline';
}

/** 某 ordinal 上一个在场声部的切片与 S3。 */
interface Cell {
  readonly voiceId: VoiceId;
  readonly slice: MeasureSlice;
  readonly total: SliceTotal;
}

/** 只在在场声部之间判定；D3 优先于 D4（结构冲突时不再比较总量）。 */
function judge(present: readonly Cell[]): MeasureVerdict {
  if (present.length < 2) {
    return 'compatible';
  }
  const raws = new Set(present.map((cell) => trailingBarline(cell.slice)).filter((raw) => raw !== undefined));
  const isolated = present.map((cell) => isIsolatedLine(cell.slice));
  if (raws.size > 1 || (isolated.includes(true) && isolated.includes(false))) {
    return 'structure-conflict';
  }
  const known = present.flatMap(({ total }) => (total.resolved ? [total.value] : []));
  const [first] = known;
  return first !== undefined && known.some((value) => !equals(value, first)) ? 'total-mismatch' : 'compatible';
}

/** 不兼容 measure 的逐声部诊断，挂首事件；`splitMeasures` 不产空切片，voice 分支仅作类型兜底。 */
function reportMeasure(voiceId: VoiceId, slice: MeasureSlice, verdict: MeasureVerdict, sink: Sink): void {
  const ordinal = String(slice.index + 1);
  const draft =
    verdict === 'structure-conflict'
      ? {
          code: CODES.systemMeasureStructureConflict,
          level: 'warning' as const,
          message:
            `本声部第 ${ordinal} 小节与同组其它声部的收尾小节线或小节形态（孤立小节线 / 内容小节）不一致，` +
            '保留公共小节边界与宽度，放弃该小节的内部时间对齐',
        }
      : {
          code: CODES.systemMeasureTimingDegraded,
          level: 'info' as const,
          message:
            `本声部第 ${ordinal} 小节与同组其它声部的时值总量不同，` +
            '该小节不做跨声部时间对齐，各声部在公共小节框内各自排列',
        };
  const [head] = slice.items;
  sink(
    head === undefined
      ? { ...draft, anchor: { kind: 'voice', voiceId } }
      : { ...draft, anchor: { kind: 'event', voiceId, eventId: head.eventId }, sourceRef: head.sourceRef },
  );
}

function alignGroup(group: SystemGroup, lookup: ReadonlyMap<VoiceId, RenderVoice>, sink: Sink): GroupMeasureAlignment {
  const voices = group.voiceIds.map((voiceId) => {
    const voice = lookup.get(voiceId);
    return { voiceId, voice, slices: voice === undefined ? [] : splitMeasures(voice.items) };
  });
  const count = voices.reduce((max, { slices }) => Math.max(max, slices.length), 0);
  // 裁决 H：找不到 RenderVoice 是调用方破坏输入、不是乐谱事实。alignment 照常返回，但该 group
  // 的全部 T2 诊断（count / structure / timing）经这一个闸门抑制，不向用户声称源文件问题。
  const hasMissingVoice = voices.some(({ voice }) => voice === undefined);
  const diagnosticsSuppressed = hasMissingVoice;
  const report: Sink = diagnosticsSuppressed ? () => undefined : sink;

  if (voices.some(({ slices }) => slices.length !== count)) {
    for (const { voiceId, voice, slices } of voices) {
      const draft: RenderDiagnosticDraft = {
        code: CODES.systemMeasureCountMismatch,
        level: 'warning',
        message:
          `本声部有 ${String(slices.length)} 个小节，同一 system group 内最多 ${String(count)} 个；` +
          '已按前缀对齐，缺少的小节留空并保留公共宽度',
        anchor: { kind: 'voice', voiceId },
      };
      const origin = voice?.voice.origins[0];
      report(origin === undefined ? draft : { ...draft, sourceRef: origin });
    }
  }

  const measures: AlignedMeasure[] = [];
  for (let k = 0; k < count; k += 1) {
    const cells = voices.map(({ voiceId, slices }): Cell | { readonly voiceId: VoiceId } => {
      const slice = slices[k];
      return slice === undefined ? { voiceId } : { voiceId, slice, total: sliceTotal(slice) };
    });
    const present = cells.flatMap((cell) => ('slice' in cell ? [cell] : []));
    const verdict = judge(present);
    const kind = verdict === 'compatible' ? 'present' : 'incompatible';
    const members = cells.map((cell): AlignedMember =>
      'slice' in cell
        ? {
            participation: { voiceId: cell.voiceId, kind, localMeasureIndex: cell.slice.index },
            slice: cell.slice,
            total: cell.total,
          }
        : { participation: { voiceId: cell.voiceId, kind: 'absent' } },
    );
    if (verdict !== 'compatible') {
      for (const cell of present) {
        reportMeasure(cell.voiceId, cell.slice, verdict, report);
      }
    }
    measures.push({ measureOrdinal: k, verdict, members });
  }
  return { groupIndex: group.index, measures };
}

/**
 * `groups`（T1 产物）× `voices`（`RenderScore.voices`）→ 每个 group 的 ordinal 对齐。
 * 声部按 VoiceId 查找，重复 id 取首次出现；纯函数，不改入参，切片是原 `items` 的引用。
 */
export function alignMeasures(groups: readonly SystemGroup[], voices: readonly RenderVoice[]): MeasureAlignment {
  const lookup = new Map<VoiceId, RenderVoice>();
  for (const voice of voices) {
    if (!lookup.has(voice.voiceId)) {
      lookup.set(voice.voiceId, voice);
    }
  }
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: Sink = (draft) => {
    drafts.push(draft);
  };
  const aligned = groups.map((group) => alignGroup(group, lookup, sink));
  return { groups: aligned, diagnostics: collectRenderDiagnostics(drafts) };
}
