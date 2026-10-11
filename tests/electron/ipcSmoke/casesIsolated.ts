/**
 * 独立子进程用例（M3 T1b-2b-1）：每个用例单独占用一个 Electron 进程，互不污染。
 *
 * - `real.*`：使用与产品完全相同的选择器（`createOpenPathChooser` + 真实 `dialog.showOpenDialog(parent, options)`）。
 *   自动化无法点击对话框，只能用窗口生命周期（close / reload / 崩溃 / destroy）结束或观察它。macOS 为 gate（断言此前实测的行为）；
 *   Windows / Linux 首轮只做完整观测，结果为 `observed`（记录事实，不判通过）。`real.destroy-isolated` 故意留下孤儿，
 *   因此必须独立进程。所有等待都有上限。
 * - `identity.win-unc`：main 的可信入口是 UNC 路径；环境不可达（管理共享 / 权限）时记为 `unverified` 并写明证据。
 */

import { stat } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

import { app } from 'electron';
import type { RenderProcessGoneDetails, WebContents } from 'electron';

import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';
import { capabilitiesOf, ownerMeta } from './context';
import type { CaseOutcome, SmokeCase, SmokeContext } from './context';
import { delay, waitFor, withTimeout } from './harness';
import { describeOpen } from './replies';
import type { SmokeWindow } from './windows';

export interface IsolatedCase extends SmokeCase {
  readonly realDialog: boolean;
}

const SHOW_WAIT_MS = 5_000;
const SETTLE_WAIT_MS = 5_000;

/**
 * renderer 崩溃的诊断观察窗口（CI run 38142547427：Ubuntu 上 5 s 内未见 `render-process-gone` 的效果）。只用于判断
 * 平台 / CI 延迟，不是产品的实时失效合同；超过 5 s 的到达会如实记为 `D-late-cleanup`。
 */
export const CRASH_OBSERVE_MS = 20_000;
const CRASH_PROMPT_MS = 5_000;

export interface CrashEvent {
  readonly ms: number;
  readonly reason: string;
  readonly exitCode: number;
}

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
  readonly appEvent: (CrashEvent & { readonly matchesTarget: boolean }) | null;
  /** 首次观察到「generation 前进、能力清空、旧 token 不再授权」的时刻（自调用崩溃起，毫秒）。 */
  readonly clearedAtMs: number | null;
  /** webContents 已销毁时为 null。 */
  readonly isCrashed: boolean | null;
  /** 观察结束时崩溃前的 renderer PID 是否仍存在（`process.kill(pid, 0)`；区分「没被杀掉」与「杀掉了但事件未送达」）。 */
  readonly rendererAliveAfter: boolean | null;
  /**
   * A：目标 webContents 的事件没到（app 也没有目标事件；若 app 只收到其它 webContents 的事件同样归 A，原始事件保留在 appEvent）；
   * B：只有 app 收到目标事件；C：webContents 收到但状态未清理；D：已清理但超过 5 s；ok：5 s 内清理。
   */
  readonly category: 'A-no-event' | 'B-app-only' | 'C-event-without-cleanup' | 'D-late-cleanup' | 'ok';
}

/**
 * 只读的崩溃观测：监听在调用 `forcefullyCrashRenderer()` 之前注册，只记录事件与状态快照，不调用任何协调器 / handle 方法
 * （清理只能由生产 `wireOpenIpcWindow` 转发的事件完成）。最多观察 `CRASH_OBSERVE_MS`。
 */
