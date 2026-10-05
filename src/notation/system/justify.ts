/**
 * notation/system —— 行内两端对齐（M2.5 T4，方案 §Q4.5 water-filling + F-3；用户裁决 I-a，2026-10-05）。
 *
 * 全部在整数 tick 上进行（`geometryTicks.ts`），输入是**内容**需求（不含行首预留：预留不参与 justify / cap，
 * 由 composer 加到行首 measure 上）。按 demand 比例分配，**不按时值、不按拍、不均分**：
 *
 * - 末行（含 group 唯一一行）、`Σdemand === 0`、剩余宽 `< minJustifySlack`（含 ≤ 0）→ `'none'`，宽 = 需求；
 * - 否则 water-filling：把剩余宽按 `demand` 比例分给未触顶的 measure；会越过
 *   `cap = ⌊demand × maxJustifyRatio⌋` 的固定在 cap、移出、把没吃下的量留给其余 measure 重新分配；
 *   直到没有新的触顶（每轮至少固定一个，必然终止）。收敛且仍有未触顶的 → `'full'`，`Σ宽 === 内容可用宽`
 *   **整数级严格成立**；全部触顶仍有剩余 → `'partial'`，右侧留白。「有一个触顶就算 partial」不成立。
 * - 触顶判定用精确有理比较（BigInt 交叉乘），最终份额用 `distributeTicks`（每项 ≤ 精确份额上取整，
 *   因此不会越过 cap）。
 *
 * `distributeMeasure` 把一个 measure 的终宽按各分量（lead / 段 / tail）自身需求比例分回去（§Q4.5「measure
 * 内部段宽同样按 segWidth 成比例放大」），和恰等于终宽、每个分量 ≥ 其需求。
 */

import { SYSTEM_METRICS } from '../layout/metrics';
import type { JustifyState } from './contracts';
import { ceilTicks, distributeTicks } from './geometryTicks';

export interface LineJustification {
  /** 每个 measure 的内容宽（tick），与输入同序。 */
  readonly widths: readonly number[];
  readonly justified: JustifyState;
}

const MIN_SLACK_TICKS = ceilTicks(SYSTEM_METRICS.minJustifySlack);

/** 单个 measure 的拉伸上限：`⌊demand × maxJustifyRatio⌋`（1.5 时即 `⌊demand × 3 / 2⌋`，整数精确）。 */
export function justifyCap(demandTicks: number): number {
  return Math.floor(demandTicks * SYSTEM_METRICS.maxJustifyRatio);
}

/**
 * 一行的 water-filling。`mayJustify === false` 表示策略上不拉（末行 / 唯一一行，F-3）。纯函数，不改输入。
 * **前提**：`demands` 与 `contentTicks` 都是非负整数 tick（由 `geometryTicks.ts` 量化得到）。
 */
export function justifyLine(demands: readonly number[], contentTicks: number, mayJustify: boolean): LineJustification {
  const total = demands.reduce((sum, demand) => sum + demand, 0);
  const slack0 = contentTicks - total;
  if (!mayJustify || total === 0 || slack0 < MIN_SLACK_TICKS) return { widths: [...demands], justified: 'none' };

  const widths = [...demands];
  let slack = slack0;
  let free = demands.flatMap((demand, i) => (demand > 0 ? [i] : []));
  for (;;) {
    const weight = free.reduce((sum, i) => sum + (demands[i] ?? 0), 0);
    if (free.length === 0 || weight === 0) return { widths, justified: 'partial' };
    const fs = BigInt(weight);
    const s = BigInt(slack);
    // 精确比较：d + slack·d/Σ > cap  ⇔  d·Σ + slack·d > cap·Σ。
    const over = free.filter((i) => {
      const d = BigInt(demands[i] ?? 0);
      return d * fs + s * d > BigInt(justifyCap(demands[i] ?? 0)) * fs;
    });
    if (over.length === 0) {
      const shares = distributeTicks(slack, free.map((i) => demands[i] ?? 0));
      free.forEach((i, k) => {
        widths[i] = (widths[i] ?? 0) + (shares[k] ?? 0);
      });
      return { widths, justified: 'full' };
    }
    for (const i of over) {
      const cap = justifyCap(demands[i] ?? 0);
      slack -= cap - (widths[i] ?? 0);
      widths[i] = cap;
    }
    free = free.filter((i) => !over.includes(i));
  }
}

/**
 * 把一个 measure 的内容终宽 `finalTicks`（≥ 各分量之和）按分量自身需求比例分回各分量：
 * 返回值与 `components` 同长，`Σ === finalTicks`，每项 ≥ 原分量。
 */
export function distributeMeasure(components: readonly number[], finalTicks: number): readonly number[] {
  const base = components.reduce((sum, part) => sum + part, 0);
  const extra = distributeTicks(Math.max(0, finalTicks - base), components);
  return components.map((part, i) => part + (extra[i] ?? 0));
}
