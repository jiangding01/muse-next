/**
 * M3 T3b：菜单命令的消息校验与 renderer 命令桥（`src/shared/menuContracts.ts`、`src/renderer/app/editor/menuBridge.ts`；
 * T3 Preflight r3 §7.4）。
 *
 * - `parseMenuCommandMessage`：只接受普通对象上两个已知取值的自有数据属性，返回只含两字段的新冻结对象；畸形输入一律 null。
 * - 命令桥：幂等（重复安装不重复订阅）、四个命令按来源路由、畸形消息与路由异常只报告不抛出、dispose 注销订阅。
 */

import { describe, expect, it } from 'vitest';

import { MENU_COMMAND_SOURCES, MENU_COMMANDS, parseMenuCommandMessage } from '../../../src/shared/menuContracts';
import type { MenuCommandMessage } from '../../../src/shared/menuContracts';
import { createMenuBridge } from '../../../src/renderer/app/editor/menuBridge';
import type { HistoryDispatchSource } from '../../../src/renderer/app/editor/editorController';

describe('parseMenuCommandMessage —— 白名单校验与归一化', () => {
  it('全部合法组合：返回只含 command / source 的新冻结对象', () => {
    for (const command of MENU_COMMANDS) {
      for (const source of MENU_COMMAND_SOURCES) {
        const input = { command, source };
        const parsed = parseMenuCommandMessage(input);
        expect(parsed).toEqual({ command, source });
        expect(parsed).not.toBe(input);
        expect(Object.isFrozen(parsed)).toBe(true);
      }
    }
  });

  it('多余字段被丢弃', () => {
    expect(parseMenuCommandMessage({ command: 'undo', source: 'menu-click', path: '/etc/passwd', extra: 1 })).toEqual({ command: 'undo', source: 'menu-click' });
    expect(Object.keys(parseMenuCommandMessage({ command: 'undo', source: 'menu-click', x: 1 }) ?? {})).toEqual(['command', 'source']);
  });

  it('renderer 内部来源（beforeinput / status-bar）不能经 IPC 出现', () => {
    expect(parseMenuCommandMessage({ command: 'undo', source: 'beforeinput' })).toBeNull();
    expect(parseMenuCommandMessage({ command: 'reparse', source: 'status-bar' })).toBeNull();
  });

  it('畸形输入一律 null', () => {
    const getter = Object.defineProperty({ source: 'menu-click' }, 'command', { get: () => 'undo', enumerable: true });
    const inherited: unknown = Object.create({ command: 'undo', source: 'menu-click' });
    class Shaped {
      command = 'undo';
      source = 'menu-click';
    }
    const inputs: unknown[] = [
      null,
      undefined,
      'undo',
      42,
      ['undo', 'menu-click'],
      {},
      { command: 'undo' },
      { source: 'menu-click' },
      { command: 'Undo', source: 'menu-click' },
      { command: 'save', source: 'menu-click' },
      { command: 'undo', source: 'key' },
      { command: 'undo', source: 'menu-click ' },
      { command: ['undo'], source: 'menu-click' },
      getter,
      inherited,
      new Shaped(),
    ];
    for (const input of inputs) expect(parseMenuCommandMessage(input)).toBeNull();
  });

  it('null 原型的普通对象可以接受', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { command: 'open', source: 'menu-accelerator' });
    expect(parseMenuCommandMessage(bare)).toEqual({ command: 'open', source: 'menu-accelerator' });
  });
});

function bridgeRig() {
  const listeners: ((message: MenuCommandMessage) => void)[] = [];
  const calls: string[] = [];
  const errors: string[] = [];
  let subscriptions = 0;
  let unsubscriptions = 0;
  let throwOn: string | null = null;
  const record = (name: string, source?: HistoryDispatchSource): void => {
    calls.push(source === undefined ? name : `${name}:${source}`);
    if (throwOn === name) throw new Error(`${name} exploded`);
  };
  const bridge = createMenuBridge({
    subscribe: (listener) => {
      subscriptions += 1;
      listeners.push(listener);
      return () => {
        unsubscriptions += 1;
        listeners.splice(listeners.indexOf(listener), 1);
      };
    },
    editor: {
      undo: (source) => {
        record('undo', source);
        return 'nothing-to-undo';
      },
      redo: (source) => {
        record('redo', source);
        return 'nothing-to-redo';
      },
      reparse: (source) => {
        record('reparse', source);
        return 'parsed';
      },
    },
    open: () => {
      record('open');
    },
    report: (error, context) => errors.push(`${context}:${error instanceof Error ? error.message : String(error)}`),
  });
  const emit = (message: unknown): void => {
    for (const listener of [...listeners]) listener(message as MenuCommandMessage);
  };
  return {
    bridge,
    calls,
    errors,
    emit,
    listenerCount: () => listeners.length,
    subscriptions: () => subscriptions,
    unsubscriptions: () => unsubscriptions,
    throwOn: (name: string | null) => {
      throwOn = name;
    },
  };
}

