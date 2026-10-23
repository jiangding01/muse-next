/**
 * G 组：生产 UI 的真实 Open（M3 T1c-2，T1c Preflight r2 §16.2 第 ⑦ 项；各占一个独立子进程，以 `ui.` 前缀运行在真实生产 renderer 上）。
 *
 * 每个用例都从产品 UI 入口出发：点击 Toolbar 的 Open 按钮 → 生产 preload → main 的新 IPC → renderer 准备候选 → 激活 → commitSession
 * → UI。页面状态只从 DOM 读取（文件状态区的 `data-document-id` / `data-capability-trust`、Open 按钮的 `data-open-phase`、提示条、
 * 只读源码面板），main 状态只从生产 handle 的诊断出口读取。激活应答扣留只经 smoke 的 `ipcFaults`（产品没有测试通道）。
 */

import { stat } from 'node:fs/promises';

import { capabilitiesOf, classifyConsole, expectEqual, expectTrue, STAFF_NOTE_COUNT, UTF8_SOURCE, verdict } from './context';
import type { CapabilityView, SmokeContext } from './context';
import type { IsolatedCase } from './casesIsolated';
import { pageCondition, productionWindow } from './casesSecurity';
import { deferred, delay, waitFor } from './harness';
import { isRecord } from './replies';
import type { SmokeWindow } from './windows';

interface UiDoc {
  readonly documentId: number;
  readonly trust: string;
  readonly name: string;
  readonly phase: string;
  readonly notice: string | null;
  readonly source: string | null;
}

const READ_UI = `(() => {
  const status = document.querySelector('.file-status');
  const button = document.querySelector('[data-open-phase]');
  if (status === null || button === null) return null;
  const notice = document.querySelector('.open-notice');
  const source = document.querySelector('.source-editor');
  return {
    documentId: Number(status.getAttribute('data-document-id')),
    trust: status.getAttribute('data-capability-trust'),
    name: status.querySelector('span')?.textContent ?? '',
    phase: button.getAttribute('data-open-phase'),
    notice: notice === null ? null : notice.getAttribute('data-notice'),
    source: source === null ? null : source.value,
  };
})()`;

async function readUi(window: SmokeWindow): Promise<UiDoc | null> {
  const result = await window.call(READ_UI, 2_000);
  if (!result.ok || !isRecord(result.value)) return null;
  const value = result.value;
  return {
    documentId: Number(value.documentId),
    trust: String(value.trust),
    name: String(value.name),
    phase: String(value.phase),
    notice: typeof value.notice === 'string' ? value.notice : null,
    source: typeof value.source === 'string' ? value.source : null,
  };
}

/** 轮询 UI 直到满足条件；到期返回最后一次读到的状态（可能为 null）。 */
async function waitUi(window: SmokeWindow, done: (doc: UiDoc) => boolean, timeoutMs: number): Promise<UiDoc | null> {
  const deadline = Date.now() + timeoutMs;
  let last: UiDoc | null = null;
  while (Date.now() < deadline) {
    last = await readUi(window);
    if (last !== null && done(last)) return last;
    await delay(100);
  }
  return last;
}

/** 点击产品 Toolbar 的 Open 按钮（DOM 级点击，走组件自己的 onClick）。 */
async function clickOpen(window: SmokeWindow): Promise<string> {
  const result = await window.call(`(() => { const b = document.querySelector('[data-open-phase]'); if (b === null || b.disabled) return 'unavailable'; b.click(); return 'clicked'; })()`);
  return result.ok ? String(result.value) : `error: ${result.error}`;
}

const active = (ctx: SmokeContext, window: SmokeWindow): CapabilityView[] => capabilitiesOf(ctx, window.ownerId).filter((c) => c.state === 'active');
const authorized = (ctx: SmokeContext, window: SmokeWindow, token: string | undefined): boolean =>
  token !== undefined && ctx.openIpc.authorize(window.ownerId, token) !== null;

/** 经 UI 打开 path 并等待提交；返回提交后的 UI 状态（未提交返回 null）。 */
async function openViaUi(ctx: SmokeContext, window: SmokeWindow, path: string): Promise<UiDoc | null> {
  const before = await waitUi(window, (doc) => doc.phase === 'idle', 5_000);
  if (before === null) return null;
  ctx.chooser.enqueue({ kind: 'path', path });
  if ((await clickOpen(window)) !== 'clicked') return null;
  return waitUi(window, (doc) => doc.phase === 'idle' && doc.documentId !== before.documentId, 8_000);
}

