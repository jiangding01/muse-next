/**
 * M3 T1b-2a′：共享的窗口事件接线 `wireOpenIpcWindow` 与生产用选择器 `createOpenPathChooser`。
 *
 * 用记录监听器的 fake 窗口证明：窗口被登记；每个事件转发到对应的 handle 方法且带同一个 ownerId；`isSameDocument`
 * / `isMainFrame` 原样转发；`destroyed` 与 `closed` 都转发 dispose；每个事件只登记一次、用 on / once 的方式与 main 原接线一致。
 * 接线后的真实 Electron 事件语义由 T1b-2b 的窗口 smoke 验证。
 */

import { describe, expect, it } from 'vitest';

import { createOpenPathChooser, openDocumentDialogOptions, wireOpenIpcWindow } from '../../../src/main/ipc/wireOpenIpcWindow';
import type { NavigationDetailsLike, OpenDialogOptionsLike, OpenIpcContentsLike, OpenIpcWindowEvents, OpenIpcWindowLike } from '../../../src/main/ipc/wireOpenIpcWindow';

type Listener = (details: NavigationDetailsLike) => void;

const NO_DETAILS: NavigationDetailsLike = { isMainFrame: false, isSameDocument: false };

interface FakeWindow extends OpenIpcWindowLike {
  readonly registrations: { readonly target: 'contents' | 'window'; readonly method: 'on' | 'once'; readonly event: string }[];
  emit(target: 'contents' | 'window', event: string, details?: NavigationDetailsLike): void;
}

function fakeWindow(id: number): FakeWindow {
  const listeners = new Map<string, Listener[]>();
  const registrations: FakeWindow['registrations'] = [];
  const add = (target: 'contents' | 'window', method: 'on' | 'once', event: string, listener: Listener): void => {
    registrations.push({ target, method, event });
    const key = `${target}:${event}`;
    listeners.set(key, [...(listeners.get(key) ?? []), listener]);
  };
  const webContents: OpenIpcContentsLike = {
    id,
    on: (event: string, listener: Listener) => add('contents', 'on', event, listener),
    once: (event: string, listener: Listener) => add('contents', 'once', event, listener),
  };
  return {
    webContents,
    once: (event: string, listener: Listener) => add('window', 'once', event, listener),
    registrations,
    emit(target, event, details = NO_DETAILS) {
      for (const listener of listeners.get(`${target}:${event}`) ?? []) listener(details);
    },
  };
}

function recordingHandle(): { readonly calls: unknown[][]; readonly handle: OpenIpcWindowEvents<FakeWindow> } {
  const calls: unknown[][] = [];
  return {
    calls,
    handle: {
      attachWindow: (ownerId, window) => calls.push(['attachWindow', ownerId, window]),
      handleNavigation: (ownerId, navigation) => calls.push(['handleNavigation', ownerId, navigation]),
      handleNavigationCommitted: (ownerId) => calls.push(['handleNavigationCommitted', ownerId]),
      handleRendererGone: (ownerId) => calls.push(['handleRendererGone', ownerId]),
      disposeWindow: (ownerId) => calls.push(['disposeWindow', ownerId]),
    },
  };
}

describe('wireOpenIpcWindow', () => {
  it('登记窗口并登记全部监听（每个事件一次，on / once 与原接线一致）；返回 webContents id', () => {
    const { calls, handle } = recordingHandle();
    const window = fakeWindow(7);
    expect(wireOpenIpcWindow(handle, window)).toBe(7);
    expect(calls).toEqual([['attachWindow', 7, window]]);
    expect(window.registrations).toEqual([
      { target: 'contents', method: 'on', event: 'did-start-navigation' },
      { target: 'contents', method: 'on', event: 'did-navigate' },
      { target: 'contents', method: 'on', event: 'render-process-gone' },
      { target: 'contents', method: 'once', event: 'destroyed' },
      { target: 'window', method: 'once', event: 'closed' },
    ]);
  });

  it('did-start-navigation 原样转发 isMainFrame / isSameDocument，不做过滤（过滤在 handle 内）', () => {
    const { calls, handle } = recordingHandle();
    const window = fakeWindow(3);
    wireOpenIpcWindow(handle, window);
    for (const details of [
      { isMainFrame: true, isSameDocument: false },
      { isMainFrame: true, isSameDocument: true },
      { isMainFrame: false, isSameDocument: false },
    ]) {
      const withExtra = { ...details, url: 'file:///ignored' };
      window.emit('contents', 'did-start-navigation', withExtra);
    }
    expect(calls.slice(1)).toEqual([
      ['handleNavigation', 3, { isMainFrame: true, isSameDocument: false }],
      ['handleNavigation', 3, { isMainFrame: true, isSameDocument: true }],
      ['handleNavigation', 3, { isMainFrame: false, isSameDocument: false }],
    ]);
  });

  it('did-navigate / render-process-gone / destroyed / closed 各自转发到对应方法', () => {
    const { calls, handle } = recordingHandle();
    const window = fakeWindow(5);
    wireOpenIpcWindow(handle, window);
    window.emit('contents', 'did-navigate');
    window.emit('contents', 'render-process-gone');
    window.emit('contents', 'destroyed');
    window.emit('window', 'closed');
    expect(calls.slice(1)).toEqual([
      ['handleNavigationCommitted', 5],
      ['handleRendererGone', 5],
      ['disposeWindow', 5],
      ['disposeWindow', 5],
    ]);
  });
});

describe('createOpenPathChooser', () => {
  it('父窗口与选项原样传给 showOpenDialog；每次调用新建选项对象', async () => {
    const seen: { parent: string; options: OpenDialogOptionsLike }[] = [];
    const choose = createOpenPathChooser<string>((parent, options) => {
      seen.push({ parent, options });
      return Promise.resolve({ canceled: false, filePaths: ['/docs/a.jcx', '/docs/b.jcx'] });
    });
    expect(await choose('window-1')).toBe('/docs/a.jcx');
    expect(await choose('window-2')).toBe('/docs/a.jcx');
    expect(seen.map((s) => s.parent)).toEqual(['window-1', 'window-2']);
    expect(seen[0]?.options).toEqual({
      title: 'Open Muse Score',
      properties: ['openFile'],
      filters: [
        { name: 'Muse score', extensions: ['jcx'] },
        { name: 'Text files', extensions: ['txt', 'abc', 'tab'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    expect(openDocumentDialogOptions()).toEqual(seen[0]?.options);
    expect(seen[0]?.options).not.toBe(seen[1]?.options);
  });

  it('取消、或 canceled:false 但没有文件（macOS close() 结束 sheet 时的回复）都返回 null', async () => {
    for (const result of [{ canceled: true, filePaths: [] }, { canceled: true, filePaths: ['/docs/a.jcx'] }, { canceled: false, filePaths: [] }]) {
      expect(await createOpenPathChooser<string>(() => Promise.resolve(result))('w')).toBeNull();
    }
  });

  it('showOpenDialog 拒绝时原样抛出（由 registerOpenIpc 统一转成 read-failed）', async () => {
    const error = new Error('dialog failed');
    await expect(createOpenPathChooser<string>(() => Promise.reject(error))('w')).rejects.toBe(error);
  });
});
