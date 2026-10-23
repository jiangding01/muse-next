/**
 * 应用菜单（M3 T3b；T3 Preflight r3 §7.1、§7.4，用户裁决 Q2 / Q-B3）。
 *
 * 替换 Electron 默认菜单：默认菜单含 Reload / Force Reload 与原生 Undo / Redo role，会绕过统一历史并静默丢弃文档。
 * - Undo / Redo / Reparse / Open 没有 `role`，点击只转交 `onCommand`（派发规则在 `wireEditorWindow.ts` 的命令路由中）；
 *   非 macOS 的 Undo / Redo 不注册加速键（键盘只走 main `before-input-event`），macOS 没有该选项（兜底见路由）。
 * - Cut / Copy / Paste / Select All 用 role（浏览器原生；macOS 上这些 role 是 Cmd+C/V/X/A 生效的前提）。
 * - 不含 Reload / Force Reload、New / Save 等文档命令；View（Toggle DevTools）只在开发构建出现。
 * - macOS 的 Window 菜单显式列出 Minimize / Zoom / Close / Bring All to Front（`windowMenu` 默认不含 Close，Cmd+W 会丢失）；
 *   Close 关窗受 renderer 同步 beforeunload 约束（T3a，Preflight r3 §7.1 / §8）。
 *
 * **本模块不 import electron**：模板用结构类型描述，`Menu.buildFromTemplate` / `Menu.setApplicationMenu` 由调用方注入。
 * main 与真实窗口 smoke 都只经 `installAppMenu` 安装菜单。
 */

import type { MenuCommand } from '../../shared/menuContracts';

/** 菜单点击事件中本模块用到的部分（Electron 的 `KeyboardEvent`）。 */
export interface MenuClickEventLike {
  readonly triggeredByAccelerator?: boolean;
}

/** 菜单项回调的参数：被点击的项、当时聚焦的窗口（可能没有）、事件。 */
export type MenuClickHandler = (menuItem: unknown, window: object | undefined, event: MenuClickEventLike) => void;

/** 本模块允许出现的 role（守卫钉住：没有 undo / redo / reload / forceReload，也没有会带入它们的整组菜单 role）。 */
export type AppMenuRole =
  | 'appMenu'
  | 'windowMenu'
  | 'minimize'
  | 'zoom'
  | 'close'
  | 'front'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'selectAll'
  | 'toggleDevTools';

export interface AppMenuItem {
  id?: string;
  label?: string;
  role?: AppMenuRole;
  type?: 'separator';
  accelerator?: string;
  registerAccelerator?: boolean;
  submenu?: AppMenuItem[];
  click?: MenuClickHandler;
}

/** 产品命令菜单项的固定 id（smoke 经 `getMenuItemById` 取得）。 */
export const MENU_ITEM_IDS: Readonly<Record<MenuCommand, string>> = {
  open: 'muse.open',
  undo: 'muse.undo',
  redo: 'muse.redo',
  reparse: 'muse.reparse',
};

export interface AppMenuOptions {
  readonly platform: string;
  /** 开发构建（未打包）才出现 View → Toggle DevTools。 */
  readonly devBuild: boolean;
  readonly onCommand: (command: MenuCommand, window: object | undefined, event: MenuClickEventLike) => void;
}

/** 构建菜单模板（纯函数；每次调用返回新对象）。 */
export function buildAppMenuTemplate(options: AppMenuOptions): AppMenuItem[] {
  const mac = options.platform === 'darwin';
  const command = (name: MenuCommand, label: string, accelerator: string, history = false): AppMenuItem => ({
    id: MENU_ITEM_IDS[name],
    label,
    accelerator,
    ...(history && !mac ? { registerAccelerator: false } : {}),
    click: (_item, window, event) => {
      options.onCommand(name, window, event);
    },
  });
  return [
    ...(mac ? [{ role: 'appMenu' as const }] : []),
    { label: 'File', submenu: [command('open', 'Open…', 'CmdOrCtrl+O')] },
    {
      label: 'Edit',
      submenu: [
        command('undo', 'Undo', 'CmdOrCtrl+Z', true),
        command('redo', 'Redo', 'Shift+CmdOrCtrl+Z', true),
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { label: 'Score', submenu: [command('reparse', 'Reparse', 'CmdOrCtrl+R')] },
    ...(options.devBuild ? [{ label: 'View', submenu: [{ role: 'toggleDevTools' as const }] }] : []),
    ...(mac
      ? [
          {
            label: 'Window',
            role: 'windowMenu' as const,
            submenu: [{ role: 'minimize' as const }, { role: 'zoom' as const }, { role: 'close' as const }, { type: 'separator' as const }, { role: 'front' as const }],
          },
        ]
      : []),
  ];
}

export interface InstallAppMenuDeps<M> extends AppMenuOptions {
  readonly buildFromTemplate: (template: AppMenuItem[]) => M;
  readonly setApplicationMenu: (menu: M) => void;
}

/** 唯一的菜单安装函数：构建模板 → `buildFromTemplate` → `setApplicationMenu`；返回安装的菜单。 */
export function installAppMenu<M>(deps: InstallAppMenuDeps<M>): M {
  const menu = deps.buildFromTemplate(buildAppMenuTemplate(deps));
  deps.setApplicationMenu(menu);
  return menu;
}
