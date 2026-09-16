/**
 * notation/model —— 时值分解（M2 方案 v1.1.1 §2.6.1，P1-3 / P1-C）。
 *
 * 两条容易踩的红线，先写在最前面：
 *
 * 1. **不涉及「拍」**：`Rational` 是**相对全音符的绝对音长**（`1/4` = 四分音符），
 *    不是拍数。`Meter` 可能是 `raw` 分支（`M:C` / `M:C|` 按 spec §8.4 不换算），
 *    那种情况下根本没有可用的拍长，所以 `Meter` **不参与**本文件的任何计算。
 * 2. **与 tuplet 无关**：视觉时值来自 `event.duration` 这个事实，与该事件是否属于
 *    某个 tuplet 无关。`(3` 里的八分音符 `duration` 就是 `1/8`，照常画一条减时线；
 *    tuplet 只额外画一个括号 + 数字。M2 **不按 `p`/`q` 推算 effective duration**
 *    （`q === 0` 的语义是 UNVERIFIED，U25），该事实由 relation 层单发一条诊断。
 *
 * 分解规则：
 * ```text
 * 基准 = 四分音符 = 1/4
 * 寻找 base = 2^-k（k ∈ [0, 10] 闭区间，见 MAX_BASE_EXPONENT）与 dots ∈ {0,1,2}，使  d == base × (2 − 2^-dots)
 *   （dots=0 → ×1；dots=1 → ×3/2；dots=2 → ×7/4）
 * 减时线 beams  = log2( (1/4) / base )   当 base < 1/4
 * 延音线 dashes = base / (1/4) − 1       当 base > 1/4
 * ```
 *
 * 分解不成立的判据是**「找不到这样的 `(base, dots)` 组合」**，而**不是**「分母不是
 * 2 的幂」——后者判错：`5/16` 的分母是 2 的幂，却无法写成 `base × {1, 3/2, 7/4}`
 * 中的任何一种（5 不在 `{1, 3, 7}` 里），照样不可表示。此时返回
 * `{ kind: 'unrepresentable' }`：不画任何时值装饰，宽度按字面 `duration` 排布，
 * 由调用方发 `muse.render.duration.unrepresentable`。
 * **不得四舍五入到最近的 2 的幂**——那是在编造作者没写的时值。
 *
 * 全程整数 / BigInt 运算，无浮点：同一输入必然得到同一输出。
 */

import type { Rational } from '../../domain';
import { fromParts } from '../../domain';

export type DurationDots = 0 | 1 | 2;

/** 分解成功：`duration === base × (2 − 2^-dots)`。 */
export interface DurationGlyph {
  readonly kind: 'glyph';
  /** `2^-k`（k ≥ 0），如 `1` / `1/4` / `1/8`。 */
  readonly base: Rational;
  readonly dots: DurationDots;
  /** 减时线条数（`base < 1/4` 时为正，否则 0）。 */
  readonly beams: number;
  /** 延音线条数（`base > 1/4` 时为正，否则 0）。 */
  readonly dashes: number;
}

/**
 * 分解不成立：找不到 `(base, dots)` 使 `duration === base × (2 − 2^-dots)`。
 * 覆盖 `1/3`（分母非 2 的幂）、`5/16`（分母是 2 的幂但分子不在 `{1,3,7}`）、
 * 超出合理范围的 `base`，以及非正时值。调用方走 fallback + 诊断。
 */
export interface DurationUnrepresentable {
  readonly kind: 'unrepresentable';
  readonly duration: Rational;
}

export type DurationDecomposition = DurationGlyph | DurationUnrepresentable;

const DOTS: readonly DurationDots[] = [0, 1, 2];

/** 四分音符基准的指数：`1/4 === 2^QUARTER_EXPONENT`。 */
const QUARTER_EXPONENT = -2;

/**
 * `base = 2^-k` 的合理范围：**`k ∈ [0, 10]`，两端闭区间**。
 *
 * - `k = 0` → `base = 1`（全音符，三条延音线）：记谱上限，**不支持二全音符**（`2/1` 走 fallback）；
 * - `k = 10` → `base = 1/1024`（八条减时线）：**仍然成立**；`1/2048`（k = 11）才走 fallback。
 *   再细已无法画出可辨的减时线，与其画一堆线不如显式降级 + 诊断。
 *
 * 这是**产品决定，不是格式事实**：spec 未规定可渲染的时值上下界。
 */
const MAX_BASE_EXPONENT = 10;

function gcdBig(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function isPowerOfTwo(x: bigint): boolean {
  return x > 0n && (x & (x - 1n)) === 0n;
}

/** 前提：`x` 已是 2 的幂。 */
function log2Exact(x: bigint): number {
  return x.toString(2).length - 1;
}

/**
 * 试一个 dots 值：`base = d ÷ (2 − 2^-dots) = (num × 2^dots) / (den × (2^(dots+1) − 1))`。
 * 约分后若 `base` 是 2 的整数次幂则成功，返回其指数。
 */
function baseExponent(num: bigint, den: bigint, dots: DurationDots): number | undefined {
  const scale = 1n << BigInt(dots);
  const factor = (1n << BigInt(dots + 1)) - 1n;
  const rawNum = num * scale;
  const rawDen = den * factor;
  const g = gcdBig(rawNum, rawDen);
  const baseNum = rawNum / g;
  const baseDen = rawDen / g;

  if (baseDen === 1n && isPowerOfTwo(baseNum)) {
    return log2Exact(baseNum);
  }
  if (baseNum === 1n && isPowerOfTwo(baseDen)) {
    return -log2Exact(baseDen);
  }
  return undefined;
}

/** 前提：`exponent ∈ [-MAX_BASE_EXPONENT, 0]`，即 `base = 2^exponent ≤ 1`。 */
function baseFromExponent(exponent: number): Rational {
  return exponent === 0 ? fromParts(1, 1) : fromParts(1, Number(1n << BigInt(-exponent)));
}

/**
 * 把一个绝对音长分解为 `{ base, dots }` 及其视觉后果（减时线 / 延音线）。
 *
 * `dots` 取能成立的**最小**值：`3/8` 先试 dots=0（`3/8` 不是 2 的幂）再试 dots=1
 * （得 `1/4`，成功），因此结果是「四分音符 + 一个附点」而不是别的等价写法。
 */
export function decomposeDuration(duration: Rational): DurationDecomposition {
  // Domain 的 `Rational` 把 0 规范化为 `{ num: 0, den: 1 }`；0 与负时值都画不出音符，
  // 走同一条 fallback（确定性：同样返回 `unrepresentable` 并原样带回 duration）。
  if (duration.num <= 0) {
    return { kind: 'unrepresentable', duration };
  }

  const num = BigInt(duration.num);
  const den = BigInt(duration.den);

  for (const dots of DOTS) {
    const exponent = baseExponent(num, den, dots);
    if (exponent === undefined || exponent > 0 || exponent < -MAX_BASE_EXPONENT) {
      continue;
    }
    const beams = exponent < QUARTER_EXPONENT ? QUARTER_EXPONENT - exponent : 0;
    const dashes =
      exponent > QUARTER_EXPONENT ? Number(1n << BigInt(exponent - QUARTER_EXPONENT)) - 1 : 0;
    return { kind: 'glyph', base: baseFromExponent(exponent), dots, beams, dashes };
  }

  return { kind: 'unrepresentable', duration };
}
