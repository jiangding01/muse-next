import { describe, expect, it } from 'vitest';

import { fromParts } from '../../../src/domain/index';
import { decomposeDuration } from '../../../src/notation/model/duration';

/** 方案 §2.6.1 的对照表，逐行一条用例。 */
const TABLE: readonly {
  readonly label: string;
  readonly duration: readonly [number, number];
  readonly base: readonly [number, number];
  readonly dots: 0 | 1 | 2;
  readonly beams: number;
  readonly dashes: number;
}[] = [
  { label: '1/4 → 数字，无减时线、无延音线', duration: [1, 4], base: [1, 4], dots: 0, beams: 0, dashes: 0 },
  { label: '1/8 → 一条减时线', duration: [1, 8], base: [1, 8], dots: 0, beams: 1, dashes: 0 },
  { label: '1/16 → 两条减时线', duration: [1, 16], base: [1, 16], dots: 0, beams: 2, dashes: 0 },
  { label: '1/2 → 一条延音线', duration: [1, 2], base: [1, 2], dots: 0, beams: 0, dashes: 1 },
  { label: '1 → 三条延音线', duration: [1, 1], base: [1, 1], dots: 0, beams: 0, dashes: 3 },
  { label: '3/8 → 四分音符 + 一个附点', duration: [3, 8], base: [1, 4], dots: 1, beams: 0, dashes: 0 },
  { label: '3/16 → 一条减时线 + 一个附点', duration: [3, 16], base: [1, 8], dots: 1, beams: 1, dashes: 0 },
];

describe('decomposeDuration —— §2.6.1 对照表', () => {
  it.each(TABLE)('$label', ({ duration, base, dots, beams, dashes }) => {
    const result = decomposeDuration(fromParts(duration[0], duration[1]));
    expect(result).toEqual({
      kind: 'glyph',
      base: fromParts(base[0], base[1]),
      dots,
      beams,
      dashes,
    });
  });
});

describe('decomposeDuration —— 附点与延音线的边界', () => {
  it('7/16 分解为四分音符 + 两个附点（dots 上限为 2）', () => {
    // 1/4 × (2 − 2^-2) = 1/4 × 7/4 = 7/16。
    expect(decomposeDuration(fromParts(7, 16))).toEqual({
      kind: 'glyph',
      base: fromParts(1, 4),
      dots: 2,
      beams: 0,
      dashes: 0,
    });
  });

  it('3/4 分解为二分音符 + 一个附点，延音线按 base 计算', () => {
    expect(decomposeDuration(fromParts(3, 4))).toEqual({
      kind: 'glyph',
      base: fromParts(1, 2),
      dots: 1,
      beams: 0,
      dashes: 1,
    });
  });

  it('取能成立的最小 dots：1/2 不会被写成「1/4 带附点的某种等价形式」', () => {
    const result = decomposeDuration(fromParts(1, 2));
    expect(result.kind).toBe('glyph');
    expect(result.kind === 'glyph' ? result.dots : -1).toBe(0);
  });
});

describe('decomposeDuration —— 不可表示时走 fallback', () => {
  it.each([
    // 分母非 2 的幂：
    [1, 3],
    [1, 6],
    [2, 3],
    [5, 12],
    // 分母**是** 2 的幂但分子不在 {1,3,7}：判据是「找不到 (base, dots)」，
    // 不是「分母非 2 的幂」——5/16 正是后者判错的反例。
    [5, 16],
    [11, 16],
  ])('%i/%i 不可表示，返回 unrepresentable 且原样带回 duration', (num, den) => {
    const duration = fromParts(num, den);
    expect(decomposeDuration(duration)).toEqual({ kind: 'unrepresentable', duration });
  });

  it('7/8 是正例：二分音符 + 两个附点（与 5/16 区分，证明判据不是分子是否为 1）', () => {
    expect(decomposeDuration(fromParts(7, 8))).toEqual({
      kind: 'glyph',
      base: fromParts(1, 2),
      dots: 2,
      beams: 0,
      dashes: 1,
    });
  });

  it('不做「四舍五入到最近的 2 的幂」：1/3 不会被当成 1/4 或 1/2', () => {
    const result = decomposeDuration(fromParts(1, 3));
    expect(result.kind).toBe('unrepresentable');
    expect(JSON.stringify(result)).not.toContain('"glyph"');
  });

  it('0（Domain 规范化为 0/1）与负时值走同一条 fallback，不产生负数减时线', () => {
    const zero = fromParts(0, 1);
    expect(decomposeDuration(zero)).toEqual({ kind: 'unrepresentable', duration: zero });
    expect(decomposeDuration(fromParts(-1, 4)).kind).toBe('unrepresentable');
  });

  it('base 范围是 k ∈ [0, 10] 闭区间：1/512 与 1/1024 成立，1/2048 才 fallback', () => {
    expect(decomposeDuration(fromParts(1, 512))).toEqual({
      kind: 'glyph',
      base: fromParts(1, 512),
      dots: 0,
      beams: 7,
      dashes: 0,
    });
    expect(decomposeDuration(fromParts(1, 1024))).toEqual({
      kind: 'glyph',
      base: fromParts(1, 1024),
      dots: 0,
      beams: 8,
      dashes: 0,
    });
    expect(decomposeDuration(fromParts(1, 2048)).kind).toBe('unrepresentable');
  });

  it('上界之外同样 fallback：2（二全音符）不在记谱范围内', () => {
    expect(decomposeDuration(fromParts(2, 1)).kind).toBe('unrepresentable');
  });
});

describe('decomposeDuration —— 与 tuplet 无关（P1-C）', () => {
  it('tuplet 成员照常分解：分解只看 Rational，不看它属不属于某个三连音', () => {
    // 一个 `(3` 三连音里的八分音符，其 `event.duration` 就是 1/8。
    // 函数签名里没有 tuplet / p / q 的位置，所以「是否属于 tuplet」在此不可表达，
    // 结果必然与一个自由的八分音符逐字段相同 —— 一条减时线，不走 fallback。
    const tupletMember = decomposeDuration(fromParts(1, 8));
    const freeEighth = decomposeDuration(fromParts(1, 8));

    expect(tupletMember).toEqual(freeEighth);
    expect(tupletMember).toEqual({
      kind: 'glyph',
      base: fromParts(1, 8),
      dots: 0,
      beams: 1,
      dashes: 0,
    });
    expect(tupletMember.kind).not.toBe('unrepresentable');
  });
});

describe('decomposeDuration —— 确定性', () => {
  it.each([
    [1, 4],
    [3, 16],
    [1, 3],
    [5, 16],
  ])('%i/%i 连续两次调用结果 toEqual', (num, den) => {
    const duration = fromParts(num, den);
    expect(decomposeDuration(duration)).toEqual(decomposeDuration(duration));
  });
});
