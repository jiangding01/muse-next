/**
 * Linux renderer 退出的信号实验（M3 T1b-2b-1，用户裁决：区分退出硬门与 forceCrash 风险观测）。
 *
 * - `linuxSigkillExitGate`：`crash.renderer-gone` 在 Linux 的正式硬门（`trigger=os-sigkill`）。对一个**新鲜、正常运行、从未被
 *   forceCrash** 的 renderer 直接发送 SIGKILL，验证「renderer 进程真实退出 ⇒ 生产接线吊销旧能力」。不代表
 *   `forcefullyCrashRenderer()` 在 Linux 上能正常完成退出。
 * - `linuxPostKillDiagnosis`：`risk.linux-force-crash-stall` 中 forceCrash 观察结束、未收到事件后的诊断清理。
 * - 两者共用 `sendVerifiedSigkill`——smoke 中唯一的 `process.kill(pid, 'SIGKILL')`；身份校验相同，用途前置条件分别定义
 *   （`killRefusals`）。所有观测只读，不调用协调器 / handle 方法，不 reload / 关闭窗口。
 */

import { performance } from 'node:perf_hooks';

import { webContents } from 'electron';

import { invariantProblems } from './context';
import type { SmokeContext } from './context';
import { bounded, isAlive, ownerProbe, relativeAppEvent, relativeEvent, watchRendererGone } from './crashObservation';
import type { AppCrashEvent, CrashEvent, CrashTimeline, GoneWatcher, OwnerProbe } from './crashObservation';
import { waitFor } from './harness';
import { ancestorsOf, killRefusals, nodeProcReader, scanCrashHelpers, snapshotProcess, unavailableSnapshot } from './linuxProcessDiagnostics';
import type { CrashHelper, KillPurpose, ProcessSnapshot } from './linuxProcessDiagnostics';
import type { SmokeWindow } from './windows';

/** SIGKILL 之后的观察窗口（超过即视为事件未到达，硬门判失败）。 */
export const EXIT_OBSERVE_MS = 5_000;

export interface LinuxProcessFacts {
  readonly windowAlive: boolean;
  readonly currentWebContentsPid: number | null;
  readonly isCrashed: boolean | null;
  readonly proc: ProcessSnapshot | null;
  readonly ancestors: readonly number[] | null;
  readonly underSmokeMain: boolean | null;
  readonly crashHelpers: readonly CrashHelper[] | null;
}

/** 只读采集进程事实（不发送任何信号）。窗口相关字段在第一个 await 之前同步取得。 */
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

interface SigkillAttempt {
  readonly refusals: readonly string[];
  readonly signalSent: boolean;
  readonly signalError: string | null;
  /** 发送时刻（`performance.now()`）；未发送为 null。 */
  readonly sentAt: number | null;
  readonly snapshotBeforeSend: ProcessSnapshot;
}

/**
 * smoke 中唯一的 SIGKILL 发送点：发送前做一次有界快照，之后窗口 / PID / 事件检查、`killRefusals` 与发送在同一段同步代码里完成。
 * 任一前置条件不满足就不发送。只对单个 PID 发送一次；不 sudo、不按名称终止。
 */
async function sendVerifiedSigkill(
  window: SmokeWindow,
  targetId: number,
  pid: number,
  before: ProcessSnapshot | null,
  ancestors: readonly number[] | null,
  purpose: KillPurpose,
  watcher: GoneWatcher,
): Promise<SigkillAttempt> {
  const now = (await bounded(snapshotProcess(nodeProcReader, pid))) ?? unavailableSnapshot(pid);
  const windowAlive = !window.win.isDestroyed();
  const refusals = killRefusals({
    platform: process.platform,
    purpose,
    eventAlreadyArrived: watcher.seen.contents !== null || watcher.seen.app?.matchesTarget === true,
    pid,
    mainPid: process.pid,
    mainExecutableName: process.execPath.split(/[\\/]/).pop() ?? '',
    before,
    now,
    ancestors,
    windowAlive,
    currentWebContentsPid: windowAlive ? window.win.webContents.getOSProcessId() : -1,
    otherWindowPids: webContents
      .getAllWebContents()
      .filter((other) => other.id !== targetId && !other.isDestroyed())
      .map((other) => other.getOSProcessId()),
  });
  if (refusals.length === 0) {
    const sentAt = performance.now();
    try {
      process.kill(pid, 'SIGKILL');
      return { refusals, signalSent: true, signalError: null, sentAt, snapshotBeforeSend: now };
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      return { refusals, signalSent: false, signalError: code, sentAt: null, snapshotBeforeSend: now };
    }
  }
  return { refusals, signalSent: false, signalError: null, sentAt: null, snapshotBeforeSend: now };
}

