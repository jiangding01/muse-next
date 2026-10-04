/**
 * notation/system —— 单个 measure 切片的结构特征（M2.5 T2 / T2.1；纯函数，从 `measureIdentity.ts`
 * 抽出以守住其行数预算）。只描述**一个声部自己的切片**，不做任何跨声部判定：
 * - S1 `trailingBarline`：收尾小节线 raw，tail 时缺席；
 * - S2 `isIsolatedLine`：只含一根小节线的 measure；
 * - S3 `sliceTotal`：timed 事件的绝对 `Rational` 时值总量（零浮点、零比例），不可知时保留原因；
 * - `hasTimedEvent`：是否含 timed 事件（desync latch 判据，用户裁决 P2-4-b）。
 */

import type { Rational } from '../../domain';
import { ZERO, add } from '../../domain';
import type { MeasureSlice } from '../layout/systems';
import { eventTiming } from './timedDuration';

/** S3：measure 内 timed 事件的绝对时值总量；不可知时保留原因（裁决 G）。 */
export type SliceTotal =
  | { readonly resolved: true; readonly value: Rational }
  | { readonly resolved: false; readonly reason: 'duration-undefined' | 'arithmetic-overflow' };

/** S3。只捕获 `RangeError`、其它照抛；`arithmetic-overflow` 统称 `add` 拒绝（越过安全整数或不变式被破坏）。 */
export function sliceTotal(slice: MeasureSlice): SliceTotal {
  let value: Rational = ZERO;
  for (const item of slice.items) {
    const timing = eventTiming(item.event);
    if (!timing.timed) {
      continue;
    }
    if (timing.duration === undefined) {
      return { resolved: false, reason: 'duration-undefined' };
    }
    try {
      value = add(value, timing.duration);
    } catch (error) {
      if (error instanceof RangeError) {
        return { resolved: false, reason: 'arithmetic-overflow' };
      }
      throw error;
    }
  }
  return { resolved: true, value };
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
