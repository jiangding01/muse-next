/**
 * DocumentSession 的纯状态迁移（`docs/M3_EDITOR_CORE_PLAN.md` §7.2、§8.2、§9.2）。
 *
 * - `applySourceTransaction`：校验 `baseVersion === sourceVersion` 与源码不变量后应用整组顺序补丁；
 *   sourceVersion + 1（永不回退），投影按冻结 frame 重建，解析快照保持原样（因此变为过期），saved 不变。
 * - `acceptParsedSnapshot`：只接受 `(documentId, sourceVersion)` 都与当前会话一致的解析结果；
 *   跨文档的迟到结果与旧版本结果一律拒绝。
 *
 * 历史栈、合并规则与 undo / redo（T2）不在本文件；T2 复用 `applySourceTransaction` 应用逆补丁 / 原补丁。
 */

import { buildProjection } from '../projection/build';
import type { TextPatch } from '../text/types';
import { checkSourceTransaction } from './invariants';
import type { TransactionViolation } from './invariants';
import type { DocumentSession, ParsedSnapshot } from './types';

export interface SourceTransaction {
  /** 事务所基于的 sourceVersion。 */
  readonly baseVersion: number;
  /** 顺序补丁：第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本。 */
  readonly patches: readonly TextPatch[];
}

export type ApplyTransactionResult =
  | { readonly ok: true; readonly session: DocumentSession; readonly inverse: readonly TextPatch[] }
  | { readonly ok: false; readonly reason: 'base-version-mismatch' }
  | { readonly ok: false; readonly reason: TransactionViolation; readonly patchIndex: number };

export function applySourceTransaction(session: DocumentSession, transaction: SourceTransaction): ApplyTransactionResult {
  if (transaction.baseVersion !== session.sourceVersion) return { ok: false, reason: 'base-version-mismatch' };
  const checked = checkSourceTransaction(session.source, transaction.patches, session.projection.protectedPrefixLength);
  if (!checked.ok) return checked;
  return {
    ok: true,
    inverse: checked.inverse,
    session: {
      ...session,
      source: checked.text,
      sourceVersion: session.sourceVersion + 1,
      projection: buildProjection(checked.text, session.projection.frame),
    },
  };
}

export type AcceptParsedResult =
  | { readonly ok: true; readonly session: DocumentSession }
  | { readonly ok: false; readonly reason: 'document-mismatch' | 'version-mismatch' };

export function acceptParsedSnapshot(session: DocumentSession, snapshot: ParsedSnapshot): AcceptParsedResult {
  if (snapshot.documentId !== session.documentId) return { ok: false, reason: 'document-mismatch' };
  if (snapshot.sourceVersion !== session.sourceVersion) return { ok: false, reason: 'version-mismatch' };
  return { ok: true, session: { ...session, parsed: snapshot } };
}
