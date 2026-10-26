/**
 * M3 T3c：输入法提交 × 真实 store 同步订阅的集成测试（Preflight r1.1 §1.6 IC-1～IC-9、勘误 E-1 IC-2a / 2b）。
 *
 * zustand `setState` 同步通知订阅者：`applyEditorStep` 内部就会进入写回层。这里用真实 store、真实 `applyEditorStep`、
 * 真实写回订阅与真实输入法会话，钉住「正常提交不被误判为非法变化」「一次性授权」「CAS 拒绝」「写回失败」「同步重入」。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { applyEditorStep, commitSession, publishEditorView, setEditorSelection, useMuseAppStore } from '../../../src/renderer/app/store';
import type { StoreWriteResult } from '../../../src/renderer/app/store';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import type { ImeSession } from '../../../src/renderer/app/editor/imeSession';
import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import { createSourceEditorBinding } from '../../../src/renderer/app/editor/sourceEditorBinding';
import type { SourceTextareaLike } from '../../../src/renderer/app/editor/sourceEditorBinding';

type Listener = (event: unknown) => void;

function fakeElement() {
  const listeners = new Map<string, Set<Listener>>();
  let value = '';
  let start = 0;
  let end = 0;
  const calls: string[] = [];
  const failOn = new Set<string>();
  const guard = (name: string): void => {
    if (failOn.has(name)) throw new Error(`${name} failed`);
  };
  const doc: SourceTextareaLike['ownerDocument'] = { activeElement: null, addEventListener: () => undefined, removeEventListener: () => undefined };
  const fire = (type: string, event: Record<string, unknown> = {}): void => {
    for (const l of [...(listeners.get(type) ?? [])]) l(event);
  };
  return {
    calls,
    failOn,
    readOnly: false,
    ownerDocument: doc,
    get value() {
      return value;
    },
    set value(next: string) {
      guard('value');
      calls.push('value=');
      value = next;
      start = next.length;
      end = next.length;
    },
    get selectionStart() {
      return start;
    },
    get selectionEnd() {
      return end;
    },
    setRangeText(text: string, from: number, to: number) {
      guard('setRangeText');
      calls.push('setRangeText');
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
    setSelectionRange(s: number, e: number) {
      guard('setSelectionRange');
      calls.push('setSelectionRange');
      start = s;
      end = e;
    },
    addEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(l)),
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l),
    blur: () => fire('blur'),
    fire,
    select: (s: number, e: number) => {
      start = s;
      end = e;
    },
    imeWrite: (text: string, from: number, to: number) => {
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
  };
}

function open(source: string): void {
  const result = prepareCandidate({ documentId: 3, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: { capability: { id: 'c' }, displayName: 'a', displayPath: '/a' } });
  if (!result.ok) throw new Error('prepare');
  commitSession(result.candidate.session, 'trusted');
}

const current = (): EditorCore => {
  const { session, history, selection } = useMuseAppStore.getState();
  return { session, history, selection };
};

function typedAt(core: EditorCore, at: number, text: string): EditorCore {
  const selection = sourceSelectionFromView(core.session, { start: at, end: at });
  if (selection === null) throw new Error('selection');
  const step = applySourceInput(core, { viewPatch: { start: at, end: at, text }, selection, coalesce: null, label: 'other' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

function spyIme(ime: ImeSession): { ime: ImeSession; discards: string[]; consumes: number[] } {
  const discards: string[] = [];
  const consumes: number[] = [];
  return {
    discards,
    consumes,
    ime: {
      ...ime,
      discard: (reason) => {
        discards.push(reason);
        ime.discard(reason);
      },
      consumeCommit: (token, facts) => {
        const ok = ime.consumeCommit(token, facts);
        if (ok) consumes.push(token);
        return ok;
      },
    },
  };
}

interface RigOptions {
  apply?: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  /** false：写回层不登记 store 订阅（模拟订阅缺失，验证处理器兜底消费授权）。 */
  subscribe?: boolean;
}

