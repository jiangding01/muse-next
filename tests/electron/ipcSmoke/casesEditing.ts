/**
 * H 组：菜单、快捷键与命令桥（M3 T3b；T3 Preflight r3 §11.3，实施 Gate v2 SP-KEY-I，用户裁决 Q-B3 / Q-B4 / R2 / R3）。
 *
 * 每个用例一个独立子进程（`ui.` 前缀，真实生产 renderer + 生产 preload）。main 侧经生产 `installAppMenu` 安装菜单、每个窗口经
 * 生产 `wireEditorWindow` 登记；`ctx.menuCommands` 只在生产 `sendMenuCommand` 外层记录实际发出的 `{ command, source }`。
 * renderer 侧只读状态栏的产品数据属性（`data-source-version` / `data-parsed-version` / `data-editor-notice`）与「知道了」按钮，
 * 产品 DOM 不含任何来源或计数类测试钩子。本组用例不做任何编辑，文档恒为 clean：撤销 / 重做只能得到「没有可撤销 / 可重做」
 * 提示且版本不变（Q-B4；有真实历史时的版本 +1 由 T3c 的 `ui.edit-path-*` 覆盖）。源码面板是否只读随 T3c 平台门控（Q9-A）：
 * macOS 可编辑，Windows / Linux 只读。
 *
 * 证据等级（必须如实区分）：
 * - 菜单用例调用的是 `MenuItem.click(event, window, webContents)`：它执行的是菜单项回调与生产路由，**不是原生菜单交互**；
 *   `triggeredByAccelerator` 由测试显式给出。原生菜单与加速键的真实行为只由 macOS 实机复验（SP-KEY-I）证明。
 * - 按键用例用 `webContents.sendInputEvent` 合成按键：SP-KEY-P 实测它会经过 `before-input-event`，但不会触发 macOS 原生菜单加速键；
 *   因此这里只证明 key-intercept 路径的唯一派发，不证明加速键兜底。
 */

import { app, Menu } from 'electron';
import type { BrowserWindow, MenuItem } from 'electron';

import { MENU_ITEM_IDS } from '../../../src/main/menu/appMenu';
import type { MenuCommand, MenuCommandMessage } from '../../../src/shared/menuContracts';
import { classifyConsole, consoleRecorder, expectEqual, expectTrue, verdict } from './context';
import type { MenuCommandRecord, SmokeContext } from './context';
import type { IsolatedCase } from './casesIsolated';
import { delay, waitFor } from './harness';
import { isRecord } from './replies';
import type { SmokeWindow } from './windows';

const SETTLE_MS = 400;
const PRIMARY: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';

interface StatusDoc {
  readonly sourceVersion: string;
  readonly parsedVersion: string;
  readonly dirty: string;
  readonly notice: string;
  readonly documentId: string;
  readonly readOnly: boolean;
}

const READ_STATUS = `(() => {
  const bar = document.querySelector('.editor-status');
  const file = document.querySelector('.file-status');
  const source = document.querySelector('.source-editor');
  if (bar === null || file === null || source === null) return null;
  return {
    sourceVersion: bar.getAttribute('data-source-version'),
    parsedVersion: bar.getAttribute('data-parsed-version'),
    dirty: bar.getAttribute('data-source-dirty'),
    notice: bar.getAttribute('data-editor-notice'),
    documentId: file.getAttribute('data-document-id'),
    readOnly: source.readOnly === true,
  };
})()`;

async function readStatus(window: SmokeWindow): Promise<StatusDoc | null> {
  const result = await window.call(READ_STATUS, 2_000);
  if (!result.ok || !isRecord(result.value)) return null;
  const value = result.value;
  return {
    sourceVersion: String(value.sourceVersion),
    parsedVersion: String(value.parsedVersion),
    dirty: String(value.dirty),
    notice: String(value.notice),
    documentId: String(value.documentId),
    readOnly: value.readOnly === true,
  };
}

/** 轮询状态栏直到 notice 等于期望；超时返回 null（调用方的断言随之失败，不会命中残留的旧提示）。 */
async function waitNotice(window: SmokeWindow, notice: string, timeoutMs = 3_000): Promise<StatusDoc | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await readStatus(window);
    if (current !== null && current.notice === notice) return current;
    await delay(50);
  }
  return null;
}

