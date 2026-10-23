/**
 * 编辑命令的窗口接线与派发路由（M3 T3b；T3 Preflight r3 §7.2–§7.4，用户裁决 Q2 方案 B / Q-B3，SP-KEY-P 实证）。
 *
 * Undo / Redo 唯一派发：
 * - **键盘唯一路径**是每个窗口的 `before-input-event`：按 `input.key`（不区分大小写，不用 `input.code`，与菜单加速键的字符口径
 *   一致）+ 修饰键匹配 —— macOS 为 Cmd（且无 Ctrl），其它平台为 Ctrl（且无 Meta），都不含 Alt；Shift 表示 redo；非 macOS 另有
 *   Ctrl+Y = redo。匹配后一律 `preventDefault()`（同时挡住页面 keydown 与菜单快捷键）；只有 `keyDown` 派发（含 auto-repeat），
 *   keyUp 只阻止。派发来源 `key-intercept`，并置一个本窗口的一次性标志，到下一个事件循环 tick 清除。
 * - **菜单路径**：显式点击（`triggeredByAccelerator !== true`）派发 `menu-click`。加速键触发时：Undo / Redo 若本轮已
 *   key-intercept 则丢弃（防重复）；任何命令在 DevTools 有焦点时都丢弃（Q-B3：防止在 DevTools 里按键作用到文档）；
 *   否则派发 `menu-accelerator`（SP-KEY-P：菜单展开时 `before-input-event` 不触发，只有这条兜底）。
 * - 没有目标窗口（undefined / null）、窗口未经本接线登记、已销毁或 renderer 已崩溃时安全丢弃；命令只发给菜单所属的那个窗口，
 *   从不广播。
 *
 * reload 键纵深拦截：F5（含 Shift / Ctrl 组合）与 Shift+Cmd/Ctrl+R 只 `preventDefault()`、不派发；`Cmd/Ctrl+R` 不在此拦截，
 * 它只由菜单加速键归属为 Reparse。真正的数据保护依据是 renderer 的同步 beforeunload（T3a）。
 *
 * **本模块不 import electron**：窗口与 webContents 按结构类型传入。main 与真实窗口 smoke 共用这一份接线。
 */

import { IPC } from '../../shared/ipc';
import type { MenuCommand, MenuCommandMessage, MenuCommandSource } from '../../shared/menuContracts';
import type { MenuClickEventLike } from './appMenu';

/** `before-input-event` 的 input 中本模块用到的部分。 */
export interface KeyInputLike {
  readonly type: string;
  readonly key: string;
  /** 物理键位；匹配**不使用**它（SP-KEY-P：Dvorak 下 `key=z / code=Slash`、`key=; / code=KeyZ`）。 */
  readonly code: string;
  readonly shift: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  readonly isAutoRepeat: boolean;
}

export interface PreventableEventLike {
  preventDefault(): void;
}

/** `WebContents` 中本模块用到的部分。 */
export interface EditorContentsLike {
  readonly id: number;
  on(event: 'before-input-event', listener: (event: PreventableEventLike, input: KeyInputLike) => void): unknown;
  isDevToolsFocused(): boolean;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  send(channel: string, message: MenuCommandMessage): void;
}

/** `BrowserWindow` 中本模块用到的部分。 */
export interface EditorWindowLike {
  readonly webContents: EditorContentsLike;
}

export type HistoryKeyCommand = 'undo' | 'redo';

/** 平台主修饰键：macOS 为 Cmd 且无 Ctrl，其它平台为 Ctrl 且无 Meta。 */
function primaryModifier(input: KeyInputLike, platform: string): boolean {
  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
}

/** Undo / Redo 按键匹配（不看 `type`，keyDown / keyUp 都匹配，由调用方决定是否派发）。 */
export function matchHistoryKey(input: KeyInputLike, platform: string): HistoryKeyCommand | null {
  if (!primaryModifier(input, platform) || input.alt) return null;
  const key = input.key.toLowerCase();
  if (key === 'z') return input.shift ? 'redo' : 'undo';
  if (platform !== 'darwin' && key === 'y' && !input.shift) return 'redo';
  return null;
}

