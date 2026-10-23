/**
 * M3 T3b：应用菜单模板与唯一安装函数（`src/main/menu/appMenu.ts`；T3 Preflight r3 §7.1，用户裁决 Q2 / Q-B3）。
 *
 * 断言三平台模板：没有 undo / redo / reload / forceReload role，也没有会带入它们的整组菜单 role；产品命令项带固定 id、
 * 加速键与回调；非 macOS 的 Undo / Redo 不注册加速键；View 只在开发构建出现；没有文档命令。回调只转交 `onCommand`，
 * 原样带上窗口与事件（派发规则在 `wireEditorWindow` 的路由中，另有单测）。
 * 这里只验证模板与回调接线；Electron 原生菜单的真实行为由真实窗口 smoke 与 macOS 实机复验覆盖。
 */

import { describe, expect, it } from 'vitest';

import { buildAppMenuTemplate, installAppMenu, MENU_ITEM_IDS } from '../../../src/main/menu/appMenu';
import type { AppMenuItem, MenuClickEventLike } from '../../../src/main/menu/appMenu';
import type { MenuCommand } from '../../../src/shared/menuContracts';

const PLATFORMS = ['darwin', 'win32', 'linux'] as const;

function flatten(items: readonly AppMenuItem[]): AppMenuItem[] {
  return items.flatMap((item) => [item, ...flatten(item.submenu ?? [])]);
}

function template(platform: string, devBuild = false) {
  const calls: [MenuCommand, object | undefined, MenuClickEventLike][] = [];
  const items = buildAppMenuTemplate({ platform, devBuild, onCommand: (command, window, event) => calls.push([command, window, event]) });
  return { items, all: flatten(items), calls };
}

const byId = (all: readonly AppMenuItem[], id: string): AppMenuItem => {
  const item = all.find((entry) => entry.id === id);
  if (item === undefined) throw new Error(`missing ${id}`);
  return item;
};

