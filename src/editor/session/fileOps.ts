/**
 * 文件操作与保存检查点的纯函数（`docs/M3_EDITOR_CORE_PLAN.md` §7.1–§7.3、§12.2、§20，M3 T4 B1；Gate B1 C1）。
 *
 * - `fileOp` 保持 T0 类型 `{ kind }` 不变（不加 token）。「这一次操作」由**对象引用**识别：`beginFileOperation`
 *   每次都新建对象，结束 / 接受结果时要求 `session.fileOp === op`；结构相等的另一个对象不被接受（防 ABA）。
 * - 检查点只在保存成功后前移，内容是**捕获并写入**的 source，而不是当前 source（保存期间继续输入后仍 dirty）。
 * - 这里只改 `saved` / `fileOp`（Save As 另改文件四项事实），绝不改 source / sourceVersion / projection / parsed；
 *   会话的其余字段一律取自传入的当前会话。
 * - 拒绝时返回 `{ ok: false, reason }`，调用方据此丢弃迟到结果；不抛异常。
 */

import type { ByteBom, EncodingRoundTrip, FileReference } from '../../shared/documentContracts';
import type { JcxEncoding } from '../../formats/jcxParse';
import type { DocumentSession, FileOperation, FileOperationKind } from './types';

export type FileOpRejection = 'file-op-busy' | 'document-mismatch' | 'not-current-operation' | 'kind-mismatch';

export type FileOpResult =
  | { readonly ok: true; readonly session: DocumentSession; readonly op: FileOperation }
  | { readonly ok: false; readonly reason: FileOpRejection };

export type FileOpSettleResult = { readonly ok: true; readonly session: DocumentSession } | { readonly ok: false; readonly reason: FileOpRejection };

/** Save As 成功时随检查点一起切换的文件事实（§7.2 Save As 成功行）。 */
export interface SavedAsFacts {
  readonly file: FileReference;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
}

/** 开始一次文件操作：已有进行中的操作即拒绝（§20「fileOp 串行化」）。返回的 `op` 是新建对象，用作之后的 CAS 依据。 */
export function beginFileOperation(session: DocumentSession, kind: FileOperationKind): FileOpResult {
  if (session.fileOp !== null) return { ok: false, reason: 'file-op-busy' };
  const op: FileOperation = { kind };
  return { ok: true, session: { ...session, fileOp: op }, op };
}

function checkCurrent(session: DocumentSession, documentId: number, op: FileOperation, kind: FileOperationKind | null): FileOpRejection | null {
  if (session.documentId !== documentId) return 'document-mismatch';
  if (session.fileOp !== op) return 'not-current-operation';
  if (kind !== null && op.kind !== kind) return 'kind-mismatch';
  return null;
}

/** 失败 / 被拒 / 取消：只清除 `fileOp`，其余全部不变（§7.2）。只清除「这一次」操作。 */
export function finishFileOperation(session: DocumentSession, documentId: number, op: FileOperation): FileOpSettleResult {
  const rejection = checkCurrent(session, documentId, op, null);
  if (rejection !== null) return { ok: false, reason: rejection };
  return { ok: true, session: { ...session, fileOp: null } };
}

/** 普通 Save 成功：`saved.source` 前移到本次捕获并写入的文本；writeEncoding 等不变（§7.2、§12.2）。 */
export function acceptSaveSuccess(session: DocumentSession, documentId: number, op: FileOperation, capturedSource: string): FileOpSettleResult {
  const rejection = checkCurrent(session, documentId, op, 'save');
  if (rejection !== null) return { ok: false, reason: rejection };
  return { ok: true, session: { ...session, saved: { source: capturedSource }, fileOp: null } };
}

/** Save As 成功：检查点与 file / writeEncoding / byteBom / encodingRoundTrip 同时更新（§7.2、§12.1 A8）。 */
export function acceptSaveAsSuccess(
  session: DocumentSession,
  documentId: number,
  op: FileOperation,
  capturedSource: string,
  facts: SavedAsFacts,
): FileOpSettleResult {
  const rejection = checkCurrent(session, documentId, op, 'saveAs');
  if (rejection !== null) return { ok: false, reason: rejection };
  return {
    ok: true,
    session: {
      ...session,
      saved: { source: capturedSource },
      file: facts.file,
      writeEncoding: facts.writeEncoding,
      byteBom: facts.byteBom,
      encodingRoundTrip: facts.encodingRoundTrip,
      fileOp: null,
    },
  };
}
