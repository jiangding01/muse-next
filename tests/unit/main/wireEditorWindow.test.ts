/**
 * M3 T3b：Undo / Redo 唯一派发与 reload 键拦截（`src/main/menu/wireEditorWindow.ts`；T3 Preflight r3 §7.2–§7.4，
 * 用户裁决 Q2 方案 B / Q-B3，SP-KEY-P 实证）。
 *
 * 用记录监听器的 fake 窗口驱动 `before-input-event` 与菜单回调，断言：按 `input.key` + 修饰键匹配（不用 code）、只对 keyDown
 * 派发、auto-repeat 逐次派发、keyUp 只阻止；一次性标志到下一 tick 清除；菜单显式点击 / 加速键兜底 / 本轮已拦截 / DevTools
 * 焦点四条规则（DevTools 规则覆盖全部四个命令）；reload 键只阻止不派发且 Cmd/Ctrl+R 不被拦截；没有目标窗口、未登记、已销毁
 * 时丢弃；多窗口只发给所属窗口。
 * 证据等级：单测只证明路由逻辑；真实 Electron 事件链由 smoke（合成按键、显式菜单回调）与 macOS 实机复验（SP-KEY-I）覆盖。
 */

import { describe, expect, it } from 'vitest';

import { IPC } from '../../../src/shared/ipc';
import type { MenuCommand, MenuCommandMessage } from '../../../src/shared/menuContracts';
import {
  createEditorCommandRouter,
  isReloadKey,
  matchHistoryKey,
  sendMenuCommand,
  wireEditorWindow,
} from '../../../src/main/menu/wireEditorWindow';
import type { EditorContentsLike, EditorWindowLike, KeyInputLike, PreventableEventLike } from '../../../src/main/menu/wireEditorWindow';

type InputListener = (event: PreventableEventLike, input: KeyInputLike) => void;

interface FakeWindow extends EditorWindowLike {
  readonly listeners: InputListener[];
  devToolsFocused: boolean;
  destroyed: boolean;
  crashed: boolean;
  readonly registrations: string[];
}

function fakeWindow(id: number): FakeWindow {
  const listeners: InputListener[] = [];
  const registrations: string[] = [];
  const window: FakeWindow = {
    listeners,
    registrations,
    devToolsFocused: false,
    destroyed: false,
    crashed: false,
    webContents: {
      id,
      on: (event, listener) => {
        registrations.push(event);
        listeners.push(listener);
      },
      isDevToolsFocused: () => window.devToolsFocused,
      isDestroyed: () => window.destroyed,
      isCrashed: () => window.crashed,
      send: () => {
        throw new Error('router must send through deps.send');
      },
    },
  };
  return window;
}

/** 默认 code 取 QWERTY 键位（`KeyZ` 等）；Dvorak 用例显式给出 key 与 code 不一致的组合。 */
function key(overrides: Partial<KeyInputLike>): KeyInputLike {
  const keyText = overrides.key ?? 'z';
  return { type: 'keyDown', key: keyText, code: `Key${keyText.toUpperCase()}`, shift: false, control: false, alt: false, meta: false, isAutoRepeat: false, ...overrides };
}

function rig(platform: string) {
  const sent: { id: number; message: MenuCommandMessage }[] = [];
  const ticks: (() => void)[] = [];
  const router = createEditorCommandRouter<FakeWindow>({
    platform,
    send: (contents, message) => sent.push({ id: contents.id, message }),
    nextTick: (task) => ticks.push(task),
  });
  const press = (window: FakeWindow, input: KeyInputLike): boolean => {
    let prevented = false;
    for (const listener of window.listeners) listener({ preventDefault: () => (prevented = true) }, input);
    return prevented;
  };
  const flushTicks = (): void => {
    for (const task of ticks.splice(0)) task();
  };
  return { router, sent, ticks, press, flushTicks };
}

const mac = { meta: true };
const ctrl = { control: true };