/** 点状态栏提示的「知道了」（产品按钮），等待提示清空。 */
async function dismissNotice(window: SmokeWindow): Promise<boolean> {
  await window.call(`(() => { const b = document.querySelector('.editor-status-notice button'); if (b !== null) b.click(); return true; })()`);
  return (await waitNotice(window, '')) !== null;
}

/** 生产 renderer 窗口（显示并聚焦：合成按键需要窗口与 webContents 有焦点）；控制台记录在加载之前挂上。 */
async function editingWindow(ctx: SmokeContext) {
  const recorder = consoleRecorder();
  const window = await ctx.windows.create({ show: true, onCreated: recorder.attach });
  window.win.focus();
  window.win.webContents.focus();
  const ready = (await waitNotice(window, '', 5_000)) !== null;
  return { window, consoleEntries: recorder.entries, ready };
}

function menuItem(command: MenuCommand): MenuItem | null {
  return Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_IDS[command]) ?? null;
}

/**
 * 以显式事件、目标窗口与 webContents 调用菜单项（`MenuItem.click(event, focusedWindow, focusedWebContents)`）。
 * 这执行菜单项回调与生产路由，不是原生菜单交互。
 */
function invokeMenuItem(command: MenuCommand, window: BrowserWindow | undefined, triggeredByAccelerator: boolean): boolean {
  const item = menuItem(command);
  if (item === null) return false;
  const click = item.click as unknown as (event: unknown, focusedWindow?: BrowserWindow, focusedWebContents?: Electron.WebContents) => void;
  click({ triggeredByAccelerator }, window, window?.webContents);
  return true;
}

const describeSends = (records: readonly MenuCommandRecord[]): string[] => records.map((item) => `${String(item.ownerId)}:${item.message.command}:${item.message.source}`);

/** 自 `from` 起新增的发送记录（等待 settle，确认没有迟到的第二次派发）。 */
async function sendsSince(ctx: SmokeContext, from: number): Promise<MenuCommandRecord[]> {
  await delay(SETTLE_MS);
  return ctx.menuCommands.all().slice(from);
}

const sendOf = (ownerId: number, command: MenuCommand, source: MenuCommandMessage['source']): string => `${String(ownerId)}:${command}:${source}`;

type KeyModifier = 'shift' | 'control' | 'meta' | 'alt' | 'isautorepeat';

function pressKey(window: SmokeWindow, keyCode: string, modifiers: KeyModifier[], repeats = 0): void {
  const contents = window.win.webContents;
  contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  for (let i = 0; i < repeats; i += 1) contents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: [...modifiers, 'isautorepeat'] });
  contents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

const ROLE_FORBIDDEN = new Set(['undo', 'redo', 'reload', 'forceReload', 'forcereload', 'editMenu', 'editmenu', 'viewMenu', 'viewmenu', 'fileMenu', 'filemenu']);

function flattenMenu(items: readonly MenuItem[]): MenuItem[] {
  return items.flatMap((item) => [item, ...flattenMenu(item.submenu?.items ?? [])]);
}

const uiMenuTemplate: IsolatedCase = {
  id: 'ui.menu-template',
  realDialog: false,
  run: () => {
    const problems: string[] = [];
    const menu = Menu.getApplicationMenu();
    if (menu === null) return Promise.resolve(verdict(['application menu is not installed']));
    const items = flattenMenu(menu.items);
    const roles = items.map((item) => String(item.role ?? '')).filter((role) => role !== '');
    expectEqual(problems, 'no undo / redo / reload / forceReload / whole-menu roles', roles.filter((role) => ROLE_FORBIDDEN.has(role)), []);
    const commands: MenuCommand[] = ['open', 'undo', 'redo', 'reparse'];
    for (const command of commands) {
      const item = menuItem(command);
      expectTrue(problems, `menu item ${command} exists`, item !== null);
      expectEqual(problems, `menu item ${command} has no role`, item?.role ?? null, null);
    }
    expectEqual(problems, 'Cmd/Ctrl+R belongs to Reparse', menuItem('reparse')?.accelerator, 'CmdOrCtrl+R');
    // macOS 的 Window 菜单显式含 Close（Cmd+W，Preflight r3 §7.1）；其它平台没有该项。
    expectEqual(problems, 'close role present only on macOS', roles.includes('close'), process.platform === 'darwin');
    const nonMac = process.platform !== 'darwin';
    expectEqual(problems, 'undo registerAccelerator', menuItem('undo')?.registerAccelerator, !nonMac);
    expectEqual(problems, 'redo registerAccelerator', menuItem('redo')?.registerAccelerator, !nonMac);
    const labels = items.map((item) => item.label).join('|');
    expectTrue(problems, `no document commands or reload labels (${labels})`, !/\b(New|Save|Reload)\b/i.test(labels));
    return Promise.resolve(verdict(problems, { roles }));
  },
};