export async function crashAndObserve(ctx: SmokeContext, window: SmokeWindow, token: string | null): Promise<CrashTimeline> {
  const contents = window.win.webContents;
  const webContentsId = contents.id;
  const rendererPid = contents.getOSProcessId();
  const gen = (): number => ownerMeta(ctx, window.ownerId)?.generation ?? -1;
  const caps = (): number => capabilitiesOf(ctx, window.ownerId).length;
  const authorized = (): boolean | null => (token === null ? null : ctx.openIpc.authorize(window.ownerId, token) !== null);
  const generationBefore = gen();
  const capabilitiesBefore = caps();
  const oldTokenAuthorizedBefore = authorized();
  // 事件回调异步写入；用记录对象而不是 let，避免控制流收窄把它们当成永远为 null。
  const seen: { contents: CrashEvent | null; app: (CrashEvent & { readonly matchesTarget: boolean }) | null; clearedAtMs: number | null } = {
    contents: null,
    app: null,
    clearedAtMs: null,
  };
  const start = performance.now();
  const since = (): number => Math.round(performance.now() - start);
  const onContentsGone = (_event: unknown, details: RenderProcessGoneDetails): void => {
    seen.contents ??= { ms: since(), reason: details.reason, exitCode: details.exitCode };
  };
  const onAppGone = (_event: unknown, gone: WebContents, details: RenderProcessGoneDetails): void => {
    const matchesTarget = gone.id === webContentsId;
    if (seen.app === null || (matchesTarget && !seen.app.matchesTarget)) seen.app = { ms: since(), reason: details.reason, exitCode: details.exitCode, matchesTarget };
  };
  const cleared = (): boolean => gen() > generationBefore && caps() === 0 && authorized() !== true;
  contents.on('render-process-gone', onContentsGone);
  app.on('render-process-gone', onAppGone);
  try {
    contents.forcefullyCrashRenderer();
    await waitFor(() => {
      if (seen.clearedAtMs === null && cleared()) seen.clearedAtMs = since();
      return seen.clearedAtMs !== null && seen.contents !== null;
    }, CRASH_OBSERVE_MS);
  } finally {
    if (!contents.isDestroyed()) contents.off('render-process-gone', onContentsGone);
    app.off('render-process-gone', onAppGone);
  }
  const contentsSeen = seen.contents;
  const appSeen = seen.app;
  const clearedSeen = seen.clearedAtMs;
  let rendererAliveAfter: boolean | null = null;
  try {
    process.kill(rendererPid, 0);
    rendererAliveAfter = true;
  } catch (error) {
    rendererAliveAfter = error instanceof Error && 'code' in error && error.code === 'EPERM' ? true : error instanceof Error && 'code' in error && error.code === 'ESRCH' ? false : null;
  }
  let category: CrashTimeline['category'] = 'ok';
  if (contentsSeen === null) category = appSeen?.matchesTarget === true ? 'B-app-only' : 'A-no-event';
  else if (clearedSeen === null) category = 'C-event-without-cleanup';
  else if (clearedSeen > CRASH_PROMPT_MS) category = 'D-late-cleanup';
  const timeline: CrashTimeline = {
    webContentsId,
    rendererPid,
    generationBefore,
    generationAfter: gen(),
    capabilitiesBefore,
    capabilitiesAfter: caps(),
    oldTokenAuthorizedBefore,
    oldTokenAuthorizedAfter: authorized(),
    contentsEvent: contentsSeen,
    appEvent: appSeen,
    clearedAtMs: clearedSeen,
    isCrashed: contents.isDestroyed() ? null : contents.isCrashed(),
    rendererAliveAfter,
    category,
  };
  // 立即写到 stderr：即使之后外层超时，诊断时间线也保留在 CI 日志里。
  process.stderr.write(`[ipc-smoke] crash timeline ${JSON.stringify(timeline)}\n`);
  return timeline;
}

/** 页面发起 Open（真实对话框），等待 main 侧出现未 settle 的选择器。页面调用本身可能永不返回，不 await。 */
async function showRealDialog(ctx: SmokeContext, window: SmokeWindow, expectedPending: number): Promise<boolean> {
  void window.openRaw(30_000);
  const shown = await waitFor(() => ctx.openIpc.pendingNativeDialogs() === expectedPending, SHOW_WAIT_MS);
  await delay(600);
  return shown;
}

async function closeWindow(window: SmokeWindow): Promise<boolean> {
  if (window.win.isDestroyed()) return true;
  const closed = new Promise<void>((resolve) => window.win.once('closed', () => resolve()));
  window.win.close();
  return withTimeout(closed, SETTLE_WAIT_MS, 'close').then(
    () => true,
    () => false,
  );
}

type Facts = Record<string, unknown>;

/**
 * macOS：按断言判定；其它平台：只记录事实（observed）。观测的前置条件是请求确实到达了真实选择器（`precondition` 为 true），
 * 否则任何平台都判失败——「没有执行」不能记成 observed。
 */
