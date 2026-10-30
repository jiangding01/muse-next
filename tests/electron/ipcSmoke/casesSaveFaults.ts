/**
 * M3 T4 B2：保存的故障注入 smoke（matrix；GATE-PLAN-r1 §2.5、GA12 §1、Gate B2 F1 / T-OP-1）。
 *
 * - 提交前 / 提交后的页面代次变化（A4）：写 port 闸门把管线挂在提交点之前（`openExclusive`）或之后（`syncDirectory`），
 *   期间页面发起一次被安全策略拦截的导航——生产接线收到 `did-start-navigation` 执行 A4，页面仍存活，应答仍能送达。
 * - H-7：页面发出激活但不处理应答（main 照常执行，renderer 不切换）；reject「丢失」即不发送。每例断言 X 的 SHA-256、
 *   dev / ino、mtimeNs 不变。
 * - F1：Save As 原生对话框挂起期间 reload，新页面的保存 / Open 都 busy；旧对话框返回后不登记、不释放新锁。
 * - T-OP-1：旧操作的迟到结束不得释放新操作的锁。
 */

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { bridge, codeOf, diskFacts, grantedId, requestRefused, requestTarget, saveAsTo, saveDir, SAVED_SOURCE, saveTo, scoreFile, temps } from './casesSave';
import { openActive, openPending } from './casesCapability';
import { expectEqual, expectTrue, ownerMeta, SECOND_SOURCE, UTF8_SOURCE, verdict } from './context';
import type { SmokeCase, SmokeContext } from './context';
import { deferred, waitFor } from './harness';
import { isRecord } from './replies';
import type { Ticket } from './replies';
import type { SmokeWindow } from './windows';

/** 被安全策略拦截的跨文档导航（与 `prod.navigation-blocked` 相同的目标）：只触发 A4，页面存活。 */
async function interceptedNavigation(ctx: SmokeContext, window: SmokeWindow): Promise<boolean> {
  const before = ownerMeta(ctx, window.ownerId)?.generation ?? 0;
  await window.call(`(location.href = ${JSON.stringify('http://127.0.0.1:9/')}, true)`, 3_000);
  return waitFor(() => (ownerMeta(ctx, window.ownerId)?.generation ?? 0) > before, 3_000);
}

const committedOf = (ctx: SmokeContext, window: SmokeWindow): unknown => ownerMeta(ctx, window.ownerId)?.committed;

/**
 * 激活应答「丢失」：页面发出激活后不处理应答（renderer 未切换会话），main 照常执行（等到 committed 前移）。B2 只验证 main 侧
 * 「main 已激活 N、renderer 仍持 X」的分叉；应答扣留设施只供 casesUi 使用（ipcFaults 使用范围守卫），renderer 侧在 B3 覆盖。
 */
async function activateReplyLost(ctx: SmokeContext, window: SmokeWindow, ticket: Ticket): Promise<boolean> {
  await window.call(`void window.museDesktop.activateDocument(${JSON.stringify(ticket)})`);
  return waitFor(() => {
    const committed = committedOf(ctx, window);
    return isRecord(committed) && committed.token === ticket.capabilityId;
  }, 3_000);
}

const ticketOf = (reply: Record<string, unknown>): Ticket | null =>
  isRecord(reply.ticket) && typeof reply.ticket.capabilityId === 'string' && typeof reply.ticket.documentId === 'number'
    ? { capabilityId: reply.ticket.capabilityId, documentId: reply.ticket.documentId }
    : null;

const resetBeforeCommit: SmokeCase = {
  id: 'save.reset-before-commit',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'before.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const gate = ctx.writeGate.holdNext('openExclusive');
    const pending = saveTo(window, ticket, SAVED_SOURCE);
    await gate.reached;
    expectTrue(problems, 'intercepted navigation did not reset the page generation', await interceptedNavigation(ctx, window));
    gate.release();
    const reply = await pending;
    expectEqual(problems, 'refused before commit', { outcome: reply.outcome, code: codeOf(reply) }, { outcome: 'not-committed', code: 'capability-invalid' });
    expectEqual(problems, 'bytes untouched', await readFile(file, 'utf8'), UTF8_SOURCE);
    expectEqual(problems, 'temp files', await temps(dir), []);
    return verdict(problems);
  },
};