/** main 中唯一的 active 能力与 renderer 当前会话是同一个文档。 */
function sameDocumentProblems(ctx: SmokeContext, window: SmokeWindow, doc: UiDoc | null, label: string): string[] {
  const problems: string[] = [];
  const records = active(ctx, window);
  expectEqual(problems, `${label}: main active capabilities`, records.length, 1);
  expectEqual(problems, `${label}: main active documentId equals renderer session documentId`, records[0]?.documentId, doc?.documentId);
  expectEqual(problems, `${label}: renderer trust`, doc?.trust, 'trusted');
  return problems;
}

const uiOpenCommit: IsolatedCase = {
  id: 'ui.open-commit',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    const problems: string[] = [];
    const initial = await waitUi(window, () => true, 5_000);
    expectEqual(problems, 'initial demo', initial === null ? null : [initial.documentId, initial.trust, initial.name], [0, 'none', 'demo.jcx']);
    const first = await openViaUi(ctx, window, ctx.fixtures.utf8);
    problems.push(...sameDocumentProblems(ctx, window, first, 'first open'));
    expectEqual(problems, 'displayed file name', first?.name, 'utf8 score.jcx');
    expectEqual(problems, 'read-only source panel shows the exact source', first?.source, UTF8_SOURCE);
    expectEqual(problems, 'no notice after a successful open', first?.notice, null);
    const firstToken = active(ctx, window)[0]?.token;
    const second = await openViaUi(ctx, window, ctx.fixtures.second);
    problems.push(...sameDocumentProblems(ctx, window, second, 'second open'));
    expectTrue(problems, 'previous capability still authorized after the replacement', !authorized(ctx, window, firstToken));
    const surface = await window.call(`({ bridge: Object.keys(window.museDesktop).sort(), require: typeof window.require, process: typeof window.process })`);
    expectEqual(problems, 'bridge surface', surface.ok ? surface.value : surface.error, { bridge: ['activateDocument', 'onMenuCommand', 'openDocument', 'rejectDocument'], require: 'undefined', process: 'undefined' }); // M3 T3b：onMenuCommand（用户授权）
    expectEqual(problems, 'no window-security blocks during normal use', ctx.security.events(window.ownerId), []);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { first: first?.documentId, second: second?.documentId });
  },
};

const uiCancelKeeps: IsolatedCase = {
  id: 'ui.cancel-keeps',
  realDialog: false,
  run: async (ctx) => {
    const { window } = await productionWindow(ctx);
    const opened = await openViaUi(ctx, window, ctx.fixtures.utf8);
    const token = active(ctx, window)[0]?.token;
    ctx.chooser.enqueue({ kind: 'cancel' });
    const clicked = await clickOpen(window);
    await pageCondition(window, `document.querySelector('[data-open-phase]')?.getAttribute('data-open-phase') !== 'idle'`, 2_000);
    const after = await waitUi(window, (doc) => doc.phase === 'idle' && ctx.chooser.calls.length === 2, 5_000);
    const problems: string[] = [];
    expectEqual(problems, 'click', clicked, 'clicked');
    expectEqual(problems, 'session after cancel', after === null ? null : [after.documentId, after.trust, after.notice], [opened?.documentId, 'trusted', null]);
    expectTrue(problems, 'capability lost after cancel', authorized(ctx, window, token));
    problems.push(...sameDocumentProblems(ctx, window, after, 'after cancel'));
    return verdict(problems);
  },
};

const uiDecodeFailureKeeps: IsolatedCase = {
  id: 'ui.decode-failure-keeps',
  realDialog: false,
  run: async (ctx) => {
    const { window } = await productionWindow(ctx);
    const opened = await openViaUi(ctx, window, ctx.fixtures.utf8);
    const token = active(ctx, window)[0]?.token;
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf16 });
    await clickOpen(window);
    const after = await waitUi(window, (doc) => doc.phase === 'idle' && doc.notice === 'open-failed', 8_000);
    const problems: string[] = [];
    expectEqual(problems, 'session after a decode failure', after === null ? null : [after.documentId, after.trust, after.notice], [opened?.documentId, 'trusted', 'open-failed']);
    expectTrue(problems, 'capability lost after a decode failure', authorized(ctx, window, token));
    const text = await window.call(`document.querySelector('.open-notice span')?.textContent ?? ''`);
    expectTrue(problems, 'decode failure notice names UTF-16', text.ok && String(text.value).includes('UTF-16'));
    problems.push(...sameDocumentProblems(ctx, window, after, 'after decode failure'));
    return verdict(problems);
  },
};

