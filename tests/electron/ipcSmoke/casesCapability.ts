/**
 * C 组：Open / Capability（M3 T1b-2b-1）。页面经 `window.museDesktop` 发起 Open / activate / reject；
 * main 只经生产 handle 的只读诊断出口观察能力表与授权结果。
 */

import { PENDING_TTL_MS } from '../../../src/main/open/openCoordinator';
import { capabilitiesOf, expectEqual, expectTrue, leaksPath, SECOND_SOURCE, UTF8_SOURCE, verdict } from './context';
import type { CaseOutcome, SmokeCase, SmokeContext } from './context';
import { deferred, waitFor } from './harness';
import type { ChooserStep } from './harness';
import { describeOpen } from './replies';
import type { OpenReply, Ticket } from './replies';
import type { SmokeWindow } from './windows';

/** 打开并激活一份文档；失败时抛出（由用例记录为失败）。 */
export async function openActive(ctx: SmokeContext, window: SmokeWindow, path: string): Promise<Ticket> {
  ctx.chooser.enqueue({ kind: 'path', path });
  const reply = await window.open();
  if (reply.kind !== 'opened') throw new Error(`setup open: ${describeOpen(reply)}`);
  const activation = await window.activate(reply.ticket);
  if (!('ok' in activation) || !activation.ok) throw new Error(`setup activate: ${JSON.stringify(activation)}`);
  return reply.ticket;
}

export async function openPending(ctx: SmokeContext, window: SmokeWindow, path: string): Promise<Ticket> {
  ctx.chooser.enqueue({ kind: 'path', path });
  const reply = await window.open();
  if (reply.kind !== 'opened') throw new Error(`setup open: ${describeOpen(reply)}`);
  return reply.ticket;
}

const authorized = (ctx: SmokeContext, window: SmokeWindow, ticket: Ticket): boolean => ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) !== null;

const openActivate: SmokeCase = {
  id: 'open.activate',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    const problems: string[] = [];
    if (reply.kind !== 'opened') return verdict([`expected opened, got ${describeOpen(reply)}`]);
    expectEqual(problems, 'source', reply.source, UTF8_SOURCE);
    expectEqual(problems, 'writeEncoding', reply.writeEncoding, 'utf-8');
    expectEqual(problems, 'displayName', reply.displayName, 'utf8 score.jcx');
    expectEqual(problems, 'pending before activate', capabilitiesOf(ctx, window.ownerId).map((c) => c.state), ['pending']);
    expectTrue(problems, 'pending capability authorizes', !authorized(ctx, window, reply.ticket));
    const activation = await window.activate(reply.ticket);
    expectEqual(problems, 'activate reply', activation, { ok: true });
    expectEqual(problems, 'active after activate', capabilitiesOf(ctx, window.ownerId).map((c) => c.state), ['active']);
    const record = ctx.openIpc.authorize(window.ownerId, reply.ticket.capabilityId);
    expectEqual(problems, 'authorized owner', record?.ownerId, window.ownerId);
    expectEqual(problems, 'authorized documentId', record?.documentId, reply.ticket.documentId);
    expectEqual(problems, 'parent passed to chooser is the requesting window', ctx.chooser.calls[0]?.parent === window.win, true);
    return verdict(problems, { documentId: reply.ticket.documentId });
  },
};

const openWrongDocument: SmokeCase = {
  id: 'open.wrong-document',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openPending(ctx, window, ctx.fixtures.utf8);
    const before = capabilitiesOf(ctx, window.ownerId);
    const problems: string[] = [];
    expectEqual(problems, 'mismatch reply', await window.activate({ ...ticket, documentId: ticket.documentId + 1000 }), { ok: false, code: 'document-mismatch' });
    expectEqual(problems, 'state unchanged by mismatch', capabilitiesOf(ctx, window.ownerId), before);
    expectEqual(problems, 'correct activate', await window.activate(ticket), { ok: true });
    return verdict(problems);
  },
};

const openActivateIdempotent: SmokeCase = {
  id: 'open.activate-idempotent',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openPending(ctx, window, ctx.fixtures.utf8);
    const problems: string[] = [];
    expectEqual(problems, 'first', await window.activate(ticket), { ok: true });
    expectEqual(problems, 'second', await window.activate(ticket), { ok: true });
    expectEqual(problems, 'capabilities', capabilitiesOf(ctx, window.ownerId).map((c) => c.state), ['active']);
    return verdict(problems);
  },
};