function realOutcome(facts: Facts, darwinExpect: Facts, precondition: boolean): CaseOutcome {
  if (!precondition) return { status: 'failed', detail: `real chooser was not reached | ${JSON.stringify(facts)}` };
  if (process.platform !== 'darwin') return { status: 'observed', detail: JSON.stringify({ platform: process.platform, chooser: 'real', ...facts }) };
  const problems = Object.entries(darwinExpect)
    .filter(([key, expected]) => JSON.stringify(facts[key]) !== JSON.stringify(expected))
    .map(([key, expected]) => `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(facts[key])}`);
  const detail = JSON.stringify(facts);
  return problems.length === 0 ? { status: 'passed', detail } : { status: 'failed', detail: `${problems.join('; ')} | ${detail}` };
}

async function timed(task: () => Promise<boolean>): Promise<{ ok: boolean; ms: number }> {
  const start = performance.now();
  const ok = await task();
  return { ok, ms: Math.round(performance.now() - start) };
}

const realCloseSettles: IsolatedCase = {
  id: 'real.close-settles',
  realDialog: true,
  run: async (ctx) => {
    const window = await ctx.windows.create({ show: true });
    const shown = await showRealDialog(ctx, window, 1);
    const closed = await closeWindow(window);
    const settle = await timed(() => waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, SETTLE_WAIT_MS));
    const facts = { shown, closed, settledAfterClose: settle.ok, settleMs: settle.ms, orphaned: ctx.openIpc.orphanedNativeDialogs(), capabilities: ctx.openIpc.currentState().table.size };
    return realOutcome(facts, { shown: true, closed: true, settledAfterClose: true, orphaned: 0, capabilities: 0 }, shown);
  },
};

const realReloadKeepsDialog: IsolatedCase = {
  id: 'real.reload-keeps-dialog',
  realDialog: true,
  run: async (ctx) => {
    const window = await ctx.windows.create({ show: true });
    const shown = await showRealDialog(ctx, window, 1);
    const load = window.nextLoad();
    window.win.webContents.reload();
    const reloaded = await load.then(
      () => true,
      () => false,
    );
    await delay(500);
    const pendingAfterReload = ctx.openIpc.pendingNativeDialogs();
    const logicalLockAfterReload = ownerMeta(ctx, window.ownerId)?.dialogOpen ?? null;
    const reopen = reloaded ? describeOpen(await window.open(3_000)) : 'not-attempted';
    const closed = await closeWindow(window);
    const settle = await timed(() => waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, SETTLE_WAIT_MS));
    const facts = { shown, reloaded, pendingAfterReload, logicalLockAfterReload, reopenWhileDialog: reopen, closed, settledAfterClose: settle.ok, settleMs: settle.ms };
    return realOutcome(facts, {
      shown: true,
      reloaded: true,
      pendingAfterReload: 1,
      logicalLockAfterReload: false,
      reopenWhileDialog: 'rejected:busy',
      closed: true,
      settledAfterClose: true,
    }, shown);
  },
};

const realCrashKeepsDialog: IsolatedCase = {
  id: 'real.crash-keeps-dialog',
  realDialog: true,
  // 典型：建窗 < 1 s + 显示对话框 ≤ 5.6 s + 崩溃观察 ≤ 20 s + 0.8 s + 关闭 / settle ≤ 10 s ≈ 37 s；理论最坏（建窗 8 s）约 44 s，
  // 届时用例或 runner 超时判失败（不会假通过），崩溃时间线已先写到 stderr。runner 的独立子进程上限为 45 s。
  timeoutMs: 38_000,
  run: async (ctx) => {
    const window = await ctx.windows.create({ show: true });
    const shown = await showRealDialog(ctx, window, 1);
    const crash = await crashAndObserve(ctx, window, null);
    const crashed = crash.contentsEvent !== null && crash.generationAfter > crash.generationBefore;
    await delay(800);
    const pendingAfterCrash = ctx.openIpc.pendingNativeDialogs();
    const closed = await closeWindow(window);
    const settle = await timed(() => waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, SETTLE_WAIT_MS));
    const facts = { shown, rendererGoneHandled: crashed, crashCategory: crash.category, pendingAfterCrash, closed, settledAfterClose: settle.ok, settleMs: settle.ms, crash };
    // macOS gate 保持原有 5 s 内生效（category 必须为 ok）；20 s 只是诊断观察窗口。
    return realOutcome(facts, { shown: true, rendererGoneHandled: true, crashCategory: 'ok', pendingAfterCrash: 1, closed: true, settledAfterClose: true }, shown);
  },
};

