/**
 * M2.5 T4-1 —— water-filling justify（`system/justify.ts`，§Q4.5 + F-3 + 用户裁决 I-a）。
 */
import { describe, expect, it } from 'vitest';

import { SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { ceilTicks } from '../../../src/notation/system/geometryTicks';
import { distributeMeasure, justifyCap, justifyLine } from '../../../src/notation/system/justify';

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
const MIN_SLACK = ceilTicks(SYSTEM_METRICS.minJustifySlack);

describe('T4-1 —— 不拉伸的情形（justified = none）', () => {
  it('末行 / 唯一一行（mayJustify = false）：宽 = 需求', () => {
    expect(justifyLine([100, 200], 10_000, false)).toEqual({ widths: [100, 200], justified: 'none' });
  });

  it('剩余宽 < minJustifySlack、剩余宽 ≤ 0（单个超宽 measure）、Σdemand = 0 → none', () => {
    expect(justifyLine([100_000, 100_000], 200_000 + MIN_SLACK - 1, true).justified).toBe('none');
    expect(justifyLine([5000], 3000, true)).toEqual({ widths: [5000], justified: 'none' });
    expect(justifyLine([0, 0], 4096, true)).toEqual({ widths: [0, 0], justified: 'none' });
  });

  it('剩余宽恰为阈值时拉伸（边界：< 才不拉）', () => {
    expect(justifyLine([100_000, 100_000], 200_000 + MIN_SLACK, true).justified).toBe('full');
  });
});

describe('T4-1 —— full：按 demand 比例、整数级严格填满', () => {
  it('无触顶：Σ 宽 === 内容可用宽（整数严格），按需求比例而不是均分', () => {
    const out = justifyLine([100_000, 300_000], 440_000, true);
    expect(out.justified).toBe('full');
    expect(sum(out.widths)).toBe(440_000);
    expect(out.widths).toEqual([110_000, 330_000]);
  });

  it('余数确定性：不能整除时按下标顺序补给有小数份额的 measure，Σ 仍严格相等', () => {
    const out = justifyLine([100_001, 100_001, 100_001], 300_003 + 3001, true);
    expect(out.justified).toBe('full');
    expect(sum(out.widths)).toBe(303_004);
    expect(out.widths).toEqual([101_002, 101_001, 101_001]);
    const odd = justifyLine([99_997, 199_999, 300_001], 600_000 + 4999, true);
    expect(odd.justified).toBe('full');
    expect(sum(odd.widths)).toBe(604_999);
  });

  // 按 demand 比例分配时所有 measure 的增长率相同、cap 比例也相同，只有 ⌊d×3/2⌋ 的取整会让小的奇数需求
  // 先触顶（d = 1 → cap = 1）；迭代正是为此存在：触顶者固定、其余继续吸收剩余宽。
  it('单个触顶：被固定在 cap，其余 measure 吸收全部剩余宽，仍 full', () => {
    const out = justifyLine([1, 100_000], 100_001 + 3000, true);
    expect(out).toEqual({ widths: [1, 103_000], justified: 'full' });
  });

  it('第二轮才触顶：3 第一轮触顶后剩余宽重分，5 才越过 cap（只截一轮会让 5 超过 7）', () => {
    expect(justifyLine([3, 5, 5112], 5120 + MIN_SLACK, true)).toEqual({ widths: [4, 7, 7157], justified: 'full' });
    // 后续轮次必须用「当前」剩余宽判定触顶：用初始剩余宽会把 4099 误判为触顶、整行错标 partial。
    expect(justifyLine([3, 5, 4099], 6159, true)).toEqual({ widths: [4, 7, 6148], justified: 'full' });
  });

  it('多个触顶后迭代收敛：触顶的恰在 cap，未触顶的继续分，仍 full 且 Σ 严格相等', () => {
    const demands = [1, 1, 100_000, 90_000];
    const out = justifyLine(demands, sum(demands) + 9_000, true);
    expect(out.justified).toBe('full');
    expect(out.widths.slice(0, 2)).toEqual([justifyCap(1), justifyCap(1)]);
    expect(sum(out.widths)).toBe(sum(demands) + 9_000);
    out.widths.forEach((w, i) => expect(w).toBeLessThanOrEqual(justifyCap(demands[i] ?? 0)));
  });
});

describe('T4-1 —— partial：全部触顶仍有剩余', () => {
  it('全部到 cap 后右侧留白：Σ < 内容可用宽，每个 = ⌊d×3/2⌋', () => {
    const demands = [1000, 2000];
    const out = justifyLine(demands, 10_000, true);
    expect(out).toEqual({ widths: [1500, 3000], justified: 'partial' });
    expect(sum(out.widths)).toBeLessThan(10_000);
  });

  it('cap 精确等于 ⌊d × 3 / 2⌋（奇数需求向下取整），maxJustifyRatio 是精确上界', () => {
    expect(SYSTEM_METRICS.maxJustifyRatio).toBe(1.5);
    for (const d of [0, 1, 7, 1001, 18091]) expect(justifyCap(d)).toBe(Math.floor((d * 3) / 2));
    expect(justifyLine([7], 7 + 5000, true)).toEqual({ widths: [10], justified: 'partial' });
  });

  it('零需求 measure 不吸收剩余宽（cap 0）', () => {
    const out = justifyLine([0, 1000], 1000 + 4000, true);
    expect(out.widths[0]).toBe(0);
    expect(out.justified).toBe('partial');
  });
});

describe('T4-1 —— 确定性与输入不变', () => {
  it('同输入两次逐字段相等；输入数组不被修改', () => {
    const demands = [123, 456, 789];
    const frozen = [...demands];
    expect(justifyLine(demands, 2000, true)).toEqual(justifyLine(demands, 2000, true));
    expect(demands).toEqual(frozen);
  });
});

describe('T4-1 —— distributeMeasure：measure 内按分量需求比例放大', () => {
  it('Σ === 终宽、每个分量 ≥ 原值、按需求比例（不按时值 / 不均分）', () => {
    const parts = [0, 1000, 3000, 500];
    const out = distributeMeasure(parts, 4500 * 1.2);
    expect(sum(out)).toBe(5400);
    out.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(parts[i] ?? 0));
    expect(out).toEqual([0, 1200, 3600, 600]);
  });

  it('终宽 = 需求 → 原样；全 0 分量 + 终宽 0 → 全 0（不除零）', () => {
    expect(distributeMeasure([10, 20], 30)).toEqual([10, 20]);
    expect(distributeMeasure([0, 0], 0)).toEqual([0, 0]);
  });
});
