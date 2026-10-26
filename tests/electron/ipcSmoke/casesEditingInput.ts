/**
 * I 组：源码编辑的代码路径（M3 T3c；Preflight r1 §8、r1.1 §5；用户裁决 Q9-A / Q8-B′）。
 *
 * 每个用例一个独立子进程（`ui.edit-path-` 前缀，真实生产 renderer + 生产 preload + 生产菜单 / 按键接线）。
 * - macOS：原生平台，直接运行。Windows / Linux：先经 CDP `Emulation.setUserAgentOverride` 把平台提示设为 macOS 再重载页面，
 *   让门控开放编辑，**只用于自动化覆盖编辑代码路径**：这不是该平台的输入法、菜单、键盘或窗口行为验收，更不是 G4-Windows / G4-Linux。
 * - 输入手段：`webContents.insertText`、`sendInputEvent`（Backspace、Cmd/Ctrl+Z）、`webContents.paste()`、CDP `Input.imeSetComposition` /
 *   `Input.insertText`（合成组字），均为合成输入（T3c Preflight r0 §4、§5 的 A 组实测路径）。读取只经产品 DOM（状态栏数据属性与 textarea）。
 * - 精确字节（CRLF / 孤立 CR / 受保护 U+FEFF）由单测断言；这里验证 view、版本、dirty、解析联动、撤销恰一步与 Open / unload 保护。
 * 用例结束前把文档撤销回 clean 或 destroy 窗口，避免 dirty 窗口卡住收尾。
 */

import { clipboard, Menu } from 'electron';
import type { BrowserWindow } from 'electron';

import { MENU_ITEM_IDS } from '../../../src/main/menu/appMenu';
import type { MenuCommand } from '../../../src/shared/menuContracts';
import { classifyConsole, consoleRecorder, expectEqual, expectTrue, verdict } from './context';
import type { SmokeContext } from './context';
import type { IsolatedCase } from './casesIsolated';
import { delay } from './harness';
import { isRecord } from './replies';
import type { SmokeWindow } from './windows';

export interface EditorDoc {
  readonly sourceVersion: number;
  readonly parsedVersion: number;
  readonly dirty: boolean;
  readonly notice: string;
  readonly value: string;
  readonly readOnly: boolean;
  readonly readOnlyNote: boolean;
  readonly uaPlatform: string | null;
}

const READ_EDITOR = `(() => {
  const bar = document.querySelector('.editor-status');
  const source = document.querySelector('.source-editor');
  if (bar === null || source === null) return null;
  const uad = navigator.userAgentData;
  return {
    sourceVersion: Number(bar.getAttribute('data-source-version')),
    parsedVersion: Number(bar.getAttribute('data-parsed-version')),
    dirty: bar.getAttribute('data-source-dirty') === 'true',
    notice: bar.getAttribute('data-editor-notice') ?? '',
    value: source.value,
    readOnly: source.readOnly === true,
    readOnlyNote: document.querySelector('.source-readonly-note') !== null,
    uaPlatform: uad && typeof uad.platform === 'string' ? uad.platform : null,
  };
})()`;

export async function readEditor(window: SmokeWindow): Promise<EditorDoc | null> {
  const result = await window.call(READ_EDITOR, 2_000);
  if (!result.ok || !isRecord(result.value)) return null;
  const v = result.value;
  return {
    sourceVersion: Number(v.sourceVersion),
    parsedVersion: Number(v.parsedVersion),
    dirty: v.dirty === true,
    notice: String(v.notice),
    value: String(v.value),
    readOnly: v.readOnly === true,
    readOnlyNote: v.readOnlyNote === true,
    uaPlatform: typeof v.uaPlatform === 'string' ? v.uaPlatform : null,
  };
}

/** 轮询直到满足条件；超时返回 null（调用方断言随之失败）。 */
export async function waitEditor(window: SmokeWindow, predicate: (doc: EditorDoc) => boolean, timeoutMs = 3_000): Promise<EditorDoc | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const doc = await readEditor(window);
    if (doc !== null && predicate(doc)) return doc;
    await delay(50);
  }
  return null;
}

export const cdp = (win: BrowserWindow, method: string, params: Record<string, unknown> = {}): Promise<unknown> => win.webContents.debugger.sendCommand(method, params);