function rig(options: RigOptions = {}) {
  const apply = options.apply ?? applyEditorStep;
  const reports: string[] = [];
  const notices: string[] = [];
  const parse: string[] = [];
  const spy = spyIme(createImeSession());
  const binding = createSourceEditorBinding({
    read: current,
    apply,
    writeSelection: setEditorSelection,
    subscribe: (listener) => (options.subscribe === false ? () => undefined : useMuseAppStore.subscribe(() => listener())),
    ime: spy.ime,
    controller: { undo: () => 'nothing-to-undo', redo: () => 'nothing-to-redo', replacementPending: () => false },
    parse: {
      sourceChanged: () => parse.push('changed'),
      flush: () => 'skipped',
      compositionStart: () => undefined,
      compositionEnd: () => undefined,
    },
    notify: (kind) => notices.push(kind),
    clearNotice: () => undefined,
    report: (_error, context) => reports.push(context),
    diagnostic: () => undefined,
    defer: (task) => task(),
    post: () => undefined,
    editingEnabled: () => true,
  });
  const el = fakeElement();
  binding.bind(el);
  return { binding, el, reports, notices, parse, ...spy };
}

function composeAtEnd(r: ReturnType<typeof rig>, data: string): void {
  const end = r.el.value.length;
  r.el.select(end, end);
  r.el.fire('compositionstart');
  r.el.imeWrite(data, end, end);
  r.el.fire('compositionend', { data });
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('IME 提交 × 同步订阅', () => {
  it('IC-1 正常提交：版本 +1、恰一个事务、settled{committed}、未调用 discard、DOM 零写入、无不变量报告', () => {
    open('abc');
    const r = rig();
    r.el.calls.length = 0;
    composeAtEnd(r, '好');
    const state = useMuseAppStore.getState();
    expect(state.session.sourceVersion).toBe(2);
    expect(state.history.undo?.size).toBe(1);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed' });
    expect(r.discards).toEqual([]);
    expect(r.consumes).toHaveLength(1);
    expect(r.el.calls).toEqual([]);
    expect(r.reports).toEqual([]);
  });

  it('IC-2a 无变化提交且选区变化（订阅者同步消费授权）：outcome = unchanged、版本不变、不调度解析、只消费一次', () => {
    open('abcd');
    const r = rig();
    r.el.select(1, 2);
    r.el.fire('compositionstart');
    r.el.imeWrite('b', 1, 2);
    r.el.fire('compositionend', { data: 'b' });
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'unchanged' });
    expect(r.consumes).toHaveLength(1);
    expect(r.parse).toEqual([]);
    expect(r.reports).toEqual([]);
  });

  it('IC-2b 无变化提交且订阅未触发写回（处理器兜底消费）：outcome = unchanged、只消费一次、不调度解析', () => {
    open('abcd');
    const r = rig({ subscribe: false });
    r.el.select(1, 2);
    r.el.fire('compositionstart');
    r.el.imeWrite('b', 1, 2);
    r.el.fire('compositionend', { data: 'b' });
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'unchanged' });
    expect(r.consumes).toHaveLength(1);
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.parse).toEqual([]);
  });

  it('IC-3a CAS 拒绝（写入方返回 base-changed、store 未变）：settled{rolled-back}、DOM 回滚、提示、无不变量报告', () => {
    open('abc');
    const r = rig({ apply: () => ({ ok: false, reason: 'base-changed' }) });
    composeAtEnd(r, '好');
    expect(useMuseAppStore.getState().session.source).toBe('abc');
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'rolled-back' });
    expect(r.el.value).toBe('abc');
    expect(r.notices).toEqual(['ime-not-applied']);
    expect(r.reports).toEqual([]);
  });

  it('IC-3b CAS 拒绝源于提交同步段内的重入写入：store 保持较新状态、结果更正为 rolled-back、DOM = store、报告一次授权外变化', () => {
    open('abc');
    const r = rig({
      apply: (core, base) => {
        const other = current();
        applyEditorStep(typedAt(other, 0, 'Z'), other);
        return applyEditorStep(core, base);
      },
    });
    composeAtEnd(r, '好');
    expect(useMuseAppStore.getState().session.source).toBe('Zabc');
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'rolled-back' });
    expect(r.el.value).toBe('Zabc');
    expect(r.notices).toEqual(['ime-not-applied']);
    expect(r.reports).toEqual(['unauthorized-change-during-commit']);
  });

  it('IC-4 授权变化中 setSelectionRange 抛错：一次整体重置，settled{committed}，报告一次，不进入 broken', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.imeWrite('好', 3, 3);
    r.el.select(0, 0);
    r.el.failOn.add('setSelectionRange');
    r.el.fire('compositionend', { data: '好' });
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed' });
    expect(r.binding.writeBack().isBroken()).toBe(false);
    expect(r.el.value).toBe('abc好');
    expect(r.reports).toEqual(['write-back-failed']);
  });

  it('IC-5 IC-4 且整体重置也抛错：broken、settled{committed}；随后可取消输入被拒且不建事务', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.imeWrite('好', 3, 3);
    r.el.select(0, 0);
    r.el.failOn.add('setSelectionRange');
    r.el.failOn.add('value');
    r.el.fire('compositionend', { data: '好' });
    expect(r.binding.writeBack().isBroken()).toBe(true);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed' });
    const version = useMuseAppStore.getState().session.sourceVersion;
    const event = { inputType: 'insertText', data: 'x', dataTransfer: null, cancelable: true, timeStamp: 1, preventDefault: () => undefined };
    r.el.fire('beforeinput', event);
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(version);
    expect(r.notices).toContain('edit-out-of-sync');
  });

  it('IC-6 重入：另一订阅者在通知中发布提示 → DOM 仍零写入、无不变量报告', () => {
    open('abc');
    const r = rig();
    const unsubscribe = useMuseAppStore.subscribe((state) => {
      if (state.editor.notice === null) publishEditorView({ notice: { kind: 'reparsed' } });
    });
    r.el.calls.length = 0;
    composeAtEnd(r, '好');
    unsubscribe();
    expect(r.el.calls).toEqual([]);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed' });
    expect(r.reports).toEqual([]);
  });

  it('IC-7 重入：先于写回层的订阅者在授权消费前做了另一次编辑写入 → committed-unverified、DOM = store、一次不变量报告', () => {
    open('abc');
    let raced = false;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      if (raced) return;
      raced = true;
      const other = current();
      applyEditorStep(typedAt(other, 0, 'Z'), other);
    });
    const r = rig();
    raced = false;
    composeAtEnd(r, '好');
    unsubscribe();
    expect(useMuseAppStore.getState().session.source).toBe('Zabc好');
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed-unverified' });
    expect(r.el.value).toBe('Zabc好');
    expect(r.reports).toContain('unauthorized-change-during-commit');
  });

  it('IC-8 组字中（未提交）store 版本变化 → discard(store-changed-while-composing)；随后 compositionend 只回滚', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.imeWrite('ni', 3, 3);
    const other = current();
    applyEditorStep(typedAt(other, 0, 'Z'), other);
    expect(r.discards).toEqual(['store-changed-while-composing']);
    r.el.imeWrite('你', 4, 6);
    r.el.fire('compositionend', { data: '你' });
    expect(useMuseAppStore.getState().session.source).toBe('Zabc');
    expect(r.el.value).toBe('Zabc');
  });

  it('IC-10 写入时先于写回层的订阅者抛错：授权按 store 实际状态收束（不停在 committing），DOM 对齐（审查 LOW-1）', () => {
    open('abc');
    let thrown = false;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      if (thrown) return;
      thrown = true;
      throw new Error('subscriber failed');
    });
    const r = rig();
    thrown = false;
    composeAtEnd(r, '好');
    unsubscribe();
    expect(useMuseAppStore.getState().session.source).toBe('abc好');
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed' });
    expect(r.ime.view()).toBe('settled');
    expect(r.el.value).toBe('abc好');
    expect(r.reports).toContain('source-editor-event');
  });

  it('IC-9 提交后立刻读取对外视图：settled（committing 在同步段结束前已退出）', () => {
    open('abc');
    const r = rig();
    composeAtEnd(r, '好');
    expect(r.ime.view()).toBe('settled');
  });
});
