/**
 * D 组：导航与生命周期（M3 T1b-2b-1）。
 *
 * 导航后旧页面上的 `executeJavaScript` Promise 可能永不 settle：用例从不把导航前发出的页面调用当作完成信号，
 * 只用 main 状态观测、新页面上的独立调用与有界等待判定。
 */

import { randomUUID } from 'node:crypto';

import { session } from 'electron';

import { capabilitiesOf, expectEqual, expectTrue, invariantProblems, ownerMeta, verdict } from './context';
import type { SmokeCase, SmokeContext } from './context';
import { openActive, openPending } from './casesCapability';
import { crashAndObserve } from './casesIsolated';
import { deferred, delay, waitFor, withTimeout } from './harness';
import { describeOpen, isRecord, parseOpenReply } from './replies';
import type { SmokeWindow } from './windows';

const generation = (ctx: SmokeContext, window: SmokeWindow): number => ownerMeta(ctx, window.ownerId)?.generation ?? -1;

async function reload(window: SmokeWindow): Promise<void> {
  const loaded = window.nextLoad();
  window.win.webContents.reload();
  await loaded;
}

/** 页面换代之后：旧票据无效、可重新 Open 并激活（恢复能力）。 */
async function recoveryProblems(ctx: SmokeContext, window: SmokeWindow, oldTicket: { capabilityId: string; documentId: number }): Promise<string[]> {
  const problems: string[] = [];
  expectEqual(problems, 'old ticket after reset', await window.activate(oldTicket), { ok: false, code: 'capability-invalid' });
  try {
    await openActive(ctx, window, ctx.fixtures.second);
  } catch (error) {
    problems.push(`recovery open failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return problems;
}

const navReloadClears: SmokeCase = {
  id: 'nav.reload-clears',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
    const before = generation(ctx, window);
    await reload(window);
    const problems: string[] = [];
    expectEqual(problems, 'capabilities after reload', capabilitiesOf(ctx, window.ownerId), []);
    expectTrue(problems, 'generation did not advance', generation(ctx, window) > before);
    expectTrue(problems, 'old token still authorized', ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) === null);
    problems.push(...(await recoveryProblems(ctx, window, ticket)));
    return verdict(problems, { generationDelta: generation(ctx, window) - before });
  },
};

const navSameDocument: SmokeCase = {
  id: 'nav.same-document',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
    const before = generation(ctx, window);
    const result = await window.call(`(history.pushState({}, '', '#pushed'), location.hash = 'moved', new Promise((r) => setTimeout(() => r(location.hash), 100)))`);
    await delay(200);
    const problems: string[] = [];
    expectEqual(problems, 'page hash', result.ok ? result.value : result.error, '#moved');
    expectEqual(problems, 'generation', generation(ctx, window), before);
    expectTrue(problems, 'active lost on same-document navigation', ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) !== null);
    return verdict(problems);
  },
};

const navForeignPage: SmokeCase = {
  id: 'nav.foreign-page',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
    const calls = ctx.chooser.calls.length;
    await withTimeout(window.win.loadURL(ctx.foreignUrl), 8_000, 'load foreign');
    const problems: string[] = [];
    expectEqual(problems, 'capabilities after leaving', capabilitiesOf(ctx, window.ownerId), []);
    const open = await window.openRaw();
    expectTrue(problems, `foreign open not rejected: ${JSON.stringify(open)}`, !open.ok && open.error.endsWith('Error: Request rejected'));
    const activation = await window.call(`window.museDesktop.activateDocument(${JSON.stringify(ticket)})`);
    expectTrue(problems, 'foreign activate not rejected', !activation.ok && activation.error.endsWith('Error: Request rejected'));
    expectEqual(problems, 'chooser not called from foreign page', ctx.chooser.calls.length, calls);
    await withTimeout(window.win.loadURL(ctx.entry.loadUrl), 8_000, 'load trusted');
    problems.push(...(await recoveryProblems(ctx, window, ticket)));
    return verdict(problems);
  },
};

/**
 * HIGH-1 回归（导航开始与提交之间旧文档仍存活）：在独立分区上用 `protocol.handle('file')` 卡住 reload 的响应，制造
 * 「已开始、未提交」窗口期。测试专属配置：只多了 `partition`，其余 webPreferences 与产品相同。
 */
const navRaceStartCommit: SmokeCase = {
  id: 'nav.race-start-commit',
  run: async (ctx) => {
    const partition = `race-${randomUUID()}`;
    let hold: Promise<void> | null = null;
    const ses = session.fromPartition(partition);
    ses.protocol.handle('file', async (request) => {
      if (hold !== null) await hold;
      return ses.fetch(request.url, { bypassCustomProtocolHandlers: true });
    });
    try {
      const window = await ctx.windows.create({ partition });
      const problems: string[] = [];
      const facts: Record<string, unknown> = {};
      const markOld = (): Promise<unknown> => window.call(`(window.smokeMarker = 'old')`);
      const marker = async (): Promise<unknown> => {
        const result = await window.call('window.smokeMarker ?? null');
        return result.ok ? result.value : result.error;
      };
      // 阶段 1：旧文档在 start 与 commit 之间完成 Open 并激活；commit 之后一律作废。
      await markOld();
      const gate1 = deferred<void>();
      hold = gate1.promise;
      const g0 = generation(ctx, window);
      const load1 = window.nextLoad(15_000);
      window.win.webContents.reload();
      expectTrue(problems, 'did-start-navigation not observed', await waitFor(() => generation(ctx, window) > g0, 3_000));
      ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
      const raw = await window.call(`(async () => ({ marker: window.smokeMarker, reply: await window.museDesktop.openDocument() }))()`);
      const reply = raw.ok && isRecord(raw.value) ? parseOpenReply(raw.value.reply) : null;
      expectTrue(problems, 'open was not issued by the old document', raw.ok && isRecord(raw.value) && raw.value.marker === 'old');
      facts.phase1Reply = reply === null ? 'none' : describeOpen(reply);
      if (reply?.kind === 'opened') facts.phase1Activate = await window.activate(reply.ticket);
      gate1.resolve();
      hold = null;
      await load1;
      expectEqual(problems, 'capabilities after commit', capabilitiesOf(ctx, window.ownerId), []);
      if (reply?.kind === 'opened') {
        expectEqual(problems, 'old-document ticket after commit', await window.activate(reply.ticket), { ok: false, code: 'capability-invalid' });
      }

      // 阶段 2：旧请求跨过 commit 仍在读取；它不得登记候选、不得释放新请求的逻辑锁。
      await markOld();
      const gate2 = deferred<void>();
      hold = gate2.promise;
      const g1 = generation(ctx, window);
      const load2 = window.nextLoad(15_000);
      window.win.webContents.reload();
      expectTrue(problems, 'second navigation start not observed', await waitFor(() => generation(ctx, window) > g1, 3_000));
      const read = ctx.fs.holdNextRead();
      ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
      void window.open(2_000);
      await withTimeout(read.reached, 3_000, 'old read reached gate');
      expectEqual(problems, 'old document still alive before commit', await marker(), 'old');
      gate2.resolve();
      hold = null;
      await load2;
      const newControl = deferred<string | null>();
      ctx.chooser.enqueue({ kind: 'deferred', control: newControl });
      const newOpen = window.open();
      expectTrue(problems, 'new request did not reach chooser', await waitFor(() => ctx.chooser.calls.length === 3, 3_000));
      read.release();
      await delay(300);
      expectEqual(problems, 'no candidate from the stale request', capabilitiesOf(ctx, window.ownerId), []);
      expectEqual(problems, 'new logical lock kept', ownerMeta(ctx, window.ownerId)?.dialogOpen, true);
      expectEqual(problems, 'third open while new dialog open', describeOpen(await window.open()), 'rejected:busy');
      newControl.resolve(ctx.fixtures.second);
      const finalReply = await newOpen;
      if (finalReply.kind === 'opened') expectEqual(problems, 'activate new', await window.activate(finalReply.ticket), { ok: true });
      else problems.push(`new open: ${describeOpen(finalReply)}`);
      problems.push(...invariantProblems(ctx));
      return verdict(problems, facts);
    } finally {
      ses.protocol.unhandle('file');
    }
  },
};

/** 新文档在脚本解析阶段立即 Open（重复 20 次）。允许可恢复的 superseded，但不得泄漏能力、错误授权或悬挂锁，且一次重试必须成功。 */
const navEarlyIpc: SmokeCase = {
  id: 'nav.early-ipc',
  run: async (ctx) => {
    const problems: string[] = [];
    const outcomes: Record<string, number> = {};
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const window = await ctx.windows.create({ url: `${ctx.entry.loadUrl}#early` });
    for (let i = 0; i < 20; i += 1) {
      if (i > 0) {
        ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
        await reload(window);
      }
      const early = await window.call('window.smokeEarly');
      const value = early.ok && isRecord(early.value) && early.value.ok === true ? parseOpenReply(early.value.value) : null;
      const label = value === null ? `error:${JSON.stringify(early)}` : describeOpen(value).replace(/#\d+$/, '');
      outcomes[label] = (outcomes[label] ?? 0) + 1;
      let ticket = value?.kind === 'opened' ? value.ticket : null;
      if (value?.kind === 'rejected' && value.reason === 'superseded') {
        expectEqual(problems, `iteration ${String(i)}: superseded left a capability`, capabilitiesOf(ctx, window.ownerId), []);
        const retry = await openPending(ctx, window, ctx.fixtures.utf8).catch(() => null);
        if (retry === null) problems.push(`iteration ${String(i)}: retry failed`);
        ticket = retry;
      } else if (ticket === null) {
        problems.push(`iteration ${String(i)}: unexpected early result ${label}`);
      }
      if (ticket !== null) expectEqual(problems, `iteration ${String(i)}: activate`, await window.activate(ticket), { ok: true });
      const caps = capabilitiesOf(ctx, window.ownerId);
      expectEqual(problems, `iteration ${String(i)}: exactly the activated capability`, caps.map((c) => `${c.state}:${c.token === ticket?.capabilityId ? 'mine' : 'other'}`), ['active:mine']);
      expectEqual(problems, `iteration ${String(i)}: lock released`, ownerMeta(ctx, window.ownerId)?.dialogOpen, false);
      expectEqual(problems, `iteration ${String(i)}: no unsettled chooser`, ctx.openIpc.pendingNativeDialogs(), 0);
      problems.push(...invariantProblems(ctx).map((p) => `iteration ${String(i)}: ${p}`));
    }
    return verdict(problems, { iterations: 20, outcomes });
  },
};

/**
 * 崩溃后旧能力必须被生产接线清理（generation 前进、能力清空、旧 token 不授权）。观察窗口最多 `CRASH_OBSERVE_MS`；
 * 先判定再 reload：reload 本身也会重置能力，不能用它掩盖崩溃事件没有生效。时间线一律写入 detail。
 */
const crashRendererGone: SmokeCase = {
  id: 'crash.renderer-gone',
  timeoutMs: 30_000,
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
    const crash = await crashAndObserve(ctx, window, ticket.capabilityId);
    const problems: string[] = [];
    expectTrue(problems, 'old token was not authorized before the crash', crash.oldTokenAuthorizedBefore === true);
    expectTrue(problems, 'webContents render-process-gone not observed', crash.contentsEvent !== null);
    expectTrue(problems, 'capabilities not cleared after the crash', crash.clearedAtMs !== null && crash.capabilitiesAfter === 0);
    expectTrue(problems, 'generation did not advance', crash.generationAfter > crash.generationBefore);
    expectTrue(problems, 'old token still authorized after the crash', crash.oldTokenAuthorizedAfter === false);
    // macOS / Windows 保持原有 5 s 内生效的 gate；Linux 在 20 s 诊断窗口内生效即可，迟到如实记为 D-late-cleanup。
    if (process.platform !== 'linux') expectEqual(problems, 'crash cleanup within 5 s', crash.category, 'ok');
    if (problems.length === 0) {
      await reload(window);
      problems.push(...(await recoveryProblems(ctx, window, ticket)));
    }
    return verdict(problems, { crash });
  },
};

const closeDisposesOwner: SmokeCase = {
  id: 'close.disposes-owner',
  run: async (ctx) => {
    const closing = await ctx.windows.create();
    const other = await ctx.windows.create();
    const ticket = await openActive(ctx, closing, ctx.fixtures.utf8);
    const kept = await openActive(ctx, other, ctx.fixtures.second);
    const closed = new Promise<void>((resolve) => closing.win.once('closed', () => resolve()));
    closing.win.close();
    await withTimeout(closed, 5_000, 'close');
    const problems: string[] = [];
    expectEqual(problems, 'owner removed', ownerMeta(ctx, closing.ownerId), undefined);
    expectEqual(problems, 'capabilities removed', capabilitiesOf(ctx, closing.ownerId), []);
    expectTrue(problems, 'closed window token still authorized', ctx.openIpc.authorize(closing.ownerId, ticket.capabilityId) === null);
    expectTrue(problems, 'other window lost its active', ctx.openIpc.authorize(other.ownerId, kept.capabilityId) !== null);
    return verdict(problems);
  },
};

export const NAVIGATION_CASES: readonly SmokeCase[] = [
  navReloadClears,
  navSameDocument,
  navForeignPage,
  navRaceStartCommit,
  navEarlyIpc,
  crashRendererGone,
  closeDisposesOwner,
];