/** 显示并聚焦的生产 renderer 窗口；`emulateMac` 时在非 macOS 平台上覆盖 UA 平台提示后重载页面。 */
export async function editorWindow(ctx: SmokeContext, emulateMac: boolean) {
  const recorder = consoleRecorder();
  const window = await ctx.windows.create({ show: true, onCreated: recorder.attach });
  window.win.webContents.debugger.attach('1.3');
  if (emulateMac && process.platform !== 'darwin') {
    const userAgent = window.win.webContents.getUserAgent();
    await cdp(window.win, 'Emulation.setUserAgentOverride', {
      userAgent,
      platform: 'MacIntel',
      userAgentMetadata: { platform: 'macOS', platformVersion: '15.0.0', architecture: 'arm', model: '', mobile: false },
    });
    const loaded = window.nextLoad(10_000);
    window.win.webContents.reload();
    await loaded;
  }
  // 产品样式在视口宽度 ≤ 1180px 时隐藏源码面板（`global.css` 的 media query）；smoke 窗口只有 640px 宽，
  // 用页面缩放 0.5 让 CSS 视口变为 1280px，源码面板可见、可聚焦（不改窗口工厂，也不改产品样式）。
  window.win.webContents.setZoomFactor(0.5);
  window.win.focus();
  window.win.webContents.focus();
  const ready = (await waitEditor(window, (doc) => doc.notice === '', 5_000)) !== null;
  return { window, consoleEntries: recorder.entries, ready };
}

/** 聚焦源码面板并设置 view 选区（测试侧页面脚本，不是产品钩子）。 */
export async function focusSource(window: SmokeWindow, start: number, end = start): Promise<boolean> {
  const result = await window.call(`(() => { const t = document.querySelector('.source-editor'); t.focus(); t.setSelectionRange(${String(start)}, ${String(end)}); return document.activeElement === t; })()`);
  await delay(100);
  return result.ok && result.value === true;
}

const PRIMARY: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';

export function pressKey(window: SmokeWindow, keyCode: string, modifiers: ('shift' | 'control' | 'meta' | 'alt')[] = []): void {
  window.win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  window.win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

export const undoKey = (window: SmokeWindow): void => pressKey(window, 'Z', [PRIMARY]);
const redoKey = (window: SmokeWindow): void => pressKey(window, 'Z', ['shift', PRIMARY]);

function invokeMenu(command: MenuCommand, win: BrowserWindow): boolean {
  const item = Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_IDS[command]) ?? null;
  if (item === null) return false;
  const click = item.click as unknown as (event: unknown, focusedWindow?: BrowserWindow, focusedWebContents?: Electron.WebContents) => void;
  click({ triggeredByAccelerator: false }, win, win.webContents);
  return true;
}

/** 状态栏的文档会话 id（`.file-status[data-document-id]`）。 */
async function readDocumentId(window: SmokeWindow): Promise<string | null> {
  const result = await window.call(`(() => { const f = document.querySelector('.file-status'); return f === null ? null : f.getAttribute('data-document-id'); })()`);
  return result.ok && typeof result.value === 'string' ? result.value : null;
}

/** 比较用的文档状态（不含提示）。 */
const docState = (doc: EditorDoc | null) => (doc === null ? null : [doc.sourceVersion, doc.parsedVersion, doc.dirty, doc.value]);

/** 撤销到 clean；仍 dirty 时 destroy 窗口，避免收尾时被 beforeunload 卡住。 */
async function cleanUp(window: SmokeWindow): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const doc = await readEditor(window);
    if (doc === null || !doc.dirty) return;
    undoKey(window);
    await delay(150);
  }
  if (!window.win.isDestroyed()) window.win.destroy();
}

const uiEditPathInput: IsolatedCase = {
  id: 'ui.edit-path-input',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editorWindow(ctx, true);
    const problems: string[] = [];
    expectTrue(problems, 'editor ready', ready);
    const initial = await readEditor(window);
    expectEqual(problems, 'editing enabled (macOS or code-path emulation)', initial?.readOnly, false);
    const v0 = initial?.sourceVersion ?? 0;
    const original = initial?.value ?? '';
    expectTrue(problems, 'focus source', await focusSource(window, 0));

    await window.win.webContents.insertText('x');
    const typed = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 1);
    expectEqual(problems, 'insertText: one transaction, view updated', typed?.value, `x${original}`);
    expectEqual(problems, 'insertText: dirty', typed?.dirty, true);
    // stale 快照保留由单测断言（时序敏感，不在 smoke 中断言）；这里只验证 debounce 之后解析追上。
    const parsed = await waitEditor(window, (doc) => doc.parsedVersion === v0 + 1, 3_000);
    expectTrue(problems, 'debounced parse catches up', parsed !== null);

    pressKey(window, 'Backspace');
    const deleted = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 2);
    expectEqual(problems, 'Backspace: one transaction, back to original view', deleted?.value, original);

    clipboard.writeText('P\r\nQ');
    window.win.webContents.paste();
    const pasted = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 3);
    expectEqual(problems, 'paste: CRLF normalized in the view', pasted?.value, `P\nQ${original}`);

    undoKey(window);
    const undone = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 4);
    expectEqual(problems, 'Cmd/Ctrl+Z: exactly one history step', undone?.value, original);
    // undo 后立即解析（不走 500ms debounce）：观察窗口取 300ms。
    const reparsed = await waitEditor(window, (doc) => doc.parsedVersion === v0 + 4, 300);
    expectTrue(problems, 'undo parses immediately', reparsed !== null);
    redoKey(window);
    const redone = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 5);
    expectEqual(problems, 'Shift+Cmd/Ctrl+Z: exactly one redo step', redone?.value, `P\nQ${original}`);

    // 不支持的类型（删词）：fail closed，版本与内容都不变。
    pressKey(window, 'Backspace', [process.platform === 'darwin' ? 'alt' : 'control']);
    await delay(300);
    const word = await readEditor(window);
    expectEqual(problems, 'word delete fails closed', [word?.sourceVersion, word?.value], [v0 + 5, `P\nQ${original}`]);
    // macOS 上 Option+Backspace 必然产生 deleteWordBackward：同时断言 fail closed 的提示，排除「按键没送达也通过」。
    if (process.platform === 'darwin') expectEqual(problems, 'word delete notice', word?.notice, 'input-unsupported');

    await cleanUp(window);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { platform: process.platform, emulated: process.platform !== 'darwin' });
  },
};