describe('matchHistoryKey —— 按 input.key 与修饰键匹配', () => {
  const cases: [string, string, Partial<KeyInputLike>, string | null][] = [
    ['darwin', 'Cmd+Z', { ...mac, key: 'z' }, 'undo'],
    ['darwin', 'Cmd+Z（大写 key）', { ...mac, key: 'Z' }, 'undo'],
    ['darwin', 'Shift+Cmd+Z（key 为大写 Z）', { ...mac, shift: true, key: 'Z' }, 'redo'],
    ['darwin', 'Dvorak：key=z / code=Slash（按字符匹配）', { ...mac, key: 'z', code: 'Slash' }, 'undo'],
    ['darwin', 'Dvorak：key=; 落在 KeyZ 物理键位（不按 code 匹配）', { ...mac, key: ';', code: 'KeyZ' }, null],
    ['darwin', 'Dvorak：Shift+Cmd+z / code=Slash', { ...mac, shift: true, key: 'Z', code: 'Slash' }, 'redo'],
    ['linux', '非 QWERTY：key=z / code=KeyY', { ...ctrl, key: 'z', code: 'KeyY' }, 'undo'],
    ['darwin', 'Ctrl+Z 不是 macOS 的撤销', { ...ctrl, key: 'z' }, null],
    ['darwin', 'Cmd+Ctrl+Z', { ...mac, ...ctrl, key: 'z' }, null],
    ['darwin', 'Alt+Cmd+Z', { ...mac, alt: true, key: 'z' }, null],
    ['darwin', 'Cmd+Y 在 macOS 不是重做', { ...mac, key: 'y' }, null],
    ['darwin', '无修饰键 z', { key: 'z' }, null],
    ['win32', 'Ctrl+Z', { ...ctrl, key: 'z' }, 'undo'],
    ['win32', 'Ctrl+Shift+Z', { ...ctrl, shift: true, key: 'Z' }, 'redo'],
    ['win32', 'Ctrl+Y', { ...ctrl, key: 'y' }, 'redo'],
    ['win32', 'Ctrl+Shift+Y 不匹配', { ...ctrl, shift: true, key: 'Y' }, null],
    ['win32', 'Meta+Z 不是 Windows 的撤销', { ...mac, key: 'z' }, null],
    ['win32', 'Ctrl+Alt+Z（AltGr）不匹配', { ...ctrl, alt: true, key: 'z' }, null],
    ['linux', 'Ctrl+Z', { ...ctrl, key: 'z' }, 'undo'],
    ['linux', 'Ctrl+Y（Linux 同样拦截）', { ...ctrl, key: 'y' }, 'redo'],
  ];
  it.each(cases)('%s %s', (platform, _label, input, expected) => {
    expect(matchHistoryKey(key(input), platform)).toBe(expected);
  });
});

describe('isReloadKey —— reload 类按键', () => {
  const cases: [string, string, Partial<KeyInputLike>, boolean][] = [
    ['darwin', 'F5', { key: 'F5' }, true],
    ['win32', 'Shift+F5', { key: 'F5', shift: true }, true],
    ['linux', 'Ctrl+F5', { key: 'F5', ...ctrl }, true],
    ['darwin', 'Shift+Cmd+R', { key: 'R', shift: true, ...mac }, true],
    ['win32', 'Ctrl+Shift+R', { key: 'R', shift: true, ...ctrl }, true],
    ['darwin', 'Cmd+R 归属 Reparse，不拦截', { key: 'r', ...mac }, false],
    ['win32', 'Ctrl+R 归属 Reparse，不拦截', { key: 'r', ...ctrl }, false],
    ['darwin', 'Shift+Ctrl+R 在 macOS 不是主修饰键', { key: 'R', shift: true, ...ctrl }, false],
    ['linux', '普通 r', { key: 'r' }, false],
  ];
  it.each(cases)('%s %s', (platform, _label, input, expected) => {
    expect(isReloadKey(key(input), platform)).toBe(expected);
  });
});

