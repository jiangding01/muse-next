/**
 * notation/system —— 单个 measure 切片的结构特征（M2.5 T2 / T2.1；纯函数，从 `measureIdentity.ts`
 * 抽出以守住其行数预算）。只描述**一个声部自己的切片**，不做任何跨声部判定：
 * - S1 `trailingBarline`：收尾小节线 raw，tail 时缺席；
 * - S2 `isIsolatedLine`：只含一根小节线的 measure；
 * - `voiceMeasureOnsets`：voice-local literal timing（唯一的时值累计实现，T2 / T3 / T3.5 共用）；
 * - S3 `sliceTotal`：它的纯投影——timed 事件的绝对 `Rational` 时值总量，不可知时保留原因；
 * - `hasTimedEvent`：是否含 timed 事件（desync latch 判据，用户裁决 P2-4-b）。
 */

import type { Rational } from '../../domain';
import { ZERO, add } from '../../domain';
import type { MeasureSlice } from '../layout/systems';
import { eventTiming } from './timedDuration';

/** S3：measure 内 timed 事件的绝对时值总量；不可知时保留原因（裁决 G）。 */
export type SliceTotal =
  | { readonly resolved: true; readonly value: Rational }
  | { readonly resolved: false; readonly reason: UnresolvedReason };

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

/** S3 = `voiceMeasureOnsets` 的纯投影（不另有累计循环）。 */
export function sliceTotal(slice: MeasureSlice): SliceTotal {
  const onsets = voiceMeasureOnsets(slice);
  return onsets.resolved ? { resolved: true, value: onsets.total } : { resolved: false, reason: onsets.reason };
}

/** S1：最后一项是小节线时取其 raw；否则缺席（tail）。 */
export function trailingBarline(slice: MeasureSlice): string | undefined {
  const last = slice.items[slice.items.length - 1];
  return last !== undefined && last.event.kind === 'barline' ? last.event.raw : undefined;
}

/** S2：只含一根小节线的 measure（开头孤立 barline 的形态）。 */
export function isIsolatedLine(slice: MeasureSlice): boolean {
  const [only] = slice.items;
  return slice.items.length === 1 && only !== undefined && only.event.kind === 'barline';
}

/**
 * 切片内至少有一个 `eventTiming(...).timed === true` 的事件（不看 duration 是否已知、总量是否为正）。
 * desync latch 只在「孤立小节线 vs 含 timed 事件的小节」时触发；只有 untimed 内容的零时值小节不锁存。
 */
export function hasTimedEvent(slice: MeasureSlice): boolean {
  return slice.items.some((item) => eventTiming(item.event).timed);
}
