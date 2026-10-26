/**
 * M3 T3c：源码面板绑定层 —— 输入法（Preflight r1 §3、r1.1 §1 / §4、勘误 E-3；用户裁决 Q8-B′ / Q8-b(i)）。
 *
 * 真实 store 与写回订阅；测试先替浏览器改 DOM（写入组字结果）再派发 compositionend：一次组字恰一个事务；取消不建事务；
 * DOM ≠ expected 回滚并提示；选区替换；Open 进行中的组字被丢弃；卡死出口；组字中的可取消输入与 input 事件；
 * 诊断窗口（Q8-B′：照常接受 + 记录；Q-D3 集成部分：版本变化后退出窗口）；失焦提交原文；blur 不 flush 的条件。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { applyEditorStep, commitSession, setEditorSelection, useMuseAppStore } from '../../../src/renderer/app/store';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import type { TrailingSuspect } from '../../../src/renderer/app/editor/imeMachine';
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
  const add = (map: Map<string, Set<Listener>>) => (type: string, l: Listener) => map.set(type, (map.get(type) ?? new Set()).add(l));
  const remove = (map: Map<string, Set<Listener>>) => (type: string, l: Listener) => map.get(type)?.delete(l);
  const doc: SourceTextareaLike['ownerDocument'] = { activeElement: null, addEventListener: add(new Map()), removeEventListener: remove(new Map()) };
  const fire = (type: string, event: Record<string, unknown> = {}): void => {
    for (const l of [...(listeners.get(type) ?? [])]) l(event);
  };
  const el = {
    calls,
    readOnly: false,
    ownerDocument: doc,
    get value() {
      return value;
    },
    set value(next: string) {
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
      calls.push('setRangeText');
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
    setSelectionRange(s: number, e: number) {
      calls.push('setSelectionRange');
      start = s;
      end = e;
    },
    addEventListener: add(listeners),
    removeEventListener: remove(listeners),
    blur: () => fire('blur'),
    fire,
    select: (s: number, e: number) => {
      start = s;
      end = e;
    },
    /** 输入法改 DOM（不经 beforeinput 的可取消路径）。 */
    imeWrite: (text: string, from: number, to: number) => {
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
  };
  return el;
}

function beforeinput(inputType: string, data: string | null = null) {
  const event = { inputType, data, dataTransfer: null, cancelable: true, timeStamp: 1, prevented: false, preventDefault: () => undefined };
  event.preventDefault = () => {
    event.prevented = true;
  };
  return event;
}

function open(source: string): void {
  const result = prepareCandidate({ documentId: 9, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: { capability: { id: 'c' }, displayName: 'a', displayPath: '/a' } });
  if (!result.ok) throw new Error('prepare');
  commitSession(result.candidate.session, 'trusted');
}

const current = (): EditorCore => {
  const { session, history, selection } = useMuseAppStore.getState();
  return { session, history, selection };
};

function rig(options: { pending?: () => boolean } = {}) {
  const notices: string[] = [];
  const parse: string[] = [];
  const posted: (() => void)[] = [];
  const diagnostics: TrailingSuspect[] = [];
  const ime = createImeSession();
  const binding = createSourceEditorBinding({
    read: current,
    apply: applyEditorStep,
    writeSelection: setEditorSelection,
    subscribe: (listener) => useMuseAppStore.subscribe(() => listener()),
    ime,
    controller: { undo: () => 'nothing-to-undo', redo: () => 'nothing-to-redo', replacementPending: options.pending ?? (() => false) },
    parse: {
      sourceChanged: () => parse.push('changed'),
      flush: (reason) => {
        parse.push(`flush:${reason}`);
        return 'skipped';
      },
      compositionStart: () => parse.push('start'),
      compositionEnd: () => parse.push('end'),
    },
    notify: (kind) => notices.push(kind),
    clearNotice: () => undefined,
    report: () => undefined,
    diagnostic: (record) => diagnostics.push(record),
    defer: (task) => task(),
    post: (task) => posted.push(task),
    editingEnabled: () => true,
  });
  const el = fakeElement();
  binding.bind(el);
  return { binding, el, ime, notices, parse, posted, diagnostics };
}

