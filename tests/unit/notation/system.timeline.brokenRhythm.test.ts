/**
 * M2.5 T3 / T9c —— brokenRhythm 正面用例（方案 §Q7.2「timing degradation」行；T9c preflight 裁决 R2）。
 *
 * 合同：broken rhythm（`>` / `>>` / `<` …）已由 parse 改写进 Domain 的最终 `duration`；system timing
 * （`voiceMeasureOnsets` / `buildMeasureTimings`）只累计这些最终 duration，**不得**再应用 brokenRhythm 倍率，
 * 也不得改用改写前的时值。期望值一律是手写的 Rational 字面量（spec §16.2：`>` = 前 ×3/2、后 ×1/2，
 * `>>` = 前 ×7/4、后 ×1/4，`<` 反向），不从被测 helper 或事件 duration 推导。
 *
 * 只用最小的本地 helper（与 `system.timeline.test.ts` 的同类写法局部重复，不导出、不共享）。
 */
import { describe, expect, it } from 'vitest';

import type { Rational } from '../../../src/domain';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import { voiceMeasureOnsets } from '../../../src/notation/system/measureFeatures';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import type { MeasureTimings } from '../../../src/notation/system/timeline';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import type { MatrixScore } from './renderMatrix.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';

const r = (value: Rational): string => `${String(value.num)}/${String(value.den)}`;

/** `M:4/4`、`L:1/4`；多于一个声部时第一个声部带 `bracket=N`（同一 group）。 */
function run(bodies: readonly string[]): { readonly matrix: MatrixScore; readonly timings: MeasureTimings } {
  const declarations = bodies.map((_body, i) => `V:${String(i + 1)}${i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''}`);
  const lines = bodies.map((body, i) => `[V:${String(i + 1)}]${body}`);
  const matrix = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', ...declarations, 'K:C', ...lines, ''].join('\n'));
  const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
  return { matrix, timings: buildMeasureTimings(alignment) };
}

/** 第一个 group 的每个 measure：`shared:<offsets>|total=<total>`，其余状态只写状态名。 */
function summary(timings: MeasureTimings): string[] {
  return (timings.groups[0]?.measures ?? []).map((m) => (m.status === 'shared' ? `shared:${m.offsets.map(r).join(',')}|total=${r(m.total)}` : m.status));
}

/** 第一个声部各音符的最终 Domain duration。 */
function durationsOf(matrix: MatrixScore): string[] {
  return (matrix.renderScore.voices[0]?.items ?? []).flatMap((item) => (item.event.kind === 'note' && item.event.note.duration !== undefined ? [r(item.event.note.duration)] : []));
}

/** 第一个声部第一小节的 voice-local onset 与 total。 */
function onsetsOf(matrix: MatrixScore): string {
  const slice = splitMeasures(matrix.renderScore.voices[0]?.items ?? [])[0];
  const result = slice === undefined ? undefined : voiceMeasureOnsets(slice);
  return result === undefined || !result.resolved ? 'unresolved' : `${result.timed.map((t) => r(t.onset)).join(',')}|total=${r(result.total)}`;
}

describe('M2.5 T3 —— brokenRhythm（parse 已改写 Domain duration，timing 不得二次处理）', () => {
  it.each([
    ['C>D E F|', '>', ['3/8', '1/8', '1/4', '1/4'], '0/1,3/8,1/2,3/4|total=1/1'],
    ['C>>D E F|', '>>', ['7/16', '1/16', '1/4', '1/4'], '0/1,7/16,1/2,3/4|total=1/1'],
    ['C<D E2|', '<', ['1/8', '3/8', '1/2'], '0/1,1/8,1/2|total=1/1'],
  ] as const)('%s：relation 存在、Domain duration 已改写，onset 只累计最终 duration', (body, raw, durations, onsets) => {
    const { matrix, timings } = run([body]);
    expect(matrix.score.voices[0]?.brokenRhythms.map((relation) => relation.raw)).toEqual([raw]);
    expect(durationsOf(matrix)).toEqual(durations);
    expect(onsetsOf(matrix)).toBe(onsets);
    expect(summary(timings)).toEqual([`shared:${onsets}`]);
  });

  it('与普通四分音符声部求并集：并集里出现的是改写后的 onset 3/8（而不是只有四分网格）', () => {
    expect(summary(run(['C>D E F|', 'C D E F|']).timings)).toEqual(['shared:0/1,1/4,3/8,1/2,3/4|total=1/1']);
  });
});
