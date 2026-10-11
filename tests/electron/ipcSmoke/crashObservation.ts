/**
 * renderer 崩溃的只读观测与 Linux 诊断（M3 T1b-2b-1；`crashAndObserve` 自 `casesIsolated.ts` 原样迁入）。
 *
 * - 所有监听只记录事件，不调用协调器 / handle 方法；清理只能由生产 `wireOpenIpcWindow` 转发的事件完成。
 * - `linuxPostKillDiagnosis` 是独立的诊断阶段：只在 Linux、forceCrash 观察窗口结束且未收到目标事件时运行；
 *   它的结果单独记录，**不改变** forceCrash 的判定。SIGKILL 只在 `killRefusals` 全部通过后发送一次。
 */

import { performance } from 'node:perf_hooks';

import { app, webContents } from 'electron';
import type { RenderProcessGoneDetails, WebContents } from 'electron';

import { capabilitiesOf, invariantProblems, ownerMeta } from './context';
import type { SmokeContext } from './context';
import { waitFor, withTimeout } from './harness';
import { ancestorsOf, killRefusals, nodeProcReader, scanCrashHelpers, snapshotProcess, unavailableSnapshot } from './linuxProcessDiagnostics';
import type { CrashHelper, ProcessSnapshot } from './linuxProcessDiagnostics';
import type { SmokeWindow } from './windows';

/**
 * forceCrash 的诊断观察窗口（CI run 38142547427：Ubuntu 上 5 s 内未见 `render-process-gone` 的效果）。只用于判断
 * 平台 / CI 延迟，不是产品的实时失效合同；超过 5 s 的到达会如实记为 `D-late-cleanup`。
 */
export const CRASH_OBSERVE_MS = 20_000;
const CRASH_PROMPT_MS = 5_000;
/** SIGKILL 之后的额外观察窗口。 */
const POST_KILL_OBSERVE_MS = 5_000;
/** 单次 `/proc` 诊断读取的上限。 */
const PROC_READ_LIMIT_MS = 3_000;

export interface CrashEvent {
  readonly ms: number;
  readonly reason: string;
  readonly exitCode: number;
}

type AppCrashEvent = CrashEvent & { readonly matchesTarget: boolean };

export interface CrashTimeline {
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

interface GoneWatcher {
  readonly seen: { contents: CrashEvent | null; app: AppCrashEvent | null };
  stop(): void;
}

/** 只读监听目标 webContents 与 app 的 `render-process-gone`（同步注册，调用方须在触发前调用）。 */
function watchRendererGone(contents: WebContents, start: number): GoneWatcher {
  const webContentsId = contents.id;
  // 事件回调异步写入；用记录对象而不是 let，避免控制流收窄把它们当成永远为 null。
  const seen: GoneWatcher['seen'] = { contents: null, app: null };
  const since = (): number => Math.round(performance.now() - start);
  const onContentsGone = (_event: unknown, details: RenderProcessGoneDetails): void => {
    seen.contents ??= { ms: since(), reason: details.reason, exitCode: details.exitCode };
  };
  const onAppGone = (_event: unknown, gone: WebContents, details: RenderProcessGoneDetails): void => {
    const matchesTarget = gone.id === webContentsId;
    if (seen.app === null || (matchesTarget && !seen.app.matchesTarget)) seen.app = { ms: since(), reason: details.reason, exitCode: details.exitCode, matchesTarget };
  };
  contents.on('render-process-gone', onContentsGone);
  app.on('render-process-gone', onAppGone);
  return {
    seen,
    stop: () => {
      if (!contents.isDestroyed()) contents.off('render-process-gone', onContentsGone);
      app.off('render-process-gone', onAppGone);
    },
  };
}

interface OwnerProbe {
  gen(): number;
  caps(): number;
  authorized(): boolean | null;
}

function ownerProbe(ctx: SmokeContext, window: SmokeWindow, token: string | null): OwnerProbe {
  return {
    gen: () => ownerMeta(ctx, window.ownerId)?.generation ?? -1,
    caps: () => capabilitiesOf(ctx, window.ownerId).length,
    authorized: () => (token === null ? null : ctx.openIpc.authorize(window.ownerId, token) !== null),
  };
}

function isAlive(pid: number): boolean | null {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : null;
    return code === 'EPERM' ? true : code === 'ESRCH' ? false : null;
  }
}

