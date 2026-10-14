/**
 * Unified History 的纯状态迁移（`docs/M3_EDITOR_CORE_PLAN.md` §7.2、§9.2–§9.4、§17.3；M3 T2 Preflight r3 §6）。
 *
 * - 所有 source 变化都经 T0 `applySourceTransaction`：新事务用调用方的 baseVersion（校验失配）；undo / redo 用**当前**
 *   sourceVersion（满足 reducer 的版本要求），正确性来自「栈顶事务的结果文本恒等于 headSource」与 headSource 的精确比较，
 *   历史上的 baseVersion 不参与判断；源码不变量照常由 reducer 重新校验。
 * - 失败时不返回任何新的 session / history / selection；对合法会话不抛异常。
 * - History 不存 dirty，也不读写 saved（dirty 由 `source !== saved.source` 派生）。
 */

import { applySourceTransaction } from '../session/reducer';
import type { DocumentSession } from '../session/types';
import type { EditorSelection, PersistedSelection } from '../selection/types';
import { advanceGroup, canCoalesce, composeTransactions, openGroup } from './coalesce';
import { candidateSelectionAfter, intentShapeValid, sameSelection, selectionFitsSource, toPersistedSelection } from './selection';
import { push, replaceTop } from './stack';
import type { CommitInput, CommitResult, HistoryFailureReason, HistoryOptions, HistoryState, HistoryStepResult, HistoryTransaction } from './types';

/** D3：合并窗口约 1 秒。 */
export const DEFAULT_HISTORY_OPTIONS: HistoryOptions = Object.freeze({ coalesceWindowMs: 1000 });

export function createHistory(session: DocumentSession): HistoryState {
  return Object.freeze({ documentId: session.documentId, headVersion: session.sourceVersion, headSource: session.source, undo: null, redo: null, open: null });
}

/** 绑定校验：同一文档，且自上次 History 操作以来没有绕过 History 的写入（版本与文本都一致）。 */
function bindingFailure(session: DocumentSession, history: HistoryState): HistoryFailureReason | null {
  if (history.documentId !== session.documentId) return 'document-mismatch';
  if (history.headVersion !== session.sourceVersion || history.headSource !== session.source) return 'history-out-of-sync';
  return null;
}

const runtimeSelection = (selection: PersistedSelection, basisVersion: number): EditorSelection => ({
  ...toPersistedSelection(selection),
  basisVersion,
});

function withHead(history: HistoryState, session: DocumentSession, patch: Pick<HistoryState, 'undo' | 'redo' | 'open'>): HistoryState {
  return Object.freeze({ documentId: history.documentId, headVersion: session.sourceVersion, headSource: session.source, ...patch });
}

