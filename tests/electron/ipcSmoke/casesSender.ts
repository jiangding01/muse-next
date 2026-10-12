/**
 * E 组：sender 与 payload 安全（M3 T1b-2b-1）。
 *
 * 生产 sandbox 下子 frame 没有 preload，单靠它无法证明 main 侧的 mainFrame 校验。`reject.subframe` 因此使用**测试专属**
 * 配置 `nodeIntegrationInSubFrames: true`（仍是 sandbox / contextIsolation / 无 nodeIntegration），让子 frame 加载与主 frame
 * 完全相同的可信页面 URL 并拿到桥：此时只有 main 侧 `senderFrame === mainFrame` 一项能拒绝它。这不是生产配置的安全证明。
 * M3 T1c-1 起子 frame 导航由生产安全接线拦截，所以该用例显式关闭安全接线（`off-for-sender-check`），只为单独观测 main 侧鉴权；
 * `wireOpenIpcWindow` 与 main 的 IPC 鉴权照常生效，断言与 T1b 相同。
 * `risk.subframe-parent-bridge`（T1b 为 observe，M3 T1c-1 起为 pass 硬门）：在默认的生产安全接线下，同源子 frame 加载不了可信页面，
 * 也就不能经 `parent.museDesktop` 调用桥；不加固时风险确实存在由 `security.subframe-control`（`casesSecurity.ts`）对照证明。
 */

import { randomUUID } from 'node:crypto';

import type { WebFrameMain } from 'electron';

import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';
import { capabilitiesOf, expectEqual, expectTrue, ownerMeta, verdict } from './context';
import type { SmokeCase } from './context';
import { openActive, openPending } from './casesCapability';
import { rejectedOpen } from './casesEnvironment';
import { waitFor, withTimeout } from './harness';
import type { PageResult } from './replies';
import { evaluate } from './windows';
import type { SmokeWindow } from './windows';

const REJECTED = 'Error: Request rejected';
const isRejected = (result: PageResult): boolean => !result.ok && result.error.endsWith(REJECTED);

/** 等待主 frame 下出现已加载 `url` 的子 frame；超时返回 null。 */
export async function childFrame(window: SmokeWindow, url: string, timeoutMs = 5_000): Promise<WebFrameMain | null> {
  const ready = await waitFor(() => window.win.webContents.mainFrame.frames.some((frame) => frame.url === url), timeoutMs);
  if (!ready) return null;
  return window.win.webContents.mainFrame.frames.find((frame) => frame.url === url) ?? null;
}

export const frameCall = (frame: WebFrameMain, expression: string): Promise<PageResult> =>
  evaluate((code) => frame.executeJavaScript(code, true), expression, 5_000);

const rejectSubframe: SmokeCase = {
  id: 'reject.subframe',
  run: async (ctx) => {
    const window = await ctx.windows.create({ subframePreload: true, security: 'off-for-sender-check', url: `${ctx.entry.loadUrl}#frame` });
    const frame = await childFrame(window, ctx.entry.loadUrl);
    if (frame === null) return verdict(['child frame did not load the trusted page URL']);
    const problems: string[] = [];
    expectTrue(problems, 'child frame URL is not the trusted identity (test would not isolate the mainFrame check)', matchesPageIdentity(frame.url, ctx.entry.identity));
    const bridge = await frameCall(frame, 'typeof window.museDesktop');
    expectEqual(problems, 'child frame has the bridge (test-only subframe preload)', bridge.ok ? bridge.value : bridge.error, 'object');
    const ticket = await openPending(ctx, window, ctx.fixtures.utf8);
    const before = capabilitiesOf(ctx, window.ownerId);
    const calls = ctx.chooser.calls.length;
    expectTrue(problems, 'subframe open not rejected', isRejected(await frameCall(frame, 'window.museDesktop.openDocument()')));
    expectTrue(problems, 'subframe activate not rejected', isRejected(await frameCall(frame, `window.museDesktop.activateDocument(${JSON.stringify(ticket)})`)));
    expectTrue(problems, 'subframe reject not rejected', isRejected(await frameCall(frame, `window.museDesktop.rejectDocument(${JSON.stringify(ticket)})`)));
    expectEqual(problems, 'chooser not called by subframe', ctx.chooser.calls.length, calls);
    expectEqual(problems, 'state unchanged by subframe', capabilitiesOf(ctx, window.ownerId), before);
    expectEqual(problems, 'main frame can still activate', await window.activate(ticket), { ok: true });
    return verdict(problems, { config: 'test-only nodeIntegrationInSubFrames' });
  },
};

