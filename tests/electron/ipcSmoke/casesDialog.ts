/**
 * F 组：原生选择器所有权（M3 T1b-2b-1，T1b-2a′ 每窗口实例最多一个未 settle 的选择器）。受控选择器的 deferred 由 main 持有；
 * 真实原生对话框的生命周期见 `casesIsolated.ts`（独立子进程）。
 */

import { BrowserWindow } from 'electron';

import { capabilitiesOf, expectEqual, expectTrue, invariantProblems, ownerMeta, verdict } from './context';
import type { SmokeCase, SmokeContext } from './context';
import { openActive } from './casesCapability';
import { deferred, delay, waitFor, withTimeout } from './harness';
import type { Deferred } from './harness';
import { describeOpen } from './replies';
import type { OpenReply } from './replies';
import type { SmokeWindow } from './windows';

/** 让窗口发起一次停在受控选择器上的 Open；返回控制器与（可能永不 settle 的）页面结果。 */
async function holdChooser(ctx: SmokeContext, window: SmokeWindow): Promise<{ control: Deferred<string | null>; reply: Promise<OpenReply> }> {
  const control = deferred<string | null>();
  const calls = ctx.chooser.calls.length;
  ctx.chooser.enqueue({ kind: 'deferred', control });
  const reply = window.open(10_000);
  if (!(await waitFor(() => ctx.chooser.calls.length === calls + 1, 3_000))) throw new Error('chooser not reached');
  return { control, reply };
}

const seq = (ctx: SmokeContext, window: SmokeWindow): number => ownerMeta(ctx, window.ownerId)?.latestRequestSeq ?? -1;

const dialogLogicalBusy: SmokeCase = {
  id: 'dialog.logical-busy',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const active = await openActive(ctx, window, ctx.fixtures.utf8);
    const held = await holdChooser(ctx, window);
    const before = seq(ctx, window);
    const problems: string[] = [];
    expectEqual(problems, 'second open while chooser open', describeOpen(await window.open()), 'rejected:busy');
    expectEqual(problems, 'busy does not take a request seq', seq(ctx, window), before);
    expectEqual(problems, 'chooser not called again', ctx.chooser.calls.length, 2);
    expectEqual(problems, 'logical lock still held', ownerMeta(ctx, window.ownerId)?.dialogOpen, true);
    expectTrue(problems, 'busy disturbed the active capability', ctx.openIpc.authorize(window.ownerId, active.capabilityId) !== null);
    held.control.resolve(ctx.fixtures.second);
    const reply = await held.reply;
    if (reply.kind === 'opened') expectEqual(problems, 'held request still completes', await window.activate(reply.ticket), { ok: true });
    else problems.push(`held request: ${describeOpen(reply)}`);
    return verdict(problems);
  },
};

const dialogSameWindowAfterReload: SmokeCase = {
  id: 'dialog.same-window-after-reload',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const held = await holdChooser(ctx, window);
    const loaded = window.nextLoad();
    window.win.webContents.reload();
    await loaded;
    const before = seq(ctx, window);
    const problems: string[] = [];
    expectEqual(problems, 'logical lock released by reload', ownerMeta(ctx, window.ownerId)?.dialogOpen, false);
    expectEqual(problems, 'physical chooser still unsettled', ctx.openIpc.pendingNativeDialogs(), 1);
    expectEqual(problems, 'new page open while old chooser unsettled', describeOpen(await window.open()), 'rejected:busy');
    expectEqual(problems, 'busy does not take a request seq', seq(ctx, window), before);
    // 用读取闸门确认迟到请求已经走到读取阶段，放行后再等它完成，才断言「没有登记候选」（否则断言可能早于迟到结果）。
    const read = ctx.fs.holdNextRead();
    held.control.resolve(ctx.fixtures.utf8);
    expectTrue(problems, 'chooser ownership not released on settle', await waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, 3_000));
    await withTimeout(read.reached, 3_000, 'late request reached read');
    read.release();
    await delay(300);
    expectEqual(problems, 'late result registered no candidate', capabilitiesOf(ctx, window.ownerId), []);
    try {
      await openActive(ctx, window, ctx.fixtures.second);
    } catch (error) {
      problems.push(`recovery: ${error instanceof Error ? error.message : String(error)}`);
    }
    return verdict(problems);
  },
};

