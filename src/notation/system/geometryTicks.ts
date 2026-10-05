/**
 * notation/system —— T4 operational geometry 的整数网格（M2.5 T4，用户裁决 I-a，2026-10-05）。
 *
 * 1 tick = `SYSTEM_METRICS.geometryQuantum`（2⁻¹⁰ unit，数值稳定性量化网格，**不是视觉 metric**）。
 * demand / 预留**向上**、可用宽**向下**取整到网格；packing、water-filling、段分配、x 累计全部是整数 tick，
 * 只在产出 `SystemMeasureGeometry` 时换回 unit（`ticks × quantum`，二进制精确）。这样 full 行
 * `Σ widthTicks === availableContentTicks` 在整数级严格成立，不会出现 799.9999999997。
 */

import { SYSTEM_METRICS } from '../layout/metrics';

const TICKS_PER_UNIT = 1 / SYSTEM_METRICS.geometryQuantum;

/** 需求 / 预留 → tick（向上取整：量化后仍 ≥ 原始值）。负值与非有限值按 0。 */
export function ceilTicks(units: number): number {
  return Number.isFinite(units) && units > 0 ? Math.ceil(units * TICKS_PER_UNIT) : 0;
}

/**
 * 可用宽 → tick（向下取整：量化后仍 ≤ 原始值，不会排出容器）。负值与非有限值按 0——包括 `Infinity`：此时每个
 * measure 各占一行（与 `layoutSystems` 的「无限宽 = 一行」相反）；调用方从不传无限宽，这里只求不出 NaN。
 */
export function floorTicks(units: number): number {
  return Number.isFinite(units) && units > 0 ? Math.floor(units * TICKS_PER_UNIT) : 0;
}

export function unitsOf(ticks: number): number {
  return ticks * SYSTEM_METRICS.geometryQuantum;
}

/**
 * 把 `extra` 个 tick 按 `weights` 成比例分出去，返回与 `weights` 同长的整数数组，**和恰为 `extra`**。
 *
 * 每项先取精确份额 `extra × wᵢ / Σw` 的下取整（BigInt，乘积越过 2⁵³ 也精确）；余下 `r` 个 tick 按下标顺序
 * 逐个补给「精确份额有小数部分」的项——这样的项至少有 `r + 1` 个（小数部分之和恰为 `r` 且每个 < 1），
 * 所以每项最终都 ≤ 精确份额的上取整，调用方据此保证不越过 cap。`Σw === 0` 时（防御性，正常不可达）
 * 全部给最后一项。纯函数、确定性。**前提**：`extra` 与 `weights` 都是整数 tick（非整数会被 `BigInt` 拒绝）。
 */
export function distributeTicks(extra: number, weights: readonly number[]): number[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (extra <= 0 || weights.length === 0) return weights.map(() => 0);
  if (total <= 0) return weights.map((_, i) => (i === weights.length - 1 ? extra : 0));
  const e = BigInt(extra);
  const t = BigInt(total);
  const products = weights.map((weight) => e * BigInt(weight));
  const shares = products.map((product) => Number(product / t));
  let remainder = extra - shares.reduce((sum, share) => sum + share, 0);
  return shares.map((share, i) => {
    if (remainder > 0 && (products[i] ?? 0n) % t !== 0n) {
      remainder -= 1;
      return share + 1;
    }
    return share;
  });
}