describe('before-input-event —— 键盘唯一路径', () => {
  it('wireEditorWindow 只登记一次 before-input-event，返回 webContents id', () => {
    const { router } = rig('darwin');
    const window = fakeWindow(7);
    expect(wireEditorWindow(router, window)).toBe(7);
    expect(window.registrations).toEqual(['before-input-event']);
  });

  it('keyDown：preventDefault 并恰一次 key-intercept 派发；keyUp 只阻止不派发', () => {
    const { router, sent, press } = rig('darwin');
    const window = fakeWindow(1);
    wireEditorWindow(router, window);
    expect(press(window, key(mac))).toBe(true);
    expect(press(window, key({ ...mac, type: 'keyUp' }))).toBe(true);
    expect(sent).toEqual([{ id: 1, message: { command: 'undo', source: 'key-intercept' } }]);
  });

  it('auto-repeat 的 keyDown 逐次派发（SP-KEY-P K5：长按连续撤销）', () => {
    const { router, sent, press } = rig('win32');
    const window = fakeWindow(1);
    wireEditorWindow(router, window);
    press(window, key({ ...ctrl, shift: true, key: 'Z' }));
    for (let i = 0; i < 3; i += 1) press(window, key({ ...ctrl, shift: true, key: 'Z', isAutoRepeat: true }));
    expect(sent.map((item) => item.message)).toEqual(Array.from({ length: 4 }, () => ({ command: 'redo', source: 'key-intercept' })));
  });

  it('不匹配的按键不阻止、不派发（Cmd+R 留给菜单加速键）', () => {
    const { router, sent, press } = rig('darwin');
    const window = fakeWindow(1);
    wireEditorWindow(router, window);
    expect(press(window, key({ ...mac, key: 'r' }))).toBe(false);
    expect(press(window, key({ ...mac, key: 'c' }))).toBe(false);
    expect(press(window, key({ key: 'z' }))).toBe(false);
    expect(sent).toEqual([]);
  });

  it('reload 键：只阻止，不派发任何命令', () => {
    const { router, sent, press } = rig('linux');
    const window = fakeWindow(1);
    wireEditorWindow(router, window);
    for (const input of [{ key: 'F5' }, { key: 'F5', shift: true }, { key: 'F5', ...ctrl }, { key: 'R', shift: true, ...ctrl }]) {
      expect(press(window, key(input))).toBe(true);
      expect(press(window, key({ ...input, type: 'keyUp' }))).toBe(true);
    }
    expect(sent).toEqual([]);
  });

  it('派发只发给按键所属的窗口', () => {
    const { router, sent, press } = rig('darwin');
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    wireEditorWindow(router, a);
    wireEditorWindow(router, b);
    press(b, key(mac));
    expect(sent.map((item) => item.id)).toEqual([2]);
  });
});

