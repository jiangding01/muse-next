/**
 * notation/layout —— 单个声部、单个 measure 切片的 **literal timing**（M2.5 T3 用户裁决 N1 / R6；
 * T3.5 用户裁决 Q1-a 从 `system/measureFeatures.ts` 原样下沉到 `layout/`）。
 *
 * 这是全仓**唯一的** literal onset 累计实现，T2（`sliceTotal`）/ T3（shared timeline）/
 * T3.5（beam 分组）共用。下沉的唯一原因是依赖方向：记谱目录（tab / jianpu）按 §B.2 只能
 * import `system/contracts`，而 `layout/` 对所有记谱开放；`system/measureFeatures.ts` 保留
 * re-export 转接，T2 / T3 的语义、调用点与测试逐字段不变。
 */

import type { Rational } from '../../domain';
import { ZERO, add } from '../../domain';
import { eventTiming } from './eventTiming';
import type { MeasureSlice } from './systems';

export type UnresolvedReason = 'duration-undefined' | 'arithmetic-overflow';

/** 一个 timed 事件在本切片内的绝对 onset（`itemIndex` = 在 `slice.items` 中的下标）。 */
export interface LocalTimedOnset {
  readonly itemIndex: number;
  readonly onset: Rational;
  readonly duration: Rational;
}

/** 一个 `chordSymbol` 的 zero-time overlay onset（= 当时的累计时值，不推进时间）。 */
export interface LocalOverlayOnset {
  readonly itemIndex: number;
  readonly onset: Rational;
}

/** voice-local 的 literal timing（T2 / T3 / T3.5 共用；不判 tuplet，tuplet 由调用层结合 `Voice.tuplets`）。 */
export type VoiceMeasureOnsets =
  | {
      readonly resolved: true;
      readonly total: Rational;
      readonly timed: readonly LocalTimedOnset[];
      readonly overlays: readonly LocalOverlayOnset[];
    }
  | { readonly resolved: false; readonly reason: UnresolvedReason };

/**
 * **唯一的 literal timing 累计实现**（用户裁决 N1）：从 `ZERO` 起按 `slice.items` 顺序，timed 事件
 * `onset = off; off = add(off, duration)`；`chordSymbol` 只记 `onset = off`、不推进；barline /
 * decoration / grace / unknown 不进入 timing。全程绝对 `Rational`，零浮点、零比例。遇到第一个
 * `duration === undefined` 即 `duration-undefined`；只捕获 `add` 的 `RangeError`（统称
 * `arithmetic-overflow`：越过安全整数或不变式被破坏），其它异常照抛。
 */
export function voiceMeasureOnsets(slice: MeasureSlice): VoiceMeasureOnsets {
  let off: Rational = ZERO;
  const timed: LocalTimedOnset[] = [];
  const overlays: LocalOverlayOnset[] = [];
  for (const [itemIndex, item] of slice.items.entries()) {
    const timing = eventTiming(item.event);
    if (!timing.timed) {
      if (item.event.kind === 'chordSymbol') {
        overlays.push({ itemIndex, onset: off });
      }
      continue;
    }
    if (timing.duration === undefined) {
      return { resolved: false, reason: 'duration-undefined' };
    }
    try {
      const next = add(off, timing.duration);
      timed.push({ itemIndex, onset: off, duration: timing.duration });
      off = next;
    } catch (error) {
      if (error instanceof RangeError) {
        return { resolved: false, reason: 'arithmetic-overflow' };
      }
      throw error;
    }
  }
  return { resolved: true, total: off, timed, overlays };
}
