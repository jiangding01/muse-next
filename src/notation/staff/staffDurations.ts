/**
 * notation/staff —— 时值分解结果 → Staff 语义时值（M2 T7.1）。
 *
 * **输入形状的选择**（方案给出「`Rational | undefined` 或 `decomposeDuration` 的结果，
 * 二选一」）：本文件选 `Rational | undefined`——它与 `Note.duration` / `Rest.duration`
 * / `ChordEvent.duration` 等 Domain 字段的形状直接对应，调用方（T7.2+ 的事件节点构造）
 * 不需要先手动跑一遍 `decomposeDuration` 再传结果；内部仍然只调用
 * `decomposeDuration` 一次，不重复实现分解算法。
 *
 * `StaffDurationResult` 本身没有单独的「时值缺失」分支（`undefined` 与分解失败
 * 共享 `unrepresentable`）：`toStaffDuration` 只回答「这个时值能不能画出具体符头」，
 * 「缺失」与「不可表示」在诊断层面是两个不同事实（`durationUnresolved` vs
 * `durationUnrepresentable`，见 `model/diagnostics.ts`），但那是**调用方**依据
 * `duration === undefined` 这个事实自行选择诊断 code 的职责——本层不重复携带这份
 * 区分，避免类型形状膨胀成方案未要求的第四个分支。
 */

import type { Rational } from '../../domain';
import { decomposeDuration } from '../model/duration';
import type { StaffDurationBase, StaffDurationResult } from './staffTypes';

/**
 * `decomposeDuration` 分解结果的 `base` 落在「常规」范围（`k ∈ [0, 7]`）时，
 * 按下标 `k` 对应到 Staff 语义的时值名。数组下标即 `k`：`base = 2^-k`。
 * `k ∈ [8, 10]`（1/256、1/512、1/1024）不在本表内，走 `beyondGlyphRange`
 * （**产品决定**：glyph 范围上限收紧到 128th，T7.0 spike 之后若有需要可以放开）。
 */
const GLYPH_RANGE_BASES: readonly StaffDurationBase[] = [
  'whole',
  'half',
  'quarter',
  'eighth',
  'sixteenth',
  'thirtySecond',
  'sixtyFourth',
  'hundredTwentyEighth',
];

/**
 * 从 `decomposeDuration` 返回的 `base: Rational` 反推 `k`（`base = 2^-k`），
 * 或识别出 breve 单点例外（`base = 2/1`，`model/duration.ts` 的 `BREVE_EXPONENT`）。
 *
 * `decomposeDuration` 的契约保证 `base` 只会是 `1/2^k`（`k ∈ [0, 10]`）或 `2/1`
 * 两种形状之一，因此这里的循环必然在有限步内终止，不需要防御性的「找不到」分支。
 */
function exponentFromGlyphBase(base: Rational): number | 'breve' {
  if (base.num === 2 && base.den === 1) {
    return 'breve';
  }
  let remaining = base.den;
  let exponent = 0;
  while (remaining > 1) {
    remaining = remaining / 2;
    exponent += 1;
  }
  return exponent;
}

/**
 * 纯函数：`decomposeDuration` 本身全程整数运算、确定性；本函数只做一次额外的
 * `base → StaffDurationBase` 查表，同样是确定性的。
 */
export function toStaffDuration(duration: Rational | undefined): StaffDurationResult {
  if (duration === undefined) {
    return { kind: 'unrepresentable' };
  }

  const decomposed = decomposeDuration(duration);
  if (decomposed.kind === 'unrepresentable') {
    return { kind: 'unrepresentable' };
  }

  const exponent = exponentFromGlyphBase(decomposed.base);
  if (exponent === 'breve') {
    return { kind: 'representable', duration: { base: 'breve', dots: decomposed.dots } };
  }

  const base = GLYPH_RANGE_BASES[exponent];
  if (base === undefined) {
    // `exponent` ∈ [8, 10]（1/256、1/512、1/1024）：`decomposeDuration` 分解成立
    // （k 上限是 10，见 model/duration.ts 的 MAX_BASE_EXPONENT），但落在本层收紧的
    // glyph 范围（0..7，即 whole..128th）之外——这是这一分支的**正常**去处，不是
    // 「查不到就兜底」的防御性分支。
    return { kind: 'beyondGlyphRange', exponent };
  }

  return { kind: 'representable', duration: { base, dots: decomposed.dots } };
}