const uiEditPathIme: IsolatedCase = {
  id: 'ui.edit-path-ime',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editorWindow(ctx, true);
    const problems: string[] = [];
    expectTrue(problems, 'editor ready', ready);
    const initial = await readEditor(window);
    const v0 = initial?.sourceVersion ?? 0;
    const original = initial?.value ?? '';
    expectTrue(problems, 'focus source', await focusSource(window, 0));

    // clean + 组字中关窗：beforeunload 判定时仍在组字中 → 由组字条件阻止（路径 A）。必须在任何提交之前做，
    // 否则文档已 dirty，阻止的是 dirty 条件，证明不了组字条件。
    await cdp(window.win, 'Input.imeSetComposition', { text: 'ha', selectionStart: 2, selectionEnd: 2 });
    expectEqual(problems, 'composing while clean', (await readEditor(window))?.dirty, false);
    window.win.close();
    await delay(800);
    expectTrue(problems, 'clean close while composing is blocked', !window.win.isDestroyed());
    const composingBlock = await waitEditor(window, (doc) => doc.notice === 'unload-blocked-composing');
    expectTrue(problems, 'blocked by the composing condition (not dirty)', composingBlock !== null);

    // Gate B1 复核补测（M-8、U-5 主进程 reload）：真实产品代码的程序化入口测试，不是物理快捷键或真实用户菜单验收。
    // 仍在 clean + 组字中：经 main 真实菜单回调触发 Open / Reparse，再由 main 直接 webContents.reload()。
    const atComposing = await readEditor(window);
    const documentBefore = await readDocumentId(window);
    const chooserCalls = ctx.chooser.calls.length;
    expectTrue(problems, 'open menu item invoked while composing', invokeMenu('open', window.win));
    const openRefused = await waitEditor(window, (doc) => doc.notice === 'open-refused-composing');
    expectTrue(problems, 'composing Open refused with notice', openRefused !== null);
    expectEqual(problems, 'composing Open: no native dialog', ctx.openIpc.pendingNativeDialogs(), 0);
    expectEqual(problems, 'composing Open: chooser not called', ctx.chooser.calls.length, chooserCalls);
    expectTrue(problems, 'reparse menu item invoked while composing', invokeMenu('reparse', window.win));
    const reparseIgnored = await waitEditor(window, (doc) => doc.notice === 'reparse-ignored-composing');
    expectTrue(problems, 'composing Reparse ignored with notice', reparseIgnored !== null);
    await delay(300);
    expectEqual(problems, 'composing Open / Reparse: versions, dirty and DOM unchanged', docState(await readEditor(window)), docState(atComposing));
    expectEqual(problems, 'composing Open / Reparse: same document session', await readDocumentId(window), documentBefore);

    // beforeunload 只在页面有过用户激活时才能阻止导航（Preflight 探针）：先断言前提，结论才有意义。
    const marked = await window.call('(() => { window.__t3cReloadMarker = 1; return navigator.userActivation.hasBeenActive; })()');
    expectTrue(problems, 'page has user activation before reload', marked.ok && marked.value === true);
    window.win.webContents.reload();
    const reloadBlocked = await waitEditor(window, (doc) => doc.notice === 'unload-blocked-composing');
    expectTrue(problems, 'composing reload blocked by the composing condition (not dirty)', reloadBlocked !== null && !reloadBlocked.dirty);
    await delay(500);
    const marker = await window.call('window.__t3cReloadMarker === 1');
    expectTrue(problems, 'page not reloaded', marker.ok && marker.value === true);
    expectEqual(problems, 'reload blocked: versions, dirty and DOM unchanged', docState(await readEditor(window)), docState(atComposing));
    expectEqual(problems, 'reload blocked: same document session', await readDocumentId(window), documentBefore);

    await cdp(window.win, 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await delay(200);
    expectEqual(problems, 'composition canceled, still clean', [(await readEditor(window))?.sourceVersion, (await readEditor(window))?.dirty], [v0, false]);
    // 被拒的 Open / Reparse 与被阻止的 reload 都没有建事务：History 仍为空。
    undoKey(window);
    const nothing = await waitEditor(window, (doc) => doc.notice === 'nothing-to-undo');
    expectEqual(problems, 'History unchanged (nothing to undo)', [nothing?.sourceVersion, nothing?.dirty, nothing?.value], [v0, false, original]);

    // 合成组字提交：恰一个事务。
    await cdp(window.win, 'Input.imeSetComposition', { text: 'n', selectionStart: 1, selectionEnd: 1 });
    await cdp(window.win, 'Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    const composing = await readEditor(window);
    expectEqual(problems, 'composing: session unchanged', composing?.sourceVersion, v0);
    await cdp(window.win, 'Input.insertText', { text: '你' });
    const committed = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 1);
    expectEqual(problems, 'IME commit: one transaction', committed?.value, `你${original}`);
    await delay(300);
    expectEqual(problems, 'IME commit: no second transaction', (await readEditor(window))?.sourceVersion, v0 + 1);

    // 合成组字取消：不建事务。
    await cdp(window.win, 'Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await cdp(window.win, 'Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await delay(300);
    const canceled = await readEditor(window);
    expectEqual(problems, 'IME cancel: no transaction', [canceled?.sourceVersion, canceled?.value], [v0 + 1, `你${original}`]);

    // Q8-B′：提交后无按键的相同文本照常接受（不吸收）。
    await cdp(window.win, 'Input.imeSetComposition', { text: 'ni', selectionStart: 2, selectionEnd: 2 });
    await cdp(window.win, 'Input.insertText', { text: '你' });
    await waitEditor(window, (doc) => doc.sourceVersion === v0 + 2);
    await cdp(window.win, 'Input.insertText', { text: '你' });
    const trailing = await waitEditor(window, (doc) => doc.sourceVersion === v0 + 3);
    expectTrue(problems, 'Q8-B′: trailing same text is accepted, not absorbed', trailing !== null);

    await cleanUp(window);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { platform: process.platform, emulated: process.platform !== 'darwin' });
  },
};