/** 故意留下孤儿：A 带着真实对话框被 destroy；B 仍可 Open（选择器被调用，说明未被拒绝），关闭 B 后其对话框 settle。 */
const realDestroyIsolated: IsolatedCase = {
  id: 'real.destroy-isolated',
  realDialog: true,
  run: async (ctx) => {
    const a = await ctx.windows.create({ show: true });
    const shownA = await showRealDialog(ctx, a, 1);
    const destroyed = new Promise<void>((resolve) => a.win.once('closed', () => resolve()));
    a.win.destroy();
    await withTimeout(destroyed, SETTLE_WAIT_MS, 'destroy');
    await delay(1_500);
    const pendingAfterDestroy = ctx.openIpc.pendingNativeDialogs();
    const orphanedAfterDestroy = ctx.openIpc.orphanedNativeDialogs();
    const b = await ctx.windows.create({ show: true });
    const shownB = await showRealDialog(ctx, b, pendingAfterDestroy + 1);
    const bLogicalLock = ownerMeta(ctx, b.ownerId)?.dialogOpen ?? null;
    const closedB = await closeWindow(b);
    const settleB = await timed(() => waitFor(() => ctx.openIpc.pendingNativeDialogs() === pendingAfterDestroy, SETTLE_WAIT_MS));
    const facts = {
      shownA,
      pendingAfterDestroy,
      orphanedAfterDestroy,
      otherWindowAccepted: shownB,
      bLogicalLock,
      closedB,
      bSettledAfterClose: settleB.ok,
      orphanedAtEnd: ctx.openIpc.orphanedNativeDialogs(),
      capabilities: ctx.openIpc.currentState().table.size,
    };
    return realOutcome(facts, {
      shownA: true,
      pendingAfterDestroy: 1,
      orphanedAfterDestroy: 1,
      otherWindowAccepted: true,
      bLogicalLock: true,
      closedB: true,
      bSettledAfterClose: true,
      orphanedAtEnd: 1,
      capabilities: 0,
    }, shownA);
  },
};

/**
 * 驱动给出 `\\127.0.0.1\<盘符>$\…`（不用 `localhost`：WHATWG URL 会把 file URL 的 `localhost` 主机规范成空串，UNC 主机丢失）。
 * 只有 Node 侧 stat 失败（管理共享 / 权限不可用）才记为 unverified；构造错误（URL 没有主机）与加载 / 身份失败都判 failed。
 */
const identityWinUnc: IsolatedCase = {
  id: 'identity.win-unc',
  realDialog: false,
  run: async (ctx) => {
    const host = new URL(ctx.entry.loadUrl).host;
    if (host === '') return { status: 'failed', detail: `harness: UNC loadUrl has no host (${ctx.entry.loadUrl.slice(0, 40)})` };
    try {
      await stat(ctx.trustedPagePath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      return { status: 'unverified', detail: `UNC path not accessible from Node (stat ${code}); loadUrl=${ctx.entry.loadUrl.slice(0, 40)}` };
    }
    let window: SmokeWindow;
    try {
      window = await ctx.windows.create();
    } catch (error) {
      return { status: 'failed', detail: `UNC path is accessible but the page did not load: ${error instanceof Error ? error.message : String(error)}` };
    }
    const frameUrl = window.win.webContents.mainFrame.url;
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    const matches = matchesPageIdentity(frameUrl, ctx.entry.identity);
    const facts = JSON.stringify({ loadUrl: ctx.entry.loadUrl.slice(0, 40), frameUrl: frameUrl.slice(0, 40), matches, reply: describeOpen(reply) });
    if (reply.kind === 'opened') await window.reject(reply.ticket);
    const clean = capabilitiesOf(ctx, window.ownerId).length === 0;
    return matches && reply.kind === 'opened' && clean ? { status: 'passed', detail: facts } : { status: 'failed', detail: facts };
  },
};

export const ISOLATED_CASES: readonly IsolatedCase[] = [identityWinUnc, realCloseSettles, realReloadKeepsDialog, realCrashKeepsDialog, realDestroyIsolated];
