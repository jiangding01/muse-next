/**
 * M3 T3c：源码面板绑定层 —— 生命周期与迟到回调隔离（Preflight r1 §7.3）。
 *
 * StrictMode attach → detach → attach 只留一组监听与一个 store 订阅；detach 结束组字；旧元素的迟到事件、旧代际的延迟任务、
 * 旧组字会话的退出回调都不改变新状态；替换为另一个 textarea 后旧元素不再被写回；Open（文档替换）使诊断窗口退出。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { applyEditorStep, commitSession, setEditorSelection, useMuseAppStore } from '../../../src/renderer/app/store';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import { createSourceEditorBinding } from '../../../src/renderer/app/editor/sourceEditorBinding';
import type { SourceTextareaLike } from '../../../src/renderer/app/editor/sourceEditorBinding';

type Listener = (event: unknown) => void;

function fakeElement() {
  const listeners = new Map<string, Set<Listener>>();
  const docListeners = new Map<string, Set<Listener>>();
  let value = '';
  let start = 0;
  let end = 0;
  let writes = 0;
  const add = (map: Map<string, Set<Listener>>) => (type: string, l: Listener) => map.set(type, (map.get(type) ?? new Set()).add(l));
  const remove = (map: Map<string, Set<Listener>>) => (type: string, l: Listener) => map.get(type)?.delete(l);
  const doc: SourceTextareaLike['ownerDocument'] = { activeElement: null, addEventListener: add(docListeners), removeEventListener: remove(docListeners) };
  const count = (map: Map<string, Set<Listener>>): number => [...map.values()].reduce((n, set) => n + set.size, 0);
  const fire = (type: string, event: Record<string, unknown> = {}): void => {
    for (const l of [...(listeners.get(type) ?? [])]) l(event);
  };
  return {
    readOnly: false,
    ownerDocument: doc,
    get value() {
      return value;
    },
    set value(next: string) {
      writes += 1;
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
      writes += 1;
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
    setSelectionRange(s: number, e: number) {
      writes += 1;
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
    imeWrite: (text: string, from: number, to: number) => {
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
    listenerCount: () => count(listeners) + count(docListeners),
    writes: () => writes,
  };
}

function open(source: string, documentId = 4): void {
  const result = prepareCandidate({ documentId, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: { capability: { id: `c${String(documentId)}` }, displayName: 'a', displayPath: '/a' } });
  if (!result.ok) throw new Error('prepare');
  commitSession(result.candidate.session, 'trusted');
}

const current = (): EditorCore => {
  const { session, history, selection } = useMuseAppStore.getState();
  return { session, history, selection };
};

function rig() {
  const posted: (() => void)[] = [];
  const parse: string[] = [];
  let subscriptions = 0;
  const ime = createImeSession();
  const binding = createSourceEditorBinding({
    read: current,
    apply: applyEditorStep,
    writeSelection: setEditorSelection,
    subscribe: (listener) => {
      subscriptions += 1;
      const unsubscribe = useMuseAppStore.subscribe(() => listener());
      return () => {
        subscriptions -= 1;
        unsubscribe();
      };
    },
    ime,
    controller: { undo: () => 'nothing-to-undo', redo: () => 'nothing-to-redo', replacementPending: () => false },
    parse: {
      sourceChanged: () => undefined,
      flush: () => 'skipped',
      compositionStart: () => parse.push('start'),
      compositionEnd: () => parse.push('end'),
    },
    notify: () => undefined,
    clearNotice: () => undefined,
    report: () => undefined,
    diagnostic: () => undefined,
    defer: (task) => task(),
    post: (task) => posted.push(task),
    editingEnabled: () => true,
  });
  return { binding, ime, posted, parse, subscriptions: () => subscriptions };
}

const insert = (data: string) => ({ inputType: 'insertText', data, dataTransfer: null, cancelable: true, timeStamp: 1, preventDefault: () => undefined });

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('sourceEditorBinding —— 生命周期', () => {
  it('StrictMode：attach → detach → attach 只留一组监听与一个 store 订阅；同一元素重复 bind 无操作', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    const perAttach = el.listenerCount();
    r.binding.bind(null);
    expect(el.listenerCount()).toBe(0);
    expect(r.subscriptions()).toBe(0);
    r.binding.bind(el);
    r.binding.bind(el);
    expect(el.listenerCount()).toBe(perAttach);
    expect(r.subscriptions()).toBe(1);
  });

  it('组字中 detach：输入法会话回到 idle；重新 attach 后对外视图为 idle', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    el.select(3, 3);
    el.fire('compositionstart');
    expect(r.ime.view()).toBe('composing');
    r.binding.bind(null);
    expect(r.ime.view()).toBe('idle');
    expect(r.parse).toEqual(['start', 'end']);
    r.binding.bind(el);
    expect(r.ime.view()).toBe('idle');
  });

  it('旧代际的退出回调在新代际执行 → 无操作', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    el.select(3, 3);
    el.fire('compositionstart');
    el.imeWrite('好', 3, 3);
    el.fire('compositionend', { data: '好' });
    const stale = r.posted.shift();
    r.binding.bind(null);
    r.binding.bind(el);
    el.select(4, 4);
    el.fire('compositionstart');
    stale?.();
    expect(r.ime.view()).toBe('composing');
  });

  it('旧代际的退出回调在新代际的诊断窗口中执行 → 不提前结束新窗口（变异 M19）', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    el.select(3, 3);
    el.fire('compositionstart');
    el.imeWrite('好', 3, 3);
    el.fire('compositionend', { data: '好' });
    const stale = r.posted.shift();
    r.binding.bind(null);
    r.binding.bind(el);
    el.select(4, 4);
    el.fire('compositionstart');
    el.imeWrite('你', 4, 4);
    el.fire('compositionend', { data: '你' });
    expect(r.ime.view()).toBe('settled');
    stale?.();
    expect(r.ime.view()).toBe('settled');
  });

  it('同一元素重复 bind 是无操作：进行中的组字不被打断（变异 M36）', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    el.select(3, 3);
    el.fire('compositionstart');
    const generation = r.binding.generation();
    r.binding.bind(el);
    expect(r.ime.view()).toBe('composing');
    expect(r.binding.generation()).toBe(generation);
  });

  it('替换为另一个 textarea：旧元素的迟到事件不写 store，store 变化也不再写回旧元素', () => {
    open('abc');
    const r = rig();
    const oldEl = fakeElement();
    const newEl = fakeElement();
    r.binding.bind(oldEl);
    r.binding.bind(newEl);
    const before = oldEl.writes();
    oldEl.fire('beforeinput', insert('x'));
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    newEl.select(3, 3);
    newEl.fire('beforeinput', insert('y'));
    expect(useMuseAppStore.getState().session.source).toBe('abcy');
    expect(newEl.value).toBe('abcy');
    expect(oldEl.writes()).toBe(before);
  });

  it('Open（文档替换）：诊断窗口退出、DOM 整体替换为新文档、旧会话的退出回调无操作', () => {
    open('abc');
    const r = rig();
    const el = fakeElement();
    r.binding.bind(el);
    el.select(3, 3);
    el.fire('compositionstart');
    el.imeWrite('好', 3, 3);
    el.fire('compositionend', { data: '好' });
    expect(r.ime.view()).toBe('settled');
    open('xyz', 8);
    expect(r.ime.view()).toBe('idle');
    expect(el.value).toBe('xyz');
    r.posted.shift()?.();
    expect(r.ime.view()).toBe('idle');
  });
});
