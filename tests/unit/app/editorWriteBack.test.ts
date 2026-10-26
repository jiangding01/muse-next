/**
 * M3 T3c：源码面板 DOM 写回（`src/renderer/app/editor/editorWriteBack.ts`；Preflight r1 §4、r1.1 §1 / §3、勘误 E-2）。
 *
 * 假 textarea 记录每一次 DOM 调用；假 store 同步通知。覆盖：文本与选区分开判定（模式 A / B、selection-only、Open view 相同）、
 * 解析发布零写入、外部改写整体回滚、同步重入、写回失败整体重置、broken 的有界恢复与去重（BR-1～BR-5）、组字中不碰 DOM、提交授权。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentSession } from '../../../src/editor/session/create';
import type { EditorSelection } from '../../../src/editor/selection/types';
import type { DocumentSession } from '../../../src/editor/session/types';
import { createWriteBack } from '../../../src/renderer/app/editor/editorWriteBack';
import type { TextareaLike, WriteBackState } from '../../../src/renderer/app/editor/editorWriteBack';
import { applySourceInput, noSelection, sourceSelectionFromView, undoStep } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import { createHistory } from '../../../src/editor/history/history';

interface FakeTextarea extends TextareaLike {
  calls: string[];
  failOn: Set<string>;
  /** 区间写入静默失效（不抛错、也不改内容），模拟浏览器拒绝写入。 */
  silent: boolean;
}

function fakeTextarea(initial = ''): FakeTextarea {
  let value = initial;
  let start = 0;
  let end = 0;
  const calls: string[] = [];
  const failOn = new Set<string>();
  const guard = (name: string): void => {
    if (failOn.has(name)) throw new Error(`${name} failed`);
  };
  const fake: FakeTextarea = {
    calls,
    failOn,
    silent: false,
    readOnly: false,
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
      calls.push(`setRangeText(${JSON.stringify(text)},${String(from)},${String(to)})`);
      if (fake.silent) return;
      value = value.slice(0, from) + text + value.slice(to);
      start = from + text.length;
      end = start;
    },
    setSelectionRange(s: number, e: number) {
      guard('setSelectionRange');
      calls.push(`setSelectionRange(${String(s)},${String(e)})`);
      start = s;
      end = e;
    },
  };
  return fake;
}

