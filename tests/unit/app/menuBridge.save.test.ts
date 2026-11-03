/**
 * M3 T4 B3a-2：菜单命令桥的 Save / Save As 路由（`menuBridge.ts`；B3 r0 §3.7）。
 *
 * save / saveAs 只转交保存控制器（准入、R5、送达门都在控制器中）；未接线时只报告、不抛给 IPC 回调；其余命令路由不变。
 */

import { describe, expect, it } from 'vitest';

import { createMenuBridge } from '../../../src/renderer/app/editor/menuBridge';
import type { MenuCommandMessage } from '../../../src/shared/menuContracts';

function rig(wired: boolean) {
  let emit: (message: unknown) => void = () => undefined;
  const calls: string[] = [];
  const errors: string[] = [];
  const bridge = createMenuBridge({
    subscribe: (listener) => {
      emit = listener as (message: unknown) => void;
      return () => undefined;
    },
    editor: {
      undo: () => {
        calls.push('undo');
        return 'nothing-to-undo';
      },
      redo: () => {
        calls.push('redo');
        return 'nothing-to-redo';
      },
      reparse: () => {
        calls.push('reparse');
        return 'parsed';
      },
    },
    open: () => calls.push('open'),
    ...(wired ? { save: () => calls.push('save'), saveAs: () => calls.push('saveAs') } : {}),
    report: (error, context) => errors.push(`${context}:${error instanceof Error ? error.message : String(error)}`),
  });
  bridge.install();
  return { emit: (message: MenuCommandMessage | unknown) => emit(message), calls, errors };
}

describe('menuBridge —— Save / Save As', () => {
  it('save / saveAs 各自只转交一次；其它命令照常', () => {
    const r = rig(true);
    r.emit({ command: 'save', source: 'menu-accelerator' });
    r.emit({ command: 'saveAs', source: 'menu-click' });
    r.emit({ command: 'open', source: 'menu-click' });
    expect(r.calls).toEqual(['save', 'saveAs', 'open']);
    expect(r.errors).toEqual([]);
  });

  it('未接线时只报告（不抛给 IPC 回调）', () => {
    const r = rig(false);
    expect(() => r.emit({ command: 'save', source: 'menu-click' })).not.toThrow();
    r.emit({ command: 'saveAs', source: 'menu-click' });
    expect(r.calls).toEqual([]);
    expect(r.errors).toEqual(['menu-command:menu bridge: save is not wired', 'menu-command:menu bridge: saveAs is not wired']);
  });
});
