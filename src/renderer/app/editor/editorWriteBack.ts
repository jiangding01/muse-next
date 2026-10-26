/**
 * 源码面板的 DOM 写回（M3 T3c；Preflight r1 §4、r1.1 §1 / §3、勘误 E-2）。
 *
 * textarea 是**非受控**的：会话 view 是唯一真相，DOM 只是它的显示。本模块订阅 store，在文档身份、版本或选中变化时把 DOM 对齐到 store：
 * - 文本：文档身份变化 → 整体 `value = view`（即使 view 相同）；版本变化 → DOM 已等于新 view（输入法提交，模式 B）则不写，
 *   等于上一次已对齐的 view（可取消输入已 preventDefault、undo / redo，模式 A）则按公共前后缀 `setRangeText`，都不是则整体重置并报告。
 * - 选区：与文本分开判定——store 选中映射到 view 后与 DOM 相同则不调用 `setSelectionRange`（不打断下一次组字），否则设置；
 *   `none` 只在文档身份变化时把光标置 0。
 * - 输入法：组字中不碰 DOM；组字中出现文档 / 版本变化 → discard（之后的 compositionend 只能回滚）。提交过渡态（committing）中，
 *   只接受与一次性授权完全一致的变化并消费授权；授权之外的变化 → `committed-unverified` 并整体对齐。
 * - 失败：写回或校验抛错 → 一次整体重置；再失败 → `broken`（fail closed：拒绝编辑、提示），恢复只在进入时的一次延迟尝试、
 *   之后每个**不同的** store 基线各一次、或重新 attach 时进行（勘误 E-2：独立的最近恢复基线，不依赖 broken 期间不更新的 `rendered`）。
 * - 订阅回调内不写 store：提示与报告经 `defer`（微任务）发布；同步重入只置 `pending`，由外层循环重跑。
 * 只依赖结构化的 `TextareaLike` 与注入的 store / 会话接口，不直接访问平台全局。
 */

import { sourceRangeToViewRange } from '../../../editor/projection/offsets';
import type { EditorSelection } from '../../../editor/selection/types';
import type { DocumentSession } from '../../../editor/session/types';
import type { EditorNoticeKind } from './editorTransitions';
import type { ImeSession } from './imeSession';

/** 写回需要的 textarea 能力（结构类型，测试用假对象）。 */
export interface TextareaLike {
  value: string;
  readOnly: boolean;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setRangeText(replacement: string, start: number, end: number, selectMode?: 'select' | 'start' | 'end' | 'preserve'): void;
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}

export interface WriteBackState {
  readonly session: DocumentSession;
  readonly selection: EditorSelection;
}

export interface WriteBackDeps {
  readonly read: () => WriteBackState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ime: Pick<ImeSession, 'state' | 'authorization' | 'consumeCommit' | 'endCommitUnverified' | 'discard' | 'noteStoreChange'>;
  readonly notify: (kind: EditorNoticeKind) => void;
  readonly clearNotice: (kind: EditorNoticeKind) => void;
  readonly report: (error: unknown, context: string) => void;
  /** 微任务：订阅回调中延后发布提示与报告。 */
  readonly defer: (task: () => void) => void;
  /** 一次性异步任务（MessageChannel）：broken 的延迟恢复。 */
  readonly post: (task: () => void) => void;
  /** 门控决定的只读值（broken 解除时恢复）。 */
  readonly gateReadOnly: () => boolean;
  /** 绑定层的事件序号（消费授权时写入 settled.endSeq）。 */
  readonly eventSeq: () => number;
}

interface Rendered {
  readonly documentId: number;
  readonly sourceVersion: number;
  readonly view: string;
  readonly selection: EditorSelection;
}

interface Basis {
  readonly documentId: number;
  readonly sourceVersion: number;
  readonly selection: EditorSelection;
}

export interface ReconcileOptions {
  readonly force?: boolean;
  readonly rollback?: boolean;
}

export interface WriteBack {
  attach(textarea: TextareaLike): void;
  detach(): void;
  /**
   * `force`：即使版本与选中未变也核对文本；`rollback`：调用方已知 DOM 含有未进入 source 的内容（输入法回滚、即时防线、写入被拒），
   * 整体重置时不再作为「意外分叉」报告。
   */
  reconcile(options?: ReconcileOptions): void;
  /** DOM 选区 := store 选中（选区同步的最终收束）。 */
  applyStoreSelection(): void;
  isBroken(): boolean;
  /** 诊断与测试：恢复尝试次数、延迟恢复投递次数。 */
  counters(): { readonly recoveryAttempts: number; readonly recoveryPosts: number };
}

const basisOf = (state: WriteBackState): Basis => ({ documentId: state.session.documentId, sourceVersion: state.session.sourceVersion, selection: state.selection });

const sameBasis = (a: Basis, b: Basis | null): boolean =>
  b !== null && a.documentId === b.documentId && a.sourceVersion === b.sourceVersion && a.selection === b.selection;