const uiMenuClickDispatch: IsolatedCase = {
  id: 'ui.menu-click-dispatch',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editingWindow(ctx);
    const problems: string[] = [];
    expectTrue(problems, 'status bar ready', ready);
    const initial = await readStatus(window);
    // M3 T3c（用户授权方案 (a)）：只读与否随平台门控——macOS 可编辑，Windows / Linux 只读。
    expectEqual(problems, 'source panel read-only only where editing is gated', initial?.readOnly, process.platform !== 'darwin');
    const id = window.ownerId;

    // 1. 显式点击 Undo / Redo：恰一次 menu-click；renderer 收到并给出「没有可撤销 / 可重做」；版本不变。
    for (const [command, notice] of [['undo', 'nothing-to-undo'], ['redo', 'nothing-to-redo']] as const) {
      const from = ctx.menuCommands.all().length;
      expectTrue(problems, `${command}: menu item invoked`, invokeMenuItem(command, window.win, false));
      const after = await waitNotice(window, notice);
      expectEqual(problems, `${command}: renderer notice`, after?.notice, notice);
      expectEqual(problems, `${command}: sends`, describeSends(await sendsSince(ctx, from)), [sendOf(id, command, 'menu-click')]);
      expectEqual(problems, `${command}: sourceVersion unchanged`, after?.sourceVersion, initial?.sourceVersion);
      expectTrue(problems, `${command}: notice dismissed`, await dismissNotice(window));
    }

    // 2. 显式点击 Reparse：恰一次；renderer 重新解析（同版本）；版本与解析版本不变。
    let from = ctx.menuCommands.all().length;
    expectTrue(problems, 'reparse: menu item invoked', invokeMenuItem('reparse', window.win, false));
    const reparsed = await waitNotice(window, 'reparsed');
    expectEqual(problems, 'reparse: renderer notice', reparsed?.notice, 'reparsed');
    expectEqual(problems, 'reparse: sends', describeSends(await sendsSince(ctx, from)), [sendOf(id, 'reparse', 'menu-click')]);
    expectEqual(problems, 'reparse: sourceVersion unchanged', reparsed?.sourceVersion, initial?.sourceVersion);
    expectEqual(problems, 'reparse: parsedVersion unchanged (same-version explicit reparse)', reparsed?.parsedVersion, initial?.parsedVersion);
    expectTrue(problems, 'reparse: notice dismissed', await dismissNotice(window));

    // 3. 状态栏「重新解析」按钮：renderer 内部来源，不经过 IPC。
    from = ctx.menuCommands.all().length;
    await window.call(`(() => { document.querySelector('.editor-status-reparse').click(); return true; })()`);
    expectEqual(problems, 'status-bar reparse: renderer notice', (await waitNotice(window, 'reparsed'))?.notice, 'reparsed');
    expectEqual(problems, 'status-bar reparse: no IPC send', describeSends(await sendsSince(ctx, from)), []);
    expectTrue(problems, 'status-bar reparse: notice dismissed', await dismissNotice(window));

    // 4. 显式点击 Open：恰一次；renderer 经 Open 控制器发起对话框（受控选择器取消），文档不变。
    from = ctx.menuCommands.all().length;
    ctx.chooser.enqueue({ kind: 'cancel' });
    expectTrue(problems, 'open: menu item invoked', invokeMenuItem('open', window.win, false));
    expectTrue(problems, 'open: dialog requested by the renderer', await waitFor(() => ctx.chooser.calls.length === 1, 5_000));
    expectEqual(problems, 'open: dialog parent is the owning window', ctx.chooser.calls[0]?.parent === window.win, true);
    expectEqual(problems, 'open: sends', describeSends(await sendsSince(ctx, from)), [sendOf(id, 'open', 'menu-click')]);
    expectEqual(problems, 'open: document unchanged', (await readStatus(window))?.documentId, initial?.documentId);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { sends: describeSends(ctx.menuCommands.all()) });
  },
};

