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

import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';
import { capabilitiesOf, ownerMeta } from './context';
import { crashAndObserve, linuxProcessFacts } from './crashObservation';
import type { CaseOutcome, SmokeCase, SmokeContext } from './context';
import { delay, waitFor, withTimeout } from './harness';
import { describeOpen } from './replies';
import type { SmokeWindow } from './windows';

export interface IsolatedCase extends SmokeCase {
  readonly realDialog: boolean;
}

const SHOW_WAIT_MS = 5_000;
const SETTLE_WAIT_MS = 5_000;

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
  // 典型：建窗 < 1 s + 显示对话框 ≤ 5.6 s + 崩溃观察 ≤ 20 s + 0.8 s + 关闭 / settle ≤ 10 s；Linux 另有有界 /proc 读取
  // （崩溃前 1 次 + 观察后 3 次，各 ≤ 3 s，正常为毫秒级）。CI 实测（Ubuntu，run 38143813025）整个子进程约 27 s；
  // 病态的 /proc 卡顿可使上界超过预算与 runner 子进程上限 45 s，届时判失败（不会假通过），时间线已先写到 stderr。
  timeoutMs: 40_000,
  run: async (ctx) => {
    const window = await ctx.windows.create({ show: true });
    const shown = await showRealDialog(ctx, window, 1);
    const crash = await crashAndObserve(ctx, window, null);
    const crashed = crash.contentsEvent !== null && crash.generationAfter > crash.generationBefore;
    // Linux 未收到事件时只追加只读的进程事实；不发送信号，保持原生对话框生命周期的既有观察。
    const linuxProcess = process.platform === 'linux' && crash.contentsEvent === null ? await linuxProcessFacts(window, crash.rendererPid) : null;
    await delay(800);
    const pendingAfterCrash = ctx.openIpc.pendingNativeDialogs();
    const closed = await closeWindow(window);
    const settle = await timed(() => waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, SETTLE_WAIT_MS));
    const facts = { shown, rendererGoneHandled: crashed, crashCategory: crash.category, pendingAfterCrash, closed, settledAfterClose: settle.ok, settleMs: settle.ms, crash, linuxProcess };
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