const dialogCrossWindow: SmokeCase = {
  id: 'dialog.cross-window',
  run: async (ctx) => {
    const a = await ctx.windows.create();
    const b = await ctx.windows.create();
    const held = await holdChooser(ctx, a);
    const problems: string[] = [];
    try {
      await openActive(ctx, b, ctx.fixtures.second);
    } catch (error) {
      problems.push(`other window blocked: ${error instanceof Error ? error.message : String(error)}`);
    }
    expectEqual(problems, 'A still holds its chooser', ownerMeta(ctx, a.ownerId)?.dialogOpen, true);
    held.control.resolve(null);
    expectEqual(problems, 'A completes independently', describeOpen(await held.reply), 'canceled');
    return verdict(problems);
  },
};

const dialogParentWindow: SmokeCase = {
  id: 'dialog.parent-window',
  run: async (ctx) => {
    const a = await ctx.windows.create();
    const b = await ctx.windows.create();
    ctx.chooser.enqueue({ kind: 'cancel' }, { kind: 'cancel' });
    const replies = [describeOpen(await b.open()), describeOpen(await a.open())];
    const problems: string[] = [];
    expectEqual(problems, 'replies', replies, ['canceled', 'canceled']);
    const parents = ctx.chooser.calls.map((call) => call.parent);
    expectTrue(problems, 'first chooser parent is not window B', parents[0] === b.win);
    expectTrue(problems, 'second chooser parent is not window A', parents[1] === a.win);
    expectTrue(problems, 'parent is not a BrowserWindow', parents.every((parent) => parent instanceof BrowserWindow));
    return verdict(problems);
  },
};

/** 带着未 settle 的选择器销毁窗口：所有权不被伪造释放、计入 orphaned、不影响其它窗口；迟到 settle 后清理且不产生能力。 */
const dialogOrphaned: SmokeCase = {
  id: 'dialog.orphaned',
  run: async (ctx) => {
    const a = await ctx.windows.create();
    const b = await ctx.windows.create();
    const held = await holdChooser(ctx, a);
    const problems: string[] = [];
    const closed = new Promise<void>((resolve) => a.win.once('closed', () => resolve()));
    a.win.destroy();
    await withTimeout(closed, 5_000, 'destroy');
    expectEqual(problems, 'unsettled after destroy', ctx.openIpc.pendingNativeDialogs(), 1);
    expectEqual(problems, 'orphaned after destroy', ctx.openIpc.orphanedNativeDialogs(), 1);
    expectEqual(problems, 'destroyed owner removed', ownerMeta(ctx, a.ownerId), undefined);
    let bTicket: { capabilityId: string; documentId: number } | null = null;
    try {
      bTicket = await openActive(ctx, b, ctx.fixtures.second);
    } catch (error) {
      problems.push(`orphan blocked another window: ${error instanceof Error ? error.message : String(error)}`);
    }
    held.control.resolve(ctx.fixtures.utf8);
    expectTrue(problems, 'late settle not released', await waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, 3_000));
    expectEqual(problems, 'orphaned after late settle', ctx.openIpc.orphanedNativeDialogs(), 0);
    expectEqual(problems, 'no capability for destroyed owner', capabilitiesOf(ctx, a.ownerId), []);
    if (bTicket !== null) expectTrue(problems, 'late settle disturbed window B', ctx.openIpc.authorize(b.ownerId, bTicket.capabilityId) !== null);
    problems.push(...invariantProblems(ctx));
    return verdict(problems);
  },
};

export const DIALOG_CASES: readonly SmokeCase[] = [dialogLogicalBusy, dialogSameWindowAfterReload, dialogCrossWindow, dialogParentWindow, dialogOrphaned];

/** 全部 matrix 用例之后：协调器一致、没有残留 owner / 能力 / 原生选择器 / 窗口。 */
export const FINAL_CASE: SmokeCase = {
  id: 'final.invariants',
  run: (ctx) => {
    const problems = invariantProblems(ctx);
    const state = ctx.openIpc.currentState();
    expectEqual(problems, 'owners', state.owners.size, 0);
    expectEqual(problems, 'capabilities', state.table.size, 0);
    expectEqual(problems, 'unsettled choosers', ctx.openIpc.pendingNativeDialogs(), 0);
    expectEqual(problems, 'orphaned choosers', ctx.openIpc.orphanedNativeDialogs(), 0);
    expectEqual(problems, 'open windows', BrowserWindow.getAllWindows().length, 0);
    expectEqual(problems, 'unused chooser steps', ctx.chooser.remaining(), 0);
    expectEqual(problems, 'read gates', ctx.fs.hasPendingGate(), false);
    return Promise.resolve(verdict(problems));
  },
};