const uiMenuRouting: IsolatedCase = {
  id: 'ui.menu-routing',
  realDialog: false,
  run: async (ctx) => {
    const a = await editingWindow(ctx);
    const b = await editingWindow(ctx);
    const problems: string[] = [];
    expectTrue(problems, 'both status bars ready', a.ready && b.ready);

    // 1. 多窗口：只发给回调给出的窗口。
    let from = ctx.menuCommands.all().length;
    invokeMenuItem('reparse', b.window.win, false);
    expectEqual(problems, 'routing: B notice', (await waitNotice(b.window, 'reparsed'))?.notice, 'reparsed');
    expectEqual(problems, 'routing: sends only to B', describeSends(await sendsSince(ctx, from)), [sendOf(b.window.ownerId, 'reparse', 'menu-click')]);
    expectEqual(problems, 'routing: A untouched', (await readStatus(a.window))?.notice, '');
    await dismissNotice(b.window);

    // 2. 没有目标窗口：安全丢弃。
    from = ctx.menuCommands.all().length;
    for (const command of ['undo', 'redo', 'reparse', 'open'] as const) invokeMenuItem(command, undefined, false);
    expectEqual(problems, 'no window: nothing sent', describeSends(await sendsSince(ctx, from)), []);

    // 3. DevTools 有焦点：四个命令的加速键都不派发；显式点击仍派发。
    const contents = b.window.win.webContents;
    const opened = new Promise<void>((resolve) => contents.once('devtools-opened', () => resolve()));
    contents.openDevTools({ mode: 'bottom', activate: true });
    await Promise.race([opened, delay(5_000)]);
    await delay(300);
    // smoke 子进程不是前台应用：macOS 上先让应用成为活动应用，窗口与 DevTools 的焦点才可观测（测试手段，不是产品行为）。
    if (process.platform === 'darwin') app.focus({ steal: true });
    b.window.win.focus();
    contents.devToolsWebContents?.focus();
    const focused = await waitFor(() => contents.isDevToolsFocused(), 5_000, 50);
    expectTrue(problems, 'devtools focus is observable (isDevToolsFocused)', focused);
    if (focused) {
      from = ctx.menuCommands.all().length;
      for (const command of ['undo', 'redo', 'reparse', 'open'] as const) invokeMenuItem(command, b.window.win, true);
      expectEqual(problems, 'devtools focused: accelerators dropped', describeSends(await sendsSince(ctx, from)), []);
      from = ctx.menuCommands.all().length;
      invokeMenuItem('undo', b.window.win, false);
      expectEqual(problems, 'devtools focused: explicit click still dispatched', describeSends(await sendsSince(ctx, from)), [
        sendOf(b.window.ownerId, 'undo', 'menu-click'),
      ]);
      expectEqual(problems, 'devtools focused: renderer received explicit undo', (await waitNotice(b.window, 'nothing-to-undo'))?.notice, 'nothing-to-undo');
      await dismissNotice(b.window);
    }
    contents.closeDevTools();
    await waitFor(() => !contents.isDevToolsOpened(), 5_000, 50);
    b.window.win.focus();
    contents.focus();

    // 4. DevTools 关闭、未拦截时：加速键以 menu-accelerator 兜底派发。
    expectTrue(problems, 'devtools no longer focused', await waitFor(() => !contents.isDevToolsFocused(), 5_000, 50));
    from = ctx.menuCommands.all().length;
    invokeMenuItem('reparse', b.window.win, true);
    expectEqual(problems, 'accelerator fallback: renderer notice', (await waitNotice(b.window, 'reparsed'))?.notice, 'reparsed');
    expectEqual(problems, 'accelerator fallback: sends', describeSends(await sendsSince(ctx, from)), [sendOf(b.window.ownerId, 'reparse', 'menu-accelerator')]);
    expectEqual(problems, 'unexpected console errors', classifyConsole([...a.consoleEntries, ...b.consoleEntries], []).unexpected, []);
    return verdict(problems, { sends: describeSends(ctx.menuCommands.all()) });
  },
};

