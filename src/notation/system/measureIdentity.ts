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
 *
 * **Desync latch（T2.1，用户裁决 R0-b / P2-4-b）**：某 ordinal 出现孤立小节线 vs 含 timed 事件的
 * 小节（序号从此可能错开）时，该处仍是 `structure-conflict` 且只在此报一次；其后全部 ordinal 判
 * `desynced`（在场者全 `incompatible`、不再判定、不发诊断，T3 不建 shared timeline）。普通 S1 raw
 * 冲突、D4、孤立线 vs 只有 untimed 内容的零时值小节（仍判 structure-conflict）均不触发；本期不自动
 * 恢复同步；latch 只在本 group 内生效，count-mismatch 不受其影响。
 */

import type { VoiceId } from '../../domain';
import { equals } from '../../domain';
import type { MeasureSlice } from '../layout/systems';
import { splitMeasures } from '../layout/systems';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnostic, RenderVoice } from '../model/types';
import type { MeasureParticipation, SystemGroup } from './contracts';
import type { SliceTotal } from './measureFeatures';
import { hasTimedEvent, isIsolatedLine, sliceTotal, trailingBarline } from './measureFeatures';

export type { SliceTotal } from './measureFeatures';

/** 一个声部在某 ordinal 上的参与：在场则携带原切片（引用）与 S3，T3 直接复用。 */
export type AlignedMember =
  | {
      readonly participation: Extract<MeasureParticipation, { readonly kind: 'present' | 'incompatible' }>;
      /** T2 已解析好的声部引用（N2）：T3 取 `Voice.tuplets` 不再做 VoiceId 查找。 */
      readonly renderVoice: RenderVoice;
      readonly slice: MeasureSlice;
      readonly total: SliceTotal;
    }
  | { readonly participation: Extract<MeasureParticipation, { readonly kind: 'absent' }> };

/** measure 级判定：`compatible` 之外的 ordinal 退出 shared timing，T3 跳过；`desynced` 见文件头。 */
export type MeasureVerdict = 'compatible' | 'structure-conflict' | 'total-mismatch' | 'desynced';

export interface AlignedMeasure {
  readonly measureOrdinal: number;
  readonly verdict: MeasureVerdict;
  /** 顺序 = `SystemGroup.voiceIds`。 */
  readonly members: readonly AlignedMember[];
}

export interface GroupMeasureAlignment {
  readonly groupIndex: number;
  /** group 含找不到的 VoiceId（调用方破坏输入）时为 true：全部 T2 诊断已抑制，T3 直接继承（R5-b）。 */
  readonly diagnosticsSuppressed: boolean;
  /** 长度 = group 内各声部 measure 数的最大值。 */
  readonly measures: readonly AlignedMeasure[];
}

export interface MeasureAlignment {
  readonly groups: readonly GroupMeasureAlignment[];
  readonly diagnostics: readonly RenderDiagnostic[];
}

type Sink = (draft: RenderDiagnosticDraft) => void;

/** 某 ordinal 上一个在场声部的切片与 S3。 */
interface Cell {
  readonly voiceId: VoiceId;
  readonly renderVoice: RenderVoice;
  readonly slice: MeasureSlice;
  readonly total: SliceTotal;
}

/** `desync` = 孤立线 vs 含 timed 事件的小节（触发 latch）；S1 同时成立时同样触发。 */
interface Judgement {
  readonly verdict: MeasureVerdict;
  readonly desync: boolean;
}

/** 只在在场声部之间判定；D3 优先于 D4（结构冲突时不再比较总量）。 */
function judge(present: readonly Cell[]): Judgement {
  if (present.length < 2) {
    return { verdict: 'compatible', desync: false };
  }
  const raws = new Set(present.map((cell) => trailingBarline(cell.slice)).filter((raw) => raw !== undefined));
  const isolated = present.map((cell) => isIsolatedLine(cell.slice));
  // 孤立线不含 timed 事件，所以「有孤立线且有含 timed 的小节」必然也是 S2 混合。
  const desync = isolated.includes(true) && present.some((cell) => hasTimedEvent(cell.slice));
  if (raws.size > 1 || (isolated.includes(true) && isolated.includes(false))) {
    return { verdict: 'structure-conflict', desync };
  }
  const known = present.flatMap(({ total }) => (total.resolved ? [total.value] : []));
  const [first] = known;
  const mismatch = first !== undefined && known.some((value) => !equals(value, first));
  return { verdict: mismatch ? 'total-mismatch' : 'compatible', desync: false };
}

/** 不兼容 measure 的逐声部诊断，挂首事件；`splitMeasures` 不产空切片，voice 分支仅作类型兜底。 */
function reportMeasure(voiceId: VoiceId, slice: MeasureSlice, judgement: Judgement, sink: Sink): void {
  const ordinal = String(slice.index + 1);
  const draft =
    judgement.verdict === 'structure-conflict'
      ? {
          code: CODES.systemMeasureStructureConflict,
          level: 'warning' as const,
          message:
            `本声部第 ${ordinal} 小节与同组其它声部的收尾小节线或小节形态（孤立小节线 / 内容小节）不一致，` +
            '保留公共小节边界与宽度，放弃该小节的内部时间对齐' +
            (judgement.desync ? '；此后本组各小节序号可能错开，均不再做跨声部时间对齐' : ''),
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
  let latched = false;
  for (let k = 0; k < count; k += 1) {
    const cells = voices.map(({ voiceId, voice, slices }): Cell | { readonly voiceId: VoiceId } => {
      const slice = slices[k];
      return slice === undefined || voice === undefined
        ? { voiceId }
        : { voiceId, renderVoice: voice, slice, total: sliceTotal(slice) };
    });
    const present = cells.flatMap((cell) => ('slice' in cell ? [cell] : []));
    // latch 之后不再判定、不发诊断（触发点的诊断已说明后续全部 desynced）。
    const judgement: Judgement = latched ? { verdict: 'desynced', desync: false } : judge(present);
    const { verdict } = judgement;
    const kind = verdict === 'compatible' ? 'present' : 'incompatible';
    const members = cells.map((cell): AlignedMember =>
      'slice' in cell
        ? {
            participation: { voiceId: cell.voiceId, kind, localMeasureIndex: cell.slice.index },
            renderVoice: cell.renderVoice,
            slice: cell.slice,
            total: cell.total,
          }
        : { participation: { voiceId: cell.voiceId, kind: 'absent' } },
    );
    if (verdict !== 'compatible' && verdict !== 'desynced') {
      for (const cell of present) {
        reportMeasure(cell.voiceId, cell.slice, judgement, report);
      }
    }
    latched = latched || judgement.desync;
    measures.push({ measureOrdinal: k, verdict, members });
  }
  return { groupIndex: group.index, diagnosticsSuppressed, measures };
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