const uiEditPathGuard: IsolatedCase = {
  id: 'ui.edit-path-guard',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries, ready } = await editorWindow(ctx, true);
    const problems: string[] = [];
    expectTrue(problems, 'editor ready', ready);
    const v0 = (await readEditor(window))?.sourceVersion ?? 0;
    expectTrue(problems, 'focus source', await focusSource(window, 0));
    await window.win.webContents.insertText('d');
    expectTrue(problems, 'dirty after typing', (await waitEditor(window, (doc) => doc.dirty && doc.sourceVersion === v0 + 1)) !== null);

    // dirty 时 Open 被拒：不弹对话框、不调用选择器。
    const chooserCalls = ctx.chooser.calls.length;
    expectTrue(problems, 'open menu item invoked', invokeMenu('open', window.win));
    const refused = await waitEditor(window, (doc) => doc.notice === 'open-refused-dirty');
    expectTrue(problems, 'dirty Open refused with notice', refused !== null);
    expectEqual(problems, 'no native dialog', ctx.openIpc.pendingNativeDialogs(), 0);
    expectEqual(problems, 'chooser not called', ctx.chooser.calls.length, chooserCalls);

    // dirty 时关窗被阻止；撤销回 clean 后可以关闭。
    window.win.close();
    await delay(800);
    expectTrue(problems, 'dirty close blocked', !window.win.isDestroyed());
    const blocked = await waitEditor(window, (doc) => doc.notice === 'unload-blocked-dirty');
    expectTrue(problems, 'unload-blocked notice', blocked !== null);
    undoKey(window);
    const clean = await waitEditor(window, (doc) => !doc.dirty && doc.sourceVersion === v0 + 2);
    expectTrue(problems, 'undo back to clean', clean !== null);
    window.win.close();
    const deadline = Date.now() + 3_000;
    while (!window.win.isDestroyed() && Date.now() < deadline) await delay(50);
    expectTrue(problems, 'clean close succeeds', window.win.isDestroyed());
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { platform: process.platform, emulated: process.platform !== 'darwin' });
  },
};

export const EDITING_INPUT_CASES: readonly IsolatedCase[] = [uiEditPathInput, uiEditPathIme, uiEditPathGuard];
