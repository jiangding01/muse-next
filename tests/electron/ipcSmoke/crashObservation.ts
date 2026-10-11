/**
 * renderer 退出的只读观测（M3 T1b-2b-1）：`render-process-gone` 监听、owner 状态探针与 forceCrash 观测 `crashAndObserve`。
 *
 * - 所有监听只记录事件，不调用协调器 / handle 方法；清理只能由生产 `wireOpenIpcWindow` 转发的事件完成。
 * - smoke 中唯一注册 `render-process-gone` 监听的地方是 `watchRendererGone`（架构守卫锁定）。
 * - Linux 的信号实验（硬门与 forceCrash 后诊断）在 `linuxExitExperiments.ts`。
 */

import { performance } from 'node:perf_hooks';

import { app } from 'electron';
import type { RenderProcessGoneDetails, WebContents } from 'electron';

import { capabilitiesOf, ownerMeta } from './context';
import type { SmokeContext } from './context';
import { waitFor, withTimeout } from './harness';
import { nodeProcReader, snapshotProcess } from './linuxProcessDiagnostics';
import type { ProcessSnapshot } from './linuxProcessDiagnostics';
import type { SmokeWindow } from './windows';

/**
 * forceCrash 的诊断观察窗口（CI run 38142547427：Ubuntu 上 5 s 内未见 `render-process-gone` 的效果）。只用于判断
 * 平台 / CI 延迟，不是产品的实时失效合同；超过 5 s 的到达会如实记为 `D-late-cleanup`。
 */
export const CRASH_OBSERVE_MS = 20_000;
const CRASH_PROMPT_MS = 5_000;
/** 单次 `/proc` 诊断读取的上限。 */
const PROC_READ_LIMIT_MS = 3_000;

export interface CrashEvent {
  readonly ms: number;
  readonly reason: string;
  readonly exitCode: number;
}

export type AppCrashEvent = CrashEvent & { readonly matchesTarget: boolean };

/** 监听器记录的绝对时刻（`performance.now()`）；由调用方按各自的基准换算成 `CrashEvent.ms`。 */
interface SeenEvent {
  readonly at: number;
  readonly reason: string;
  readonly exitCode: number;
}

export function relativeEvent(event: SeenEvent | null, base: number): CrashEvent | null {
  return event === null ? null : { ms: Math.round(event.at - base), reason: event.reason, exitCode: event.exitCode };
}

export function relativeAppEvent(event: (SeenEvent & { readonly matchesTarget: boolean }) | null, base: number): AppCrashEvent | null {
  return event === null ? null : { ms: Math.round(event.at - base), reason: event.reason, exitCode: event.exitCode, matchesTarget: event.matchesTarget };
}

export interface CrashTimeline {
  /** 已调用 `forcefullyCrashRenderer()`：调用抛错会使 `crashAndObserve` 直接抛出（用例判失败），所以返回的时间线中恒为 true。 */
  readonly forceCrashInvoked: boolean;
  /** 观察窗口已经结束：`crashAndObserve` 只在观察结束后返回时间线，此字段记录这一事实供后续诊断的前置条件使用。 */
  readonly observationEnded: boolean;
  readonly webContentsId: number;
  readonly rendererPid: number;
  readonly generationBefore: number;
  readonly generationAfter: number;
  readonly capabilitiesBefore: number;
  readonly capabilitiesAfter: number;
  /** 旧 token 崩溃前 / 后能否授权（没有 token 时为 null）。 */
  readonly oldTokenAuthorizedBefore: boolean | null;
  readonly oldTokenAuthorizedAfter: boolean | null;
  /** 目标 webContents 的 `render-process-gone`（生产接线监听的就是它）。 */
  readonly contentsEvent: CrashEvent | null;
  /** `app` 的 `render-process-gone`；`matchesTarget` 表示事件属于目标 webContents。 */
  readonly appEvent: AppCrashEvent | null;
  /** 首次观察到「generation 前进、能力清空、旧 token 不再授权」的时刻（自调用崩溃起，毫秒）。 */
  readonly clearedAtMs: number | null;
  /** webContents 已销毁时为 null。 */
  readonly isCrashed: boolean | null;
  /** 观察结束时崩溃前的 renderer PID 是否仍存在（`process.kill(pid, 0)`；区分「没被杀掉」与「杀掉了但事件未送达」）。 */
  readonly rendererAliveAfter: boolean | null;
  /** Linux：崩溃前的 `/proc` 快照（进程身份基准，用于识别 PID 复用）；其它平台为 null。 */
  readonly linuxBefore: ProcessSnapshot | null;
  /**
   * A：目标 webContents 的事件没到（app 也没有目标事件；若 app 只收到其它 webContents 的事件同样归 A，原始事件保留在 appEvent）；
   * B：只有 app 收到目标事件；C：webContents 收到但状态未清理；D：已清理但超过 5 s；ok：5 s 内清理。
   */
  readonly category: 'A-no-event' | 'B-app-only' | 'C-event-without-cleanup' | 'D-late-cleanup' | 'ok';
}

export interface GoneWatcher {
  /** 注册时刻（`performance.now()`）。 */
  readonly registeredAt: number;
  readonly seen: { contents: SeenEvent | null; app: (SeenEvent & { readonly matchesTarget: boolean }) | null };
  stop(): void;
}

