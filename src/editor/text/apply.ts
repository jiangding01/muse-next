/**
 * TextPatch 的应用与逆补丁（`docs/M3_EDITOR_CORE_PLAN.md` §9.2）。
 *
 * - 补丁区间非法属于调用方可触发的失败，返回带标签的拒绝结果，不抛异常。
 * - 逆补丁在应用时由被替换的原文机械生成；多补丁事务的逆补丁序列已按**逆序**排列，
 *   直接对结果文本顺序应用即可还原（`applyTextPatches(result.text, result.inverse)`）。
 */

import type { TextPatch } from './types';

export interface PatchOutOfRange {
  readonly ok: false;
  readonly reason: 'patch-out-of-range';
  /** 事务内出错补丁的下标（单补丁调用时为 0）。 */
  readonly patchIndex: number;
}

export type SinglePatchResult =
  | { readonly ok: true; readonly text: string; readonly inverse: TextPatch }
  | PatchOutOfRange;

export type PatchSequenceResult =
  | { readonly ok: true; readonly text: string; readonly inverse: readonly TextPatch[] }
  | PatchOutOfRange;

/** 补丁区间是否落在 `source` 内：整数、`0 ≤ start ≤ end ≤ source.length`。 */
export function isPatchInRange(source: string, patch: TextPatch): boolean {
  return (
    Number.isInteger(patch.start) &&
    Number.isInteger(patch.end) &&
    patch.start >= 0 &&
    patch.start <= patch.end &&
    patch.end <= source.length
  );
}

/** 应用单个补丁并给出它的逆补丁。 */
export function applyTextPatch(source: string, patch: TextPatch): SinglePatchResult {
  if (!isPatchInRange(source, patch)) return { ok: false, reason: 'patch-out-of-range', patchIndex: 0 };
  const text = source.slice(0, patch.start) + patch.text + source.slice(patch.end);
  const inverse: TextPatch = {
    start: patch.start,
    end: patch.start + patch.text.length,
    text: source.slice(patch.start, patch.end),
  };
  return { ok: true, text, inverse };
}

/**
 * 顺序应用一组补丁：第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本。
 * 任一补丁越界则整组拒绝（全有或全无），并报告出错补丁的下标。
 */
export function applyTextPatches(source: string, patches: readonly TextPatch[]): PatchSequenceResult {
  let text = source;
  const inverses: TextPatch[] = [];
  for (const [index, patch] of patches.entries()) {
    const applied = applyTextPatch(text, patch);
    if (!applied.ok) return { ok: false, reason: 'patch-out-of-range', patchIndex: index };
    text = applied.text;
    inverses.push(applied.inverse);
  }
  return { ok: true, text, inverse: inverses.reverse() };
}