describe('appMenu —— 模板', () => {
  it.each(PLATFORMS)('%s：没有危险 role，也没有整组菜单 role', (platform) => {
    for (const devBuild of [false, true]) {
      const roles = template(platform, devBuild).all.map((item) => item.role).filter((role) => role !== undefined);
      for (const forbidden of ['undo', 'redo', 'reload', 'forceReload', 'editMenu', 'viewMenu', 'fileMenu', 'quit']) {
        expect(roles).not.toContain(forbidden);
      }
    }
  });

  it.each(PLATFORMS)('%s：产品命令项恰为 Open / Undo / Redo / Reparse，带固定 id、加速键与回调，没有 role', (platform) => {
    const { all } = template(platform);
    const commands = all.filter((item) => item.click !== undefined);
    expect(commands.map((item) => item.id).sort()).toEqual(Object.values(MENU_ITEM_IDS).sort());
    for (const item of commands) expect(item.role).toBeUndefined();
    expect(byId(all, MENU_ITEM_IDS.open).accelerator).toBe('CmdOrCtrl+O');
    expect(byId(all, MENU_ITEM_IDS.undo).accelerator).toBe('CmdOrCtrl+Z');
    expect(byId(all, MENU_ITEM_IDS.redo).accelerator).toBe('Shift+CmdOrCtrl+Z');
    // Cmd/Ctrl+R 归属 Reparse（方案 §15.6）。
    expect(byId(all, MENU_ITEM_IDS.reparse).accelerator).toBe('CmdOrCtrl+R');
  });

  it('非 macOS 的 Undo / Redo 不注册加速键（键盘只走 before-input-event）；macOS 与其它命令项不带该选项', () => {
    for (const platform of ['win32', 'linux']) {
      const { all } = template(platform);
      expect(byId(all, MENU_ITEM_IDS.undo).registerAccelerator).toBe(false);
      expect(byId(all, MENU_ITEM_IDS.redo).registerAccelerator).toBe(false);
      expect(byId(all, MENU_ITEM_IDS.reparse).registerAccelerator).toBeUndefined();
      expect(byId(all, MENU_ITEM_IDS.open).registerAccelerator).toBeUndefined();
    }
    for (const item of template('darwin').all) expect(item.registerAccelerator).toBeUndefined();
  });

  it('顶层结构：macOS 有 App / Window role；View（Toggle DevTools）只在开发构建出现', () => {
    expect(template('darwin').items.map((item) => item.role ?? item.label)).toEqual(['appMenu', 'File', 'Edit', 'Score', 'windowMenu']);
    expect(template('darwin', true).items.map((item) => item.role ?? item.label)).toEqual(['appMenu', 'File', 'Edit', 'Score', 'View', 'windowMenu']);
    // macOS Window 菜单显式含 Close（Cmd+W；Preflight r3 §7.1，审查 M2）；其它平台没有 Window 菜单与 Close 项。
    const windowMenu = template('darwin').items.find((item) => item.role === 'windowMenu');
    expect(windowMenu?.submenu?.map((item) => item.role ?? item.type)).toEqual(['minimize', 'zoom', 'close', 'separator', 'front']);
    for (const platform of ['win32', 'linux']) expect(template(platform, true).all.filter((item) => item.role === 'close')).toEqual([]);
    expect(template('win32').items.map((item) => item.label)).toEqual(['File', 'Edit', 'Score']);
    expect(template('linux', true).items.map((item) => item.label)).toEqual(['File', 'Edit', 'Score', 'View']);
    expect(template('linux', true).all.filter((item) => item.role === 'toggleDevTools')).toHaveLength(1);
    expect(template('linux', false).all.filter((item) => item.role === 'toggleDevTools')).toHaveLength(0);
  });

  it('Edit 的剪贴板项使用 role（浏览器原生）；没有文档命令（New / Save / Close）', () => {
    const { all } = template('darwin');
    expect(all.filter((item) => item.role !== undefined && ['cut', 'copy', 'paste', 'selectAll'].includes(item.role)).map((item) => item.role)).toEqual([
      'cut',
      'copy',
      'paste',
      'selectAll',
    ]);
    const labels = all.map((item) => item.label ?? '').join('|');
    expect(/New|Save|Close|Reload/i.test(labels)).toBe(false);
  });

  it('回调只转交 onCommand，原样带上命令、窗口与事件', () => {
    const { all, calls } = template('linux');
    const window = { id: 'w' };
    const event = { triggeredByAccelerator: true };
    byId(all, MENU_ITEM_IDS.undo).click?.({}, window, event);
    byId(all, MENU_ITEM_IDS.reparse).click?.({}, undefined, {});
    expect(calls).toEqual([
      ['undo', window, event],
      ['reparse', undefined, {}],
    ]);
  });

  it('每次调用返回新的模板对象', () => {
    const options = { platform: 'darwin', devBuild: false, onCommand: () => undefined };
    expect(buildAppMenuTemplate(options)).not.toBe(buildAppMenuTemplate(options));
  });
});

describe('appMenu —— installAppMenu', () => {
  it('构建一次、设置一次，返回安装的菜单；模板与 buildAppMenuTemplate 相同', () => {
    const built: AppMenuItem[][] = [];
    const set: unknown[] = [];
    const menu = { marker: 'menu' };
    const result = installAppMenu({
      platform: 'win32',
      devBuild: false,
      onCommand: () => undefined,
      buildFromTemplate: (items) => {
        built.push(items);
        return menu;
      },
      setApplicationMenu: (value) => set.push(value),
    });
    expect(result).toBe(menu);
    expect(set).toEqual([menu]);
    expect(built).toHaveLength(1);
    expect(flatten(built[0] ?? []).map((item) => item.id ?? item.role ?? item.label ?? item.type)).toEqual(
      flatten(buildAppMenuTemplate({ platform: 'win32', devBuild: false, onCommand: () => undefined })).map((item) => item.id ?? item.role ?? item.label ?? item.type),
    );
  });
});