/** 只读监听目标 webContents 与 app 的 `render-process-gone`（同步注册，调用方须在触发前调用）。 */
export function watchRendererGone(contents: WebContents): GoneWatcher {
  const webContentsId = contents.id;
  // 事件回调异步写入；用记录对象而不是 let，避免控制流收窄把它们当成永远为 null。
  const seen: GoneWatcher['seen'] = { contents: null, app: null };
  const onContentsGone = (_event: unknown, details: RenderProcessGoneDetails): void => {
    seen.contents ??= { at: performance.now(), reason: details.reason, exitCode: details.exitCode };
  };
  const onAppGone = (_event: unknown, gone: WebContents, details: RenderProcessGoneDetails): void => {
    const matchesTarget = gone.id === webContentsId;
    if (seen.app === null || (matchesTarget && !seen.app.matchesTarget)) seen.app = { at: performance.now(), reason: details.reason, exitCode: details.exitCode, matchesTarget };
  };
  contents.on('render-process-gone', onContentsGone);
  app.on('render-process-gone', onAppGone);
  return {
    registeredAt: performance.now(),
    seen,
    stop: () => {
      if (!contents.isDestroyed()) contents.off('render-process-gone', onContentsGone);
      app.off('render-process-gone', onAppGone);
    },
  };
}

export interface OwnerProbe {
  gen(): number;
  caps(): number;
  authorized(): boolean | null;
}

export function ownerProbe(ctx: SmokeContext, window: SmokeWindow, token: string | null): OwnerProbe {
  return {
    gen: () => ownerMeta(ctx, window.ownerId)?.generation ?? -1,
    caps: () => capabilitiesOf(ctx, window.ownerId).length,
    authorized: () => (token === null ? null : ctx.openIpc.authorize(window.ownerId, token) !== null),
  };
}

export function isAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    return code === 'EPERM' ? true : code === 'ESRCH' ? false : null;
  }
}

/** 有界的 `/proc` 读取；超时或异常记为 null（unavailable），不当成通过。 */
export function bounded<T>(task: Promise<T>): Promise<T | null> {
  return withTimeout(task, PROC_READ_LIMIT_MS, 'proc diagnostics').catch(() => null);
}

/**
 * 只读的崩溃观测：监听在调用 `forcefullyCrashRenderer()` 之前注册，只记录事件与状态快照，不调用任何协调器 / handle 方法
 * （清理只能由生产 `wireOpenIpcWindow` 转发的事件完成）。最多观察 `CRASH_OBSERVE_MS`。观察结束后同步返回（之后不再 await），
 * 调用方可以在同一轮微任务内接着注册诊断阶段的监听，不会漏掉迟到的事件。
 */
export async function crashAndObserve(ctx: SmokeContext, window: SmokeWindow, token: string | null): Promise<CrashTimeline> {
  const contents = window.win.webContents;
  const webContentsId = contents.id;
  const rendererPid = contents.getOSProcessId();
  const probe = ownerProbe(ctx, window, token);
  const generationBefore = probe.gen();
  const capabilitiesBefore = probe.caps();
  const oldTokenAuthorizedBefore = probe.authorized();
  const linuxBefore = process.platform === 'linux' ? await bounded(snapshotProcess(nodeProcReader, rendererPid)) : null;
  const start = performance.now();
  const cleared = (): boolean => probe.gen() > generationBefore && probe.caps() === 0 && probe.authorized() !== true;
  const mark: { clearedAtMs: number | null } = { clearedAtMs: null };
  const watcher = watchRendererGone(contents);
  let forceCrashInvoked = false;
  try {
    contents.forcefullyCrashRenderer();
    forceCrashInvoked = true;
    await waitFor(() => {
      if (mark.clearedAtMs === null && cleared()) mark.clearedAtMs = Math.round(performance.now() - start);
      return mark.clearedAtMs !== null && watcher.seen.contents !== null;
    }, CRASH_OBSERVE_MS);
  } finally {
    watcher.stop();
  }
  const clearedAtMs = mark.clearedAtMs;
  const contentsSeen = relativeEvent(watcher.seen.contents, start);
  const appSeen = relativeAppEvent(watcher.seen.app, start);
  let category: CrashTimeline['category'] = 'ok';
  if (contentsSeen === null) category = appSeen?.matchesTarget === true ? 'B-app-only' : 'A-no-event';
  else if (clearedAtMs === null) category = 'C-event-without-cleanup';
  else if (clearedAtMs > CRASH_PROMPT_MS) category = 'D-late-cleanup';
  const timeline: CrashTimeline = {
    forceCrashInvoked,
    observationEnded: true,
    webContentsId,
    rendererPid,
    generationBefore,
    generationAfter: probe.gen(),
    capabilitiesBefore,
    capabilitiesAfter: probe.caps(),
    oldTokenAuthorizedBefore,
    oldTokenAuthorizedAfter: probe.authorized(),
    contentsEvent: contentsSeen,
    appEvent: appSeen,
    clearedAtMs,
    isCrashed: contents.isDestroyed() ? null : contents.isCrashed(),
    rendererAliveAfter: isAlive(rendererPid),
    linuxBefore,
    category,
  };
  // 立即写到 stderr：即使之后外层超时，诊断时间线也保留在 CI 日志里。
  process.stderr.write(`[ipc-smoke] crash timeline ${JSON.stringify(timeline)}\n`);
  return timeline;
}
