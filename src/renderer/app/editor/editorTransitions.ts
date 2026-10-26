/**
 * 编辑器核心状态的纯迁移（M3 T3a；T3 Preflight r3 §4.1–§4.6；纯逻辑）。
 *
 * - 把 T0 会话、T2 History 与运行时选中视为一组 `EditorCore`，每个函数返回整组的新值或拒绝原因，由 store 一次写入。
 * - 源码输入：view 补丁经 T0 `applyViewPatchToSource` 换算成 source 补丁，再经 T2 `commitTransaction` 提交；本模块不直接
 *   调用 `applySourceTransaction`（m3t2 守卫），不读 DOM、不做全文 diff。
 * - undo / redo 只包装 T2 的 `undo` / `redo`；选区变化（非编辑）结束合并组。
 * - T3 只产生 `none` 与 `source` 两种选中；`source` 选中一律使用 `DEFAULT_RANGE_BIAS`，永不产生 `document` kind。
 * 不依赖 React / DOM / Electron / 定时器。
 */

import { commitTransaction, createHistory, endCoalescing, redo, undo } from '../../../editor/history/history';
import { sameSelection, selectionFitsSource } from '../../../editor/history/selection';
import type { CoalesceHint, CommitResult, HistoryState, HistoryStepResult } from '../../../editor/history/types';
import { viewRangeToSourceRange } from '../../../editor/projection/offsets';
import { applyViewPatchToSource } from '../../../editor/projection/viewPatch';
import type { ViewPatchRejection } from '../../../editor/projection/viewPatch';
import { DEFAULT_RANGE_BIAS } from '../../../editor/selection/types';
import type { EditorSelection } from '../../../editor/selection/types';
import type { DocumentSession } from '../../../editor/session/types';
import type { SourceRange, TextPatch } from '../../../editor/text/types';

/**
 * 编辑器的轻提示（纯展示数据，不参与任何判断）。T3a 中只有单测能触发其中大部分；状态栏在 T3b 呈现。
 * 与 Open 的 `OpenNotice` 分开：后者由 Toolbar 穷举呈现，T3a 不新增 Open 提示种类。
 */
export type EditorNoticeKind =
  | 'open-refused-dirty'
  | 'open-refused-composing'
  | 'open-candidate-dropped-dirty'
  | 'open-commit-refused-dirty'
  | 'command-ignored-composing'
  | 'command-ignored-replacing'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'reparse-ignored-composing'
  | 'reparsed'
  | 'parse-failed'
  | 'editor-error'
  | 'unload-blocked-dirty'
  | 'unload-blocked-composing'
  // M3 T3c：源码编辑。
  | 'input-unsupported'
  | 'input-rejected'
  | 'input-reverted'
  | 'edit-conflict'
  | 'edit-out-of-sync'
  | 'ime-not-applied'
  | 'source-readonly-platform';

export interface EditorNotice {
  readonly kind: EditorNoticeKind;
}

/** 一次原子写入的单位：会话、与之绑定的历史、当前版本上的运行时选中。 */
export interface EditorCore {
  readonly session: DocumentSession;
  readonly history: HistoryState;
  readonly selection: EditorSelection;
}

type CommitFailure = Extract<CommitResult, { readonly ok: false }>['reason'];
type HistoryStepFailure = Extract<HistoryStepResult, { readonly ok: false }>['reason'];

export type EditorStepFailure = ViewPatchRejection | CommitFailure | HistoryStepFailure | 'stale-selection' | 'selection-out-of-range';

export type EditorStep =
  | { readonly ok: true; readonly core: EditorCore; readonly changed: boolean; readonly merged: boolean }
  | { readonly ok: false; readonly reason: EditorStepFailure };

/** 一次源码输入：view 坐标上的补丁、事件发生时的选中、合并提示（null ⇒ 独立事务）与标签。 */
export interface SourceInput {
  readonly viewPatch: TextPatch;
  readonly selection: EditorSelection;
  readonly coalesce: CoalesceHint | null;
  readonly label: string;
}

/** 空选中（Open / demo 之后的初始值）。 */
export function noSelection(basisVersion: number): EditorSelection {
  return Object.freeze({ kind: 'none', ranges: Object.freeze([]), bias: DEFAULT_RANGE_BIAS, basisVersion });
}

/** 新会话的初始核心：空历史、空选中。 */
export function initialEditorCore(session: DocumentSession): EditorCore {
  return { session, history: createHistory(session), selection: noSelection(session.sourceVersion) };
}

/**
 * view 区间（textarea 选区）→ 当前版本的 source 选中。全选 `[0, view.length]` 自然映射为 `[protectedPrefixLength, source.length]`，
 * 受保护的开头 U+FEFF 不会被选中。区间非法时返回 null。
 */
export function sourceSelectionFromView(session: DocumentSession, viewRange: SourceRange): EditorSelection | null {
  const mapped = viewRangeToSourceRange(session.projection, viewRange);
  if (!mapped.ok) return null;
  const range = Object.freeze({ start: mapped.range.start, end: mapped.range.end });
  return Object.freeze({ kind: 'source', ranges: Object.freeze([range]), bias: DEFAULT_RANGE_BIAS, basisVersion: session.sourceVersion });
}

/** 源码输入：view 补丁 → source 补丁 → T2 事务。无变化事务（Q4 / R3-H2）返回 `changed: false`，版本不变。 */
export function applySourceInput(core: EditorCore, input: SourceInput): EditorStep {
  const mapped = applyViewPatchToSource(core.session.projection, input.viewPatch);
  if (!mapped.ok) return { ok: false, reason: mapped.reason };
  const result = commitTransaction(core.session, core.history, {
    baseVersion: core.session.sourceVersion,
    patches: [mapped.sourcePatch],
    selection: input.selection,
    label: input.label,
    origin: 'source-input',
    coalesce: input.coalesce,
  });
  if (!result.ok) return { ok: false, reason: result.reason };
  const next: EditorCore = { session: result.session, history: result.history, selection: result.selection };
  return result.changed ? { ok: true, core: next, changed: true, merged: result.merged } : { ok: true, core: next, changed: false, merged: false };
}

/** 撤销栈顶事务：版本 +1，恢复其 selectionBefore（§17.3）。 */
export function undoStep(core: EditorCore): EditorStep {
  const result = undo(core.session, core.history);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, core: { session: result.session, history: result.history, selection: result.selection }, changed: true, merged: false };
}

/** 重做 redo 栈顶事务：版本 +1，恢复其 selectionAfter（§17.3）。 */
export function redoStep(core: EditorCore): EditorStep {
  const result = redo(core.session, core.history);
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, core: { session: result.session, history: result.history, selection: result.selection }, changed: true, merged: false };
}

/**
 * 非编辑的选区变化（点击、方向键、全选）：选中必须属于当前版本且不越界；与当前选中相同时原样返回，
 * 不同时更新选中并结束合并组（§9.3「光标跳转 / 选区改变 → 结束合并」）。
 */
export function changeSelection(core: EditorCore, selection: EditorSelection): EditorStep {
  if (selection.basisVersion !== core.session.sourceVersion) return { ok: false, reason: 'stale-selection' };
  if (!selectionFitsSource(selection, core.session.source.length)) return { ok: false, reason: 'selection-out-of-range' };
  if (sameSelection(selection, core.selection)) return { ok: true, core, changed: false, merged: false };
  return { ok: true, core: { session: core.session, history: endCoalescing(core.history), selection }, changed: true, merged: false };
}