const uiKeyIntercept: IsolatedCase = {
  id: 'ui.key-intercept',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editingWindow(ctx);
    const problems: string[] = [];
    expectTrue(problems, 'status bar ready', ready);
    const initial = await readStatus(window);
    const id = window.ownerId;
    const steps: [string, string, KeyModifier[], MenuCommand, string, number][] = [
      ['primary+Z', 'Z', [PRIMARY], 'undo', 'nothing-to-undo', 0],
      ['shift+primary+Z', 'Z', ['shift', PRIMARY], 'redo', 'nothing-to-redo', 0],
      ...(process.platform === 'darwin' ? [] : ([['ctrl+Y', 'Y', ['control'], 'redo', 'nothing-to-redo', 0]] as [string, string, KeyModifier[], MenuCommand, string, number][])),
      // 长按：一次 keyDown + 两次 auto-repeat keyDown → 恰三次派发（SP-KEY-P K5）。
      ['primary+Z held (2 auto-repeats)', 'Z', [PRIMARY], 'undo', 'nothing-to-undo', 2],
    ];
    for (const [label, keyCode, modifiers, command, notice, repeats] of steps) {
      const from = ctx.menuCommands.all().length;
      pressKey(window, keyCode, modifiers, repeats);
      const after = await waitNotice(window, notice);
      expectEqual(problems, `${label}: renderer notice`, after?.notice, notice);
      expectEqual(
        problems,
        `${label}: exactly one key-intercept send per keyDown`,
        describeSends(await sendsSince(ctx, from)),
        Array.from({ length: repeats + 1 }, () => sendOf(id, command, 'key-intercept')),
      );
      expectEqual(problems, `${label}: sourceVersion unchanged`, after?.sourceVersion, initial?.sourceVersion);
      await dismissNotice(window);
    }
    // 不匹配的组合（Alt+主修饰键+Z）不派发。
    const from = ctx.menuCommands.all().length;
    pressKey(window, 'Z', ['alt', PRIMARY]);
    expectEqual(problems, 'alt+primary+Z: nothing sent', describeSends(await sendsSince(ctx, from)), []);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { sends: describeSends(ctx.menuCommands.all()) });
  },
};

/**
 * 证据边界：替换默认菜单后 F5 等按键本来就不会重载页面，因此本用例证明的是「产品菜单与路由下这些按键不重载、不派发」，
 * 杀不死「reload 键未拦截」的变异——拦截本身由 `wireEditorWindow.test.ts` 的单测证明。
 */
const uiReloadKeysBlocked: IsolatedCase = {
  id: 'ui.reload-keys-blocked',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editingWindow(ctx);
    const problems: string[] = [];
    expectTrue(problems, 'status bar ready', ready);
    const contents = window.win.webContents;
    // 只读观测页面加载完成次数（smoke 不登记 Open 生命周期事件，见 architecture.m3t1b2b）。
    let loads = 0;
    contents.on('did-finish-load', () => {
      loads += 1;
    });
    // 测试侧在页面主世界放一个标记：页面被重载则标记消失（不是产品钩子）。
    await window.call(`(() => { window.__museSmokeReloadMarker = 'kept'; return true; })()`);
    const from = ctx.menuCommands.all().length;
    const presses: [string, KeyModifier[]][] = [
      ['F5', []],
      ['F5', ['shift']],
      ['F5', ['control']],
      ['R', ['shift', PRIMARY]],
      // Cmd/Ctrl+R 不被拦截，归属 Reparse 菜单加速键：合成按键可能（macOS 上不会）触发它，但绝不能重载页面。
      ['R', [PRIMARY]],
    ];
    for (const [keyCode, modifiers] of presses) {
      pressKey(window, keyCode, modifiers);
      await delay(150);
    }
    await delay(1_000);
    const sends = describeSends(await sendsSince(ctx, from));
    expectEqual(problems, 'no page load after the keys', loads, 0);
    const marker = await window.call('window.__museSmokeReloadMarker');
    expectEqual(problems, 'page not reloaded (marker kept)', marker.ok ? marker.value : marker.error, 'kept');
    const reparse = sendOf(window.ownerId, 'reparse', 'menu-accelerator');
    expectEqual(problems, 'only Reparse may be dispatched', sends.filter((item) => item !== reparse), []);
    expectTrue(problems, `at most one Reparse for one Cmd/Ctrl+R (${String(sends.length)})`, sends.length <= 1);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { sends });
  },
};

export const EDITING_CASES: readonly IsolatedCase[] = [uiMenuTemplate, uiMenuClickDispatch, uiMenuRouting, uiKeyIntercept, uiReloadKeysBlocked];
