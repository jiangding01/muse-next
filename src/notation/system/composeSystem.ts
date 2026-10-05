/**
 * notation/system —— 公共 measure 几何的编排（M2.5 T4，§Q4.1–Q4.6 / §Q6.1–Q6.3 / F-3 / F-5；用户裁决
 * A–O，2026-10-05）。**第一版只到几何**：产出阶段包装 `ComposedSystemGeometry`，不构造 `ScoreSystemLayout`
 * （voice 层纵向几何归 T5、和弦 overlay 归 T6、行高归 T8，不塞占位值）；不 import 任何 voice layout 或
 * `layoutChord`（K-a），需求全部经 `measureDemand.ts` 的记谱需求出口。
 *
 * 管线（一次 compose 内 T1 / T2 / T3 各只跑一次并复用）：
 * 1. `groupVoices` → `alignMeasures` → `buildMeasureTimings`；每 voice 的需求按 voice 缓存；
 * 2. 逐 group **独立** packing（F-5）：阈值 = ⌊可用宽⌋ − ⌈行首预留⌉（预留在 packing **之前**扣，§Q4.4），
 *    沿用 `layoutSystems` 的贪心（单个超宽 measure 独占一行不拆）。page 策略给了**有效** hint
 *    （`Number.isSafeInteger(N) && N ≥ 1`，否则一律视为没有 hint）时：该行 N 个按需求放得下就强制 N 个，否则本行
 *    退回自动（H-a：不发诊断）。全零 group（预留 0 且所有需求 0，如只有 fallback 声部）忽略 hint、一行装完（M-a）；
 * 3. 逐行 water-filling（`justify.ts`，末行 / 唯一一行不拉）；行首 measure 的终宽 = 预留 + 内容宽，预留不参与
 *    justify / cap，并以 `contentOffsetX` 写进几何（G-b）；
 * 4. shared measure 的内容终宽按 lead / 段 / tail 的需求比例分回（`distributeMeasure`）：
 *    `xByOffsetIndex[0] = contentOffsetX + lead'`，逐段累加，`endX` = 收尾 barline x（无则为逻辑内容末端），
 *    `width = endX + tail'`（D/E-a）；零 timed shared 保留空 timeline（C-a）；tier 3 无 timeline。
 * 全部 x / 宽在整数 tick 上累计（`geometryTicks.ts`），产出时换回 unit；`systemIndex` 全文档按 group 文档
 * 顺序累加（N-a）。诊断只透传 `renderScore` + T1 + T2 + T3（顺序固定），T4 不新增码。纯函数，不改输入。
 *
 * M2.5 T6（用户裁决 C-b）：本次 compose 的 T1 / T2 / T3 结果以纯数据 `SystemAnalysis` 一并返回，供 T6 消费 T3 的
 * `OverlayOnset`（唯一真源），一次最终 compose 内 T1 / T2 / T3 仍只各跑一次。
 */

import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderDiagnostic, RenderScore } from '../model/types';
import type { JustifyState, LayoutTarget, MeasureTimeline, PackingPolicy, SystemMeasureGeometry } from './contracts';
import { floorTicks, unitsOf } from './geometryTicks';
import { groupVoices } from './groupVoices';
import type { VoiceGrouping } from './groupVoices';
import { distributeMeasure, justifyLine } from './justify';
import { createVoiceSpacings, groupMeasureDemands, lineStartReserveTicks, voicesOf } from './measureDemand';
import type { MeasureDemand } from './measureDemand';
import { alignMeasures } from './measureIdentity';
import type { AlignedMeasure, MeasureAlignment } from './measureIdentity';
import { buildMeasureTimings } from './timeline';
import type { MeasureTimings, SharedMeasureTiming } from './timeline';