/** 等多久确认可信页面子 frame 没有加载出来（子 frame 在测试页脚本解析阶段创建，首次加载完成时导航早已发生）。 */
const SUBFRAME_ABSENT_MS = 3_000;

/**
 * 生产安全接线下（默认窗口配置）：同源子 frame 的导航被 `will-frame-navigate` 拦截，没有子 frame 加载出可信页面，因此没有任何
 * 子 frame 能经 `parent.museDesktop` 发起 Open；未导航成功的空白 frame 允许存在（不对它执行任何脚本）。主 frame 自己的 IPC 照常。
 */
const riskSubframeParentBridge: SmokeCase = {
  id: 'risk.subframe-parent-bridge',
  run: async (ctx) => {
    const window = await ctx.windows.create({ url: `${ctx.entry.loadUrl}#frame` });
    const problems: string[] = [];
    const loaded = await childFrame(window, ctx.entry.loadUrl, SUBFRAME_ABSENT_MS);
    const blocks = ctx.security.events(window.ownerId).filter((block) => block.kind === 'subframe-navigation');
    const facts = {
      productionWiring: true,
      frames: window.win.webContents.mainFrame.frames.map((frame) => (frame.url === '' ? '<empty>' : frame.url === ctx.entry.loadUrl ? '<trusted>' : '<other>')),
      subframeBlocks: blocks.map((block) => ({ event: block.event, trustedUrl: block.url === ctx.entry.loadUrl })),
    };
    expectTrue(problems, 'a child frame loaded the trusted page despite window security', loaded === null);
    expectTrue(problems, 'will-frame-navigate did not block the trusted-page subframe', blocks.some((block) => block.event === 'will-frame-navigate' && block.url === ctx.entry.loadUrl));
    expectEqual(problems, 'chooser called through a subframe', ctx.chooser.calls.length, 0);
    expectEqual(problems, 'an Open request reached main before the main frame asked', ownerMeta(ctx, window.ownerId)?.latestRequestSeq, 0);
    try {
      await openActive(ctx, window, ctx.fixtures.utf8);
    } catch (error) {
      problems.push(`main frame IPC broken: ${error instanceof Error ? error.message : String(error)}`);
    }
    expectEqual(problems, 'main frame Open reached the chooser exactly once', ctx.chooser.calls.length, 1);
    return verdict(problems, facts);
  },
};

const rejectUnattachedWindow: SmokeCase = {
  id: 'reject.unattached-window',
  run: async (ctx) => {
    const window = await ctx.windows.create({ wire: false });
    const outcome = rejectedOpen(ctx, window.ownerId, await window.openRaw());
    const problems: string[] = outcome.status === 'passed' ? [] : [outcome.detail ?? 'open not rejected'];
    const activation = await window.call(`window.museDesktop.activateDocument(${JSON.stringify({ capabilityId: randomUUID(), documentId: 1 })})`);
    expectTrue(problems, 'unattached activate not rejected', isRejected(activation));
    expectEqual(problems, 'owner not registered', ownerMeta(ctx, window.ownerId), undefined);
    return verdict(problems);
  },
};

