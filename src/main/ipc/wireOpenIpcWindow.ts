/**
 * Open IPC 的窗口事件接线与生产用选择器（M3 T1b-2a′，T1b-2b preflight 裁决 Q2）。
 *
 * 产品 main 与 T1b-2b 的真实窗口 smoke 共用这一份接线，不各自复制事件名与转发逻辑。**本模块不 import electron**：
 * 窗口、webContents 与 `dialog.showOpenDialog` 都按结构类型传入，`BrowserWindow` 直接满足这些接口。
 *
 * 转发的事件（每个窗口登记一次）：
 * - `did-start-navigation` → `handleNavigation`（由它判断只有主 frame 的跨文档导航才 reset）；
 * - `did-navigate` → `handleNavigationCommitted`（只对主 frame 触发；页内导航走 `did-navigate-in-page`，不转发）；
 * - `render-process-gone` → `handleRendererGone`；
 * - webContents `destroyed` 与窗口 `closed` → `disposeWindow`（幂等，两者都转发）。
 */

import type { OpenIpcHandle } from './registerOpenIpc';

export interface NavigationDetailsLike {
  readonly isMainFrame: boolean;
  readonly isSameDocument: boolean;
}

/** `WebContents` 中接线用到的部分。 */
export interface OpenIpcContentsLike {
  readonly id: number;
  on(event: 'did-start-navigation', listener: (details: NavigationDetailsLike) => void): unknown;
  on(event: 'did-navigate', listener: () => void): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** `BrowserWindow` 中接线用到的部分。 */
export interface OpenIpcWindowLike {
  readonly webContents: OpenIpcContentsLike;
  once(event: 'closed', listener: () => void): unknown;
}

export type OpenIpcWindowEvents<W> = Pick<
  OpenIpcHandle<W>,
  'attachWindow' | 'handleNavigation' | 'handleNavigationCommitted' | 'handleRendererGone' | 'disposeWindow'
>;

/** 登记窗口并转发它的生命周期事件；返回 ownerId（webContents id）。 */
export function wireOpenIpcWindow<W extends OpenIpcWindowLike>(openIpc: OpenIpcWindowEvents<W>, window: W): number {
  const contents = window.webContents;
  const ownerId = contents.id;
  openIpc.attachWindow(ownerId, window);
  contents.on('did-start-navigation', (details) => {
    openIpc.handleNavigation(ownerId, { isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument });
  });
  contents.on('did-navigate', () => {
    openIpc.handleNavigationCommitted(ownerId);
  });
  contents.on('render-process-gone', () => {
    openIpc.handleRendererGone(ownerId);
  });
  contents.once('destroyed', () => {
    openIpc.disposeWindow(ownerId);
  });
  window.once('closed', () => {
    openIpc.disposeWindow(ownerId);
  });
  return ownerId;
}

/** `dialog.showOpenDialog` 的选项中本模块用到的部分。 */
export interface OpenDialogOptionsLike {
  title: string;
  properties: 'openFile'[];
  filters: { name: string; extensions: string[] }[];
}

export interface OpenDialogResultLike {
  readonly canceled: boolean;
  readonly filePaths: readonly string[];
}

/** 父窗口模态的 Open 对话框选项；每次调用新建，调用方无法改写共享对象。 */
export function openDocumentDialogOptions(): OpenDialogOptionsLike {
  return {
    title: 'Open Muse Score',
    properties: ['openFile'],
    filters: [
      { name: 'Muse score', extensions: ['jcx'] },
      { name: 'Text files', extensions: ['txt', 'abc', 'tab'] },
      { name: 'All files', extensions: ['*'] },
    ],
  };
}

/**
 * 生产用选择器：取消或没有选中文件都返回 null。macOS 上 `close()` 结束 sheet 时回复的是 `canceled: false` 且 `filePaths` 为空，
 * 同样映射为 null。异常原样抛出，由 `registerOpenIpc` 统一转成 `read-failed`。
 */
export function createOpenPathChooser<W>(
  showOpenDialog: (parent: W, options: OpenDialogOptionsLike) => Promise<OpenDialogResultLike>,
): (parent: W) => Promise<string | null> {
  return async (parent) => {
    const result = await showOpenDialog(parent, openDocumentDialogOptions());
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
}
