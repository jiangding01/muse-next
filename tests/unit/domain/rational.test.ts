import { describe, expect, it } from 'vitest';

import {
  ONE,
  ZERO,
  add,
  cmp,
  equals,
  fromParts,
  mul,
  type Rational,
} from '../../../src/domain/rational';

const SAMPLES: readonly Rational[] = [
  ZERO,
  ONE,
  fromParts(1, 2),
  fromParts(-1, 2),
  fromParts(3, 4),
  fromParts(-7, 3),
  fromParts(5, 1),
  fromParts(7, 16),
];

describe('fromParts', () => {
  it('约分到最简', () => {
    expect(fromParts(4, 8)).toEqual({ num: 1, den: 2 });
    expect(fromParts(6, 3)).toEqual({ num: 2, den: 1 });
  });

  it('分母恒为正，负号只在分子', () => {
    expect(fromParts(1, -2)).toEqual({ num: -1, den: 2 });
    expect(fromParts(-1, -2)).toEqual({ num: 1, den: 2 });
    expect(fromParts(-3, 6)).toEqual({ num: -1, den: 2 });
  });

  it('零规范化为 {0,1}', () => {
    expect(fromParts(0, 5)).toEqual(ZERO);
    expect(fromParts(0, -5)).toEqual(ZERO);
    expect(fromParts(-0, 7)).toEqual(ZERO);
  });

  it('分母为 0 抛 RangeError', () => {
    expect(() => fromParts(1, 0)).toThrow(RangeError);
  });

  it('safe-integer 越界或非整数抛 RangeError', () => {
    expect(() => fromParts(Number.MAX_SAFE_INTEGER + 2, 1)).toThrow(RangeError);
    expect(() => fromParts(1, Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
    expect(() => fromParts(1.5, 2)).toThrow(RangeError);
    expect(() => fromParts(Number.NaN, 2)).toThrow(RangeError);
    expect(() => fromParts(1, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('输出总是满足 den>0 且 gcd=1', () => {
    for (const a of SAMPLES) {
      expect(a.den).toBeGreaterThan(0);
      expect(fromParts(a.num, a.den)).toEqual(a);
    }
  });
});

describe('add / mul', () => {
  it('基本求值', () => {
    expect(add(fromParts(1, 2), fromParts(1, 3))).toEqual({ num: 5, den: 6 });
    expect(add(fromParts(1, 2), fromParts(-1, 2))).toEqual(ZERO);
    expect(mul(fromParts(2, 3), fromParts(3, 2))).toEqual(ONE);
    expect(mul(fromParts(-2, 3), fromParts(3, 4))).toEqual({ num: -1, den: 2 });
    expect(mul(fromParts(3, 4), ZERO)).toEqual(ZERO);
  });

  it('单位元', () => {
    for (const a of SAMPLES) {
      expect(add(a, ZERO)).toEqual(a);
      expect(mul(a, ONE)).toEqual(a);
    }
  });

  it('交换律（抽样）', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        expect(add(a, b)).toEqual(add(b, a));
        expect(mul(a, b)).toEqual(mul(b, a));
      }
    }
  });

  it('结合律（抽样）', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        for (const c of SAMPLES) {
          expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
          expect(mul(mul(a, b), c)).toEqual(mul(a, mul(b, c)));
        }
      }
    }
  });
});

describe('cmp / equals', () => {
  it('给出全序（反对称、传递、完全）', () => {
    for (const a of SAMPLES) {
      expect(cmp(a, a)).toBe(0);
      for (const b of SAMPLES) {
        expect(cmp(a, b) + cmp(b, a)).toBe(0);
        expect([-1, 0, 1]).toContain(cmp(a, b));
        for (const c of SAMPLES) {
          if (cmp(a, b) <= 0 && cmp(b, c) <= 0) {
            expect(cmp(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
  });

  it('cmp 与数值序一致', () => {
    expect(cmp(fromParts(1, 3), fromParts(1, 2))).toBe(-1);
    expect(cmp(fromParts(-1, 3), fromParts(-1, 2))).toBe(1);
    expect(cmp(fromParts(2, 4), fromParts(1, 2))).toBe(0);
  });

  it('cmp===0 等价于 equals（规范化前提下）', () => {
    for (const a of SAMPLES) {
      for (const b of SAMPLES) {
        expect(cmp(a, b) === 0).toBe(equals(a, b));
      }
    }
  });
});
