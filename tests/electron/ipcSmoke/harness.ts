/**
 * 真实窗口 IPC smoke 的测试侧 harness（M3 T1b-2b-1）。
 *
 * 只提供「可控的输入」与「观测手段」，不实现任何 Open 协议逻辑：协议全部来自生产 `registerOpenIpc`，窗口事件全部经生产
 * `wireOpenIpcWindow` 接线。这里有：
 * - 受控选择器 `createScriptedChooser`：main 持有的脚本队列，按调用顺序给出路径 / 取消 / 同步抛错 / 异步 reject / 延迟 settle；
 *   renderer 无法向它传任何路径。
 * - 可暂停的只读 fs `createGatedFileSystem`：包裹生产 `createNodeReadOnlyFileSystem`，可让读取阶段停在 `openForRead` 之前。
 * - 测试时钟与调度器：`now` = 单调时钟 + 可推进的偏移；`schedule` 只登记任务，由用例显式执行到期任务。
 * - 有界等待：每个页面调用都有超时；导航前发出的 `executeJavaScript` 不作为完成信号。
 *
 * 本文件不 import electron：窗口与页面操作在 `windows.ts`。
 */

import { performance } from 'node:perf_hooks';

import type { FileStat, ReadOnlyFileHandle, ReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
  readonly settled: () => boolean;
}

export function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  let rejectFn: (error: unknown) => void = () => undefined;
  let done = false;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return {
    promise,
    resolve: (value) => {
      done = true;
      resolveFn(value);
    },
    reject: (error) => {
      done = true;
      rejectFn(error);
    },
    settled: () => done,
  };
}

/** 有界等待：超时抛出带标签的错误（不吞掉原 promise 的结果）。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${String(ms)} ms: ${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询直到条件成立或超时；返回最终是否成立（不抛错，由调用方判定）。 */
export async function waitFor(condition: () => boolean, timeoutMs: number, stepMs = 20): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (condition()) return true;
    await delay(stepMs);
  }
  return condition();
}

/** 选择器的一步脚本。 */
export type ChooserStep =
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'throw-sync'; readonly message: string }
  | { readonly kind: 'reject-async'; readonly message: string }
  | { readonly kind: 'deferred'; readonly control: Deferred<string | null> };

export interface ChooserCall<W> {
  readonly parent: W;
  readonly step: ChooserStep | null;
}

export interface ScriptedChooser<W> {
  choose(parent: W): Promise<string | null>;
  /** 追加脚本；选择器按调用顺序消费。 */
  enqueue(...steps: ChooserStep[]): void;
  readonly calls: readonly ChooserCall<W>[];
  /** 未被消费的脚本数（用例结束时应为 0）。 */
  remaining(): number;
  /** 清空脚本与调用记录；尚未 settle 的 deferred 一律以「取消」结束（避免失败用例的残留选择器连锁影响后续用例）。 */
  reset(): void;
}

/**
 * main 持有的受控选择器。没有脚本时视为测试编写错误：同步抛错（registerOpenIpc 会转成 read-failed，用例断言会失败）。
 */
export function createScriptedChooser<W>(): ScriptedChooser<W> {
  const queue: ChooserStep[] = [];
  const calls: ChooserCall<W>[] = [];
  return {
    choose(parent) {
      const step = queue.shift() ?? null;
      calls.push({ parent, step });
      if (step === null) throw new Error('scripted chooser: no step queued');
      switch (step.kind) {
        case 'path':
          return Promise.resolve(step.path);
        case 'cancel':
          return Promise.resolve(null);
        case 'throw-sync':
          throw new Error(step.message);
        case 'reject-async':
          return Promise.reject(new Error(step.message));
        case 'deferred':
          return step.control.promise;
      }
    },
    enqueue: (...steps) => {
      queue.push(...steps);
    },
    calls,
    remaining: () => queue.length,
    reset: () => {
      const steps = [...queue, ...calls.map((call) => call.step)];
      for (const step of steps) if (step?.kind === 'deferred' && !step.control.settled()) step.control.resolve(null);
      queue.length = 0;
      calls.length = 0;
    },
  };
}