/** 一个 group 的一行（T4 阶段产物；T5+ 在其上组装 `ScoreSystemLayout`）。 */
export interface SystemLineGeometry {
  /** 全文档序号：按 group 文档顺序逐行累加（§Q1.3）。 */
  readonly systemIndex: number;
  readonly groupIndex: number;
  /** group 内的行序。 */
  readonly lineIndex: number;
  /** 本行行首预留（各层行首预留的 max，量化后）；已计入行首 measure 的 `width` 与 `contentOffsetX`。 */
  readonly lineStartReserve: number;
  /** 行实际宽 = 各 measure `width` 之和（full 时恰为可用宽；partial / none 时更窄或超宽）。 */
  readonly width: number;
  readonly justified: JustifyState;
  readonly measures: readonly SystemMeasureGeometry[];
  /**
   * 三态（用户裁决 a / b / c，2026-10-05）：缺席 = 没有可应用的有效 hint（hint 缺席 / 非法 / screen / 全零 group
   * 主动忽略）；`true` = 有效 page hint 参与了 packing 且本行没有因宽度回退（文档结束导致末行不足 N 仍是 true）；
   * `false` = 有效 hint 本要参与，但本行 N 个放不下、退回自动 packing。
   */
  readonly barsPerStaffHonored?: boolean;
}

/** 一次 compose 的 T1 / T2 / T3 结果（T6 裁决 C-b / 附加裁决 1）：只存数据，不挂函数 / cache。 */
export interface SystemAnalysis {
  readonly grouping: VoiceGrouping;
  readonly alignment: MeasureAlignment;
  readonly timings: MeasureTimings;
}

export interface ComposedSystemGeometry {
  readonly target: LayoutTarget;
  readonly lines: readonly SystemLineGeometry[];
  /** `renderScore.diagnostics` + T1 + T2 + T3（顺序固定）；T4 不新增诊断码。下游不得再从 `analysis` 重复合并。 */
  readonly diagnostics: readonly RenderDiagnostic[];
  readonly analysis: SystemAnalysis;
}

interface PackedLine {
  readonly indices: readonly number[];
  readonly honored?: boolean;
}

/** `layoutSystems` 同款贪心：`cursor > 0` 且再放就超阈值才换行；单个超宽 measure 独占一行。 */
function greedyEnd(demands: readonly number[], start: number, threshold: number): number {
  let cursor = demands[start] ?? 0;
  let end = start + 1;
  while (end < demands.length) {
    const next = demands[end] ?? 0;
    if (cursor > 0 && cursor + next > threshold) break;
    cursor += next;
    end += 1;
  }
  return end;
}

/** 有效 page hint：安全整数且 ≥ 1；其余（0、负数、小数、NaN、Infinity、越过安全整数）一律视为没有 hint。 */
function validHint(barsPerStaff: number | undefined): number | undefined {
  return barsPerStaff !== undefined && Number.isSafeInteger(barsPerStaff) && barsPerStaff >= 1 ? barsPerStaff : undefined;
}

/** `hint` 已经过 `validHint`；缺席时不产出 `honored`。 */
function packLines(demands: readonly number[], threshold: number, hint: number | undefined): readonly PackedLine[] {
  const lines: PackedLine[] = [];
  let start = 0;
  while (start < demands.length) {
    const take = hint === undefined ? 0 : Math.min(hint, demands.length - start);
    const forced = take > 0 && demands.slice(start, start + take).reduce((a, b) => a + b, 0) <= threshold;
    const end = forced ? start + take : greedyEnd(demands, start, threshold);
    const indices = Array.from({ length: end - start }, (_, i) => start + i);
    lines.push(hint === undefined ? { indices } : { indices, honored: forced });
    start = end;
  }
  return lines;
}

/** shared measure 的 timeline：内容终宽按分量需求比例分回，x 在 tick 上累加；tier 3 返回 undefined。 */
function timelineOf(
  demand: MeasureDemand, timing: SharedMeasureTiming | undefined, offsetTicks: number, contentTicks: number,
): MeasureTimeline | undefined {
  const parts = demand.components;
  if (parts === undefined || timing === undefined || timing.status !== 'shared') return undefined;
  const scaled = distributeMeasure([parts.lead, ...parts.segments, parts.tail], contentTicks);
  let cursor = offsetTicks + (scaled[0] ?? 0);
  const xs = parts.segments.map((_, k) => {
    const x = cursor;
    cursor += scaled[k + 1] ?? 0;
    return unitsOf(x);
  });
  return { offsets: timing.offsets, total: timing.total, xByOffsetIndex: xs, endX: unitsOf(cursor) };
}

