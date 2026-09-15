/**
 * Domain —— 有理数（M1.6 方案 v1.1 §1.5）。
 *
 * 不变式：`den > 0`、`gcd(|num|, den) === 1`、负号只出现在 `num`、`0` 规范化为 `{ num: 0, den: 1 }`。
 * 本模块只做纯数值工具，不承载任何乐理派生语义。
 */

export interface Rational {
  readonly num: number;
  readonly den: number;
}

export const ZERO: Rational = { num: 0, den: 1 };
export const ONE: Rational = { num: 1, den: 1 };

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function assertSafe(num: number, den: number, stage: 'input' | 'reduced'): void {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den)) {
    throw new RangeError(
      `Rational ${stage} out of safe integer range: ${String(num)}/${String(den)}`,
    );
  }
}

/**
 * 构造规范化 Rational。
 *
 * - `den === 0` 抛 `RangeError`；
 * - 约分前后各做一次 `Number.isSafeInteger` 检查，越界抛 `RangeError`（非整数输入同样被拒）。
 */
export function fromParts(num: number, den: number): Rational {
  if (den === 0) {
    throw new RangeError('Rational denominator must not be zero');
  }
  assertSafe(num, den, 'input');

  if (num === 0) {
    return ZERO;
  }

  const sign = den < 0 ? -1 : 1;
  const g = gcd(num, den);
  const reducedNum = (num / g) * sign;
  const reducedDen = Math.abs(den / g);
  assertSafe(reducedNum, reducedDen, 'reduced');

  return { num: reducedNum, den: reducedDen };
}

export function add(a: Rational, b: Rational): Rational {
  const g = gcd(a.den, b.den);
  const lcm = (a.den / g) * b.den;
  const num = a.num * (lcm / a.den) + b.num * (lcm / b.den);
  return fromParts(num, lcm);
}

export function mul(a: Rational, b: Rational): Rational {
  // 交叉约分，降低中间积越界的概率。
  const g1 = gcd(a.num, b.den);
  const g2 = gcd(b.num, a.den);
  const safeG1 = g1 === 0 ? 1 : g1;
  const safeG2 = g2 === 0 ? 1 : g2;
  const num = (a.num / safeG1) * (b.num / safeG2);
  const den = (a.den / safeG2) * (b.den / safeG1);
  return fromParts(num, den);
}

/** 全序比较；中间积越界时退化为浮点比较，保证任何输入都有确定结果。 */
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const g = gcd(a.den, b.den);
  const left = a.num * (b.den / g);
  const right = b.num * (a.den / g);
  if (Number.isSafeInteger(left) && Number.isSafeInteger(right)) {
    return left < right ? -1 : left > right ? 1 : 0;
  }
  const fa = a.num / a.den;
  const fb = b.num / b.den;
  return fa < fb ? -1 : fa > fb ? 1 : 0;
}

/** 规范化保证下，相等即字段逐一相等。 */
export function equals(a: Rational, b: Rational): boolean {
  return a.num === b.num && a.den === b.den;
}