const committedUnconfirmed: SmokeCase = {
  id: 'save.committed-unconfirmed',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'after.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const gate = ctx.writeGate.holdNext('syncDirectory');
    const pending = saveTo(window, ticket, SAVED_SOURCE);
    await gate.reached;
    expectTrue(problems, 'intercepted navigation did not reset the page generation', await interceptedNavigation(ctx, window));
    gate.release();
    const reply = await pending;
    expectEqual(problems, 'committed but unconfirmed', { outcome: reply.outcome, ticket: reply.ticket }, { outcome: 'committed-unconfirmed', ticket: null });
    expectEqual(problems, 'bytes written', await readFile(file, 'utf8'), SAVED_SOURCE);
    // M53：墓碑的指纹随磁盘真相刷新。
    const record = ctx.openIpc.currentState().table.get(ticket.capabilityId);
    expectEqual(problems, 'tombstone refreshed', record?.purpose === 'tombstone' ? record.lastKnownDiskFingerprint : null, (await diskFacts(file)).sha256);
    return verdict(problems);
  },
};

/** H-7 的共同前置：打开 X，Save As 到 N 成功，N 的激活应答丢失（main 已激活 N）。 */
async function forkedAnchor(ctx: SmokeContext, window: SmokeWindow, dir: string): Promise<{ x: string; tx: Ticket; next: Ticket }> {
  const x = await scoreFile(dir, 'x.jcx');
  const tx = await openActive(ctx, window, x);
  const saved = await saveAsTo(window, grantedId(await requestTarget(ctx, window, join(dir, 'n.jcx'), tx.capabilityId)), tx.documentId, tx.capabilityId, SAVED_SOURCE);
  const next = ticketOf(saved);
  if (saved.outcome !== 'saved' || next === null) throw new Error('setup save-as failed');
  if (!(await activateReplyLost(ctx, window, next))) throw new Error('main did not activate N');
  return { x, tx, next };
}

const activationLostRejectDelivered: SmokeCase = {
  id: 'save-as.activation-lost-reject-delivered',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const window = await ctx.windows.create();
    const { x, tx, next } = await forkedAnchor(ctx, window, dir);
    const before = await diskFacts(x);
    const problems: string[] = [];
    // renderer 放弃 N 并且 reject 送达：A2 回退到 X（墓碑），R19 重新成立。
    expectEqual(problems, 'reject N', await window.reject(next), { ok: true });
    expectEqual(problems, 'anchor back to X', committedOf(ctx, window), { kind: 'record', token: tx.capabilityId });
    const reply = await requestTarget(ctx, window, x, tx.capabilityId);
    expectEqual(problems, 'same-file grant', { kind: reply.kind, sameAsCurrent: reply.sameAsCurrent }, { kind: 'granted', sameAsCurrent: true });
    expectEqual(problems, 'X untouched', await diskFacts(x), before);
    return verdict(problems);
  },
};

const activationLostRejectLost: SmokeCase = {
  id: 'save-as.activation-lost-reject-lost',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const window = await ctx.windows.create();
    const { x, tx } = await forkedAnchor(ctx, window, dir);
    const problems: string[] = [];
    // exact：renderer 仍持 X，main committed = N。Save As 选 X → 阶段 1 即 source-mismatch，不弹对话框。
    const before = await diskFacts(x);
    expectEqual(problems, 'exact: source-mismatch', codeOf(await requestRefused(window, tx.capabilityId)), 'source-mismatch');
    expectEqual(problems, 'exact: X untouched', await diskFacts(x), before);
    // 外部修改：X 被外部改写后，分叉状态下仍不会按错误的文件事实写盘。
    await scoreFile(dir, 'x.jcx', SECOND_SOURCE);
    const external = await diskFacts(x);
    expectEqual(problems, 'external: source-mismatch', codeOf(await requestRefused(window, tx.capabilityId)), 'source-mismatch');
    expectEqual(problems, 'external: X keeps external bytes', await diskFacts(x), external);
    // 普通 Save 用 X 的旧 token：它已是墓碑，不授权。
    expectEqual(problems, 'save with stale X', codeOf(await saveTo(window, tx, SAVED_SOURCE)), 'capability-invalid');
    expectEqual(problems, 'X still external', await diskFacts(x), external);
    return verdict(problems);
  },
};

const demoStaleAnchor: SmokeCase = {
  id: 'save-as.demo-stale-anchor',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const target = join(dir, 'from-demo.jcx');
    const saved = await saveAsTo(window, grantedId(await requestTarget(ctx, window, target, null)), 0, null, SAVED_SOURCE);
    const next = ticketOf(saved);
    if (next === null) return verdict(['setup: missing ticket']);
    if (!(await activateReplyLost(ctx, window, next))) return verdict(['setup: main did not activate']);
    const before = await diskFacts(target);
    // 页面仍是 demo（null），main 已 committed = N（M67：null 不是「跳过核对」）。
    expectEqual(problems, 'demo source rejected', codeOf(await requestRefused(window, null)), 'source-mismatch');
    expectEqual(problems, 'N untouched', await diskFacts(target), before);
    return verdict(problems);
  },
};

