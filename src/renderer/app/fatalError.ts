/**
 * 运行时错误处理（M3 T3a；`docs/M3_EDITOR_CORE_PLAN.md` §19，T3 Preflight r3 §5.1、§8）。
 *
 * - 编辑器不变量错误（补丁越界、版本倒退、写回校验失败、事件处理器中的异常）：先由调用方回滚 / 拒绝写入，这里记录；
 *   **开发期再用微任务异步重新抛出**（不打断当前事件处理、不卸载 React 根），生产期只记录（§19.1）。
 * - React 根错误回调只做记录与致命处理，不是 ErrorBoundary 式的 UI 恢复（§19.2）：`onUncaughtError`（整个根已卸载）时
 *   在 React 之外插入最小提示，并订阅 dirty 状态实时更新文案（r3 复查 L-6，避免用户盲目撤销）。T3 没有 Save，
 *   提示不写「先保存」（r0 审查 R0-13）。
 * - 根卸载后 `#root` 仍占满一屏高度（`html, body, #root { height: 100% }`），追加在 body 末尾的提示会落在首屏之外
 *   （r3a 复核 M-2）：提示插入 body 最前面，并经 CSSOM 固定在视口顶部。CSSOM 写入不受 CSP `style-src` 约束，
 *   不需要放宽 CSP，也不改 global.css。
 * - 会话 store、解析调度、beforeunload 都是模块级的，根卸载后仍工作。
 */

import { isSourceDirty } from '../../editor/session/derive';
import { useMuseAppStore } from './store';

export interface ErrorReporterDeps {
  readonly log: (message: string, error: unknown) => void;
  readonly isDev: boolean;
  /** 开发期异步重新抛出的调度（生产实现为 `queueMicrotask`）。 */
  readonly defer: (task: () => void) => void;
}

export type ErrorReporter = (error: unknown, context: string) => void;

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

export function createErrorReporter(deps: ErrorReporterDeps): ErrorReporter {
  return (error, context) => {
    deps.log(`[muse] editor error (${context})`, error);
    if (!deps.isDev) return;
    const rethrown = asError(error);
    deps.defer(() => {
      throw rethrown;
    });
  };
}

/** 产品使用的报告器：开发构建异步重新抛出，生产构建只记录。 */
export const reportEditorError: ErrorReporter = createErrorReporter({
  log: (message, error) => {
    console.error(message, error);
  },
  isDev: import.meta.env.DEV,
  defer: (task) => {
    queueMicrotask(task);
  },
});

/** 致命提示文案：随 dirty 状态变化。 */
export function fatalNoticeText(dirty: boolean): string {
  const head = '界面发生错误，已停止显示。';
  return dirty
    ? `${head}当前有未保存的修改（本阶段尚不能保存），请先用菜单撤销回到未修改状态，再关闭窗口。`
    : `${head}当前没有未保存的修改，可以关闭窗口后重新打开。`;
}

export interface FatalNoticeDeps<E extends { textContent: string | null }> {
  readonly create: () => E;
  readonly attach: (element: E) => void;
  /** 订阅 dirty 状态；立即以当前值回调一次，返回取消订阅。 */
  readonly subscribeDirty: (listener: (dirty: boolean) => void) => () => void;
}

/** 在 React 之外显示致命提示；重复调用只显示一次。返回取消订阅函数。 */
export function createFatalNotice<E extends { textContent: string | null }>(deps: FatalNoticeDeps<E>): () => () => void {
  let shown: (() => void) | null = null;
  return () => {
    if (shown !== null) return shown;
    const element = deps.create();
    deps.attach(element);
    shown = deps.subscribeDirty((dirty) => {
      element.textContent = fatalNoticeText(dirty);
    });
    return shown;
  };
}

const showMuseFatalNotice = createFatalNotice({
  create: () => {
    const element = document.createElement('div');
    element.className = 'muse-fatal-error';
    element.setAttribute('role', 'alert');
    const { style } = element;
    style.position = 'fixed';
    style.top = '0px';
    style.left = '0px';
    style.right = '0px';
    style.zIndex = '2147483647';
    style.padding = '12px 16px';
    style.background = '#8a1c1c';
    style.color = '#ffffff';
    style.font = '14px/1.5 system-ui, sans-serif';
    return element;
  },
  attach: (element) => {
    document.body.prepend(element);
  },
  subscribeDirty: (listener) => {
    listener(isSourceDirty(useMuseAppStore.getState().session));
    return useMuseAppStore.subscribe((state) => {
      listener(isSourceDirty(state.session));
    });
  },
});

interface RootErrorInfo {
  readonly componentStack?: string | undefined;
}

/** `createRoot` 的根错误回调（React 19）：只记录与致命处理。 */
export const museRootErrorOptions = {
  onUncaughtError(error: unknown, info: RootErrorInfo): void {
    console.error('[muse] uncaught render error', error, info.componentStack);
    showMuseFatalNotice();
  },
  onCaughtError(error: unknown, info: RootErrorInfo): void {
    console.error('[muse] caught render error', error, info.componentStack);
  },
  onRecoverableError(error: unknown, info: RootErrorInfo): void {
    console.error('[muse] recoverable render error', error, info.componentStack);
  },
};