const openReject: SmokeCase = {
  id: 'open.reject',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openPending(ctx, window, ctx.fixtures.utf8);
    const problems: string[] = [];
    expectEqual(problems, 'reject reply', await window.reject(ticket), { ok: true });
    expectEqual(problems, 'capabilities after reject', capabilitiesOf(ctx, window.ownerId), []);
    expectEqual(problems, 'activate after reject', await window.activate(ticket), { ok: false, code: 'capability-invalid' });
    return verdict(problems);
  },
};

const openRejectAfterActivate: SmokeCase = {
  id: 'open.reject-after-activate',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const first = await openActive(ctx, window, ctx.fixtures.utf8);
    const second = await openActive(ctx, window, ctx.fixtures.second);
    const problems: string[] = [];
    expectTrue(problems, 'first revoked when second activated', !authorized(ctx, window, first));
    expectEqual(problems, 'reject active', await window.reject(second), { ok: true });
    expectTrue(problems, 'second still authorized after reject', !authorized(ctx, window, second));
    expectTrue(problems, 'first restored after rejecting second', !authorized(ctx, window, first));
    expectEqual(problems, 'capabilities', capabilitiesOf(ctx, window.ownerId), []);
    return verdict(problems);
  },
};

const openReplaceActive: SmokeCase = {
  id: 'open.replace-active',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const first = await openActive(ctx, window, ctx.fixtures.utf8);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
    const reply = await window.open();
    const problems: string[] = [];
    if (reply.kind !== 'opened') return verdict([`second open: ${describeOpen(reply)}`]);
    expectEqual(problems, 'second source', reply.source, SECOND_SOURCE);
    expectTrue(problems, 'old active lost while new is only pending', authorized(ctx, window, first));
    expectEqual(problems, 'activate second', await window.activate(reply.ticket), { ok: true });
    expectTrue(problems, 'old active not revoked', !authorized(ctx, window, first));
    expectTrue(problems, 'new active not authorized', authorized(ctx, window, reply.ticket));
    expectEqual(problems, 'one active', capabilitiesOf(ctx, window.ownerId).map((c) => c.state), ['active']);
    return verdict(problems);
  },
};

/** 已有 active 时，后续 Open 的非成功结果不得吊销它；错误信息不得泄露路径。 */
async function keepsActive(ctx: SmokeContext, expected: (reply: OpenReply) => string[], step: ChooserStep, inject?: () => void): Promise<CaseOutcome> {
  const window = await ctx.windows.create();
  const first = await openActive(ctx, window, ctx.fixtures.utf8);
  inject?.();
  ctx.chooser.enqueue(step);
  const reply = await window.open();
  const problems = expected(reply);
  expectTrue(problems, 'old active revoked', authorized(ctx, window, first));
  expectEqual(problems, 'capabilities', capabilitiesOf(ctx, window.ownerId).map((c) => c.state), ['active']);
  if (reply.kind === 'failed') expectTrue(problems, `error leaks a path: ${reply.message}`, !leaksPath(ctx, reply.message));
  return verdict(problems, { reply: describeOpen(reply) });
}

function expectKind(kind: string, code?: string): (reply: OpenReply) => string[] {
  return (reply) => {
    const problems: string[] = [];
    expectEqual(problems, 'reply', describeOpen(reply), code === undefined ? kind : `${kind}:${code}`);
    return problems;
  };
}

const openCancelKeepsActive: SmokeCase = {
  id: 'open.cancel-keeps-active',
  run: (ctx) => keepsActive(ctx, expectKind('canceled'), { kind: 'cancel' }),
};

const openDecodeFailureKeepsActive: SmokeCase = {
  id: 'open.decode-failure-keeps-active',
  run: (ctx) => keepsActive(ctx, expectKind('failed', 'decode-utf16-unsupported'), { kind: 'path', path: ctx.fixtures.utf16 }),
};

const openRelativePath: SmokeCase = {
  id: 'open.relative-path',
  run: (ctx) => keepsActive(ctx, expectKind('failed', 'read-failed'), { kind: 'path', path: 'relative dir/score.jcx' }),
};

const openChooserThrows: SmokeCase = {
  id: 'open.chooser-throws',
  run: (ctx) => keepsActive(ctx, expectKind('failed', 'read-failed'), { kind: 'throw-sync', message: `boom at ${ctx.fixtures.dir}` }),
};