const openActivationLostRejectLost: SmokeCase = {
  id: 'open.activation-lost-reject-lost',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const x = await scoreFile(dir, 'x.jcx');
    const y = await scoreFile(dir, 'y.jcx', SECOND_SOURCE);
    const window = await ctx.windows.create();
    const tx = await openActive(ctx, window, x);
    const ty = await openPending(ctx, window, y);
    const problems: string[] = [];
    expectTrue(problems, 'main did not activate Y', await activateReplyLost(ctx, window, ty));
    const before = await diskFacts(x);
    expectEqual(problems, 'save-as with X', codeOf(await requestRefused(window, tx.capabilityId)), 'source-mismatch');
    expectEqual(problems, 'save with X', codeOf(await saveTo(window, tx, SAVED_SOURCE)), 'capability-invalid');
    expectEqual(problems, 'X untouched', await diskFacts(x), before);
    return verdict(problems);
  },
};

const dialogReturnsAfterReload: SmokeCase = {
  id: 'save-as.dialog-returns-after-reload',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const control = deferred<string | null>();
    ctx.saveChooser.enqueue({ kind: 'deferred', control });
    await window.call(`void window.museDesktop.requestSaveTarget(${JSON.stringify({ suggestedName: 'x.jcx', encoding: 'utf-8', sourceCapabilityId: null })})`);
    expectTrue(problems, 'old dialog not shown', await waitFor(() => ctx.openIpc.pendingNativeDialogs() === 1, 3_000));
    const loaded = window.nextLoad();
    window.win.webContents.reload();
    await loaded;
    // 新页面：旧原生对话框仍未 settle → Save As、普通 Save、Open 都 busy（逻辑锁已被 reload 清理也一样）。
    expectEqual(problems, 'save-as busy', codeOf(await requestRefused(window, null)), 'busy');
    expectEqual(problems, 'save busy', codeOf(await saveTo(window, { capabilityId: 'stale', documentId: 1 }, 'x')), 'busy');
    expectEqual(problems, 'open busy', await window.open(), { kind: 'rejected', reason: 'busy' });
    // 旧对话框返回（选中了路径）：不登记 save-target，物理所有权释放。
    control.resolve(join(dir, 'late.jcx'));
    expectTrue(problems, 'old dialog not released', await waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, 3_000));
    expectTrue(problems, 'late grant registered', ![...ctx.openIpc.currentState().table.values()].some((record) => record.purpose === 'save-target'));
    expectEqual(problems, 'save lock after late return', ownerMeta(ctx, window.ownerId)?.saveOperation, null);
    // 之后重试成功。
    const retry = await requestTarget(ctx, window, join(dir, 'retry.jcx'), null);
    expectEqual(problems, 'retry granted', retry.kind, 'granted');
    return verdict(problems);
  },
};

const lateReleaseAfterReset: SmokeCase = {
  id: 'save.late-release-after-reset',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'a.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const gateA = ctx.writeGate.holdNext('openExclusive');
    const saveA = saveTo(window, ticket, 'X:1\nT:A\n');
    await gateA.reached;
    // A4：锁被清理，a 转墓碑但仍是锚点。
    expectTrue(problems, 'intercepted navigation did not reset the page generation', await interceptedNavigation(ctx, window));
    const target = grantedId(await requestTarget(ctx, window, join(dir, 'b.jcx'), ticket.capabilityId));
    const gateB = ctx.writeGate.holdNext('openExclusive');
    const saveB = saveAsTo(window, target, ticket.documentId, ticket.capabilityId, 'X:1\nT:B\n');
    await gateB.reached;
    const heldByB = ownerMeta(ctx, window.ownerId)?.saveOperation;
    gateA.release();
    expectEqual(problems, 'A refused', codeOf(await saveA), 'capability-invalid');
    expectEqual(problems, 'B still holds the lock', ownerMeta(ctx, window.ownerId)?.saveOperation, heldByB);
    expectEqual(problems, 'C busy', codeOf(await bridge(window, 'saveDocument', { ...ticket, source: 'C', encoding: 'utf-8' })), 'busy');
    gateB.release();
    expectEqual(problems, 'B saved', (await saveB).outcome, 'saved');
    expectEqual(problems, 'A bytes never written', await readFile(file, 'utf8'), UTF8_SOURCE);
    expectEqual(problems, 'lock released', ownerMeta(ctx, window.ownerId)?.saveOperation, null);
    return verdict(problems);
  },
};

export const SAVE_FAULT_CASES: readonly SmokeCase[] = [
  resetBeforeCommit,
  committedUnconfirmed,
  activationLostRejectDelivered,
  activationLostRejectLost,
  demoStaleAnchor,
  openActivationLostRejectLost,
  dialogReturnsAfterReload,
  lateReleaseAfterReset,
];