export interface GatedFileSystem extends ReadOnlyFileSystem {
  /** 下一次 `openForRead` 在此闸门打开前不返回；返回闸门（resolve 即放行）与「已到达闸门」信号。 */
  holdNextRead(): { readonly release: () => void; readonly reached: Promise<void> };
  /** 是否仍有未放行的闸门（用例结束时应为 false）。 */
  hasPendingGate(): boolean;
  /** 下一次 `openForRead` 抛出给定异常（故障注入：异常文本含路径，验证 main 不外泄）。 */
  failNextOpen(error: Error): void;
  /** 用例收尾：放行并丢弃全部闸门与未消费的故障（在残留检查之后调用，避免一个失败用例连锁影响后续用例）。 */
  releaseAll(): void;
}

/** 包裹生产只读 fs：只在 `openForRead` 前插入可选闸门，其余原样转发。 */
export function createGatedFileSystem(inner: ReadOnlyFileSystem): GatedFileSystem {
  interface Gate {
    readonly gate: Deferred<void>;
    readonly reached: Deferred<void>;
  }
  /** 尚未被读取消费的闸门（按顺序）。 */
  const queue: Gate[] = [];
  /** 尚未放行的全部闸门（含已被读取消费、正在等待的）。 */
  const held = new Set<Gate>();
  const failures: Error[] = [];
  const release = (entry: Gate): void => {
    held.delete(entry);
    entry.gate.resolve();
  };
  return {
    realpath: (path) => inner.realpath(path),
    stat: (path): Promise<FileStat> => inner.stat(path),
    openForRead: async (path): Promise<ReadOnlyFileHandle> => {
      const failure = failures.shift();
      if (failure !== undefined) throw failure;
      const next = queue.shift();
      if (next !== undefined) {
        next.reached.resolve();
        await next.gate.promise;
      }
      return inner.openForRead(path);
    },
    holdNextRead: () => {
      const entry: Gate = { gate: deferred<void>(), reached: deferred<void>() };
      queue.push(entry);
      held.add(entry);
      return { release: () => release(entry), reached: entry.reached.promise };
    },
    hasPendingGate: () => held.size > 0 || failures.length > 0,
    failNextOpen: (error) => {
      failures.push(error);
    },
    releaseAll: () => {
      for (const entry of [...held]) release(entry);
      queue.length = 0;
      failures.length = 0;
    },
  };
}

export interface TestClock {
  now(): number;
  advance(ms: number): void;
}

/** 单调时钟 + 可推进偏移（只增不减）。 */
export function createTestClock(): TestClock {
  let offset = 0;
  return {
    now: () => performance.now() + offset,
    advance: (ms) => {
      if (!Number.isFinite(ms) || ms < 0) throw new RangeError('clock can only move forward');
      offset += ms;
    },
  };
}

export interface ManualScheduler {
  schedule(delayMs: number, task: () => void): void;
  /** 执行所有已到期（按测试时钟）的任务；返回执行数。 */
  runDue(): number;
  pending(): number;
  /** 用例开始时丢弃此前用例登记的任务（它们只清理已关闭窗口的候选），使 `runDue` 只统计本用例的任务。 */
  clear(): void;
}

export function createManualScheduler(clock: TestClock): ManualScheduler {
  const tasks: { due: number; task: () => void }[] = [];
  return {
    schedule: (delayMs, task) => {
      tasks.push({ due: clock.now() + delayMs, task });
    },
    runDue: () => {
      const now = clock.now();
      const due = tasks.filter((entry) => entry.due <= now);
      for (const entry of due) tasks.splice(tasks.indexOf(entry), 1);
      for (const entry of due) entry.task();
      return due.length;
    },
    pending: () => tasks.length,
    clear: () => {
      tasks.length = 0;
    },
  };
}

/** 故障注入：下一次签发 token 时抛出给定异常（让 T1a 管线之外的意外异常进入 `registerOpenIpc` 的兜底分支）。 */
export interface TokenFaults {
  failNext(error: Error): void;
  /** 生产 token 生成器的包装：有待注入的故障时抛出，否则调用 `issue`。 */
  issue(next: () => string): string;
  pending(): number;
  clear(): void;
}

export function createTokenFaults(): TokenFaults {
  const queue: Error[] = [];
  return {
    failNext: (error) => {
      queue.push(error);
    },
    issue: (next) => {
      const failure = queue.shift();
      if (failure !== undefined) throw failure;
      return next();
    },
    pending: () => queue.length,
    clear: () => {
      queue.length = 0;
    },
  };
}
