/**
 * DocumentSession 的派生状态（`docs/M3_EDITOR_CORE_PLAN.md` §7.1）。三者互不合并（F3），永不单独存储：
 *
 * - `sourceDirty ⇔ source !== saved.source`（undo 回到保存点即 clean，版本号不回退）；
 * - `parseStale ⇔ parsed.sourceVersion !== sourceVersion`（尚无快照也算过期）；
 * - `saveInFlight ⇔ fileOp?.kind ∈ { save, saveAs }`。
 *
 * `isFileOperationBusy`（M3 T4 B3a-1）：会话上有任何进行中的文件操作（`fileOp !== null`）。它只覆盖已捕获快照之后的阶段；
 * 捕获之前的整个准入期由 renderer 的准入租约（`fileIntentGate`）覆盖。
 */

import type { DocumentSession } from './types';

export function isSourceDirty(session: DocumentSession): boolean {
  return session.source !== session.saved.source;
}

export function isParseStale(session: DocumentSession): boolean {
  return session.parsed === null || session.parsed.sourceVersion !== session.sourceVersion;
}

export function isFileOperationBusy(session: DocumentSession): boolean {
  return session.fileOp !== null;
}

export function isSaveInFlight(session: DocumentSession): boolean {
  return session.fileOp?.kind === 'save' || session.fileOp?.kind === 'saveAs';
}
