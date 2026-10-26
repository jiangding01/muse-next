/**
 * M3 T3a：编辑命令唯一入口（`src/renderer/app/editor/editorController.ts`；T3 Preflight r3 §4.5、§7.2、§8）。
 *
 * 重点：undo / redo 经同一入口，成功后立即以对应原因 flush 解析；记录派发来源；Open 进行中或组字中一律忽略并提示；
 * 没有可撤销内容时安全 no-op；store 写入被拒按编辑器错误报告；Reparse 只 flush，不碰历史；openGate 读取 dirty 与组字。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentSession } from '../../../src/editor/session/create';
import { applySourceInput, initialEditorCore, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore, EditorNotice } from '../../../src/renderer/app/editor/editorTransitions';
import { createEditorController, museEditorController } from '../../../src/renderer/app/editor/editorController';
import { museImeSession } from '../../../src/renderer/app/editor/imeSession';
import type { ImeView } from '../../../src/renderer/app/editor/editorController';
import type { FlushReason } from '../../../src/renderer/app/editor/parseSchedule';
import type { StoreWriteResult } from '../../../src/renderer/app/store';

function typed(core: EditorCore, text: string): EditorCore {
  const end = core.session.projection.view.length;
  const selection = sourceSelectionFromView(core.session, { start: end, end });
  if (selection === null) throw new Error('selection');
  const step = applySourceInput(core, { viewPatch: { start: end, end, text }, selection, coalesce: null, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

function fixture(options: { ime?: ImeView; reject?: boolean; flushThrows?: boolean } = {}) {
  const base = initialEditorCore(createDocumentSession({ documentId: 1, source: 'abc', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null }));
  const state = { core: typed(base, 'x'), ime: options.ime ?? 'idle' };
  const flushes: FlushReason[] = [];
  const notices: EditorNotice['kind'][] = [];
  const errors: string[] = [];
  const bases: EditorCore[] = [];
  let beforeReplace = 0;
  const controller = createEditorController({
    read: () => state.core,
    apply: (core, base): StoreWriteResult => {
      bases.push(base);
      if (options.reject === true) return { ok: false, reason: 'history-unbound' };
      state.core = core;
      return { ok: true };
    },
    flush: (reason) => {
      flushes.push(reason);
      if (options.flushThrows === true) throw new Error('parse exploded');
      return 'parsed';
    },
    notify: (notice) => notices.push(notice.kind),
    report: (error, context) => errors.push(`${context}:${error instanceof Error ? error.message : String(error)}`),
    imeView: () => state.ime,
    beforeReplace: () => {
      beforeReplace += 1;
    },
  });
  return { state, controller, flushes, notices, errors, bases, beforeReplace: () => beforeReplace, base };
}

describe('editorController —— undo / redo 唯一入口', () => {
  it('undo：写入新核心后立即 flush（undo），记录来源；redo 同理', () => {
    const { state, controller, flushes } = fixture();
    expect(controller.undo('menu-click')).toBe('applied');
    expect(state.core.session.source).toBe('abc');
    expect(controller.lastDispatch()).toEqual({ command: 'undo', source: 'menu-click' });
    expect(controller.redo('key-intercept')).toBe('applied');
    expect(state.core.session.source).toBe('abcx');
    expect(flushes).toEqual(['undo', 'redo']);
    expect(controller.lastDispatch()).toEqual({ command: 'redo', source: 'key-intercept' });
  });

  it('没有可撤销 / 可重做：安全 no-op，只给提示，不 flush', () => {
    const { controller, flushes, notices } = fixture();
    expect(controller.redo('menu-click')).toBe('nothing-to-redo');
    controller.undo('menu-click');
    expect(controller.undo('menu-click')).toBe('nothing-to-undo');
    expect(notices).toEqual(['nothing-to-redo', 'nothing-to-undo']);
    expect(flushes).toEqual(['undo']);
  });

  it('Open 进行中（replacementPending）：undo / redo 一律忽略并提示，状态不变', () => {
    const { state, controller, notices } = fixture();
    const before = state.core;
    controller.setReplacementPending(true);
    expect(controller.undo('menu-click')).toBe('ignored-replacing');
    expect(controller.redo('menu-click')).toBe('ignored-replacing');
    expect(state.core).toBe(before);
    expect(notices).toEqual(['command-ignored-replacing', 'command-ignored-replacing']);
    controller.setReplacementPending(false);
    expect(controller.undo('menu-click')).toBe('applied');
  });

  it('输入法组字中：undo 忽略并提示（T3a 的产品实例恒为 idle，此处以注入验证契约）', () => {
    const { controller, notices } = fixture({ ime: 'composing' });
    expect(controller.undo('beforeinput')).toBe('ignored-composing');
    expect(notices).toEqual(['command-ignored-composing']);
  });

  it('store 写入被拒：按编辑器错误报告并提示，不 flush', () => {
    const { controller, flushes, errors, notices } = fixture({ reject: true });
    expect(controller.undo('menu-click')).toBe('failed');
    expect(errors).toEqual(['undo:undo store write rejected: history-unbound']);
    expect(notices).toEqual(['editor-error']);
    expect(flushes).toEqual([]);
  });
});

describe('editorController —— Reparse、Open 门控与组字视图', () => {
  it('Reparse 只 flush（reparse），不碰历史', () => {
    const { state, controller, flushes } = fixture();
    const history = state.core.history;
    expect(controller.reparse('menu-accelerator')).toBe('parsed');
    expect(flushes).toEqual(['reparse']);
    expect(state.core.history).toBe(history);
    expect(controller.lastDispatch()).toEqual({ command: 'reparse', source: 'menu-accelerator' });
  });

  it('状态栏按钮的 Reparse 以 status-bar 来源记录（M3 T3b，用户裁决 Q-B1）；同版本连按两次各 flush 一次、不建历史事务', () => {
    const { state, controller, flushes } = fixture();
    const { session, history } = state.core;
    controller.reparse('status-bar');
    controller.reparse('status-bar');
    expect(flushes).toEqual(['reparse', 'reparse']);
    expect(state.core.session).toBe(session);
    expect(state.core.history).toBe(history);
    expect(controller.lastDispatch()).toEqual({ command: 'reparse', source: 'status-bar' });
  });

  it('openGate：dirty 来自 source ≠ saved；composing 只认 composing（discarded / settled 不算）', () => {
    expect(fixture().controller.openGate()).toEqual({ dirty: true, composing: false });
    expect(fixture({ ime: 'composing' }).controller.openGate().composing).toBe(true);
    expect(fixture({ ime: 'discarded' }).controller.openGate().composing).toBe(false);
    expect(fixture({ ime: 'settled' }).controller.openGate().composing).toBe(false);
    const clean = fixture();
    clean.controller.undo('menu-click');
    expect(clean.controller.openGate()).toEqual({ dirty: false, composing: false });
  });

  it('prepareReplacement 调用注入的 beforeReplace；replacementPending 默认为 false', () => {
    const f = fixture();
    expect(f.controller.replacementPending()).toBe(false);
    f.controller.prepareReplacement();
    expect(f.beforeReplace()).toBe(1);
  });
});

describe('editorController —— 写入之后的异常（r3a 审查 M-4）', () => {
  it('undo 写入成功后立即解析抛错：结果仍为 applied，异常归入编辑器错误，不抛给调用方', () => {
    const { state, controller, errors } = fixture({ flushThrows: true });
    expect(controller.undo('menu-click')).toBe('applied');
    expect(state.core.session.source).toBe('abc');
    expect(errors).toEqual(['undo-parse:parse exploded']);
  });
});

describe('editorController —— 写入以读取到的状态为 CAS 基线（r3a 复核 M-1）', () => {
  it('undo / redo 把计算所依据的同一个核心对象作为基线交给 store', () => {
    const { state, controller, bases } = fixture();
    const beforeUndo = state.core;
    controller.undo('menu-click');
    const beforeRedo = state.core;
    controller.redo('menu-click');
    expect(bases).toHaveLength(2);
    expect(bases[0]).toBe(beforeUndo);
    expect(bases[1]).toBe(beforeRedo);
  });
});

describe('editorController —— M3 T3c 产品接线', () => {
  it('产品实例的 imeView 读取模块级输入法会话（不再恒为 idle）；prepareReplacement 以 open-commit 理由 discard 组字', () => {
    museImeSession.discard('detach');
    expect(museEditorController.imeView()).toBe('idle');
    museImeSession.start({ documentId: 1, version: 1, view: 'abc', base: { start: 3, end: 3 }, replacing: false });
    expect(museEditorController.imeView()).toBe('composing');
    expect(museEditorController.openGate().composing).toBe(true);
    museEditorController.prepareReplacement();
    expect(museEditorController.imeView()).toBe('discarded');
    expect(museEditorController.openGate().composing).toBe(false);
    museImeSession.discard('detach');
  });
});
