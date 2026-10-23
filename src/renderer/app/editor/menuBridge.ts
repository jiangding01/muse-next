/**
 * 菜单命令桥（M3 T3b；T3 Preflight r3 §7.4，用户裁决 Q2）。
 *
 * - 模块级、幂等：入口在 `createRoot` 之前安装一次，重复安装不会重复订阅；React 根卸载后仍然有效。
 * - 只经 preload 的 `onMenuCommand` 订阅（renderer 中除 openController 外唯一使用 `window.museDesktop` 的模块），
 *   收到的消息再校验一次（纵深防御），然后转交：undo / redo / reparse → `museEditorController`（带派发来源），
 *   open → `museOpenController.open()`（dirty / 组字 / 进行中的拒绝都在 Open 控制器中）。
 * - 路由抛错只报告为编辑器错误，不向 IPC 回调抛出。
 */

import { parseMenuCommandMessage } from '../../../shared/menuContracts';
import type { MenuCommandMessage } from '../../../shared/menuContracts';
import { reportEditorError } from '../fatalError';
import { museEditorController } from './editorController';
import type { EditorController } from './editorController';
import { museOpenController } from './openController';

export interface MenuBridgeDeps {
  /** 订阅 main 的菜单命令；返回注销函数（产品为 `window.museDesktop.onMenuCommand`，在安装时才访问 window）。 */
  readonly subscribe: (listener: (message: MenuCommandMessage) => void) => () => void;
  readonly editor: Pick<EditorController, 'undo' | 'redo' | 'reparse'>;
  readonly open: () => void;
  readonly report: (error: unknown, context: string) => void;
}

export interface MenuBridge {
  /** 安装订阅；已安装时什么也不做。返回本次是否新建了订阅。 */
  install(): boolean;
  /** 注销订阅（测试与诊断）。 */
  dispose(): void;
  installed(): boolean;
}

export function createMenuBridge(deps: MenuBridgeDeps): MenuBridge {
  let unsubscribe: (() => void) | null = null;

  const route = (raw: unknown): void => {
    try {
      const message = parseMenuCommandMessage(raw);
      if (message === null) {
        deps.report(new Error('menu bridge: rejected malformed menu command'), 'menu-command');
        return;
      }
      switch (message.command) {
        case 'undo':
          deps.editor.undo(message.source);
          return;
        case 'redo':
          deps.editor.redo(message.source);
          return;
        case 'reparse':
          deps.editor.reparse(message.source);
          return;
        case 'open':
          deps.open();
          return;
      }
    } catch (error) {
      deps.report(error, 'menu-command');
    }
  };

  return {
    install() {
      if (unsubscribe !== null) return false;
      unsubscribe = deps.subscribe(route);
      return true;
    },
    dispose() {
      const current = unsubscribe;
      unsubscribe = null;
      current?.();
    },
    installed: () => unsubscribe !== null,
  };
}

/** 产品使用的模块级命令桥。 */
export const museMenuBridge: MenuBridge = createMenuBridge({
  subscribe: (listener) => window.museDesktop.onMenuCommand(listener),
  editor: museEditorController,
  open: () => {
    museOpenController.open();
  },
  report: reportEditorError,
});

/** 入口调用（`createRoot` 之前）；幂等。 */
export function installMenuBridge(): void {
  museMenuBridge.install();
}
