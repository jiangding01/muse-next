/**
 * view 补丁 → source 补丁（`docs/M3_EDITOR_CORE_PLAN.md` §6.5–§6.7）。
 *
 * - view 区间按 `viewRangeToSourceRange` 换算：被删除的换行序列整体从 source 删除；被删除的登记占位符对应删除 CR。
 * - 插入文本中的 LF 按冻结的 dominant EOL 转换；插入的 U+240D 是普通字符（不进入占位符位置表）。
 * - 插入文本含 CR 时拒绝：view 中不存在 CR（输入层先把 CR / CRLF 规范为 LF）。
 * - 换算后的 source 补丁必须满足 §6.7 的源码不变量，否则整个补丁 Rejected。
 * - 未被补丁触及的换行序列与孤立 CR 一律原样保留（补丁之外的 source 字节逐一相等）。
 *
 * 交换律：对合法 view 补丁 `p`，`viewOf(apply(s, sourcePatch)) === applyPatch(viewOf(s), p)`（测试覆盖）。
 */

import { applyTextPatch, isPatchInRange } from '../text/apply';
import { checkSourcePatchInvariants } from '../text/sourceInvariants';
import type { SourceInvariantViolation } from '../text/sourceInvariants';
import type { TextPatch } from '../text/types';
import { buildProjection } from './build';
import { viewRangeToSourceRange } from './offsets';
import type { SourceProjection } from './types';

export type ViewPatchRejection = 'view-range-out-of-range' | 'view-text-contains-cr' | SourceInvariantViolation;

export type ViewPatchResult =
  | { readonly ok: true; readonly sourcePatch: TextPatch; readonly nextProjection: SourceProjection }
  | { readonly ok: false; readonly reason: ViewPatchRejection };

export function applyViewPatchToSource(projection: SourceProjection, viewPatch: TextPatch): ViewPatchResult {
  if (!isPatchInRange(projection.view, viewPatch)) return { ok: false, reason: 'view-range-out-of-range' };
  if (viewPatch.text.includes('\r')) return { ok: false, reason: 'view-text-contains-cr' };
  const range = viewRangeToSourceRange(projection, viewPatch);
  if (!range.ok) return { ok: false, reason: 'view-range-out-of-range' };

  const newline = projection.frame.dominantEol === 'crlf' ? '\r\n' : '\n';
  const sourcePatch: TextPatch = {
    start: range.range.start,
    end: range.range.end,
    text: viewPatch.text.split('\n').join(newline),
  };
  const check = checkSourcePatchInvariants(projection.source, sourcePatch, projection.protectedPrefixLength);
  if (!check.ok) return { ok: false, reason: check.reason };

  const applied = applyTextPatch(projection.source, sourcePatch);
  if (!applied.ok) return { ok: false, reason: 'view-range-out-of-range' };
  return { ok: true, sourcePatch, nextProjection: buildProjection(applied.text, projection.frame) };
}