function geometryOf(
  measure: AlignedMeasure, demand: MeasureDemand, timing: SharedMeasureTiming | undefined,
  at: { readonly systemIndex: number; readonly xTicks: number; readonly offsetTicks: number; readonly contentTicks: number },
): SystemMeasureGeometry {
  const timeline = timelineOf(demand, timing, at.offsetTicks, at.contentTicks);
  const base = {
    measureOrdinal: measure.measureOrdinal,
    systemIndex: at.systemIndex,
    x: unitsOf(at.xTicks),
    width: unitsOf(at.offsetTicks + at.contentTicks),
    demandWidth: unitsOf(demand.demandTicks),
    contentOffsetX: unitsOf(at.offsetTicks),
    participation: measure.members.map((member) => member.participation),
  };
  return timeline === undefined ? base : { ...base, timeline };
}

/** 整份文档的公共 measure 几何（T4 阶段产物）。 */
export function composeSystemGeometry(
  renderScore: RenderScore, measurer: TextMeasurer, policy: PackingPolicy,
): ComposedSystemGeometry {
  const grouping = groupVoices(renderScore.score.voices);
  const alignment = alignMeasures(grouping.groups, renderScore.voices);
  const timings = buildMeasureTimings(alignment);
  const spacingsOf = createVoiceSpacings(renderScore.score, measurer);
  const widthTicks = floorTicks(policy.kind === 'screen' ? policy.availableWidth : policy.contentWidth);
  const hint = validHint(policy.kind === 'page' ? policy.barsPerStaff : undefined);

  const lines: SystemLineGeometry[] = [];
  for (const group of alignment.groups) {
    const ids = grouping.groups[group.groupIndex]?.voiceIds ?? [];
    const reserveTicks = lineStartReserveTicks(voicesOf(ids, renderScore.voices), renderScore.score);
    const threshold = Math.max(0, widthTicks - reserveTicks);
    const groupTimings = timings.groups[group.groupIndex]?.measures ?? [];
    const demands = groupMeasureDemands(group.measures, groupTimings, spacingsOf);
    // 全零 group（M-a）：没有可见的 measure 几何，忽略 hint，整组一行（贪心本身也会一行装完）。
    const allZero = reserveTicks === 0 && demands.every((demand) => demand.demandTicks === 0);
    const packed = packLines(demands.map((demand) => demand.demandTicks), threshold, allZero ? undefined : hint);
    for (const [lineIndex, line] of packed.entries()) {
      const systemIndex = lines.length;
      const justification = justifyLine(line.indices.map((i) => demands[i]?.demandTicks ?? 0), threshold, lineIndex < packed.length - 1);
      let xTicks = 0;
      const measures = line.indices.flatMap((ordinal, j): SystemMeasureGeometry[] => {
        const measure = group.measures[ordinal];
        const demand = demands[ordinal];
        if (measure === undefined || demand === undefined) return [];
        const offsetTicks = j === 0 ? reserveTicks : 0;
        const contentTicks = justification.widths[j] ?? demand.demandTicks;
        const geometry = geometryOf(measure, demand, groupTimings[ordinal], { systemIndex, xTicks, offsetTicks, contentTicks });
        xTicks += offsetTicks + contentTicks;
        return [geometry];
      });
      const base = {
        systemIndex, groupIndex: group.groupIndex, lineIndex, lineStartReserve: unitsOf(reserveTicks),
        width: unitsOf(xTicks), justified: justification.justified, measures,
      };
      lines.push(line.honored === undefined ? base : { ...base, barsPerStaffHonored: line.honored });
    }
  }
  const diagnostics = [...renderScore.diagnostics, ...grouping.diagnostics, ...alignment.diagnostics, ...timings.diagnostics];
  return { target: policy.kind, lines, diagnostics, analysis: { grouping, alignment, timings } };
}
