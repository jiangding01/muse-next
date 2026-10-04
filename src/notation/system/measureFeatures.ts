/**
 * notation/system —— 单个 measure 切片的结构特征（M2.5 T2 / T2.1；纯函数，从 `measureIdentity.ts`
 * 抽出以守住其行数预算）。只描述**一个声部自己的切片**，不做任何跨声部判定：
 * - S1 `trailingBarline`：收尾小节线 raw，tail 时缺席；
 * - S2 `isIsolatedLine`：只含一根小节线的 measure；
 * - `voiceMeasureOnsets`：voice-local literal timing（唯一的时值累计实现，T2 / T3 / T3.5 共用；
 *   T3.5 用户裁决 Q1-a 起实现住在 `layout/measureOnsets.ts`，本文件只 re-export）；
 * - S3 `sliceTotal`：它的纯投影——timed 事件的绝对 `Rational` 时值总量，不可知时保留原因；
 * - `hasTimedEvent`：是否含 timed 事件（desync latch 判据，用户裁决 P2-4-b）。
 */

import type { Rational } from '../../domain';
import { eventTiming } from '../layout/eventTiming';
import type { UnresolvedReason } from '../layout/measureOnsets';
import { voiceMeasureOnsets } from '../layout/measureOnsets';
import type { MeasureSlice } from '../layout/systems';

export type {
  LocalOverlayOnset,
  LocalTimedOnset,
  UnresolvedReason,
  VoiceMeasureOnsets,
} from '../layout/measureOnsets';
export { voiceMeasureOnsets } from '../layout/measureOnsets';

/** S3：measure 内 timed 事件的绝对时值总量；不可知时保留原因（裁决 G）。 */
export type SliceTotal =
  | { readonly resolved: true; readonly value: Rational }
  | { readonly resolved: false; readonly reason: UnresolvedReason };

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
