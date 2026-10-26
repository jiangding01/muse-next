/**
 * M3 T3c：源码面板绑定层 —— 普通输入（`src/renderer/app/editor/sourceEditorBinding.ts`；方案 §9.1；Preflight r0 §3–§4、r1 §2 / §5）。
 *
 * 真实 store、真实 `applyEditorStep` / `setEditorSelection`、真实写回订阅，假 textarea 记录每次 DOM 调用：
 * `abc → abxc`；CRLF 单键编辑只改目标；受保护 U+FEFF；孤立 CR 不被规范化；字素簇删除；全选替换；同文本替换；粘贴 / 剪切；
 * fail closed；可取消输入第一步 preventDefault；CAS 拒绝不重试且 DOM 对齐到较新状态；一次键入只写回一次；即时防线；门控；选区同步。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { commitSession, applyEditorStep, publishParsedSession, setEditorSelection, useMuseAppStore } from '../../../src/renderer/app/store';
import type { StoreWriteResult } from '../../../src/renderer/app/store';
import { acceptParsedSnapshot } from '../../../src/editor/session/reducer';
import { loadJcx } from '../../../src/formats/jcxParse';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import { createSourceEditorBinding } from '../../../src/renderer/app/editor/sourceEditorBinding';
import type { SourceTextareaLike } from '../../../src/renderer/app/editor/sourceEditorBinding';

type Listener = (event: unknown) => void;

interface FakeElement extends SourceTextareaLike {
  calls: string[];
  fire(type: string, event?: Record<string, unknown>): void;
  select(start: number, end: number): void;
  focusIn(): void;
  listenerCount(): number;
}

function fakeElement(): FakeElement {
  const listeners = new Map<string, Set<Listener>>();
  const docListeners = new Map<string, Set<Listener>>();
  let value = '';
  let start = 0;
  let end = 0;
  const calls: string[] = [];
  const doc: FakeElement['ownerDocument'] & { activeElement: unknown } = {
    activeElement: null,
    addEventListener: (type: string, l: Listener) => docListeners.set(type, (docListeners.get(type) ?? new Set()).add(l)),
    removeEventListener: (type: string, l: Listener) => docListeners.get(type)?.delete(l),
  };
  const el: FakeElement = {
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
    addEventListener: (type: string, l: Listener) => listeners.set(type, (listeners.get(type) ?? new Set()).add(l)),
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l),
    blur: () => el.fire('blur'),
    fire: (type, event = {}) => {
      const target = type === 'selectionchange' ? docListeners : listeners;
      for (const l of [...(target.get(type) ?? [])]) l(event);
    },
    select: (s, e) => {
      start = s;
      end = e;
    },
    focusIn: () => {
      doc.activeElement = el;
    },
    listenerCount: () => [...listeners.values()].reduce((n, set) => n + set.size, 0) + [...docListeners.values()].reduce((n, set) => n + set.size, 0),
  };
  return el;
}

function beforeinput(inputType: string, data: string | null = null): Record<string, unknown> & { prevented: boolean } {
  const event = {
    inputType,
    data,
    dataTransfer: null,
    cancelable: true,
    timeStamp: 100,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

function open(source: string, documentId = 5): void {
  const result = prepareCandidate({
    documentId,
    source,
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: `cap-${String(documentId)}` }, displayName: 's.jcx', displayPath: '/s.jcx' },
  });
  if (!result.ok) throw new Error('prepare');
  commitSession(result.candidate.session, 'trusted');
}

const current = (): EditorCore => {
  const { session, history, selection } = useMuseAppStore.getState();
  return { session, history, selection };
};

interface RigOptions {
  enabled?: boolean;
  pending?: boolean;
  apply?: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  writeSelection?: (core: EditorCore, base: EditorCore) => StoreWriteResult;
}

function rig(options: RigOptions = {}) {
  const notices: string[] = [];
  const reports: string[] = [];
  const parse: string[] = [];
  const history: string[] = [];
  const posted: (() => void)[] = [];
  const ime = createImeSession();
  let applies = 0;
  let writes = 0;
  const binding = createSourceEditorBinding({
    read: current,
    apply: (core, base) => {
      applies += 1;
      return (options.apply ?? applyEditorStep)(core, base);
    },
    writeSelection: (core, base) => {
      writes += 1;
      return (options.writeSelection ?? setEditorSelection)(core, base);
    },
    subscribe: (listener) => useMuseAppStore.subscribe(() => listener()),
    ime,
    controller: {
      undo: (source) => {
        history.push(`undo:${source}`);
        return 'nothing-to-undo';
      },
      redo: (source) => {
        history.push(`redo:${source}`);
        return 'nothing-to-redo';
      },
      replacementPending: () => options.pending === true,
    },
    parse: {
      sourceChanged: () => parse.push('changed'),
      flush: (reason) => {
        parse.push(`flush:${reason}`);
        return 'skipped';
      },
      compositionStart: () => parse.push('composition-start'),
      compositionEnd: () => parse.push('composition-end'),
    },
    notify: (kind) => notices.push(kind),
    clearNotice: () => undefined,
    report: (_error, context) => reports.push(context),
    diagnostic: () => undefined,
    defer: (task) => task(),
    post: (task) => posted.push(task),
    editingEnabled: () => options.enabled !== false,
  });
  const el = fakeElement();
  binding.bind(el);
  el.focusIn();
  return { binding, el, ime, notices, reports, parse, history, posted, applies: () => applies, writes: () => writes };
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('sourceEditorBinding —— 普通输入', () => {
  it('abc → abxc：preventDefault、恰一个事务、版本 +1、DOM 与选区对齐、调度解析', () => {
    open('abc');
    const r = rig();
    expect(r.el.value).toBe('abc');
    r.el.select(2, 2);
    const event = beforeinput('insertText', 'x');
    r.el.calls.length = 0;
    r.el.fire('beforeinput', event);
    const state = useMuseAppStore.getState();
    expect(event.prevented).toBe(true);
    expect(state.session.source).toBe('abxc');
    expect(state.session.sourceVersion).toBe(2);
    expect(state.history.undo?.size).toBe(1);
    expect(r.el.value).toBe('abxc');
    expect([r.el.selectionStart, r.el.selectionEnd]).toEqual([3, 3]);
    expect(r.el.calls).toEqual(['setRangeText']);
    expect(r.parse).toEqual(['changed']);
  });

  it('CRLF 文件单键编辑只改目标位置，其余字节逐一相等；新换行按 dominant EOL', () => {
    open('ab\r\ncd\r\nef');
    const r = rig();
    r.el.select(5, 5);
    r.el.fire('beforeinput', beforeinput('insertText', 'X'));
    expect(useMuseAppStore.getState().session.source).toBe('ab\r\ncdX\r\nef');
    r.el.select(1, 1);
    r.el.fire('beforeinput', beforeinput('insertLineBreak'));
    expect(useMuseAppStore.getState().session.source).toBe('a\r\nb\r\ncdX\r\nef');
    expect(r.el.value).toBe(useMuseAppStore.getState().session.projection.view);
  });

  it('受保护的开头 U+FEFF：全选替换后仍在 offset 0', () => {
    open('﻿abc');
    const r = rig();
    r.el.select(0, 3);
    r.el.fire('beforeinput', beforeinput('insertText', 'z'));
    expect(useMuseAppStore.getState().session.source).toBe('﻿z');
    expect([r.el.selectionStart, r.el.selectionEnd]).toEqual([1, 1]);
  });

  it('孤立 CR 不被规范化；会造成 CR/LF 合并的补丁被拒并提示，DOM 不变', () => {
    open('a\rb');
    const r = rig();
    expect(r.el.value).toBe('a␍b');
    r.el.select(3, 3);
    r.el.fire('beforeinput', beforeinput('insertText', 'c'));
    expect(useMuseAppStore.getState().session.source).toBe('a\rbc');
    r.el.select(2, 2);
    r.el.fire('beforeinput', beforeinput('insertLineBreak'));
    expect(useMuseAppStore.getState().session.source).toBe('a\rbc');
    expect(r.notices).toEqual(['input-rejected']);
    expect(r.el.value).toBe('a␍bc');
  });

  it('字素簇删除：Backspace 删除整个 emoji / 组合符序列', () => {
    open('x😀é');
    const r = rig();
    r.el.select(5, 5);
    r.el.fire('beforeinput', beforeinput('deleteContentBackward'));
    expect(useMuseAppStore.getState().session.source).toBe('x😀');
    r.el.fire('beforeinput', beforeinput('deleteContentBackward'));
    expect(useMuseAppStore.getState().session.source).toBe('x');
  });

  it('同文本替换（选 b 输 b）：版本不变、选区折叠到末尾，再输 x 得 abxc', () => {
    open('abc');
    const r = rig();
    r.el.select(1, 2);
    r.el.fire('beforeinput', beforeinput('insertText', 'b'));
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect([r.el.selectionStart, r.el.selectionEnd]).toEqual([2, 2]);
    r.el.fire('beforeinput', beforeinput('insertText', 'x'));
    expect(useMuseAppStore.getState().session.source).toBe('abxc');
  });

  it('粘贴（data 中的 CRLF 规范后按 dominant EOL 写入）与剪切', () => {
    open('ab\r\ncd');
    const r = rig();
    r.el.select(1, 2);
    r.el.fire('beforeinput', beforeinput('insertFromPaste', 'P\r\nQ'));
    expect(useMuseAppStore.getState().session.source).toBe('aP\r\nQ\r\ncd');
    r.el.select(0, 1);
    r.el.fire('beforeinput', beforeinput('deleteByCut'));
    expect(useMuseAppStore.getState().session.source).toBe('P\r\nQ\r\ncd');
  });

  it('fail closed：不支持的类型与缺数据的输入先 preventDefault，不建事务、提示，DOM 不变', () => {
    open('ab cd');
    const r = rig();
    r.el.select(5, 5);
    const word = beforeinput('deleteWordBackward');
    r.el.fire('beforeinput', word);
    const empty = beforeinput('insertText', '');
    r.el.fire('beforeinput', empty);
    expect(word.prevented && empty.prevented).toBe(true);
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.notices).toEqual(['input-unsupported', 'input-rejected']);
    expect(r.el.value).toBe('ab cd');
  });

  it('historyUndo / historyRedo：preventDefault 并派发到编辑控制器（来源 beforeinput），不建事务', () => {
    open('abc');
    const r = rig();
    const undo = beforeinput('historyUndo');
    r.el.fire('beforeinput', undo);
    r.el.fire('beforeinput', beforeinput('historyRedo'));
    expect(undo.prevented).toBe(true);
    expect(r.history).toEqual(['undo:beforeinput', 'redo:beforeinput']);
  });

  it('CAS 拒绝：另一写入抢先 → 不重试、不重算，DOM 对齐到较新的 store 状态，提示冲突', () => {
    open('abc');
    const r = rig({
      apply: (core, base) => {
        const other = current();
        const end = other.session.projection.view.length;
        const raced = createRaced(other, end);
        applyEditorStep(raced, other);
        return applyEditorStep(core, base);
      },
    });
    r.el.select(0, 0);
    r.el.fire('beforeinput', beforeinput('insertText', 'x'));
    expect(r.applies()).toBe(1);
    expect(useMuseAppStore.getState().session.source).toBe('abcR');
    expect(r.el.value).toBe('abcR');
    expect(r.notices).toEqual(['edit-conflict']);
  });

  it('Open 进行中：可取消输入被拒并提示；blur 不为即将被替换的文档 flush 解析', () => {
    open('abc');
    const r = rig({ pending: true });
    r.el.fire('beforeinput', beforeinput('insertText', 'x'));
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(r.notices).toEqual(['command-ignored-replacing']);
    r.el.fire('blur');
    expect(r.parse).toEqual([]);
  });

  it('即时防线：非组字状态下绕过 beforeinput 的 DOM 改动 → 整体回滚并提示；DOM 与 store 一致时无操作', () => {
    open('abc');
    const r = rig();
    r.el.fire('input', {});
    expect(r.notices).toEqual([]);
    r.el.setRangeText('INJECTED', 0, 0);
    r.el.fire('input', {});
    expect(r.el.value).toBe('abc');
    expect(r.notices).toEqual(['input-reverted']);
  });
});

describe('sourceEditorBinding —— 平台门控（控制器侧）', () => {
  it('未开放平台：所有可取消输入被拒且不建事务；组字不进入状态机，结束时回滚 DOM', () => {
    open('abc');
    const r = rig({ enabled: false });
    expect(r.el.readOnly).toBe(true);
    for (const [type, data] of [
      ['insertText', 'x'],
      ['insertFromPaste', 'p'],
      ['deleteByCut', null],
      ['historyUndo', null],
      ['deleteContentBackward', null],
    ] as const) {
      const event = beforeinput(type, data);
      r.el.fire('beforeinput', event);
      expect(event.prevented).toBe(true);
    }
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
    expect(useMuseAppStore.getState().history.undo).toBeNull();
    expect(r.history).toEqual([]);
    expect(new Set(r.notices)).toEqual(new Set(['source-readonly-platform']));
    r.el.fire('compositionstart');
    expect(r.ime.view()).toBe('idle');
    r.el.setRangeText('ni', 3, 3);
    r.el.fire('compositionend', { data: '你' });
    expect(r.el.value).toBe('abc');
    expect(useMuseAppStore.getState().session.sourceVersion).toBe(1);
  });
});

describe('sourceEditorBinding —— 选区同步', () => {
  it('selectionchange（焦点在 textarea）→ store 选中 = DOM 选区；写回引起的排队事件被过滤', () => {
    open('abcdef');
    const r = rig();
    r.el.select(1, 4);
    r.el.fire('selectionchange');
    const selection = useMuseAppStore.getState().selection;
    expect(selection.ranges).toEqual([{ start: 1, end: 4 }]);
    r.el.fire('selectionchange');
    expect(useMuseAppStore.getState().selection).toBe(selection);
  });

  it('与解析发布交错：第一次被 CAS 拒绝（会话对象已换），即时以新鲜状态重算成功，不重放旧结果', () => {
    open('abcdef');
    let first = true;
    const r = rig({
      writeSelection: (core, base) => {
        if (first) {
          first = false;
          const session = useMuseAppStore.getState().session;
          const accepted = acceptParsedSnapshot(session, { documentId: session.documentId, sourceVersion: session.sourceVersion, load: loadJcx(session.source) });
          if (!accepted.ok) throw new Error('accept');
          publishParsedSession(accepted.session);
        }
        return setEditorSelection(core, base);
      },
    });
    r.el.select(2, 3);
    r.el.fire('selectionchange');
    expect(r.writes()).toBe(2);
    expect(useMuseAppStore.getState().selection.ranges).toEqual([{ start: 2, end: 3 }]);
    expect(r.posted).toHaveLength(0);
  });
});

function createRaced(core: EditorCore, at: number): EditorCore {
  // 在 view 末尾插入 R（与被测输入竞争的另一写入）。
  const selection = sourceSelectionFromView(core.session, { start: at, end: at });
  if (selection === null) throw new Error('selection');
  const step = applySourceInput(core, { viewPatch: { start: at, end: at, text: 'R' }, selection, coalesce: null, label: 'race' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}