const uiReloadIsolation: IsolatedCase = {
  id: 'ui.reload-isolation',
  realDialog: false,
  timeoutMs: 25_000,
  run: async (ctx) => {
    const { window } = await productionWindow(ctx);
    await openViaUi(ctx, window, ctx.fixtures.utf8);
    const control = deferred<string | null>();
    ctx.chooser.enqueue({ kind: 'deferred', control });
    await clickOpen(window);
    await waitUi(window, (doc) => doc.phase === 'requesting', 3_000);
    const loaded = window.nextLoad(10_000);
    window.win.webContents.reload();
    await loaded;
    const problems: string[] = [];
    const fresh = await waitUi(window, () => true, 5_000);
    expectEqual(problems, 'reloaded page starts from demo', fresh === null ? null : [fresh.documentId, fresh.trust], [0, 'none']);
    expectEqual(problems, 'capabilities after reload', capabilitiesOf(ctx, window.ownerId), []);
    // 刷新前的对话框仍未结束：新页面的 Open 收到 busy（不归因提示），不改会话。
    await clickOpen(window);
    const busy = await waitUi(window, (doc) => doc.phase === 'idle' && doc.notice === 'busy', 5_000);
    expectEqual(problems, 'busy while the old dialog is open', busy === null ? null : [busy.notice, busy.documentId, busy.trust], ['busy', 0, 'none']);
    control.resolve(ctx.fixtures.second);
    // 先等旧对话框在 main 中真正 settle，再留出读取与判定的时间；之后无论多晚签发能力，都会被下面「恰好 1 条」的断言抓住。
    expectTrue(problems, 'old chooser settled in main', await waitFor(() => ctx.openIpc.pendingNativeDialogs() === 0, 5_000));
    await delay(500);
    expectEqual(problems, 'old request left no capability', capabilitiesOf(ctx, window.ownerId), []);
    const stale = await readUi(window);
    expectEqual(problems, 'old request did not touch the new page', stale === null ? null : [stale.documentId, stale.trust], [0, 'none']);
    const reopened = await openViaUi(ctx, window, ctx.fixtures.second);
    problems.push(...sameDocumentProblems(ctx, window, reopened, 'open after reload'));
    // 包括 pending 在内的全部能力：只有新页面这一次 Open 的 active 记录。
    expectEqual(problems, 'all capabilities after reopen', capabilitiesOf(ctx, window.ownerId).map((c) => [c.state, c.documentId]), [['active', reopened?.documentId]]);
    return verdict(problems);
  },
};

const uiStaffRender: IsolatedCase = {
  id: 'ui.staff-render',
  realDialog: false,
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    const opened = await openViaUi(ctx, window, ctx.fixtures.staff);
    const rendered = await pageCondition(window, `document.querySelectorAll('.system-layer-staff .vf-stavenote').length === ${String(STAFF_NOTE_COUNT)}`, 10_000);
    await window.call('document.fonts.ready.then(() => true)');
    const facts = await window.call(`({
      notes: document.querySelectorAll('.system-layer-staff .vf-stavenote').length,
      layers: [...new Set([...document.querySelectorAll('.system-layer')].map((el) => [...el.classList].find((c) => c.startsWith('system-layer-')) ?? ''))].sort(),
      bravura: document.fonts.check('30px Bravura'),
    })`);
    const classified = classifyConsole(consoleEntries, []);
    const problems: string[] = [];
    problems.push(...sameDocumentProblems(ctx, window, opened, 'staff open'));
    expectTrue(problems, 'VexFlow staff notes not rendered under the production CSP', rendered);
    expectEqual(problems, 'rendered layers and font', facts.ok ? facts.value : facts.error, { notes: STAFF_NOTE_COUNT, layers: ['system-layer-jianpu', 'system-layer-staff'], bravura: true });
    expectEqual(problems, 'unexpected console errors or CSP refusals', classified.unexpected, []);
    expectEqual(problems, 'no CSP refusal while rendering', classified.expected, []);
    return verdict(problems);
  },
};

