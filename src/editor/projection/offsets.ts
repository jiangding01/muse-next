/**
 * exact source 与 editor view 之间的偏移 / 区间映射（`docs/M3_EDITOR_CORE_PLAN.md` §6.5）。
 *
 * - 只有 CRLF 改变长度（source 2 个 code unit → view 1 个 LF）；孤立 CR ↔ 占位符、LF ↔ LF 都是 1 : 1。
 * - view 偏移 0 映射到受保护前缀之后；source 偏移落在受保护前缀内（含其末端）时映射到 view 偏移 0。
 * - source 偏移落在 CRLF 中间（CR 与 LF 之间）时，取该换行在 view 中的位置。
 * - `sourceOffsetToViewOffset ∘ viewOffsetToSourceOffset` 在 view 偏移上是恒等（测试覆盖）。
 */

import type { SourceRange } from '../text/types';
import type { SourceProjection } from './types';

export type OffsetResult =
  | { readonly ok: true; readonly offset: number }
  | { readonly ok: false; readonly reason: 'offset-out-of-range' };

export type RangeResult =
  | { readonly ok: true; readonly range: SourceRange }
  | { readonly ok: false; readonly reason: 'range-out-of-range' };

/** 第 k 个 CRLF 在 view 中对应 LF 的位置。 */
const crlfViewOffset = (projection: SourceProjection, k: number): number =>
  (projection.crlfSourceStarts[k] ?? 0) - projection.protectedPrefixLength - k;

/** 满足 `predicate(k)` 的最小 k（谓词对 k 单调：前假后真）；全假时返回数组长度。 */
function firstIndex(count: number, predicate: (k: number) => boolean): number {
  let low = 0;
  let high = count;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (predicate(mid)) high = mid;
    else low = mid + 1;
  }
  return low;
}

const isOffset = (value: number, max: number): boolean => Number.isInteger(value) && value >= 0 && value <= max;

export function viewOffsetToSourceOffset(projection: SourceProjection, viewOffset: number): OffsetResult {
  if (!isOffset(viewOffset, projection.view.length)) return { ok: false, reason: 'offset-out-of-range' };
  const count = projection.crlfSourceStarts.length;
  const crlfBefore = firstIndex(count, (k) => crlfViewOffset(projection, k) >= viewOffset);
  return { ok: true, offset: viewOffset + projection.protectedPrefixLength + crlfBefore };
}

export function sourceOffsetToViewOffset(projection: SourceProjection, sourceOffset: number): OffsetResult {
  if (!isOffset(sourceOffset, projection.source.length)) return { ok: false, reason: 'offset-out-of-range' };
  if (sourceOffset <= projection.protectedPrefixLength) return { ok: true, offset: 0 };
  const starts = projection.crlfSourceStarts;
  const fullyBefore = firstIndex(starts.length, (k) => (starts[k] ?? 0) + 2 > sourceOffset);
  if (starts[fullyBefore] === sourceOffset - 1) return { ok: true, offset: crlfViewOffset(projection, fullyBefore) };
  return { ok: true, offset: sourceOffset - projection.protectedPrefixLength - fullyBefore };
}

/** view 区间 → source 区间：覆盖整个换行的 view 区间映射为整个换行序列。 */
export function viewRangeToSourceRange(projection: SourceProjection, viewRange: SourceRange): RangeResult {
  if (viewRange.start > viewRange.end) return { ok: false, reason: 'range-out-of-range' };
  const start = viewOffsetToSourceOffset(projection, viewRange.start);
  const end = viewOffsetToSourceOffset(projection, viewRange.end);
  if (!start.ok || !end.ok) return { ok: false, reason: 'range-out-of-range' };
  return { ok: true, range: { start: start.offset, end: end.offset } };
}

/** source 区间 → view 区间（端点各自按 `sourceOffsetToViewOffset` 映射）。 */
export function sourceRangeToViewRange(projection: SourceProjection, sourceRange: SourceRange): RangeResult {
  if (sourceRange.start > sourceRange.end) return { ok: false, reason: 'range-out-of-range' };
  const start = sourceOffsetToViewOffset(projection, sourceRange.start);
  const end = sourceOffsetToViewOffset(projection, sourceRange.end);
  if (!start.ok || !end.ok) return { ok: false, reason: 'range-out-of-range' };
  return { ok: true, range: { start: start.offset, end: end.offset } };
}
