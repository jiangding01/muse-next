/**
 * M3 T3a：运行时错误处理（`src/renderer/app/fatalError.ts`；方案 §19，T3 Preflight r3 §5.1、§8，r3 复查 L-6）。
 *
 * 重点：编辑器错误先记录；开发期经 defer 异步重新抛出（同一个 Error 对象，非 Error 值被包装），生产期只记录；
 * 致命提示只显示一次、随 dirty 实时改变文案、不出现「先保存」；根错误回调三项齐全。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { applySourceInput, sourceSelectionFromView, undoStep } from '../../../src/renderer/app/editor/editorTransitions';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { createErrorReporter, createFatalNotice, fatalNoticeText, museRootErrorOptions } from '../../../src/renderer/app/fatalError';
import { applyEditorStep, commitSession, useMuseAppStore } from '../../../src/renderer/app/store';

function reporter(isDev: boolean) {
  const logs: unknown[] = [];
  const deferred: (() => void)[] = [];
  const report = createErrorReporter({ log: (_message, error) => logs.push(error), isDev, defer: (task) => deferred.push(task) });
  return { report, logs, deferred };
}

describe('fatalError —— 编辑器错误报告', () => {
  it('开发期：记录后异步重新抛出同一个 Error（不在当前调用中抛出）', () => {
    const { report, logs, deferred } = reporter(true);
    const error = new Error('boom');
    expect(() => report(error, 'undo')).not.toThrow();
    expect(logs).toEqual([error]);
    expect(deferred).toHaveLength(1);
    expect(() => deferred[0]?.()).toThrow(error);
  });

  it('开发期：非 Error 值被包装为 Error', () => {
    const { report, deferred } = reporter(true);
    report('plain', 'parse');
    expect(() => deferred[0]?.()).toThrow('plain');
  });

  it('生产期：只记录，不重新抛出', () => {
    const { report, logs, deferred } = reporter(false);
    report(new Error('quiet'), 'parse');
    expect(logs).toHaveLength(1);
    expect(deferred).toEqual([]);
  });
});

describe('fatalError —— 致命提示', () => {
  it('文案随 dirty 变化，且不建议「先保存」（T3 没有 Save）', () => {
    expect(fatalNoticeText(true)).toContain('未保存的修改');
    expect(fatalNoticeText(false)).toContain('可以关闭窗口');
    expect(fatalNoticeText(true)).not.toContain('先保存');
    expect(fatalNoticeText(false)).not.toContain('先保存');
  });

  it('只显示一次；dirty 变化时实时更新文案；重复调用返回同一取消订阅函数', () => {
    const attached: { textContent: string | null }[] = [];
    let emit: (dirty: boolean) => void = () => undefined;
    let unsubscribed = 0;
    const show = createFatalNotice({
      create: () => ({ textContent: null }),
      attach: (element) => attached.push(element),
      subscribeDirty: (listener) => {
        emit = listener;
        listener(true);
        return () => {
          unsubscribed += 1;
        };
      },
    });
    const stop = show();
    expect(show()).toBe(stop);
    expect(attached).toHaveLength(1);
    expect(attached[0]?.textContent).toBe(fatalNoticeText(true));
    emit(false);
    expect(attached[0]?.textContent).toBe(fatalNoticeText(false));
    stop();
    expect(unsubscribed).toBe(1);
  });

  it('根错误回调：onUncaughtError / onCaughtError / onRecoverableError 三项都存在', () => {
    expect(Object.keys(museRootErrorOptions).sort()).toEqual(['onCaughtError', 'onRecoverableError', 'onUncaughtError']);
  });
});

interface FakeElement {
  readonly tag: string;
  className: string;
  textContent: string | null;
  readonly attributes: Map<string, string>;
  readonly style: Record<string, string>;
  setAttribute(name: string, value: string): void;
}

/** node 环境没有 DOM：用最小的 document 夹具记录 createElement、插入位置与 CSSOM 样式（真实 Electron 中的可见性另见复核证据）。 */
function fakeDocument() {
  const created: FakeElement[] = [];
  const prepended: FakeElement[] = [];
  const appended: FakeElement[] = [];
  const document = {
    createElement: (tag: string): FakeElement => {
      const attributes = new Map<string, string>();
      const element: FakeElement = { tag, className: '', textContent: null, attributes, style: {}, setAttribute: (name, value) => attributes.set(name, value) };
      created.push(element);
      return element;
    },
    body: { prepend: (element: FakeElement) => prepended.push(element), append: (element: FakeElement) => appended.push(element) },
  };
  return { document, created, prepended, appended };
}

function editOnCurrent(text: string): void {
  const { session, history, selection } = useMuseAppStore.getState();
  const base = { session, history, selection };
  const end = session.projection.view.length;
  const caret = sourceSelectionFromView(session, { start: end, end });
  if (caret === null) throw new Error('selection');
  const step = applySourceInput(base, { viewPatch: { start: end, end, text }, selection: caret, coalesce: null, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  expect(applyEditorStep(step.core, base)).toEqual({ ok: true });
}

describe('fatalError —— 根卸载后的致命提示（r3a 复核 M-2）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    commitSession(createDemoSession(), 'none');
  });

  it('根卸载（onUncaughtError）：提示插入 body 最前面并固定在视口顶部，无需滚动；重复错误只显示一个；文案随 dirty 实时更新', () => {
    const dom = fakeDocument();
    vi.stubGlobal('document', dom.document);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    museRootErrorOptions.onUncaughtError(new Error('render 1'), {});
    museRootErrorOptions.onUncaughtError(new Error('render 2'), {});
    expect(dom.created).toHaveLength(1);
    expect(dom.appended).toEqual([]);
    expect(dom.prepended).toHaveLength(1);
    const notice = dom.prepended[0];
    if (notice === undefined) throw new Error('notice');
    expect(notice.attributes.get('role')).toBe('alert');
    expect(notice.style).toMatchObject({ position: 'fixed', top: '0px', left: '0px', right: '0px' });
    expect(Number(notice.style.zIndex)).toBeGreaterThanOrEqual(2147483647);
    expect(notice.textContent).toBe(fatalNoticeText(false));
    editOnCurrent('z');
    expect(notice.textContent).toBe(fatalNoticeText(true));
    const { session, history, selection } = useMuseAppStore.getState();
    const undone = undoStep({ session, history, selection });
    if (!undone.ok) throw new Error(undone.reason);
    expect(applyEditorStep(undone.core, { session, history, selection })).toEqual({ ok: true });
    expect(notice.textContent).toBe(fatalNoticeText(false));
  });
});