/** 有界的 `/proc` 读取；超时或异常记为 null（unavailable），不当成通过。 */
function bounded<T>(task: Promise<T>): Promise<T | null> {
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
  const watcher = watchRendererGone(contents, start);
  try {
    contents.forcefullyCrashRenderer();
    await waitFor(() => {
      if (mark.clearedAtMs === null && cleared()) mark.clearedAtMs = Math.round(performance.now() - start);
      return mark.clearedAtMs !== null && watcher.seen.contents !== null;
    }, CRASH_OBSERVE_MS);
  } finally {
    watcher.stop();
  }
  const clearedAtMs = mark.clearedAtMs;
  const contentsSeen = watcher.seen.contents;
  const appSeen = watcher.seen.app;
  let category: CrashTimeline['category'] = 'ok';
  if (contentsSeen === null) category = appSeen?.matchesTarget === true ? 'B-app-only' : 'A-no-event';
  else if (clearedAtMs === null) category = 'C-event-without-cleanup';
  else if (clearedAtMs > CRASH_PROMPT_MS) category = 'D-late-cleanup';
  const timeline: CrashTimeline = {
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

export interface LinuxProcessFacts {
  readonly windowAlive: boolean;
  readonly currentWebContentsPid: number | null;
  readonly isCrashed: boolean | null;
  readonly proc: ProcessSnapshot | null;
  readonly ancestors: readonly number[] | null;
  readonly underSmokeMain: boolean | null;
  readonly crashHelpers: readonly CrashHelper[] | null;
}

/** 只读采集崩溃观察结束后的进程事实（不发送任何信号）。窗口相关字段在第一个 await 之前同步取得。 */
export async function linuxProcessFacts(window: SmokeWindow, pid: number): Promise<LinuxProcessFacts> {
  const alive = !window.win.isDestroyed();
  const currentWebContentsPid = alive ? window.win.webContents.getOSProcessId() : null;
  const isCrashed = alive ? window.win.webContents.isCrashed() : null;
  const proc = await bounded(snapshotProcess(nodeProcReader, pid));
  const ancestors = await bounded(ancestorsOf(nodeProcReader, pid));
  return {
    windowAlive: alive,
    currentWebContentsPid,
    isCrashed,
    proc,
    ancestors,
    underSmokeMain: ancestors === null ? null : ancestors.includes(process.pid),
    crashHelpers: await bounded(scanCrashHelpers(nodeProcReader, process.pid)),
  };
}

export interface PostKillDiagnosis {
  readonly facts: LinuxProcessFacts;
  /** 发送信号前的拒绝原因（非空即未发送）。 */
  readonly refusals: readonly string[];
  readonly signalSent: boolean;
  readonly signalError: string | null;
  readonly procAfterKill: ProcessSnapshot | null;
  /** `process.kill(pid, 0)`：未被回收的僵尸进程同样为 true，须结合 `procAfterKill.stateLabel` 解读。 */
  readonly aliveAfterKill: boolean | null;
  readonly contentsEvent: CrashEvent | null;
  readonly appEvent: AppCrashEvent | null;
  readonly generationBefore: number;
  readonly generationAfter: number;
  readonly capabilitiesAfter: number;
  readonly oldTokenAuthorizedAfter: boolean | null;
  /** 自发送信号起，首次观察到清理完成的时刻（毫秒）。 */
  readonly clearedAtMs: number | null;
  readonly invariantsHold: boolean;
}

/**
 * Linux 诊断阶段（独立于 forceCrash 判定）：先**同步**重新注册只读监听（不漏掉观察窗口之后迟到的事件），再采集 `/proc` 事实；
 * `killRefusals` 全部通过才对该 renderer PID 发送一次 SIGKILL，并在 `POST_KILL_OBSERVE_MS` 内观察事件与清理。
 */
export async function linuxPostKillDiagnosis(ctx: SmokeContext, window: SmokeWindow, token: string | null, crash: CrashTimeline): Promise<PostKillDiagnosis> {
  const contents = window.win.webContents;
  const watcher = watchRendererGone(contents, performance.now());
  const probe = ownerProbe(ctx, window, token);
  const generationBefore = probe.gen();
  try {
    const pid = crash.rendererPid;
    const facts = await linuxProcessFacts(window, pid);
    // 发送前的最后一次有界快照；之后的窗口 / PID / 事件检查与发送都在同一段同步代码里完成，中间没有 await。
    const now = (await bounded(snapshotProcess(nodeProcReader, pid))) ?? unavailableSnapshot(pid);
    const windowAlive = !window.win.isDestroyed();
    const targetId = crash.webContentsId;
    const refusals = killRefusals({
      platform: process.platform,
      observationEnded: true,
      forceCrashRecorded: true,
      eventAlreadyArrived: watcher.seen.contents !== null || watcher.seen.app?.matchesTarget === true,
      pid,
      mainPid: process.pid,
      mainExecutableName: process.execPath.split(/[\\/]/).pop() ?? '',
      before: crash.linuxBefore,
      now,
      ancestors: facts.ancestors,
      windowAlive,
      currentWebContentsPid: windowAlive ? window.win.webContents.getOSProcessId() : -1,
      otherWindowPids: webContents
        .getAllWebContents()
        .filter((other) => other.id !== targetId && !other.isDestroyed())
        .map((other) => other.getOSProcessId()),
    });
    let signalSent = false;
    let signalError: string | null = null;
    const mark: { clearedAtMs: number | null } = { clearedAtMs: null };
    if (refusals.length === 0) {
      const start = performance.now();
      try {
        process.kill(pid, 'SIGKILL');
        signalSent = true;
      } catch (error) {
        signalError = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      }
      const cleared = (): boolean => probe.gen() > generationBefore && probe.caps() === 0 && probe.authorized() !== true;
      if (signalSent) {
        await waitFor(() => {
          if (mark.clearedAtMs === null && cleared()) mark.clearedAtMs = Math.round(performance.now() - start);
          return mark.clearedAtMs !== null && watcher.seen.contents !== null;
        }, POST_KILL_OBSERVE_MS);
      }
    }
    const diagnosis: PostKillDiagnosis = {
      facts,
      refusals,
      signalSent,
      signalError,
      procAfterKill: signalSent ? await bounded(snapshotProcess(nodeProcReader, pid)) : null,
      aliveAfterKill: signalSent ? isAlive(pid) : null,
      contentsEvent: watcher.seen.contents,
      appEvent: watcher.seen.app,
      generationBefore,
      generationAfter: probe.gen(),
      capabilitiesAfter: probe.caps(),
      oldTokenAuthorizedAfter: probe.authorized(),
      clearedAtMs: mark.clearedAtMs,
      invariantsHold: invariantProblems(ctx).length === 0,
    };
    process.stderr.write(`[ipc-smoke] linux post-kill diagnosis ${JSON.stringify(diagnosis)}\n`);
    return diagnosis;
  } finally {
    watcher.stop();
  }
}