function session(source: string, documentId = 1): DocumentSession {
  return createDocumentSession({ documentId, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

function rig(initial: DocumentSession) {
  let core: EditorCore = { session: initial, history: createHistory(initial), selection: noSelection(initial.sourceVersion) };
  const listeners = new Set<() => void>();
  const ime = createImeSession();
  const notices: string[] = [];
  const cleared: string[] = [];
  const reports: string[] = [];
  const micro: (() => void)[] = [];
  const posted: (() => void)[] = [];
  const writeBack = createWriteBack({
    read: (): WriteBackState => ({ session: core.session, selection: core.selection }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ime,
    notify: (kind) => notices.push(kind),
    clearNotice: (kind) => cleared.push(kind),
    report: (_error, context) => reports.push(context),
    defer: (task) => micro.push(task),
    post: (task) => posted.push(task),
    gateReadOnly: () => false,
    eventSeq: () => 0,
  });
  const set = (next: EditorCore): void => {
    core = next;
    for (const listener of [...listeners]) listener();
  };
  const flush = (): void => {
    while (micro.length > 0) micro.shift()?.();
  };
  const runPosted = (): void => {
    while (posted.length > 0) posted.shift()?.();
  };
  return { get core() { return core; }, set, ime, writeBack, notices, cleared, reports, posted, flush, runPosted, listeners };
}

function select(core: EditorCore, start: number, end: number): EditorSelection {
  const selection = sourceSelectionFromView(core.session, { start, end });
  if (selection === null) throw new Error('selection');
  return selection;
}

function typed(core: EditorCore, at: number, text: string): EditorCore {
  const step = applySourceInput(core, { viewPatch: { start: at, end: at, text }, selection: select(core, at, at), coalesce: null, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

describe('editorWriteBack —— attach 与文本 / 选区分开判定', () => {
  it('attach：整体 value = view，none 选中 → 光标 0', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea('stale');
    r.writeBack.attach(ta);
    expect(ta.value).toBe('abc');
    expect(ta.calls).toEqual(['value=', 'setSelectionRange(0,0)']);
  });

  it('模式 A：DOM 等于上次 view（已 preventDefault）→ 公共前后缀区间写回，并按 store 设选区', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.calls.length = 0;
    r.set(typed(r.core, 2, 'x'));
    expect(ta.value).toBe('abxc');
    expect(ta.calls).toEqual(['setRangeText("x",2,2)']);
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([3, 3]);
  });

  it('模式 B：DOM 已等于新 view 且光标已在末尾（输入法提交）→ 零 DOM 调用', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.setRangeText('x', 2, 2);
    ta.calls.length = 0;
    r.set(typed(r.core, 2, 'x'));
    expect(ta.calls).toEqual([]);
  });

  it('文本一致但选区不符 → 只设选区', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.setRangeText('x', 2, 2);
    ta.setSelectionRange(0, 0);
    ta.calls.length = 0;
    r.set(typed(r.core, 2, 'x'));
    expect(ta.calls).toEqual(['setSelectionRange(3,3)']);
  });

  it('selection-only：view 不变、store 选中变 → 只设选区；与 DOM 相同 → 零调用', () => {
    const r = rig(session('abcd'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.calls.length = 0;
    r.set({ ...r.core, selection: select(r.core, 1, 3) });
    expect(ta.calls).toEqual(['setSelectionRange(1,3)']);
    ta.calls.length = 0;
    r.set({ ...r.core, selection: select(r.core, 1, 3) });
    expect(ta.calls).toEqual([]);
  });

  it('Undo：文本按区间写回，选区恢复为 selectionBefore（选区判定不依赖文本是否变化）', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    const withSelection = { ...r.core, selection: select(r.core, 0, 1) };
    r.set(withSelection);
    r.set(typed(withSelection, 3, 'z'));
    const undone = undoStep(r.core);
    if (!undone.ok) throw new Error(undone.reason);
    ta.calls.length = 0;
    r.set(undone.core);
    expect(ta.value).toBe('abc');
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([3, 3]);
    expect(ta.calls).toEqual(['setRangeText("",3,4)']);
  });

  it('版本变化而 view 与选区都相同（构造状态；T8 可能出现）→ 不写文本，选区仍按 store 判定', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    const bumped = { ...r.core.session, sourceVersion: r.core.session.sourceVersion + 1 };
    ta.setSelectionRange(1, 1);
    ta.calls.length = 0;
    r.set({ session: bumped, history: { ...r.core.history, headVersion: bumped.sourceVersion }, selection: { ...select(r.core, 2, 2), basisVersion: bumped.sourceVersion } });
    expect(ta.calls).toEqual(['setSelectionRange(2,2)']);
  });

  it('Open：新文档 view 与旧文档完全相同、documentId 不同 → 仍整体重置并把光标置 0', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.setSelectionRange(2, 2);
    ta.calls.length = 0;
    const next = session('abc', 2);
    r.set({ session: next, history: createHistory(next), selection: noSelection(next.sourceVersion) });
    expect(ta.calls).toEqual(['value=', 'setSelectionRange(0,0)']);
  });

  it('解析发布（会话对象换了、版本 / 选区不变）→ 零 DOM 调用', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.calls.length = 0;
    r.set({ ...r.core, session: { ...r.core.session } });
    expect(ta.calls).toEqual([]);
  });

  it('store 更新时 textarea 已被外部改写 → 整体回滚为 view 并报告', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.value = 'hacked';
    ta.calls.length = 0;
    r.set(typed(r.core, 0, 'x'));
    expect(ta.value).toBe('xabc');
    expect(ta.calls[0]).toBe('value=');
    r.flush();
    expect(r.reports).toContain('write-back-diverged');
  });

  it('同步重入：订阅回调中再次写 store → 外层循环重跑，最终对齐到最新状态', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    let reentered = false;
    r.listeners.add(() => {
      if (reentered) return;
      reentered = true;
      r.set(typed(r.core, 0, 'q'));
    });
    r.set(typed(r.core, 3, 'z'));
    expect(ta.value).toBe(r.core.session.projection.view);
    expect(ta.value).toBe('qabcz');
  });
});

