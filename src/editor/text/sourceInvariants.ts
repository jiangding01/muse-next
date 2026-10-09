/**
 * exact source 的补丁级不变量（`docs/M3_EDITOR_CORE_PLAN.md` §6.2、§6.3、§6.7）。
 *
 * 对**所有**补丁生效：SourceProjection 的 view 补丁换算出的 source 补丁，以及将来可视化命令直接产生的
 * source 补丁（session reducer 逐个补丁校验）。放在 text 层，供 projection 与 session 共用。
 *
 * 1. 受保护前缀不被触及：补丁起点 ≥ `protectedPrefixLength`。
 * 2. 没有受保护前缀时，结果的首字符不得是 U+FEFF（含插入与「删除首部使后面的 U+FEFF 前移」两种途径）。
 * 3. 不拆开已有 CRLF：补丁的起点或终点不得落在一个 CRLF 的 CR 与 LF 之间。
 * 4. 不合并出新的 CRLF：替换之后，补丁左右两条接缝处不得出现「CR 紧邻 LF」。
 *
 * 前提：补丁区间已经通过 `isPatchInRange`。
 */

import type { TextPatch } from './types';

export const BYTE_ORDER_MARK = '\uFEFF';

export type SourceInvariantViolation =
  | 'touches-protected-prefix'
  | 'creates-leading-feff'
  | 'splits-crlf'
  | 'merges-cr-lf';

export type SourceInvariantCheck = { readonly ok: true } | { readonly ok: false; readonly reason: SourceInvariantViolation };

const isInsideCrlf = (source: string, offset: number): boolean =>
  offset > 0 && source[offset - 1] === '\r' && source[offset] === '\n';

/** 校验一个补丁是否满足 exact source 不变量。 */
export function checkSourcePatchInvariants(
  source: string,
  patch: TextPatch,
  protectedPrefixLength: 0 | 1,
): SourceInvariantCheck {
  if (patch.start < protectedPrefixLength) return { ok: false, reason: 'touches-protected-prefix' };
  if (isInsideCrlf(source, patch.start) || isInsideCrlf(source, patch.end)) return { ok: false, reason: 'splits-crlf' };

  const before = patch.start > 0 ? source[patch.start - 1] : undefined;
  const after = source[patch.end];
  const firstOfRest = patch.text.length > 0 ? patch.text[0] : after;
  const lastOfHead = patch.text.length > 0 ? patch.text[patch.text.length - 1] : before;
  if ((before === '\r' && firstOfRest === '\n') || (lastOfHead === '\r' && after === '\n')) {
    return { ok: false, reason: 'merges-cr-lf' };
  }

  if (protectedPrefixLength === 0 && patch.start === 0 && firstOfRest === BYTE_ORDER_MARK) {
    return { ok: false, reason: 'creates-leading-feff' };
  }
  return { ok: true };
}