/** 模拟一次完整组字：start → 输入法写 DOM → end。 */
function compose(r: ReturnType<typeof rig>, from: number, to: number, data: string, domText = data): void {
  r.el.select(from, to);
  r.el.fire('compositionstart');
  r.el.imeWrite(domText, from, to);
  r.el.fire('compositionend', { data });
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('sourceEditorBinding —— 组字提交', () => {
  it('一次组字恰一个事务：版本 +1、History +1、DOM 零写入、进入诊断窗口；解析调度顺序为 start → end → changed', () => {
    open('abc');
    const r = rig();
    r.el.calls.length = 0;
    compose(r, 3, 3, '好');
    const state = useMuseAppStore.getState();
    expect(state.session.source).toBe('abc好');
    expect(state.session.sourceVersion).toBe(2);
    expect(state.history.undo?.size).toBe(1);
    expect(r.el.calls).toEqual([]);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed', committedText: '好' });
    expect(r.parse).toEqual(['start', 'end', 'changed']);
  });

  it('选区非空时组字：替换 compositionstart 时的选区', () => {
    open('abcd');
    const r = rig();
    compose(r, 1, 3, '你');
    expect(useMuseAppStore.getState().session.source).toBe('a你d');
  });

  it('取消（data 为空且 DOM 已恢复原文）：不建事务、不提示', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.fire('compositionend', { data: '' });
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'canceled' });
    expect(r.notices).toEqual([]);
    // 未提交的结束同样投递一次有界退出（审查 LOW-2）。
    expect(r.posted).toHaveLength(1);
    r.posted.shift()?.();
    expect(r.ime.view()).toBe('idle');
  });

  it('DOM ≠ expected（长按选字 / 平台差异）：不提交，DOM 整体回滚，提示输入未生效', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, '好', '好好');
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.el.value).toBe('abc');
    expect(r.notices).toEqual(['ime-not-applied']);
  });

  it('失焦 / 切窗以拼音原文提交（Q8-b(i)）：DOM === expected 即作为一次可撤销事务', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, "ni'hao");
    expect(useMuseAppStore.getState().session.source).toBe("abcni'hao");
    expect(useMuseAppStore.getState().history.undo?.size).toBe(1);
  });

  it('Open 进行中开始的组字直接丢弃：提示；结束时只回滚 DOM、不提交', () => {
    open('abc');
    const r = rig({ pending: () => true });
    compose(r, 3, 3, '好');
    expect(r.notices).toEqual(['command-ignored-replacing']);
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.el.value).toBe('abc');
  });

  it('卡死出口：组字中收到 isComposing=false 的 keydown → idle，DOM 回滚', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.imeWrite('ni', 3, 3);
    r.el.fire('keydown', { isComposing: true });
    expect(r.ime.view()).toBe('composing');
    r.el.fire('keydown', { isComposing: false });
    expect(r.ime.view()).toBe('idle');
    expect(r.el.value).toBe('abc');
    // compositionend 不会再来：解析调度的组字暂停必须同时结束（审查 MEDIUM-1）。
    expect(r.parse).toEqual(['start', 'end']);
  });

  it('组字中：可取消输入被 preventDefault 且不建事务；input 事件（含取消组字时无 beforeinput 的 deleteContentBackward）不回滚', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.imeWrite('ni', 3, 3);
    const event = beforeinput('insertText', 'x');
    r.el.fire('beforeinput', event);
    r.el.fire('input', { inputType: 'deleteContentBackward', isComposing: false });
    expect(event.prevented).toBe(true);
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.el.value).toBe('abcni');
    expect(r.notices).toEqual([]);
  });

  it('blur：组字中或 Open 进行中不 flush；idle 时 flush(blur)', () => {
    open('abc');
    const r = rig();
    r.el.select(3, 3);
    r.el.fire('compositionstart');
    r.el.fire('blur');
    expect(r.parse).not.toContain('flush:blur');
    r.el.fire('compositionend', { data: '' });
    r.el.fire('blur');
    expect(r.parse).toContain('flush:blur');
  });
});

describe('sourceEditorBinding —— 诊断窗口（Q8-B′，勘误 E-3）', () => {
  it('Q-1′ + Q-D3 集成：提交后无 keydown 的相同文本照常接受并记录 1 条诊断；版本随之改变、窗口退出，后续事件不再记录', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, '好');
    for (let i = 0; i < 3; i += 1) r.el.fire('beforeinput', beforeinput('insertText', '好'));
    expect(useMuseAppStore.getState().session.source).toBe('abc好好好好');
    expect(r.diagnostics).toHaveLength(1);
    expect(r.diagnostics[0]).toMatchObject({ dataMatchesCommit: true, caretAtCommitEnd: true, versionUnchanged: true, eventsSinceEnd: 1, outcome: 'committed' });
    expect(r.ime.view()).toBe('idle');
  });

  it('Q-3′：先 keydown 再输入相同文本 → 接受、不记录', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, '好');
    r.el.fire('keydown', { isComposing: false });
    r.el.fire('beforeinput', beforeinput('insertText', '好'));
    expect(r.diagnostics).toHaveLength(0);
    expect(useMuseAppStore.getState().session.source).toBe('abc好好');
  });

  it('Q-9′：提交后无 keydown 的 deleteContentBackward → 照常删除并记录', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, '好');
    r.el.fire('beforeinput', beforeinput('deleteContentBackward'));
    expect(useMuseAppStore.getState().session.source).toBe('abc');
    expect(r.diagnostics[0]).toMatchObject({ inputType: 'deleteContentBackward', dataMatchesCommit: false });
  });

  it('退出回调：执行后回到 idle；新组字会话开始后，旧会话的回调无操作（Q-11）', () => {
    open('abc');
    const r = rig();
    compose(r, 3, 3, '好');
    const first = r.posted.shift();
    r.el.select(4, 4);
    r.el.fire('compositionstart');
    first?.();
    expect(r.ime.view()).toBe('composing');
    r.el.imeWrite('你', 4, 4);
    r.el.fire('compositionend', { data: '你' });
    r.posted.shift()?.();
    expect(r.ime.view()).toBe('idle');
  });
});