describe('菜单路由 —— 显式点击、加速键兜底、本轮已拦截、DevTools 焦点', () => {
  const COMMANDS: readonly MenuCommand[] = ['undo', 'redo', 'reparse', 'open'];

  it.each(COMMANDS)('%s：显式点击（triggeredByAccelerator 不为 true）派发 menu-click，DevTools 有焦点时仍派发', (command) => {
    const { router, sent } = rig('darwin');
    const window = fakeWindow(3);
    wireEditorWindow(router, window);
    expect(router.handleMenuCommand(command, window, {})).toBe('dispatched');
    window.devToolsFocused = true;
    expect(router.handleMenuCommand(command, window, { triggeredByAccelerator: false })).toBe('dispatched');
    expect(sent).toEqual([
      { id: 3, message: { command, source: 'menu-click' } },
      { id: 3, message: { command, source: 'menu-click' } },
    ]);
  });

  it.each(COMMANDS)('%s：加速键在没有拦截、DevTools 无焦点时以 menu-accelerator 兜底派发（SP-KEY-P K8）', (command) => {
    const { router, sent } = rig('darwin');
    const window = fakeWindow(3);
    wireEditorWindow(router, window);
    expect(router.handleMenuCommand(command, window, { triggeredByAccelerator: true })).toBe('dispatched');
    expect(sent).toEqual([{ id: 3, message: { command, source: 'menu-accelerator' } }]);
  });

  it.each(COMMANDS)('%s：DevTools 有焦点时加速键一律丢弃（用户裁决 Q-B3；SP-KEY-P K6c）', (command) => {
    const { router, sent } = rig('darwin');
    const window = fakeWindow(3);
    wireEditorWindow(router, window);
    window.devToolsFocused = true;
    expect(router.handleMenuCommand(command, window, { triggeredByAccelerator: true })).toBe('dropped:devtools-focused');
    expect(sent).toEqual([]);
  });

  it('本轮已 key-intercept：同窗口的 Undo / Redo 加速键丢弃；下一 tick 清除后恢复兜底', () => {
    const { router, sent, press, flushTicks } = rig('darwin');
    const window = fakeWindow(4);
    wireEditorWindow(router, window);
    press(window, key(mac));
    expect(router.handleMenuCommand('undo', window, { triggeredByAccelerator: true })).toBe('dropped:key-intercepted');
    expect(router.handleMenuCommand('redo', window, { triggeredByAccelerator: true })).toBe('dropped:key-intercepted');
    // 标志只针对 Undo / Redo：同一 tick 内 Reparse 加速键照常兜底。
    expect(router.handleMenuCommand('reparse', window, { triggeredByAccelerator: true })).toBe('dispatched');
    flushTicks();
    expect(router.handleMenuCommand('undo', window, { triggeredByAccelerator: true })).toBe('dispatched');
    expect(sent.map((item) => item.message)).toEqual([
      { command: 'undo', source: 'key-intercept' },
      { command: 'reparse', source: 'menu-accelerator' },
      { command: 'undo', source: 'menu-accelerator' },
    ]);
  });

  it('keyUp 不置拦截标志；标志按窗口隔离', () => {
    const { router, press } = rig('darwin');
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    wireEditorWindow(router, a);
    wireEditorWindow(router, b);
    press(a, key({ ...mac, type: 'keyUp' }));
    expect(router.handleMenuCommand('undo', a, { triggeredByAccelerator: true })).toBe('dispatched');
    press(a, key(mac));
    expect(router.handleMenuCommand('undo', b, { triggeredByAccelerator: true })).toBe('dispatched');
    expect(router.handleMenuCommand('undo', a, { triggeredByAccelerator: true })).toBe('dropped:key-intercepted');
  });

  it('没有目标窗口（undefined / null）、窗口未经本接线登记、renderer 已崩溃或已销毁：安全丢弃，不发送', () => {
    const { router, sent } = rig('darwin');
    const wired = fakeWindow(5);
    wireEditorWindow(router, wired);
    expect(router.handleMenuCommand('undo', undefined, {})).toBe('dropped:no-window');
    expect(router.handleMenuCommand('redo', null, { triggeredByAccelerator: true })).toBe('dropped:no-window');
    expect(router.handleMenuCommand('undo', fakeWindow(6), {})).toBe('dropped:no-window');
    expect(router.handleMenuCommand('open', {}, { triggeredByAccelerator: true })).toBe('dropped:no-window');
    wired.crashed = true;
    expect(router.handleMenuCommand('open', wired, {})).toBe('dropped:crashed');
    wired.destroyed = true;
    expect(router.handleMenuCommand('reparse', wired, {})).toBe('dropped:destroyed');
    expect(sent).toEqual([]);
  });

  it('多窗口：菜单命令只发给回调给出的那个窗口，不广播', () => {
    const { router, sent } = rig('win32');
    const a = fakeWindow(1);
    const b = fakeWindow(2);
    wireEditorWindow(router, a);
    wireEditorWindow(router, b);
    router.handleMenuCommand('reparse', a, {});
    router.handleMenuCommand('open', b, { triggeredByAccelerator: true });
    expect(sent).toEqual([
      { id: 1, message: { command: 'reparse', source: 'menu-click' } },
      { id: 2, message: { command: 'open', source: 'menu-accelerator' } },
    ]);
  });

  it('发送的消息只有 command 与 source 两个字段，且冻结', () => {
    const { router, sent } = rig('darwin');
    const window = fakeWindow(1);
    wireEditorWindow(router, window);
    router.handleMenuCommand('undo', window, {});
    const message = sent[0]?.message;
    expect(Object.keys(message ?? {})).toEqual(['command', 'source']);
    expect(Object.isFrozen(message)).toBe(true);
  });
});

describe('sendMenuCommand —— 唯一发送点', () => {
  it('经 IPC.menuCommand 发给传入的 webContents', () => {
    const calls: [string, MenuCommandMessage][] = [];
    const contents: EditorContentsLike = {
      id: 1,
      on: () => undefined,
      isDevToolsFocused: () => false,
      isDestroyed: () => false,
      isCrashed: () => false,
      send: (channel, message) => calls.push([channel, message]),
    };
    sendMenuCommand(contents, { command: 'redo', source: 'menu-click' });
    expect(calls).toEqual([[IPC.menuCommand, { command: 'redo', source: 'menu-click' }]]);
  });
});
