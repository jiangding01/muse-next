/**
 * `notation/staff/staffDurations.ts` 契约测试（M2 T7.1）。
 *
 * 覆盖：`breve..128th` 全表、`1/256`/`1/512`/`1/1024` → `beyondGlyphRange`（带
 * `exponent`）、`1/3` 与 `3/1` → `unrepresentable`、`dots` 0/1/2、`undefined` 输入、
 * 纯函数确定性。
 */
import { describe, expect, it } from 'vitest';

import { fromParts } from '../../../src/domain';
import { toStaffDuration } from '../../../src/notation/staff/staffDurations';
import type { StaffDurationBase } from '../../../src/notation/staff/staffTypes';

describe('toStaffDuration —— breve..128th 全表（dots = 0）', () => {
  const TABLE: readonly { readonly label: string; readonly duration: readonly [number, number]; readonly base: StaffDurationBase }[] = [
    { label: 'breve（2/1）', duration: [2, 1], base: 'breve' },
    { label: 'whole（1/1）', duration: [1, 1], base: 'whole' },
    { label: 'half（1/2）', duration: [1, 2], base: 'half' },
    { label: 'quarter（1/4）', duration: [1, 4], base: 'quarter' },
    { label: 'eighth（1/8）', duration: [1, 8], base: 'eighth' },
    { label: 'sixteenth（1/16）', duration: [1, 16], base: 'sixteenth' },
    { label: 'thirtySecond（1/32）', duration: [1, 32], base: 'thirtySecond' },
    { label: 'sixtyFourth（1/64）', duration: [1, 64], base: 'sixtyFourth' },
    { label: 'hundredTwentyEighth（1/128）', duration: [1, 128], base: 'hundredTwentyEighth' },
  ];

  it.each(TABLE)('$label → representable, base=$base, dots=0', ({ duration, base }) => {
    const result = toStaffDuration(fromParts(duration[0], duration[1]));
    expect(result).toEqual({ kind: 'representable', duration: { base, dots: 0 } });
  });
});

describe('toStaffDuration —— 超出 glyph 范围（产品决定：上限收紧到 128th）', () => {
  it.each([
    { label: '1/256', duration: [1, 256] as const, exponent: 8 },
    { label: '1/512', duration: [1, 512] as const, exponent: 9 },
    { label: '1/1024', duration: [1, 1024] as const, exponent: 10 },
  ])('$label → beyondGlyphRange，exponent = $exponent', ({ duration, exponent }) => {
    const result = toStaffDuration(fromParts(duration[0], duration[1]));
    expect(result).toEqual({ kind: 'beyondGlyphRange', exponent });
  });
});

describe('toStaffDuration —— 不可表示', () => {
  it('1/3：分母非 2 的幂 → unrepresentable', () => {
    expect(toStaffDuration(fromParts(1, 3))).toEqual({ kind: 'unrepresentable' });
  });

  it('3/1：附点 breve 无证据支持 → unrepresentable（不因 2/1 放行而被顺带支持）', () => {
    expect(toStaffDuration(fromParts(3, 1))).toEqual({ kind: 'unrepresentable' });
  });
});

describe('toStaffDuration —— dots 0/1/2', () => {
  it('3/8 → quarter + 1 个附点', () => {
    expect(toStaffDuration(fromParts(3, 8))).toEqual({
      kind: 'representable',
      duration: { base: 'quarter', dots: 1 },
    });
  });

  it('7/16 → quarter + 2 个附点（dots 上限为 2）', () => {
    expect(toStaffDuration(fromParts(7, 16))).toEqual({
      kind: 'representable',
      duration: { base: 'quarter', dots: 2 },
    });
  });

  it('1/4 → quarter + 0 个附点', () => {
    expect(toStaffDuration(fromParts(1, 4))).toEqual({
      kind: 'representable',
      duration: { base: 'quarter', dots: 0 },
    });
  });
});

describe('toStaffDuration —— undefined 输入', () => {
  it('undefined（`L:` 不可知导致 duration 缺失）→ unrepresentable', () => {
    expect(toStaffDuration(undefined)).toEqual({ kind: 'unrepresentable' });
  });
});

describe('toStaffDuration —— 确定性', () => {
  it.each([
    [1, 4] as const,
    [3, 8] as const,
    [1, 256] as const,
    [1, 3] as const,
  ])('%i/%i 连续两次调用结果 toEqual', (num, den) => {
    const duration = fromParts(num, den);
    expect(toStaffDuration(duration)).toEqual(toStaffDuration(duration));
  });

  it('undefined 连续两次调用结果 toEqual', () => {
    expect(toStaffDuration(undefined)).toEqual(toStaffDuration(undefined));
  });
});