describe('menuBridge —— 幂等订阅与路由', () => {
  it('重复安装不重复订阅；dispose 注销后可再次安装', () => {
    const rig = bridgeRig();
    expect(rig.bridge.install()).toBe(true);
    expect(rig.bridge.install()).toBe(false);
    expect(rig.bridge.install()).toBe(false);
    expect(rig.subscriptions()).toBe(1);
    expect(rig.listenerCount()).toBe(1);
    expect(rig.bridge.installed()).toBe(true);
    rig.bridge.dispose();
    expect(rig.unsubscriptions()).toBe(1);
    expect(rig.listenerCount()).toBe(0);
    expect(rig.bridge.installed()).toBe(false);
    rig.bridge.dispose();
    expect(rig.unsubscriptions()).toBe(1);
    expect(rig.bridge.install()).toBe(true);
    expect(rig.subscriptions()).toBe(2);
  });

  it('一条消息恰一次路由：undo / redo / reparse 带来源交给编辑控制器，open 交给 Open 控制器', () => {
    const rig = bridgeRig();
    rig.bridge.install();
    rig.emit({ command: 'undo', source: 'key-intercept' });
    rig.emit({ command: 'redo', source: 'menu-click' });
    rig.emit({ command: 'reparse', source: 'menu-accelerator' });
    rig.emit({ command: 'open', source: 'menu-click' });
    expect(rig.calls).toEqual(['undo:key-intercept', 'redo:menu-click', 'reparse:menu-accelerator', 'open']);
    expect(rig.errors).toEqual([]);
  });

  it('来源逐条透传：undo / redo / reparse 与每一种跨进程来源的组合都原样交给编辑控制器（变异 18c 补测）', () => {
    const rig = bridgeRig();
    rig.bridge.install();
    const expected: string[] = [];
    for (const command of ['undo', 'redo', 'reparse'] as const) {
      for (const source of MENU_COMMAND_SOURCES) {
        rig.emit({ command, source });
        expected.push(`${command}:${source}`);
      }
    }
    expect(rig.calls).toEqual(expected);
  });

  it('未安装时不接收；dispose 之后不再路由', () => {
    const rig = bridgeRig();
    rig.emit({ command: 'undo', source: 'menu-click' });
    rig.bridge.install();
    rig.bridge.dispose();
    rig.emit({ command: 'undo', source: 'menu-click' });
    expect(rig.calls).toEqual([]);
  });

  it('畸形消息（纵深防御）：不路由，只报告', () => {
    const rig = bridgeRig();
    rig.bridge.install();
    rig.emit({ command: 'save', source: 'menu-click' });
    rig.emit({ command: 'undo', source: 'status-bar' });
    rig.emit(null);
    expect(rig.calls).toEqual([]);
    expect(rig.errors).toEqual([
      'menu-command:menu bridge: rejected malformed menu command',
      'menu-command:menu bridge: rejected malformed menu command',
      'menu-command:menu bridge: rejected malformed menu command',
    ]);
  });

  it('路由异常只报告为编辑器错误，不抛给 IPC 回调；之后的命令照常路由', () => {
    const rig = bridgeRig();
    rig.bridge.install();
    rig.throwOn('reparse');
    expect(() => rig.emit({ command: 'reparse', source: 'menu-click' })).not.toThrow();
    rig.throwOn('open');
    expect(() => rig.emit({ command: 'open', source: 'menu-accelerator' })).not.toThrow();
    rig.throwOn(null);
    rig.emit({ command: 'undo', source: 'menu-click' });
    expect(rig.errors).toEqual(['menu-command:reparse exploded', 'menu-command:open exploded']);
    expect(rig.calls).toEqual(['reparse:menu-click', 'open', 'undo:menu-click']);
  });
});