export interface ExitObservation {
  /** 事件耗时的计时起点：已发送为发送时刻；未发送（被拒绝）时为监听注册时刻，迟到事件照样记录。清理耗时总是自发送起计。 */
  readonly eventsBase: 'signal-sent' | 'watcher-registered';
  /** 事件与清理耗时（毫秒）。 */
  readonly contentsEvent: CrashEvent | null;
  readonly appEvent: AppCrashEvent | null;
  readonly clearedAtMs: number | null;
  readonly procAfterKill: ProcessSnapshot | null;
  /** `process.kill(pid, 0)`：未被回收的僵尸进程同样为 true，须结合 `procAfterKill.stateLabel` 解读。 */
  readonly aliveAfterKill: boolean | null;
  /** 原 PID 已退出：不再存在（ESRCH）或已是僵尸。 */
  readonly pidExited: boolean | null;
  readonly generationAfter: number;
  readonly capabilitiesAfter: number;
  readonly oldTokenAuthorizedAfter: boolean | null;
  readonly invariantsHold: boolean;
}

/** SIGKILL 之后最多 `EXIT_OBSERVE_MS`：等待目标事件（webContents 与 app）到达且清理完成；超时不放行，如实记录。 */
async function observeExit(ctx: SmokeContext, probe: OwnerProbe, watcher: GoneWatcher, pid: number, generationBefore: number, sentAt: number | null): Promise<ExitObservation> {
  const mark: { clearedAtMs: number | null } = { clearedAtMs: null };
  if (sentAt !== null) {
    const cleared = (): boolean => probe.gen() > generationBefore && probe.caps() === 0 && probe.authorized() !== true;
    await waitFor(() => {
      if (mark.clearedAtMs === null && cleared()) mark.clearedAtMs = Math.round(performance.now() - sentAt);
      return mark.clearedAtMs !== null && watcher.seen.contents !== null && watcher.seen.app?.matchesTarget === true;
    }, EXIT_OBSERVE_MS);
  }
  // 先同步测存活（不受随后有界读取的耗时影响），再读 /proc 状态。
  const aliveAfterKill = sentAt === null ? null : isAlive(pid);
  const procAfterKill = sentAt === null ? null : await bounded(snapshotProcess(nodeProcReader, pid));
  const base = sentAt ?? watcher.registeredAt;
  return {
    eventsBase: sentAt === null ? 'watcher-registered' : 'signal-sent',
    contentsEvent: relativeEvent(watcher.seen.contents, base),
    appEvent: relativeAppEvent(watcher.seen.app, base),
    clearedAtMs: mark.clearedAtMs,
    procAfterKill,
    aliveAfterKill,
    pidExited: sentAt === null ? null : aliveAfterKill === false || procAfterKill?.stateLabel === 'zombie',
    generationAfter: probe.gen(),
    capabilitiesAfter: probe.caps(),
    oldTokenAuthorizedAfter: probe.authorized(),
    invariantsHold: invariantProblems(ctx).length === 0,
  };
}

export interface ExitGateResult extends ExitObservation {
  readonly trigger: 'os-sigkill';
  readonly webContentsId: number;
  readonly rendererPid: number;
  readonly baseline: ProcessSnapshot | null;
  readonly ancestors: readonly number[] | null;
  readonly generationBefore: number;
  readonly capabilitiesBefore: number;
  readonly oldTokenAuthorizedBefore: boolean | null;
  readonly refusals: readonly string[];
  readonly signalSent: boolean;
  readonly signalError: string | null;
  readonly snapshotBeforeSend: ProcessSnapshot;
}