/** 畸形票据被 main 拒绝且不改状态；preload 只转发两个字段（多余字段不出现在 main）；openDocument 的参数被忽略。 */
const rejectBadPayload: SmokeCase = {
  id: 'reject.bad-payload',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
    const before = capabilitiesOf(ctx, window.ownerId);
    const problems: string[] = [];
    const bad = [
      `{ capabilityId: ${JSON.stringify(ticket.capabilityId)}, documentId: '${String(ticket.documentId)}' }`,
      `{ capabilityId: ${JSON.stringify(ticket.capabilityId)}, documentId: 1.5 }`,
      `{ capabilityId: ${JSON.stringify(ticket.capabilityId)}, documentId: -1 }`,
      `{ capabilityId: ${JSON.stringify(ticket.capabilityId)}, documentId: Number.MAX_SAFE_INTEGER + 2 }`,
      `{ capabilityId: 'a/../b', documentId: ${String(ticket.documentId)} }`,
      `{ capabilityId: 'x'.repeat(65), documentId: ${String(ticket.documentId)} }`,
      `{ capabilityId: ${JSON.stringify(ticket.capabilityId)} }`,
    ];
    for (const payload of bad) {
      expectTrue(problems, `activate ${payload} not rejected`, isRejected(await window.call(`window.museDesktop.activateDocument(${payload})`)));
      expectTrue(problems, `reject ${payload} not rejected`, isRejected(await window.call(`window.museDesktop.rejectDocument(${payload})`)));
    }
    const nullTicket = await window.call('window.museDesktop.activateDocument(null)');
    expectTrue(problems, 'null ticket did not fail in preload', !nullTicket.ok);
    const extra = await window.call(`window.museDesktop.activateDocument({ ...${JSON.stringify(ticket)}, path: '/etc/passwd', __proto__: { x: 1 } })`);
    expectEqual(problems, 'extra fields stripped by preload (main accepts exact keys)', extra.ok ? extra.value : extra.error, { ok: true });
    ctx.chooser.enqueue({ kind: 'cancel' });
    const withArg = await window.call(`window.museDesktop.openDocument(${JSON.stringify(ctx.fixtures.second)})`);
    expectEqual(problems, 'openDocument ignores page arguments', withArg.ok ? withArg.value : withArg.error, { kind: 'canceled' });
    expectEqual(problems, 'state unchanged', capabilitiesOf(ctx, window.ownerId), before);
    return verdict(problems, { malformed: bad.length });
  },
};

const rejectCrossWindowToken: SmokeCase = {
  id: 'reject.cross-window-token',
  run: async (ctx) => {
    const a = await ctx.windows.create();
    const b = await ctx.windows.create();
    const active = await openActive(ctx, a, ctx.fixtures.utf8);
    const pending = await openPending(ctx, a, ctx.fixtures.second);
    const problems: string[] = [];
    expectEqual(problems, 'B activates A active', await b.activate(active), { ok: false, code: 'capability-invalid' });
    expectEqual(problems, 'B activates A pending', await b.activate(pending), { ok: false, code: 'capability-invalid' });
    expectEqual(problems, 'B rejects A tokens', [await b.reject(active), await b.reject(pending)], [{ ok: true }, { ok: true }]);
    expectEqual(problems, 'authorize under B', ctx.openIpc.authorize(b.ownerId, active.capabilityId), null);
    expectEqual(problems, 'A capabilities unchanged', capabilitiesOf(ctx, a.ownerId).map((c) => c.state).sort(), ['active', 'pending']);
    expectEqual(problems, 'A can still activate its pending', await a.activate(pending), { ok: true });
    return verdict(problems);
  },
};

const rejectForgedCapability: SmokeCase = {
  id: 'reject.forged-capability',
  run: async (ctx) => {
    const closed = await ctx.windows.create();
    const stale = await openActive(ctx, closed, ctx.fixtures.utf8);
    const closing = new Promise<void>((resolve) => closed.win.once('closed', () => resolve()));
    closed.win.close();
    await withTimeout(closing, 5_000, 'close');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, ctx.fixtures.second);
    const problems: string[] = [];
    expectEqual(problems, 'random capability', await window.activate({ capabilityId: randomUUID(), documentId: ticket.documentId }), {
      ok: false,
      code: 'capability-invalid',
    });
    expectEqual(problems, 'capability of a closed window', await window.activate(stale), { ok: false, code: 'capability-invalid' });
    expectEqual(problems, 'reject of random capability is ok (no oracle)', await window.reject({ capabilityId: randomUUID(), documentId: 1 }), { ok: true });
    expectTrue(problems, 'own active lost', ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) !== null);
    return verdict(problems);
  },
};

export const SENDER_CASES: readonly SmokeCase[] = [
  rejectSubframe,
  rejectUnattachedWindow,
  rejectBadPayload,
  rejectCrossWindowToken,
  rejectForgedCapability,
  riskSubframeParentBridge,
];