/** reload 类按键：任意 F5，或 Shift + 主修饰键 + R。普通 Cmd/Ctrl+R 不算（归属 Reparse）。 */
export function isReloadKey(input: KeyInputLike, platform: string): boolean {
  if (input.key === 'F5') return true;
  return input.shift && !input.alt && primaryModifier(input, platform) && input.key.toLowerCase() === 'r';
}

export type MenuRouteOutcome =
  | 'dispatched'
  | 'dropped:no-window'
  | 'dropped:destroyed'
  | 'dropped:crashed'
  | 'dropped:key-intercepted'
  | 'dropped:devtools-focused';

export interface EditorCommandRouterDeps {
  readonly platform: string;
  /** 发送一条命令；产品为 `sendMenuCommand`，smoke 在其外层记录。 */
  readonly send: (contents: EditorContentsLike, message: MenuCommandMessage) => void;
  /** 安排到下一个事件循环 tick 执行（产品为 `setImmediate`）。 */
  readonly nextTick: (task: () => void) => void;
}

export interface EditorCommandRouter<W extends EditorWindowLike> {
  /** 登记窗口并接上它的 `before-input-event`；返回 webContents id。只经 `wireEditorWindow` 调用。 */
  wire(window: W): number;
  /** 菜单项回调：按 §7.2 规则派发或丢弃。 */
  handleMenuCommand(command: MenuCommand, window: object | null | undefined, event: MenuClickEventLike): MenuRouteOutcome;
}

/** 产品的发送函数：唯一一处向 `IPC.menuCommand` 发送。 */
export function sendMenuCommand(contents: EditorContentsLike, message: MenuCommandMessage): void {
  contents.send(IPC.menuCommand, message);
}

interface WiredWindow {
  readonly contents: EditorContentsLike;
  keyIntercepted: boolean;
}

export function createEditorCommandRouter<W extends EditorWindowLike>(deps: EditorCommandRouterDeps): EditorCommandRouter<W> {
  const wired = new WeakMap<object, WiredWindow>();

  const dispatch = (target: WiredWindow, command: MenuCommand, source: MenuCommandSource): void => {
    deps.send(target.contents, Object.freeze({ command, source }));
  };

  return {
    wire(window) {
      const contents = window.webContents;
      const target: WiredWindow = { contents, keyIntercepted: false };
      wired.set(window, target);
      contents.on('before-input-event', (event, input) => {
        if (isReloadKey(input, deps.platform)) {
          event.preventDefault();
          return;
        }
        const command = matchHistoryKey(input, deps.platform);
        if (command === null) return;
        event.preventDefault();
        if (input.type !== 'keyDown') return;
        target.keyIntercepted = true;
        deps.nextTick(() => {
          target.keyIntercepted = false;
        });
        dispatch(target, command, 'key-intercept');
      });
      return contents.id;
    },
    handleMenuCommand(command, window, event) {
      const target = window === undefined || window === null ? undefined : wired.get(window);
      if (target === undefined) return 'dropped:no-window';
      if (target.contents.isDestroyed()) return 'dropped:destroyed';
      if (target.contents.isCrashed()) return 'dropped:crashed';
      if (event.triggeredByAccelerator !== true) {
        dispatch(target, command, 'menu-click');
        return 'dispatched';
      }
      if ((command === 'undo' || command === 'redo') && target.keyIntercepted) return 'dropped:key-intercepted';
      if (target.contents.isDevToolsFocused()) return 'dropped:devtools-focused';
      dispatch(target, command, 'menu-accelerator');
      return 'dispatched';
    },
  };
}

/** 每个窗口登记一次（main 与 smoke 共用；位置在安全与 Open 接线之后、加载页面之前）。返回 webContents id。 */
export function wireEditorWindow<W extends EditorWindowLike>(router: EditorCommandRouter<W>, window: W): number {
  return router.wire(window);
}