export function commitTransaction(
  session: DocumentSession,
  history: HistoryState,
  input: CommitInput,
  options: HistoryOptions = DEFAULT_HISTORY_OPTIONS,
): CommitResult {
  const binding = bindingFailure(session, history);
  if (binding !== null) return { ok: false, reason: binding };
  if (input.selection.basisVersion !== session.sourceVersion) return { ok: false, reason: 'stale-selection' };
  const before = toPersistedSelection(input.selection);
  if (!selectionFitsSource(before, session.source.length)) return { ok: false, reason: 'selection-out-of-range' };
  const intent = input.selectionIntent;
  if (intent !== undefined && !intentShapeValid(intent)) return { ok: false, reason: 'invalid-selection-intent' };

  // 版本、补丁范围、源码不变量与空补丁序列全部在这里由 T0 校验；任何非法补丁都到不了下面的无变化分支。
  const applied = applySourceTransaction(session, { baseVersion: input.baseVersion, patches: input.patches });
  if (!applied.ok) return applied;
  const next = applied.session;

  if (intent !== undefined && intent.range.end > next.source.length) return { ok: false, reason: 'invalid-selection-intent' };
  const after = candidateSelectionAfter(before, input.patches, intent, input.origin);
  if (after === 'invalid' || !selectionFitsSource(after, next.source.length)) return { ok: false, reason: 'selection-out-of-range' };

  if (next.source === session.source) {
    // 无变化（Q4 / R3-H2）：不入栈、不清 redo、版本不变；选中按候选更新，选中变化时结束当前合并组。
    if (sameSelection(after, before)) return { ok: true, changed: false, session, history, selection: input.selection };
    const ended = history.open === null ? history : Object.freeze({ ...history, open: null });
    return { ok: true, changed: false, session, history: ended, selection: runtimeSelection(after, session.sourceVersion) };
  }

  const tx: HistoryTransaction = Object.freeze({
    baseVersion: input.baseVersion,
    patches: Object.freeze(input.patches.map((patch) => Object.freeze({ start: patch.start, end: patch.end, text: patch.text }))),
    inverse: Object.freeze(applied.inverse.map((patch) => Object.freeze({ start: patch.start, end: patch.end, text: patch.text }))),
    selectionBefore: before,
    selectionAfter: after,
    label: input.label,
    coalesceKey: input.coalesceKey ?? null,
    origin: input.origin,
  });
  const selection = runtimeSelection(after, next.sourceVersion);

  const top = history.undo?.top;
  if (history.undo !== null && top !== undefined && history.open !== null && input.coalesce !== null && canCoalesce(history.open, top, input, before, tx, options)) {
    const merged = composeTransactions(top, tx, history.open.kind);
    if (merged !== null) {
      const open = advanceGroup(history.open, input.coalesce.timestamp, tx);
      return { ok: true, changed: true, session: next, history: withHead(history, next, { undo: replaceTop(history.undo, merged), redo: null, open }), selection, merged: true };
    }
  }
  const open = openGroup(input, before, tx);
  return { ok: true, changed: true, session: next, history: withHead(history, next, { undo: push(history.undo, tx), redo: null, open }), selection, merged: false };
}

export function undo(session: DocumentSession, history: HistoryState): HistoryStepResult {
  const binding = bindingFailure(session, history);
  if (binding !== null) return { ok: false, reason: binding };
  if (history.undo === null) return { ok: false, reason: 'nothing-to-undo' };
  const tx = history.undo.top;
  const applied = applySourceTransaction(session, { baseVersion: session.sourceVersion, patches: tx.inverse });
  if (!applied.ok) return { ok: false, reason: 'history-corrupt' };
  return {
    ok: true,
    session: applied.session,
    history: withHead(history, applied.session, { undo: history.undo.rest, redo: push(history.redo, tx), open: null }),
    selection: runtimeSelection(tx.selectionBefore, applied.session.sourceVersion),
  };
}

export function redo(session: DocumentSession, history: HistoryState): HistoryStepResult {
  const binding = bindingFailure(session, history);
  if (binding !== null) return { ok: false, reason: binding };
  if (history.redo === null) return { ok: false, reason: 'nothing-to-redo' };
  const tx = history.redo.top;
  const applied = applySourceTransaction(session, { baseVersion: session.sourceVersion, patches: tx.patches });
  if (!applied.ok) return { ok: false, reason: 'history-corrupt' };
  return {
    ok: true,
    session: applied.session,
    history: withHead(history, applied.session, { undo: push(history.undo, tx), redo: history.redo.rest, open: null }),
    selection: runtimeSelection(tx.selectionAfter, applied.session.sourceVersion),
  };
}

/** blur、光标跳转、选区改变、IME 开始、Save 开始时由调用方调用；没有打开的组时返回同一对象。 */
export function endCoalescing(history: HistoryState): HistoryState {
  return history.open === null ? history : Object.freeze({ ...history, open: null });
}

export const canUndo = (history: HistoryState): boolean => history.undo !== null;
export const canRedo = (history: HistoryState): boolean => history.redo !== null;
export const undoLabel = (history: HistoryState): string | null => history.undo?.top.label ?? null;
export const redoLabel = (history: HistoryState): string | null => history.redo?.top.label ?? null;
