/**
 * 编辑命令的唯一入口（M3 T3a；T3 Preflight r3 §4.5、§7.2、§8）。
 *
 * - Undo / Redo / Reparse 只经本控制器派发（菜单、快捷键、beforeinput 在 T3b / T3c 都汇入这里），并记录派发来源。
 * - Open 进行中（`replacementPending`）或输入法组字中，undo / redo 一律忽略并提示；Reparse 在组字中由调度器忽略（F3）。
 * - `replacementPending` 是**同步标志**：由 Open 控制器在事务进入非 idle 时置位、在终态的全部效果执行完之后清除
 *   （r3 复核 M-2 / L-5），不依赖 Open 视图的发布顺序。
 * - `imeView()`：T3a 中恒为 `'idle'`（源码面板只读，不可能组字）；T3c 替换为输入法状态机的实现（r3 复查 M-3）。
 * - `openGate()` / `prepareReplacement()` 供 Open 控制器在入口与提交前读取 dirty 与组字状态、结束组字（T3a 中为空操作）。
 * 控制器是模块级对象，不在任何 React 组件生命周期里。
 */

import { isSourceDirty } from '../../../editor/session/derive';
import { reportEditorError } from '../fatalError';
import { applyEditorStep, publishEditorView, useMuseAppStore } from '../store';
import type { StoreWriteResult } from '../store';
import { redoStep, undoStep } from './editorTransitions';
import type { EditorCore, EditorNotice, EditorStep } from './editorTransitions';
import { museParseController } from './parseController';
import type { FlushOutcome } from './parseController';
import type { FlushReason } from './parseSchedule';

/** 派发来源：键盘拦截（main）、菜单点击、菜单加速键兜底、beforeinput（T3b / T3c 接入）。 */
export type HistoryDispatchSource = 'key-intercept' | 'menu-click' | 'menu-accelerator' | 'beforeinput';

export type ImeView = 'idle' | 'composing' | 'discarded' | 'settled';

export type HistoryCommand = 'undo' | 'redo';

export type HistoryCommandOutcome =
  | 'applied'
  | 'ignored-composing'
  | 'ignored-replacing'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'failed';

export interface OpenGate {
  readonly dirty: boolean;
  readonly composing: boolean;
}

export interface EditorControllerDeps {
  readonly read: () => EditorCore;
  /** 写入 store；`base` 是计算 `core` 时读取的状态（CAS 基线，r3a 复核 M-1）。 */
  readonly apply: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  readonly flush: (reason: FlushReason) => FlushOutcome;
  readonly notify: (notice: EditorNotice) => void;
  readonly report: (error: unknown, context: string) => void;
  readonly imeView: () => ImeView;
  /** Open 提交前结束组字（T3c：discard → blur）。 */
  readonly beforeReplace: () => void;
}

export interface EditorController {
  undo(source: HistoryDispatchSource): HistoryCommandOutcome;
  redo(source: HistoryDispatchSource): HistoryCommandOutcome;
  reparse(source: HistoryDispatchSource): FlushOutcome;
  imeView(): ImeView;
  openGate(): OpenGate;
  prepareReplacement(): void;
  replacementPending(): boolean;
  setReplacementPending(pending: boolean): void;
  /** 最近一次被接受的派发（诊断与测试）。 */
  lastDispatch(): { readonly command: HistoryCommand | 'reparse'; readonly source: HistoryDispatchSource } | null;
}

export function createEditorController(deps: EditorControllerDeps): EditorController {
  let pending = false;
  let last: ReturnType<EditorController['lastDispatch']> = null;

  function runHistory(command: HistoryCommand, source: HistoryDispatchSource, step: (core: EditorCore) => EditorStep): HistoryCommandOutcome {
    if (pending) {
      deps.notify({ kind: 'command-ignored-replacing' });
      return 'ignored-replacing';
    }
    if (deps.imeView() === 'composing') {
      deps.notify({ kind: 'command-ignored-composing' });
      return 'ignored-composing';
    }
    last = { command, source };
    const base = deps.read();
    const result = step(base);
    if (!result.ok) {
      if (result.reason === 'nothing-to-undo' || result.reason === 'nothing-to-redo') {
        deps.notify({ kind: result.reason });
        return result.reason;
      }
      deps.report(new Error(`${command} failed: ${result.reason}`), command);
      deps.notify({ kind: 'editor-error' });
      return 'failed';
    }
    const written = deps.apply(result.core, base);
    if (!written.ok) {
      deps.report(new Error(`${command} store write rejected: ${written.reason}`), command);
      deps.notify({ kind: 'editor-error' });
      return 'failed';
    }
    // 写入已经完成：随后的立即解析即使抛错，也只归入编辑器错误，不改变本次命令的结果（方案 §19.2）。
    try {
      deps.flush(command);
    } catch (error) {
      deps.report(error, `${command}-parse`);
    }
    return 'applied';
  }

  return {
    undo: (source) => runHistory('undo', source, undoStep),
    redo: (source) => runHistory('redo', source, redoStep),
    reparse: (source) => {
      last = { command: 'reparse', source };
      return deps.flush('reparse');
    },
    imeView: () => deps.imeView(),
    openGate: () => ({ dirty: isSourceDirty(deps.read().session), composing: deps.imeView() === 'composing' }),
    prepareReplacement: () => {
      deps.beforeReplace();
    },
    replacementPending: () => pending,
    setReplacementPending: (value) => {
      pending = value;
    },
    lastDispatch: () => last,
  };
}

/** 产品使用的模块级编辑控制器（T3a：输入法视图恒为 idle）。 */
export const museEditorController: EditorController = createEditorController({
  read: () => {
    const { session, history, selection } = useMuseAppStore.getState();
    return { session, history, selection };
  },
  apply: applyEditorStep,
  flush: (reason) => museParseController.flush(reason),
  notify: (notice) => publishEditorView({ notice }),
  report: reportEditorError,
  imeView: () => 'idle',
  beforeReplace: () => undefined,
});