/**
 * Linux 正式硬门：对当前窗口新鲜、正常运行的 renderer 直接发送 SIGKILL（不先调用 forceCrash）。监听在任何信号之前注册；
 * 本函数只观测并返回时间线，判定（含 reload 之前的全部状态检查）由调用方完成。
 */
export async function linuxSigkillExitGate(ctx: SmokeContext, window: SmokeWindow, token: string | null): Promise<ExitGateResult> {
  const contents = window.win.webContents;
  const webContentsId = contents.id;
  const pid = contents.getOSProcessId();
  const probe = ownerProbe(ctx, window, token);
  const generationBefore = probe.gen();
  const capabilitiesBefore = probe.caps();
  const oldTokenAuthorizedBefore = probe.authorized();
  const baseline = await bounded(snapshotProcess(nodeProcReader, pid));
  const ancestors = await bounded(ancestorsOf(nodeProcReader, pid));
  const watcher = watchRendererGone(contents);
  try {
    const attempt = await sendVerifiedSigkill(window, webContentsId, pid, baseline, ancestors, { kind: 'direct-exit-gate', forceCrashInvoked: false }, watcher);
    const observed = await observeExit(ctx, probe, watcher, pid, generationBefore, attempt.sentAt);
    const result: ExitGateResult = {
      trigger: 'os-sigkill',
      webContentsId,
      rendererPid: pid,
      baseline,
      ancestors,
      generationBefore,
      capabilitiesBefore,
      oldTokenAuthorizedBefore,
      refusals: attempt.refusals,
      signalSent: attempt.signalSent,
      signalError: attempt.signalError,
      snapshotBeforeSend: attempt.snapshotBeforeSend,
      ...observed,
    };
    process.stderr.write(`[ipc-smoke] linux exit gate ${JSON.stringify(result)}\n`);
    return result;
  } finally {
    watcher.stop();
  }
}

export interface PostKillDiagnosis extends ExitObservation {
  readonly facts: LinuxProcessFacts;
  readonly snapshotBeforeSend: ProcessSnapshot;
  readonly refusals: readonly string[];
  readonly signalSent: boolean;
  readonly signalError: string | null;
  readonly generationBefore: number;
}

/**
 * forceCrash 观察结束、未收到目标事件后的诊断清理（独立于 forceCrash 结论）：先**同步**重新注册只读监听，再采集 `/proc` 事实；
 * 前置条件取自 forceCrash 时间线的真实记录（`observationEnded`、`forceCrashInvoked`），全部通过才发送 SIGKILL。
 */
export async function linuxPostKillDiagnosis(ctx: SmokeContext, window: SmokeWindow, token: string | null, crash: CrashTimeline): Promise<PostKillDiagnosis> {
  const watcher = watchRendererGone(window.win.webContents);
  const probe = ownerProbe(ctx, window, token);
  const generationBefore = probe.gen();
  try {
    const pid = crash.rendererPid;
    const facts = await linuxProcessFacts(window, pid);
    const purpose: KillPurpose = { kind: 'post-force-crash-diagnostic', observationEnded: crash.observationEnded, forceCrashRecorded: crash.forceCrashInvoked };
    const attempt = await sendVerifiedSigkill(window, crash.webContentsId, pid, crash.linuxBefore, facts.ancestors, purpose, watcher);
    const observed = await observeExit(ctx, probe, watcher, pid, generationBefore, attempt.sentAt);
    const diagnosis: PostKillDiagnosis = {
      facts,
      snapshotBeforeSend: attempt.snapshotBeforeSend,
      refusals: attempt.refusals,
      signalSent: attempt.signalSent,
      signalError: attempt.signalError,
      generationBefore,
      ...observed,
    };
    process.stderr.write(`[ipc-smoke] linux post-kill diagnosis ${JSON.stringify(diagnosis)}\n`);
    return diagnosis;
  } finally {
    watcher.stop();
  }
}