/** 故障注入：fs 抛出带路径文本的 errno 异常 → 固定错误码与固定文案，不外泄路径。 */
const openFsErrorHidden: SmokeCase = {
  id: 'open.fs-error-hidden',
  run: (ctx) =>
    keepsActive(ctx, expectKind('failed', 'permission-denied'), { kind: 'path', path: ctx.fixtures.second }, () => {
      ctx.fs.failNextOpen(Object.assign(new Error(`EACCES: permission denied, open '${ctx.fixtures.second}'`), { code: 'EACCES' }));
    }),
};

/** 故障注入：T1a 管线之外的意外异常（token 签发抛出带路径文本的异常）→ 兜底 read-failed，不外泄、不登记候选。 */
const openPipelineThrows: SmokeCase = {
  id: 'open.pipeline-throws',
  run: (ctx) =>
    keepsActive(ctx, expectKind('failed', 'read-failed'), { kind: 'path', path: ctx.fixtures.second }, () => {
      ctx.tokenFaults.failNext(new Error(`token store unavailable at ${ctx.fixtures.dir}`));
    }),
};

const openChooserRejects: SmokeCase = {
  id: 'open.chooser-rejects',
  run: (ctx) => keepsActive(ctx, expectKind('failed', 'read-failed'), { kind: 'reject-async', message: `EACCES ${ctx.fixtures.utf8}` }),
};

/** TTL：从 pending 登记起计时，`now >= expiresAt` 即失效；定时清理只做清理。距到期还剩 1 s 时仍可激活。 */
const openTtlExpiry: SmokeCase = {
  id: 'open.ttl-expiry',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const early = await openPending(ctx, window, ctx.fixtures.utf8);
    ctx.clock.advance(PENDING_TTL_MS - 1_000);
    expectEqual(problems, 'activate before expiry', await window.activate(early), { ok: true });
    const late = await openPending(ctx, window, ctx.fixtures.second);
    ctx.clock.advance(PENDING_TTL_MS);
    expectEqual(problems, 'activate after expiry', await window.activate(late), { ok: false, code: 'capability-invalid' });
    expectTrue(problems, 'expired candidate replaced the active', authorized(ctx, window, early));
    const stale = await openPending(ctx, window, ctx.fixtures.second);
    ctx.clock.advance(PENDING_TTL_MS);
    // 调度器在用例开始时已清空：这里执行的只可能是本用例三次 Open 登记的清理任务。
    const ran = ctx.scheduler.runDue();
    expectEqual(problems, 'cleanup tasks scheduled by this case', ran, 3);
    expectEqual(problems, 'cleanup dropped expired pending only', capabilitiesOf(ctx, window.ownerId).map((c) => c.token), [early.capabilityId]);
    expectEqual(problems, 'activate cleaned candidate', await window.activate(stale), { ok: false, code: 'capability-invalid' });
    return verdict(problems, { ttlMs: PENDING_TTL_MS });
  },
};

/** 长时间停在选择器上不消耗 TTL：TTL 从 pending 登记时才开始。 */
const openTtlStartsAtRegistration: SmokeCase = {
  id: 'open.ttl-starts-at-registration',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const control = deferred<string | null>();
    ctx.chooser.enqueue({ kind: 'deferred', control });
    const pending = window.open();
    // 先确认请求已到达 main 并停在选择器上，再推进时钟（否则推进发生在请求到达之前，测不到「对话框期间不计时」）。
    if (!(await waitFor(() => ctx.chooser.calls.length === 1, 3_000))) return verdict(['chooser not reached']);
    ctx.clock.advance(PENDING_TTL_MS * 2);
    control.resolve(ctx.fixtures.utf8);
    const reply = await pending;
    const problems: string[] = [];
    if (reply.kind !== 'opened') return verdict([`open: ${describeOpen(reply)}`]);
    expectEqual(problems, 'activate after long dialog', await window.activate(reply.ticket), { ok: true });
    return verdict(problems);
  },
};

export const CAPABILITY_CASES: readonly SmokeCase[] = [
  openActivate,
  openWrongDocument,
  openActivateIdempotent,
  openReject,
  openRejectAfterActivate,
  openReplaceActive,
  openCancelKeepsActive,
  openDecodeFailureKeepsActive,
  openRelativePath,
  openChooserThrows,
  openChooserRejects,
  openFsErrorHidden,
  openPipelineThrows,
  openTtlExpiry,
  openTtlStartsAtRegistration,
];