/** 写回相关的编辑器不变量错误（只用于报告；`name` 便于诊断归类）。 */
export function writeBackError(message: string): Error {
  const error = new Error(message);
  error.name = 'WriteBackError';
  return error;
}

/** store 选中（第一个区间）在 view 中的位置；`none` 或映射失败时为 null。 */
export function selectionViewRange(session: DocumentSession, selection: EditorSelection): { readonly start: number; readonly end: number } | null {
  const range = selection.ranges[0];
  if (selection.kind === 'none' || range === undefined) return null;
  const mapped = sourceRangeToViewRange(session.projection, range);
  return mapped.ok ? mapped.range : null;
}

/**
 * 写回层输入法分支的结果。`handled`：已完整处理（组字中不碰 DOM、授权变化已对齐并消费）；`continue`：交给通用对齐；
 * `continue-reported`：交给通用对齐，且 DOM 中的组字残留已作为不变量报告过，整体重置时不再重复报告分叉。
 */
type ImeBranchResult = 'handled' | 'continue' | 'continue-reported';

export function createWriteBack(deps: WriteBackDeps): WriteBack {
  let textarea: TextareaLike | null = null;
  let unsubscribe: (() => void) | null = null;
  let rendered: Rendered | null = null;
  let reconciling = false;
  let pending = false;
  let pendingForce = false;
  let pendingRollback = false;
  let broken = false;
  let brokenEpoch = 0;
  let recoveryBasis: Basis | null = null;
  let recoveryAttempts = 0;
  let recoveryPosts = 0;

  const reportLater = (error: unknown, context: string): void => {
    deps.defer(() => {
      deps.report(error, context);
    });
  };

  function setSelection(ta: TextareaLike, start: number, end: number): void {
    if (ta.selectionStart === start && ta.selectionEnd === end) return;
    ta.setSelectionRange(start, end, 'forward');
  }

  function applySelection(ta: TextareaLike, state: WriteBackState, initialize: boolean): void {
    const range = selectionViewRange(state.session, state.selection);
    if (range !== null) setSelection(ta, range.start, range.end);
    else if (initialize) setSelection(ta, 0, 0);
  }

  function writeRegion(ta: TextareaLike, from: string, to: string): void {
    let prefix = 0;
    const limit = Math.min(from.length, to.length);
    while (prefix < limit && from.charCodeAt(prefix) === to.charCodeAt(prefix)) prefix += 1;
    let suffix = 0;
    while (suffix < limit - prefix && from.charCodeAt(from.length - 1 - suffix) === to.charCodeAt(to.length - 1 - suffix)) suffix += 1;
    ta.setRangeText(to.slice(prefix, to.length - suffix), prefix, from.length - suffix, 'end');
  }

  function verify(ta: TextareaLike, view: string): void {
    if (ta.value !== view) throw writeBackError('write-back verification failed');
  }

  function remember(state: WriteBackState): void {
    rendered = { documentId: state.session.documentId, sourceVersion: state.session.sourceVersion, view: state.session.projection.view, selection: state.selection };
  }

  function settledFacts(ta: TextareaLike | null, state: WriteBackState, trustDom: boolean): { versionAfter: number; caretView: number; endSeq: number } {
    const range = selectionViewRange(state.session, state.selection);
    const caretView = trustDom && ta !== null ? ta.selectionEnd : (range?.end ?? state.session.projection.view.length);
    return { versionAfter: state.session.sourceVersion, caretView, endSeq: deps.eventSeq() };
  }

  /** 文本对齐（不含输入法分支）。 */
  function alignText(ta: TextareaLike, state: WriteBackState, force: boolean, expectDivergence: boolean): void {
    const view = state.session.projection.view;
    if (rendered === null || state.session.documentId !== rendered.documentId) {
      ta.value = view;
      applySelection(ta, state, true);
      return;
    }
    if (force || state.session.sourceVersion !== rendered.sourceVersion || ta.value !== view) {
      if (ta.value === view) {
        // 模式 B：输入法已写入，或文本本来一致。
      } else if (ta.value === rendered.view) {
        writeRegion(ta, rendered.view, view);
      } else {
        ta.value = view;
        if (!expectDivergence) reportLater(writeBackError('source editor DOM diverged from the session view'), 'write-back-diverged');
      }
      applySelection(ta, state, false);
      return;
    }
    if (state.selection !== rendered.selection) applySelection(ta, state, false);
  }


  function imeBranch(ta: TextareaLike, state: WriteBackState): ImeBranchResult {
    const ime = deps.ime.state();
    if (ime.kind === 'composing') {
      if (rendered !== null && state.session.documentId === rendered.documentId && state.session.sourceVersion === rendered.sourceVersion) return 'handled';
      deps.ime.discard('store-changed-while-composing');
      reportLater(writeBackError('store changed while composing'), 'store-changed-while-composing');
      return 'continue-reported';
    }
    if (ime.kind !== 'committing') return 'continue';
    const auth = deps.ime.authorization();
    if (auth === null) return 'continue';
    const authorized =
      state.session.documentId === auth.documentId && state.session.sourceVersion === auth.authorizedVersion && state.session.projection.view === auth.expectedView;
    if (!authorized) {
      deps.ime.endCommitUnverified(auth.token, settledFacts(ta, state, false));
      reportLater(writeBackError('unauthorized store change during IME commit'), 'unauthorized-change-during-commit');
      return 'continue-reported';
    }
    try {
      alignText(ta, state, false, false);
      verify(ta, state.session.projection.view);
    } catch (error) {
      // 提交已进入 store，不能回退：先以 store 事实消费授权，再交给外层整体重置。
      deps.ime.consumeCommit(auth.token, settledFacts(ta, state, false));
      throw error;
    }
    remember(state);
    deps.ime.consumeCommit(auth.token, settledFacts(ta, state, true));
    return 'handled';
  }

  function enterBroken(ta: TextareaLike): void {
    broken = true;
    brokenEpoch += 1;
    recoveryBasis = basisOf(deps.read());
    try {
      ta.readOnly = true;
    } catch {
      // 连只读都设不上时只能依赖绑定层的拒绝分支。
    }
    const epoch = brokenEpoch;
    deps.defer(() => {
      deps.notify('edit-out-of-sync');
    });
    recoveryPosts += 1;
    deps.post(() => {
      if (!broken || epoch !== brokenEpoch || textarea !== ta) return;
      tryRecover();
    });
  }

  function tryRecover(): void {
    const ta = textarea;
    if (ta === null || !broken) return;
    recoveryAttempts += 1;
    const state = deps.read();
    try {
      ta.value = state.session.projection.view;
      applySelection(ta, state, true);
      verify(ta, state.session.projection.view);
    } catch (error) {
      reportLater(error, 'write-back-recovery-failed');
      return;
    }
    broken = false;
    recoveryBasis = null;
    remember(state);
    ta.readOnly = deps.gateReadOnly();
    deps.defer(() => {
      deps.clearNotice('edit-out-of-sync');
    });
  }

  function runOnce(ta: TextareaLike, force: boolean, expectDivergence: boolean): void {
    const state = deps.read();
    try {
      const branch = imeBranch(ta, state);
      if (branch !== 'handled') {
        alignText(ta, state, force, expectDivergence || branch === 'continue-reported');
        verify(ta, state.session.projection.view);
        remember(state);
      }
    } catch (error) {
      reportLater(error, 'write-back-failed');
      try {
        const fresh = deps.read();
        ta.value = fresh.session.projection.view;
        applySelection(ta, fresh, true);
        verify(ta, fresh.session.projection.view);
        remember(fresh);
      } catch {
        enterBroken(ta);
        return;
      }
    }
    const latest = deps.read();
    deps.ime.noteStoreChange(latest.session.documentId, latest.session.sourceVersion);
  }

  function reconcile(options: ReconcileOptions = {}): void {
    const ta = textarea;
    if (ta === null) return;
    if (broken) return;
    if (reconciling) {
      pending = true;
      pendingForce = pendingForce || options.force === true;
      pendingRollback = pendingRollback || options.rollback === true;
      return;
    }
    reconciling = true;
    let force = options.force === true;
    let expectDivergence = options.rollback === true;
    try {
      do {
        pending = false;
        runOnce(ta, force, expectDivergence);
        force = pendingForce;
        expectDivergence = pendingRollback;
        pendingForce = false;
        pendingRollback = false;
      } while (pending && !broken);
    } finally {
      reconciling = false;
    }
  }

  function onStore(): void {
    if (textarea === null) return;
    const state = deps.read();
    if (broken) {
      const basis = basisOf(state);
      if (sameBasis(basis, recoveryBasis)) return;
      recoveryBasis = basis;
      tryRecover();
      return;
    }
    if (
      rendered !== null &&
      state.session.documentId === rendered.documentId &&
      state.session.sourceVersion === rendered.sourceVersion &&
      state.selection === rendered.selection
    ) {
      return;
    }
    reconcile();
  }

  return {
    attach: (ta) => {
      if (textarea !== null) {
        unsubscribe?.();
      }
      textarea = ta;
      rendered = null;
      broken = false;
      recoveryBasis = null;
      ta.readOnly = deps.gateReadOnly();
      unsubscribe = deps.subscribe(onStore);
      reconcile();
    },
    detach: () => {
      unsubscribe?.();
      unsubscribe = null;
      textarea = null;
      rendered = null;
      broken = false;
      recoveryBasis = null;
      brokenEpoch += 1;
    },
    reconcile,
    applyStoreSelection: () => {
      const ta = textarea;
      if (ta === null || broken) return;
      const state = deps.read();
      try {
        applySelection(ta, state, false);
        if (rendered !== null) rendered = { ...rendered, selection: state.selection };
      } catch (error) {
        reportLater(error, 'write-back-selection-failed');
      }
    },
    isBroken: () => broken,
    counters: () => ({ recoveryAttempts, recoveryPosts }),
  };
}