const uiActivationHeldRetry: IsolatedCase = {
  id: 'ui.activation-held-retry',
  realDialog: false,
  timeoutMs: 25_000,
  run: async (ctx) => {
    const { window } = await productionWindow(ctx);
    await waitUi(window, () => true, 5_000);
    ctx.faults.holdNextActivations(1);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    await clickOpen(window);
    const problems: string[] = [];
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && ctx.faults.records().length === 0) await delay(20);
    expectTrue(problems, 'activation never reached main', ctx.faults.records().length > 0);
    // main 已激活、应答被扣留：renderer 必须还停在旧会话上。
    const mainActive = active(ctx, window);
    const during = await readUi(window);
    expectEqual(problems, 'main activated the candidate', mainActive.length, 1);
    expectEqual(problems, 'renderer did not commit before an explicit ok', during === null ? null : [during.documentId, during.trust], [0, 'none']);
    expectTrue(problems, 'renderer phase while the reply is held', during !== null && (during.phase === 'activating' || during.phase === 'uncertain'));
    const committed = await waitUi(window, (doc) => doc.documentId !== 0 && doc.phase === 'idle', 12_000);
    problems.push(...sameDocumentProblems(ctx, window, committed, 'after the retry'));
    expectEqual(problems, 'committed the candidate main activated', committed?.documentId, mainActive[0]?.documentId);
    const records = ctx.faults.records();
    expectEqual(problems, 'activation attempts (held, then retried with the same ticket)', records.map((r) => r.held), [true, false]);
    expectEqual(problems, 'same ticket on retry', records[1]?.payload, records[0]?.payload);
    expectEqual(problems, 'retry result', records[1]?.result, { ok: true });
    return verdict(problems, { attempts: records.length });
  },
};

const uiActivationUnresolved: IsolatedCase = {
  id: 'ui.activation-unresolved',
  realDialog: false,
  timeoutMs: 35_000,
  run: async (ctx) => {
    const { window } = await productionWindow(ctx);
    const opened = await openViaUi(ctx, window, ctx.fixtures.utf8);
    const oldToken = active(ctx, window)[0]?.token;
    // 只统计本次 Open 的激活（前置打开 A 的那次激活不计入）。
    ctx.faults.reset();
    ctx.faults.holdNextActivations(3);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
    await clickOpen(window);
    const after = await waitUi(window, (doc) => doc.phase === 'idle' && doc.notice === 'activation-unresolved', 22_000);
    await delay(300);
    const problems: string[] = [];
    expectEqual(problems, 'old session kept and downgraded', after === null ? null : [after.documentId, after.name, after.trust], [opened?.documentId, opened?.name, 'unverified']);
    const records = ctx.faults.records();
    expectEqual(problems, 'three held attempts with the same ticket', [records.length, records.every((r) => r.held), new Set(records.map((r) => JSON.stringify(r.payload))).size], [3, true, 1]);
    // main 的第一次激活已吊销旧能力；renderer 发出的 reject（未扣留）吊销了候选：旧授权确实不可再信任。
    expectTrue(problems, 'old capability is no longer authorized in main', !authorized(ctx, window, oldToken));
    expectEqual(problems, 'no active capability left after the reject', active(ctx, window), []);
    return verdict(problems, { attempts: records.length });
  },
};

const uiWinUnc: IsolatedCase = {
  id: 'ui.win-unc',
  realDialog: false,
  run: async (ctx) => {
    try {
      await stat(ctx.trustedPagePath);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : 'unknown';
      return { status: 'unverified', detail: `UNC production renderer not accessible from Node (stat ${code}); loadUrl=${ctx.entry.loadUrl.slice(0, 40)}` };
    }
    const { window } = await productionWindow(ctx);
    const opened = await openViaUi(ctx, window, ctx.fixtures.utf8);
    const problems = sameDocumentProblems(ctx, window, opened, 'UNC open');
    expectTrue(problems, 'UNC page URL has a host', new URL(window.win.webContents.mainFrame.url).host !== '');
    return verdict(problems);
  },
};

/** 生产 UI 用例：每个占一个独立子进程，runner 以 `ui.` 前缀识别并让该子进程的可信页面指向生产 renderer。 */
export const UI_CASES: readonly IsolatedCase[] = [
  uiOpenCommit,
  uiCancelKeeps,
  uiDecodeFailureKeeps,
  uiReloadIsolation,
  uiStaffRender,
  uiActivationHeldRetry,
  uiActivationUnresolved,
  uiWinUnc,
];
