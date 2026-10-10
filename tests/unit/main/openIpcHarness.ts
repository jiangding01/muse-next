/**
 * M3 T1b-2a `registerOpenIpc` 测试用的可控 fake：IPC 注册表、窗口 / sender / frame、可手动结束的对话框、
 * 单调时钟与定时器、内存文件系统（复用 T1a 的 `fakeFileSystem`）。
 */

import { expect } from 'vitest';

import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
import { registerOpenIpc } from '../../../src/main/ipc/registerOpenIpc';
import type { FrameLike, InvokeEventLike, OpenIpcDeps, OpenIpcHandle, SenderLike } from '../../../src/main/ipc/registerOpenIpc';
import { IPC } from '../../../src/shared/ipc';
import { bytesOf, createFakeFileSystem } from './fakeFileSystem';
import type { FakeFileSystem } from './fakeFileSystem';
import type { ReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';

export const APP_URL = 'file:///app/renderer/main_window/index.html';

export interface FakeSender extends SenderLike {
  destroyed: boolean;
}

export interface FakeWindow {
  readonly name: string;
}

type Listener = (event: InvokeEventLike<FakeSender>, payload: unknown) => unknown;

interface Deferred {
  resolve(path: string | null): void;
  reject(error: unknown): void;
}

export interface Harness {
  readonly handle: OpenIpcHandle<FakeWindow>;
  readonly fs: FakeFileSystem;
  /** 每次对话框调用收到的父窗口。 */
  readonly dialogParents: FakeWindow[];
  /** 已排程的 TTL 清理任务。 */
  readonly timers: { readonly at: number; readonly delay: number; readonly task: () => void }[];
  clock: number;
  invoke(channel: string, event: InvokeEventLike<FakeSender>, payload: unknown): Promise<unknown>;
  /** 结束第 index 次对话框（0 起）。 */
  resolveDialog(index: number, path: string | null): void;
  failDialog(index: number, error: unknown): void;
  /** 执行到期的定时器。 */
  runDueTimers(): void;
  window(id: number): { readonly sender: FakeSender; readonly window: FakeWindow };
  expectConsistent(): void;
}

export interface HarnessOptions {
  readonly issueToken?: () => string;
  readonly windowForSender?: (sender: FakeSender) => FakeWindow | null;
  /** 覆盖默认的可控对话框（例如同步抛错的选择器）。 */
  readonly chooseOpenPath?: (parent: FakeWindow) => Promise<string | null>;
  /** 覆盖默认的内存文件系统（例如读取悬挂的 fs）。 */
  readonly fs?: ReadOnlyFileSystem;
}

const ASCII = (text: string): Uint8Array => bytesOf(...Array.from(text, (c) => c.charCodeAt(0)));

export function createHarness(options: HarnessOptions = {}): Harness {
  const listeners = new Map<string, Listener>();
  const fs = createFakeFileSystem({
    '/docs/a.jcx': { kind: 'file', bytes: ASCII('X:1\nT:a\n'), ino: 11n },
    '/docs/b.jcx': { kind: 'file', bytes: ASCII('X:1\nT:b\n'), ino: 12n },
    '/docs/utf16.jcx': { kind: 'file', bytes: bytesOf(0xff, 0xfe, 0x41, 0x00), ino: 13n },
  });
  const dialogs: Deferred[] = [];
  const dialogParents: FakeWindow[] = [];
  const timers: { at: number; delay: number; task: () => void; done: boolean }[] = [];
  const windows = new Map<number, { sender: FakeSender; window: FakeWindow }>();
  let tokens = 0;
  const state = { clock: 1_000 };
  const deps: OpenIpcDeps<FakeSender, FakeWindow> = {
    ipc: {
      handle(channel, listener) {
        if (listeners.has(channel)) throw new Error(`second handler for ${channel}`);
        listeners.set(channel, listener);
      },
    },
    windowForSender: options.windowForSender ?? ((sender) => windows.get(sender.id)?.window ?? null),
    pageIdentity: { kind: 'file', url: APP_URL },
    chooseOpenPath: (parent) => {
      dialogParents.push(parent);
      if (options.chooseOpenPath !== undefined) return options.chooseOpenPath(parent);
      return new Promise<string | null>((resolve, reject) => {
        dialogs.push({ resolve, reject });
      });
    },
    fs: options.fs ?? fs,
    platform: 'linux',
    now: () => state.clock,
    issueToken:
      options.issueToken ??
      (() => {
        tokens += 1;
        return `token-${String(tokens)}`;
      }),
    schedule: (delay, task) => {
      timers.push({ at: state.clock + delay, delay, task, done: false });
    },
  };
  const handle = registerOpenIpc(deps);

  const dialogAt = (index: number): Deferred => {
    const dialog = dialogs[index];
    if (dialog === undefined) throw new Error(`no dialog #${String(index)}`);
    return dialog;
  };

  return {
    handle,
    fs,
    dialogParents,
    timers,
    get clock() {
      return state.clock;
    },
    set clock(value: number) {
      state.clock = value;
    },
    async invoke(channel, event, payload) {
      const listener = listeners.get(channel);
      if (listener === undefined) throw new Error(`no handler for ${channel}`);
      return await listener(event, payload);
    },
    resolveDialog: (index, path) => dialogAt(index).resolve(path),
    failDialog: (index, error) => dialogAt(index).reject(error),
    runDueTimers() {
      for (const timer of timers) {
        if (!timer.done && timer.at <= state.clock) {
          timer.done = true;
          timer.task();
        }
      }
    },
    window(id) {
      const existing = windows.get(id);
      if (existing !== undefined) return existing;
      const mainFrame: FrameLike = { url: APP_URL };
      const sender: FakeSender = { id, destroyed: false, mainFrame, isDestroyed: () => sender.destroyed };
      const created = { sender, window: { name: `window-${String(id)}` } };
      windows.set(id, created);
      handle.attachWindow(id, created.window);
      return created;
    },
    expectConsistent() {
      expect(coordinatorInvariantViolations(handle.currentState())).toEqual([]);
    },
  };
}

/** 主 frame 上应用页面发出的事件。 */
export function mainFrameEvent(sender: FakeSender): InvokeEventLike<FakeSender> {
  return { sender, senderFrame: sender.mainFrame };
}

export const OPEN = IPC.openDocument;
export const ACTIVATE = IPC.activateDocument;
export const REJECT = IPC.rejectDocument;
export const DIALOG = { intent: 'dialog' } as const;

/** 等待微任务队列清空（让被 resolve 的对话框后续步骤执行完）。 */
export const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