describe('editorWriteBack —— 写回失败与 broken 的有界恢复（勘误 E-2）', () => {
  it('写回校验失败 → 一次整体重置，broken 为 false，报告一次', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.failOn.add('setRangeText');
    r.set(typed(r.core, 3, 'z'));
    expect(ta.value).toBe('abcz');
    expect(r.writeBack.isBroken()).toBe(false);
    r.flush();
    expect(r.reports).toEqual(['write-back-failed']);
  });

  it('区间写入静默失效：写回后校验发现 DOM ≠ view → 整体重置并报告（变异 M35）', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.silent = true;
    r.set(typed(r.core, 3, 'z'));
    expect(ta.value).toBe('abcz');
    r.flush();
    expect(r.reports).toEqual(['write-back-failed']);
  });

  function brokenRig() {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    ta.failOn.add('setRangeText');
    ta.failOn.add('value');
    r.set(typed(r.core, 3, 'z'));
    return { r, ta };
  }

  it('整体重置也失败 → broken：只读、提示、恰好投递 1 个恢复任务', () => {
    const { r, ta } = brokenRig();
    expect(r.writeBack.isBroken()).toBe(true);
    expect(ta.readOnly).toBe(true);
    r.flush();
    expect(r.notices).toEqual(['edit-out-of-sync']);
    expect(r.writeBack.counters().recoveryPosts).toBe(1);
  });

  it('BR-1：延迟恢复失败后连续 5 次只改提示的通知 → 尝试总数 1、投递总数 1', () => {
    const { r } = brokenRig();
    r.runPosted();
    for (let i = 0; i < 5; i += 1) r.set({ ...r.core });
    expect(r.writeBack.counters()).toEqual({ recoveryAttempts: 1, recoveryPosts: 1 });
  });

  it('BR-2 / BR-3：之后每个不同的基线（版本变、选区变）各尝试一次，同基线的提示不再尝试', () => {
    const { r } = brokenRig();
    r.runPosted();
    r.set(typed(r.core, 0, 'u'));
    for (let i = 0; i < 3; i += 1) r.set({ ...r.core });
    expect(r.writeBack.counters().recoveryAttempts).toBe(2);
    r.set({ ...r.core, selection: select(r.core, 0, 1) });
    expect(r.writeBack.counters().recoveryAttempts).toBe(3);
  });

  it('BR-4：进入 broken 时 store 已与上次对齐值不同，随后的提示通知不会因 `rendered` 过期而重试', () => {
    const { r } = brokenRig();
    r.runPosted();
    r.set({ ...r.core });
    r.set({ ...r.core });
    expect(r.writeBack.counters().recoveryAttempts).toBe(1);
  });

  it('恢复成功：broken 解除、只读恢复为门控值、提示被清除', () => {
    const { r, ta } = brokenRig();
    ta.failOn.clear();
    r.runPosted();
    expect(r.writeBack.isBroken()).toBe(false);
    expect(ta.readOnly).toBe(false);
    expect(ta.value).toBe('abcz');
    r.flush();
    expect(r.cleared).toEqual(['edit-out-of-sync']);
  });

  it('BR-5：旧 broken 期的延迟任务在恢复并再次进入 broken 之后才执行 → 无操作', () => {
    const { r, ta } = brokenRig();
    const stale = r.posted.shift();
    ta.failOn.clear();
    r.set(typed(r.core, 0, 'u'));
    expect(r.writeBack.isBroken()).toBe(false);
    ta.failOn.add('setRangeText');
    ta.failOn.add('value');
    r.set(typed(r.core, 0, 'v'));
    expect(r.writeBack.isBroken()).toBe(true);
    const attempts = r.writeBack.counters().recoveryAttempts;
    stale?.();
    expect(r.writeBack.counters().recoveryAttempts).toBe(attempts);
  });
});

describe('editorWriteBack —— 输入法分支', () => {
  it('组字中：解析发布等不改版本的通知不碰 DOM；版本变化 → discard 并整体对齐', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    r.ime.start({ documentId: 1, version: 1, view: 'abc', base: { start: 3, end: 3 }, replacing: false });
    ta.setRangeText('ni', 3, 3);
    ta.calls.length = 0;
    r.set({ ...r.core, session: { ...r.core.session } });
    expect(ta.calls).toEqual([]);
    r.set(typed(r.core, 0, 'x'));
    expect(r.ime.view()).toBe('discarded');
    expect(ta.value).toBe('xabc');
  });

  it('提交授权：与授权一致的变化被消费（settled{committed}），DOM 零写入', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    r.ime.start({ documentId: 1, version: 1, view: 'abc', base: { start: 3, end: 3 }, replacing: false });
    ta.setRangeText('好', 3, 3);
    const next = typed(r.core, 3, '好');
    r.ime.beginCommit({ documentId: 1, authorizedVersion: 2, expectedView: 'abc好', outcome: 'committed', committedText: '好' });
    ta.calls.length = 0;
    r.set(next);
    expect(ta.calls).toEqual([]);
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed', versionAfter: 2, caretView: 4 });
  });

  it('提交过渡中出现授权之外的变化 → committed-unverified，DOM 对齐到 store，报告不变量', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    r.ime.start({ documentId: 1, version: 1, view: 'abc', base: { start: 3, end: 3 }, replacing: false });
    ta.setRangeText('好', 3, 3);
    r.ime.beginCommit({ documentId: 1, authorizedVersion: 2, expectedView: 'abc好', outcome: 'committed', committedText: '好' });
    r.set(typed(typed(r.core, 3, '好'), 0, 'x'));
    expect(r.ime.state()).toMatchObject({ kind: 'settled', outcome: 'committed-unverified' });
    expect(ta.value).toBe('xabc好');
    r.flush();
    expect(r.reports).toContain('unauthorized-change-during-commit');
  });

  it('detach 之后的 store 变化不再写 DOM', () => {
    const r = rig(session('abc'));
    const ta = fakeTextarea();
    r.writeBack.attach(ta);
    r.writeBack.detach();
    ta.calls.length = 0;
    r.set(typed(r.core, 0, 'x'));
    expect(ta.calls).toEqual([]);
  });
});
