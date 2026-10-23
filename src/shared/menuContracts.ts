/**
 * 菜单命令的跨进程契约（M3 T3b；T3 Preflight r3 §7.4，用户裁决 Q2 / Q-B1）。
 *
 * main 经 `IPC.menuCommand` 只向按键或菜单所属的窗口发送 `{ command, source }`；preload 用 `parseMenuCommandMessage`
 * 校验并归一化后才交给页面。`source` 只描述跨进程的派发路径：renderer 内部另有 `beforeinput` 与 `status-bar` 两个来源
 * （`HistoryDispatchSource`），它们从不经过 IPC。本模块不含任何平台依赖，main / preload / renderer 共用。
 */

export const MENU_COMMANDS = ['undo', 'redo', 'reparse', 'open'] as const;
export type MenuCommand = (typeof MENU_COMMANDS)[number];

/** `key-intercept`：main `before-input-event` 拦截；`menu-click`：显式点击菜单项；`menu-accelerator`：菜单加速键兜底。 */
export const MENU_COMMAND_SOURCES = ['key-intercept', 'menu-click', 'menu-accelerator'] as const;
export type MenuCommandSource = (typeof MENU_COMMAND_SOURCES)[number];

export interface MenuCommandMessage {
  readonly command: MenuCommand;
  readonly source: MenuCommandSource;
}

const isMember = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

/**
 * 校验一条菜单命令消息：必须是普通对象，`command` 与 `source` 都是已知取值（自有数据属性，不读原型链与 getter）。
 * 合法时返回只含这两个字段的新冻结对象（多余字段丢弃）；否则返回 null。
 */
export function parseMenuCommandMessage(value: unknown): MenuCommandMessage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return null;
  const command = Object.getOwnPropertyDescriptor(value, 'command');
  const source = Object.getOwnPropertyDescriptor(value, 'source');
  if (command === undefined || source === undefined || !('value' in command) || !('value' in source)) return null;
  if (!isMember(MENU_COMMANDS, command.value) || !isMember(MENU_COMMAND_SOURCES, source.value)) return null;
  return Object.freeze({ command: command.value, source: source.value });
}
