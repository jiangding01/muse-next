/**
 * DOM 选区 → store 选中的同步（M3 T3c；Preflight r1 §5、r1.1 §2；用户裁决 Q-C1(a)）。
 *
 * - 电平触发：每次都重新读取 store 与 DOM，从不重放旧结果（被拒绝的旧编辑事务从不重试；这里只表达「DOM 现在的选区」）。
 * - 写入经 `setEditorSelection(core, base)` 的三对象 CAS。拒绝后：立即以新鲜状态重算一次；再被拒 → 投递一次延迟任务（携带代际、
 *   序号、文档、版本）；延迟任务中仍被拒 → **收束**：以 store 为准设置 DOM 选区并结束。每个触发至多 3 次 store 写尝试 + 1 次 DOM 写，
 *   之后不再有任何待办，与是否出现后续事件无关。
 * - 任何新的同步请求都会使旧的延迟任务失效（序号），不会用旧意图覆盖新意图；文档 / 版本已变时延迟任务无操作（写回层已按 store 设置选区）。
 * - 不同步：组字中、Open 进行中、写回暂停（broken）、DOM ≠ 会话 view（交给写回层整体对齐）。
 */

import type { StoreWriteResult } from '../store';
import { changeSelection, sourceSelectionFromView } from './editorTransitions';
import type { EditorCore } from './editorTransitions';
import type { TextareaLike } from './editorWriteBack';

export interface SelectionSyncDeps {
  readonly read: () => EditorCore;
  readonly write: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  readonly textarea: () => Pick<TextareaLike, 'value' | 'selectionStart' | 'selectionEnd'> | null;
  /** 绑定有效、非组字、非 Open 进行中、写回未暂停。 */
  readonly canSync: () => boolean;
  readonly generation: () => number;
  readonly post: (task: () => void) => void;
  /** DOM 不等于会话 view：交给写回层整体对齐。 */
  readonly realign: () => void;
  /** 收束：DOM 选区 := store 选中。 */
  readonly resolveToStore: () => void;
  readonly diagnostic: (kind: 'selection-sync-resolved-to-store') => void;
}

export type SyncOutcome = 'skipped' | 'unchanged' | 'written' | 'deferred' | 'resolved-to-store';

export interface SelectionSync {
  sync(): SyncOutcome;
  /** 使待办的延迟任务失效（detach / 文档替换）。 */
  invalidate(): void;
  hasDeferred(): boolean;
}

export function createSelectionSync(deps: SelectionSyncDeps): SelectionSync {
  let epoch = 0;
  let deferred = false;

  type Attempt = 'skipped' | 'unchanged' | 'written' | 'rejected';

  function attempt(): Attempt {
    if (!deps.canSync()) return 'skipped';
    const ta = deps.textarea();
    if (ta === null) return 'skipped';
    const base = deps.read();
    if (ta.value !== base.session.projection.view) {
      deps.realign();
      return 'skipped';
    }
    const selection = sourceSelectionFromView(base.session, { start: ta.selectionStart, end: ta.selectionEnd });
    if (selection === null) return 'skipped';
    const step = changeSelection(base, selection);
    if (!step.ok) return 'skipped';
    if (!step.changed) return 'unchanged';
    return deps.write(step.core, base).ok ? 'written' : 'rejected';
  }

  function settle(result: Attempt): SyncOutcome {
    return result === 'rejected' ? 'deferred' : result;
  }

  return {
    sync: () => {
      epoch += 1;
      deferred = false;
      const first = attempt();
      if (first !== 'rejected') return settle(first);
      const second = attempt();
      if (second !== 'rejected') return settle(second);
      const scheduled = { epoch, generation: deps.generation(), documentId: deps.read().session.documentId, version: deps.read().session.sourceVersion };
      deferred = true;
      deps.post(() => {
        if (scheduled.epoch !== epoch || scheduled.generation !== deps.generation()) return;
        deferred = false;
        const now = deps.read().session;
        if (now.documentId !== scheduled.documentId || now.sourceVersion !== scheduled.version) return;
        if (attempt() !== 'rejected') return;
        epoch += 1;
        deps.resolveToStore();
        deps.diagnostic('selection-sync-resolved-to-store');
      });
      return 'deferred';
    },
    invalidate: () => {
      epoch += 1;
      deferred = false;
    },
    hasDeferred: () => deferred,
  };
}
