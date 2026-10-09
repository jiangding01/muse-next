/**
 * 事务级源码不变量（`docs/M3_EDITOR_CORE_PLAN.md` §6.7）。
 *
 * 对一组顺序补丁（第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本，§9.2）逐个校验：
 * 区间合法 + `checkSourcePatchInvariants`。任一补丁违规则整个事务 Rejected（全有或全无），并报告补丁下标。
 * 可视化命令直接产生的 source 补丁与 view 补丁换算出的 source 补丁走同一套校验。
 */

import { applyTextPatch } from '../text/apply';
import { checkSourcePatchInvariants } from '../text/sourceInvariants';
import type { SourceInvariantViolation } from '../text/sourceInvariants';
import type { TextPatch } from '../text/types';

export type TransactionViolation = 'empty-transaction' | 'patch-out-of-range' | SourceInvariantViolation;

export type TransactionCheck =
  | { readonly ok: true; readonly text: string; readonly inverse: readonly TextPatch[] }
  | { readonly ok: false; readonly reason: TransactionViolation; readonly patchIndex: number };

export function checkSourceTransaction(
  source: string,
  patches: readonly TextPatch[],
  protectedPrefixLength: 0 | 1,
): TransactionCheck {
  if (patches.length === 0) return { ok: false, reason: 'empty-transaction', patchIndex: 0 };
  let text = source;
  const inverses: TextPatch[] = [];
  for (const [patchIndex, patch] of patches.entries()) {
    const applied = applyTextPatch(text, patch);
    if (!applied.ok) return { ok: false, reason: 'patch-out-of-range', patchIndex };
    const check = checkSourcePatchInvariants(text, patch, protectedPrefixLength);
    if (!check.ok) return { ok: false, reason: check.reason, patchIndex };
    text = applied.text;
    inverses.push(applied.inverse);
  }
  return { ok: true, text, inverse: inverses.reverse() };
}
