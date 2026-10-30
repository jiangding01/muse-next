/**
 * G 组：生产 UI 的真实 Open（M3 T1c-2，T1c Preflight r2 §16.2 第 ⑦ 项；各占一个独立子进程，以 `ui.` 前缀运行在真实生产 renderer 上）。
 *
 * 每个用例都从产品 UI 入口出发：点击 Toolbar 的 Open 按钮 → 生产 preload → main 的新 IPC → renderer 准备候选 → 激活 → commitSession
 * → UI。页面状态只从 DOM 读取（文件状态区的 `data-document-id` / `data-capability-trust`、Open 按钮的 `data-open-phase`、提示条、
 * 只读源码面板），main 状态只从生产 handle 的诊断出口读取。激活应答扣留只经 smoke 的 `ipcFaults`（产品没有测试通道）。
 * M3 T4 B3a-1：reject 应答故障（`hold` 执行但扣留应答 / `swallow` 不执行）同样只经 `ipcFaults`，只在本文件布置。
 */

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { Menu } from 'electron';
import type { BrowserWindow } from 'electron';

import { MENU_ITEM_IDS } from '../../../src/main/menu/appMenu';
import type { MenuCommand } from '../../../src/shared/menuContracts';

import { capabilitiesOf, classifyConsole, expectEqual, expectTrue, STAFF_NOTE_COUNT, UTF8_SOURCE, verdict } from './context';
import type { CapabilityView, SmokeContext } from './context';
import type { IsolatedCase } from './casesIsolated';
import { pageCondition, productionWindow } from './casesSecurity';
import { deferred, delay, waitFor } from './harness';
import { isRecord } from './replies';
import type { RejectFault } from './ipcFaults';
import { diskFacts, saveDir, scoreFile } from './casesSave';
import { editorWindow, focusSource, pressKey, readEditor, waitEditor, waitPage } from './casesEditingInput';
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
    expectEqual(problems, 'bridge surface', surface.ok ? surface.value : surface.error, { bridge: ['activateDocument', 'onMenuCommand', 'openDocument', 'rejectDocument', 'requestSaveTarget', 'saveDocument'], require: 'undefined', process: 'undefined' }); // M3 T3b：onMenuCommand（用户授权）
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

/** 编辑器状态栏上的提示（产品数据属性 `data-editor-notice`）。 */
async function editorNotice(window: SmokeWindow): Promise<string | null> {
  const result = await window.call(`(() => document.querySelector('.editor-status')?.getAttribute('data-editor-notice') ?? null)()`, 2_000);
  return result.ok && typeof result.value === 'string' && result.value !== '' ? result.value : null;
}

async function waitNotice(window: SmokeWindow, kind: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await editorNotice(window)) === kind) return true;
    await delay(100);
  }
  return false;
}

/**
 * M3 T4 B3a-1（只覆盖 **Open 部分**；Save / Save As 部分属 B3a-2，不在此验收）：激活应答三次全部丢失 → 事务不确定，
 * renderer 经产品账本发 reject，reject 按 `fault` 丢失 → 下一次 Open 被送达门拒绝（不弹对话框、不调用选择器）→ 故障解除后
 * 送达门重发 reject、送达，Open 进入对话框并正常提交。
 * - `swallow`：main 未处理 reject，候选 Y 仍是 active（T-H7-7 Open 部分）。
 * - `hold`：main 已处理 reject（候选已吊销），但 renderer 收不到确认，仍必须拒绝（T-H7-8 Open 部分，M65）。
 */
async function openWithLostReject(ctx: SmokeContext, fault: Exclude<RejectFault, 'none'>): Promise<{ problems: string[]; detail: Record<string, unknown> }> {
  const { window } = await productionWindow(ctx);
  const problems: string[] = [];
  const opened = await openViaUi(ctx, window, ctx.fixtures.utf8);
  expectTrue(problems, 'X opened', opened !== null);
  ctx.faults.reset();
  ctx.faults.holdNextActivations(3);
  ctx.faults.setRejectFault(fault);
  ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
  await clickOpen(window);
  const unresolved = await waitUi(window, (doc) => doc.phase === 'idle' && doc.notice === 'activation-unresolved', 22_000);
  expectEqual(problems, 'unresolved: old session kept', unresolved === null ? null : [unresolved.documentId, unresolved.trust], [opened?.documentId, 'unverified']);
  const lost = [...ctx.faults.rejectRecords()];
  expectTrue(problems, `${fault}: the renderer sent the reject`, lost.length > 0);
  expectEqual(problems, `${fault}: every reject so far hit the fault`, lost.map((r) => [r.fault, r.executed]), lost.map(() => [fault, fault === 'hold']));
  // swallow：main 未处理 reject，候选仍 active；hold：main 已处理，候选已吊销（两种模式可区分）。
  expectEqual(problems, `${fault}: main active capabilities after the lost reject`, active(ctx, window).length, fault === 'swallow' ? 1 : 0);

  // 等首次 reject 尝试超时（产品账本单次 5 s）：之后的送达门必须在故障下重发，而不是复用进行中的尝试（R-3）。
  await delay(6_000);
  // 送达门：下一次 Open 不进入对话框（不调用选择器、无原生对话框），给出未送达提示，会话不变。
  const chooserCalls = ctx.chooser.calls.length;
  expectEqual(problems, 'refused Open: click', await clickOpen(window), 'clicked');
  expectTrue(problems, 'refused Open: reject-pending notice', await waitNotice(window, 'open-refused-reject-pending', 15_000));
  expectEqual(problems, 'refused Open: chooser not called', ctx.chooser.calls.length, chooserCalls);
  expectEqual(problems, 'refused Open: no native dialog', ctx.openIpc.pendingNativeDialogs(), 0);
  const refused = await readUi(window);
  expectEqual(problems, 'refused Open: session unchanged', refused === null ? null : [refused.documentId, refused.phase], [opened?.documentId, 'idle']);
  const resent = ctx.faults.rejectRecords().length;
  const gateResent = ctx.faults.rejectRecords().slice(lost.length);
  expectTrue(problems, 'refused Open: the gate re-sent the reject under the fault', gateResent.length > 0 && gateResent.every((r) => r.fault === fault && r.executed === (fault === 'hold')));
  expectEqual(problems, `${fault}: main state unchanged by the refused Open`, active(ctx, window).length, fault === 'swallow' ? 1 : 0);

  // 恢复：故障解除 → 送达门重发并送达（main 的 reject 幂等）→ Open 进入对话框并提交。
  ctx.faults.setRejectFault('none');
  const reopened = await openViaUi(ctx, window, ctx.fixtures.utf8);
  const delivered = ctx.faults.rejectRecords().slice(resent);
  expectTrue(problems, 'recovery: reject delivered without fault', delivered.length > 0 && delivered.every((r) => r.fault === 'none' && r.executed));
  expectEqual(problems, 'recovery: chooser called once', ctx.chooser.calls.length, chooserCalls + 1);
  problems.push(...sameDocumentProblems(ctx, window, reopened, 'recovery'));
  return { problems, detail: { fault, lostRejects: lost.length, resentRejects: resent - lost.length, deliveredRejects: delivered.length } };
}

const uiOpenActivationLostLedger: IsolatedCase = {
  id: 'ui.open-activation-lost-ledger',
  realDialog: false,
  timeoutMs: 60_000,
  run: async (ctx) => {
    const { problems, detail } = await openWithLostReject(ctx, 'swallow');
    return verdict(problems, detail);
  },
};

const uiOpenRejectGate: IsolatedCase = {
  id: 'ui.open-reject-gate',
  realDialog: false,
  timeoutMs: 60_000,
  run: async (ctx) => {
    const { problems, detail } = await openWithLostReject(ctx, 'hold');
    return verdict(problems, detail);
  },
};


// ———— M3 T4 B3a-2：生产 renderer 的保存用例（菜单 Save / Save As → 生产 preload → main 两阶段保存 IPC → 激活 → store）。
// 页面状态只从 DOM 读取（状态栏、文件状态区、保存诊断区的产品数据属性），磁盘事实只在本次运行的隔离目录中读取。

export interface SaveUiDoc {
  readonly message: string | null;
  /** 失败提示的错误码（`data-save-code`）。 */
  readonly code: string | null;
  readonly documentId: number;
  readonly trust: string;
  readonly name: string;
}

const READ_SAVE = `(() => {
  const status = document.querySelector('.file-status');
  if (status === null) return null;
  const diag = document.querySelector('.save-diagnostics');
  return {
    message: diag === null ? null : diag.getAttribute('data-save-message'),
    code: diag === null ? null : diag.getAttribute('data-save-code'),
    documentId: Number(status.getAttribute('data-document-id')),
    trust: status.getAttribute('data-capability-trust'),
    name: status.querySelector('span')?.textContent ?? '',
  };
})()`;

export async function readSave(window: SmokeWindow): Promise<SaveUiDoc | null> {
  const result = await window.call(READ_SAVE, 2_000);
  if (!result.ok || !isRecord(result.value)) return null;
  const v = result.value;
  return { message: typeof v.message === 'string' ? v.message : null, code: typeof v.code === 'string' ? v.code : null, documentId: Number(v.documentId), trust: String(v.trust), name: String(v.name) };
}

/** 等保存诊断区出现某种提示；超时返回最后一次读取（调用方断言随之失败）。 */
export async function waitSave(window: SmokeWindow, kind: string, timeoutMs: number): Promise<SaveUiDoc | null> {
  const deadline = Date.now() + timeoutMs;
  let last: SaveUiDoc | null = null;
  while (Date.now() < deadline) {
    last = await readSave(window);
    if (last?.message === kind) return last;
    await delay(100);
  }
  return last;
}

/** 清空保存诊断区（点击产品的「知道了」）。 */
export async function dismissSave(window: SmokeWindow): Promise<void> {
  await window.call(`(() => { document.querySelector('.save-diagnostics button')?.click(); return true; })()`);
  await delay(100);
}

/** 点击产品菜单项（菜单点击路径，不是加速键）。 */
export function clickMenu(command: MenuCommand, win: BrowserWindow): boolean {
  const item = Menu.getApplicationMenu()?.getMenuItemById(MENU_ITEM_IDS[command]) ?? null;
  if (item === null) return false;
  const click = item.click as unknown as (event: unknown, focusedWindow?: BrowserWindow, focusedWebContents?: Electron.WebContents) => void;
  click({ triggeredByAccelerator: false }, win, win.webContents);
  return true;
}

/** 在源码末尾输入文本（产品输入路径：聚焦源码面板后 insertText）。 */
export async function typeAtEnd(window: SmokeWindow, text: string): Promise<boolean> {
  const doc = await readEditor(window);
  if (doc === null || !(await focusSource(window, doc.value.length))) return false;
  await window.win.webContents.insertText(text);
  return (await waitEditor(window, (next) => next.sourceVersion > doc.sourceVersion && next.value.endsWith(text))) !== null;
}

/** 经菜单 Open 打开 path 并等待文档号改变。 */
export async function openViaMenu(ctx: SmokeContext, window: SmokeWindow, path: string): Promise<SaveUiDoc | null> {
  const before = await readSave(window);
  ctx.chooser.enqueue({ kind: 'path', path });
  if (!clickMenu('open', window.win)) return null;
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const doc = await readSave(window);
    if (doc !== null && before !== null && doc.documentId !== before.documentId && doc.trust === 'trusted') return doc;
    await delay(100);
  }
  return null;
}

/** 可编辑的生产窗口 + 打开隔离目录中的一份文件 X。 */
export async function editableFile(ctx: SmokeContext, name = 'x.jcx') {
  const { window, ready } = await editorWindow(ctx, true);
  const dir = await saveDir(ctx);
  const path = await scoreFile(dir, name);
  const opened = await openViaMenu(ctx, window, path);
  return { window, dir, path, ready: ready && opened !== null, opened };
}

const PRIMARY: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';

/** M27：一次 Cmd/Ctrl+S 只派发一次、只写一次。S 键不经 before-input-event 派发；加速键兜底只派发一次。 */
const uiSaveMenuOnce: IsolatedCase = {
  id: 'ui.save-menu-once',
  realDialog: false,
  timeoutMs: 30_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await editableFile(ctx);
    expectTrue(problems, 'editable window with X opened', x.ready);
    expectTrue(problems, 'typed', await typeAtEnd(x.window, 'a'));
    const before = ctx.menuCommands.all().length;
    // 合成的 Cmd/Ctrl+S 经过 before-input-event：不得被拦截派发（S 只走菜单加速键）。
    pressKey(x.window, 'S', [PRIMARY]);
    await delay(400);
    expectEqual(problems, 'S keyDown is not intercepted', ctx.menuCommands.all().slice(before).map((r) => r.message.command), []);
    // 菜单加速键兜底（生产路由）：一次。
    expectEqual(problems, 'accelerator routed', ctx.editorCommands.handleMenuCommand('save', x.window.win, { triggeredByAccelerator: true }), 'dispatched');
    const saved = await waitSave(x.window, 'saved', 8_000);
    expectEqual(problems, 'saved', saved?.message, 'saved');
    await delay(500);
    const sends = ctx.menuCommands.all().slice(before).map((r) => `${r.message.command}:${r.message.source}`);
    expectEqual(problems, 'exactly one save dispatch', sends, ['save:menu-accelerator']);
    const doc = await readEditor(x.window);
    expectEqual(problems, 'clean after save', doc?.dirty, false);
    expectEqual(problems, 'disk equals the saved source', await readFile(x.path, 'utf8'), doc?.value);
    expectEqual(problems, 'still saved (no second save / busy)', (await readSave(x.window))?.message, 'saved');
    return verdict(problems);
  },
};

/** M18：保存进行中继续输入 → 检查点取捕获值，完成后仍 dirty；磁盘内容是捕获值。 */
const uiSaveWhileTyping: IsolatedCase = {
  id: 'ui.save-while-typing',
  realDialog: false,
  timeoutMs: 30_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await editableFile(ctx);
    expectTrue(problems, 'editable window with X opened', x.ready);
    expectTrue(problems, 'typed a', await typeAtEnd(x.window, 'a'));
    const captured = (await readEditor(x.window))?.value ?? '';
    const gate = ctx.writeGate.holdNext('openExclusive');
    expectTrue(problems, 'save menu clicked', clickMenu('save', x.window.win));
    await gate.reached;
    expectTrue(problems, 'typed b while saving', await typeAtEnd(x.window, 'b'));
    gate.release();
    const saved = await waitSave(x.window, 'saved', 8_000);
    expectEqual(problems, 'saved', saved?.message, 'saved');
    const doc = await readEditor(x.window);
    expectEqual(problems, 'disk holds the captured source', await readFile(x.path, 'utf8'), captured);
    expectEqual(problems, 'still dirty after save (M18)', doc?.dirty, true);
    expectTrue(problems, 'renderer kept the later input', doc?.value.endsWith('ab') === true);
    return verdict(problems);
  },
};

/** demo → Save As → 激活 → 文件状态切换为新文件（trusted）、clean；磁盘内容为 source。 */
const uiSaveAsCommit: IsolatedCase = {
  id: 'ui.save-as-commit',
  realDialog: false,
  timeoutMs: 30_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const { window, ready } = await editorWindow(ctx, true);
    expectTrue(problems, 'editable window', ready);
    const demo = await readSave(window);
    expectEqual(problems, 'demo session', demo === null ? null : [demo.trust], ['none']);
    expectTrue(problems, 'typed', await typeAtEnd(window, 'z'));
    const dir = await saveDir(ctx);
    const target = join(dir, 'new.jcx');
    ctx.saveChooser.enqueue({ kind: 'path', path: target });
    expectTrue(problems, 'save as clicked', clickMenu('saveAs', window.win));
    const saved = await waitSave(window, 'saved-as', 15_000);
    expectEqual(problems, 'saved-as', saved?.message, 'saved-as');
    expectEqual(problems, 'switched to the new file', saved === null ? null : [saved.documentId, saved.trust, saved.name], [demo?.documentId, 'trusted', 'new.jcx']);
    const doc = await readEditor(window);
    expectEqual(problems, 'clean after save as', doc?.dirty, false);
    expectEqual(problems, 'disk equals the source', await readFile(target, 'utf8'), doc?.value);
    expectEqual(problems, 'save dialog used once', ctx.saveChooser.calls.length, 1);
    // 再按一次 Save：已有文件 → 普通 Save；clean → 短路（R7），不再弹对话框。
    expectTrue(problems, 'save clicked', clickMenu('save', window.win));
    expectEqual(problems, 'R7 after save as', (await waitSave(window, 'nothing-to-save', 5_000))?.message, 'nothing-to-save');
    expectEqual(problems, 'no second dialog', ctx.saveChooser.calls.length, 1);
    return verdict(problems, { sha256: (await diskFacts(target)).sha256.slice(0, 12) });
  },
};

/**
 * M3 T4 B3a-2，T-H7-2（端到端，保存部分）：demo Save As 写入 X 后激活应答三次全部丢失，renderer 经账本发 reject 也被吞没
 * （main 未处理，候选 X 仍 active）→ 下一次 Save As 被送达门拒绝：不弹对话框、X 的字节与身份不变 → 故障解除后送达门重发 reject、
 * 送达，Save As 选 X 进入对话框并切换（X 已存在，走已存在目标管线）。
 */
const uiSaveAsActivationLost: IsolatedCase = {
  id: 'ui.save-as-activation-lost',
  realDialog: false,
  timeoutMs: 75_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const { window, ready } = await editorWindow(ctx, true);
    expectTrue(problems, 'editable window', ready);
    expectTrue(problems, 'typed', await typeAtEnd(window, 'z'));
    const x = `${await saveDir(ctx)}/x.jcx`;
    ctx.faults.reset();
    ctx.faults.holdNextActivations(3);
    ctx.faults.setRejectFault('swallow');
    ctx.saveChooser.enqueue({ kind: 'path', path: x });
    expectTrue(problems, 'save as clicked', clickMenu('saveAs', window.win));
    const lost = await waitSave(window, 'save-as-not-switched', 25_000);
    expectEqual(problems, 'not switched: demo kept (H-5: trust none)', lost === null ? null : [lost.message, lost.trust], ['save-as-not-switched', 'none']);
    expectEqual(problems, 'reject swallowed: main kept the candidate active', active(ctx, window).length, 1);
    const xFacts = await diskFacts(x);
    await dismissSave(window);
    await delay(6_000);
    const dialogs = ctx.saveChooser.calls.length;
    expectTrue(problems, 'save as clicked again', clickMenu('saveAs', window.win));
    expectEqual(problems, 'gate refused the second Save As', (await waitSave(window, 'reject-pending', 15_000))?.message, 'reject-pending');
    expectEqual(problems, 'no save dialog', ctx.saveChooser.calls.length, dialogs);
    expectEqual(problems, 'X untouched', await diskFacts(x), xFacts);
    const records = ctx.faults.rejectRecords();
    expectTrue(problems, 'gate re-sent the reject under the fault', records.length >= 2 && records.every((r) => r.fault === 'swallow' && !r.executed));
    // 恢复：送达门重发并送达 → Save As 选 X → 切换。
    ctx.faults.setRejectFault('none');
    await dismissSave(window);
    ctx.saveChooser.enqueue({ kind: 'path', path: x });
    expectTrue(problems, 'save as clicked to recover', clickMenu('saveAs', window.win));
    const switched = await waitSave(window, 'saved-as', 20_000);
    expectEqual(problems, 'recovered: switched to X', switched === null ? null : [switched.message, switched.trust, switched.name], ['saved-as', 'trusted', 'x.jcx']);
    expectTrue(problems, 'reject delivered on recovery', ctx.faults.rejectRecords().some((r) => r.fault === 'none' && r.executed));
    return verdict(problems, { rejects: ctx.faults.rejectRecords().length });
  },
};

/**
 * M3 T4 B3a-2，T-H7-8（M65）与 T-H7-7（保存部分）：已打开 X，Open Y 的激活应答三次丢失 → reject 已由 main 处理但应答被扣留（hold）。
 * 之后 Save 与 Save As 都被送达门拒绝：不弹对话框、不写盘。故障解除后：普通 Save 经送达门送达 reject 后由 main 拒绝
 * （X 的能力已不再授权：capability-invalid），Save As 到新文件成功。
 */
const uiSaveRejectGate: IsolatedCase = {
  id: 'ui.save-reject-gate',
  realDialog: false,
  timeoutMs: 75_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await editableFile(ctx);
    expectTrue(problems, 'X opened in an editable window', x.ready);
    ctx.faults.reset();
    ctx.faults.holdNextActivations(3);
    ctx.faults.setRejectFault('hold');
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
    expectTrue(problems, 'open clicked', clickMenu('open', x.window.win));
    const unresolved = await waitUi(x.window, (doc) => doc.phase === 'idle' && doc.notice === 'activation-unresolved', 25_000);
    expectEqual(problems, 'open unresolved: X kept and downgraded', unresolved === null ? null : [unresolved.name, unresolved.trust], [x.opened?.name, 'unverified']);
    expectTrue(problems, 'typed', await typeAtEnd(x.window, 'q'));
    const xFacts = await diskFacts(x.path);
    await delay(6_000);
    const dialogs = ctx.saveChooser.calls.length;
    for (const command of ['save', 'saveAs'] as const) {
      await dismissSave(x.window);
      expectTrue(problems, `${command} clicked`, clickMenu(command, x.window.win));
      expectEqual(problems, `${command}: gate refused`, (await waitSave(x.window, 'reject-pending', 15_000))?.message, 'reject-pending');
    }
    expectEqual(problems, 'no save dialog', ctx.saveChooser.calls.length, dialogs);
    expectEqual(problems, 'X untouched', await diskFacts(x.path), xFacts);
    expectTrue(problems, 'held rejects were executed by main', ctx.faults.rejectRecords().every((r) => r.fault === 'hold' && r.executed));
    // 恢复：Save → 送达门送达 → main 拒绝（X 的能力已不再授权）；Save As 到新文件成功。
    ctx.faults.setRejectFault('none');
    await dismissSave(x.window);
    expectTrue(problems, 'save clicked to recover', clickMenu('save', x.window.win));
    const refused = await waitSave(x.window, 'failed', 15_000);
    expectEqual(problems, 'T-H7-7: plain Save refused by main', refused === null ? null : [refused.message, refused.code], ['failed', 'capability-invalid']);
    expectEqual(problems, 'X still untouched', await diskFacts(x.path), xFacts);
    await dismissSave(x.window);
    const target = `${x.dir}/recovered.jcx`;
    ctx.saveChooser.enqueue({ kind: 'path', path: target });
    expectTrue(problems, 'save as clicked to recover', clickMenu('saveAs', x.window.win));
    const switched = await waitSave(x.window, 'saved-as', 20_000);
    expectEqual(problems, 'recovered by Save As', switched === null ? null : [switched.message, switched.trust, switched.name], ['saved-as', 'trusted', 'recovered.jcx']);
    expectEqual(problems, 'final save message readable', (await readSave(x.window))?.message, 'saved-as');
    return verdict(problems, { rejects: ctx.faults.rejectRecords().length });
  },
};

// ———— M3 T4 B3b：替换守卫（dirty 的 Open 询问保存 / 不保存 / 取消；三分支各一个独立子进程）。

const guardPhase = (phase: 'asking' | 'saving'): string => `document.querySelector('.replacement-guard')?.getAttribute('data-guard-phase') === '${phase}'`;

async function chooseGuard(window: SmokeWindow, choice: 'save' | 'discard' | 'cancel'): Promise<boolean> {
  const result = await window.call(`(() => { const b = document.querySelector('[data-guard-choice="${choice}"]'); if (b === null || b.disabled) return false; b.click(); return true; })()`);
  return result.ok && result.value === true;
}

/** 已打开 X、输入使其 dirty，经菜单 Open 弹出守卫询问（不调用选择器）。 */
async function dirtyOpenAsks(ctx: SmokeContext, problems: string[]) {
  const x = await editableFile(ctx);
  expectTrue(problems, 'X opened in an editable window', x.ready);
  expectTrue(problems, 'typed', await typeAtEnd(x.window, 'g'));
  const typed = (await readEditor(x.window))?.value ?? '';
  const xFacts = await diskFacts(x.path);
  const chooserCalls = ctx.chooser.calls.length;
  expectTrue(problems, 'open clicked', clickMenu('open', x.window.win));
  expectTrue(problems, 'guard asks', await waitPage(x.window, guardPhase('asking'), 5_000));
  expectEqual(problems, 'no chooser while asking', ctx.chooser.calls.length, chooserCalls);
  return { ...x, typed, xFacts, chooserCalls };
}

const uiGuardOpenSave: IsolatedCase = {
  id: 'ui.guard-open-save',
  realDialog: false,
  timeoutMs: 40_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await dirtyOpenAsks(ctx, problems);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
    expectTrue(problems, 'save chosen', await chooseGuard(x.window, 'save'));
    // 先保存（复用 Open 的租约），保存成功且 clean 之后才进入 Open 的对话框并替换。
    const replaced = await waitUi(x.window, (doc) => doc.phase === 'idle' && doc.documentId !== x.opened?.documentId && doc.trust === 'trusted', 15_000);
    expectTrue(problems, 'replaced by the chosen file after saving', replaced !== null && replaced.documentId !== x.opened?.documentId);
    expectEqual(problems, 'X on disk holds the typed source', await readFile(x.path, 'utf8'), x.typed);
    expectEqual(problems, 'chooser called once (after the save)', ctx.chooser.calls.length, x.chooserCalls + 1);
    expectTrue(problems, 'guard closed', await waitPage(x.window, `document.querySelector('.replacement-guard') === null`, 3_000));
    problems.push(...sameDocumentProblems(ctx, x.window, replaced, 'after guard save'));
    return verdict(problems);
  },
};

const uiGuardOpenDiscard: IsolatedCase = {
  id: 'ui.guard-open-discard',
  realDialog: false,
  timeoutMs: 40_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await dirtyOpenAsks(ctx, problems);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.second });
    expectTrue(problems, 'discard chosen', await chooseGuard(x.window, 'discard'));
    const replaced = await waitUi(x.window, (doc) => doc.phase === 'idle' && doc.documentId !== x.opened?.documentId && doc.trust === 'trusted', 15_000);
    expectTrue(problems, 'replaced without saving', replaced !== null && replaced.documentId !== x.opened?.documentId);
    expectEqual(problems, 'X untouched on disk', await diskFacts(x.path), x.xFacts);
    expectEqual(problems, 'no save dialog', ctx.saveChooser.calls.length, 0);
    problems.push(...sameDocumentProblems(ctx, x.window, replaced, 'after guard discard'));
    return verdict(problems);
  },
};

const uiGuardOpenCancel: IsolatedCase = {
  id: 'ui.guard-open-cancel',
  realDialog: false,
  timeoutMs: 30_000,
  run: async (ctx) => {
    const problems: string[] = [];
    const x = await dirtyOpenAsks(ctx, problems);
    expectTrue(problems, 'cancel chosen', await chooseGuard(x.window, 'cancel'));
    expectTrue(problems, 'guard closed', await waitPage(x.window, `document.querySelector('.replacement-guard') === null`, 3_000));
    const kept = await readUi(x.window);
    expectEqual(problems, 'document kept', kept === null ? null : [kept.documentId, kept.phase], [x.opened?.documentId, 'idle']);
    expectEqual(problems, 'still dirty', (await readEditor(x.window))?.dirty, true);
    expectEqual(problems, 'chooser not called', ctx.chooser.calls.length, x.chooserCalls);
    expectEqual(problems, 'X untouched on disk', await diskFacts(x.path), x.xFacts);
    // 取消后租约已释放：再次 Open 仍会询问。
    expectTrue(problems, 'open clicked again', clickMenu('open', x.window.win));
    expectTrue(problems, 'guard asks again', await waitPage(x.window, guardPhase('asking'), 5_000));
    expectTrue(problems, 'cancel again', await chooseGuard(x.window, 'cancel'));
    return verdict(problems);
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
  // M3 T4 B3a-1：R20 送达门的 Open 部分（Save / Save As 部分在 B3a-2 另立用例）。
  uiOpenActivationLostLedger,
  uiOpenRejectGate,
  // M3 T4 B3a-2：保存流程（菜单、M18、Save As 切换）与 R20 送达门的保存部分（H-7）。
  uiSaveMenuOnce,
  uiSaveWhileTyping,
  uiSaveAsCommit,
  uiSaveAsActivationLost,
  uiSaveRejectGate,
  // M3 T4 B3b：替换守卫三分支。
  uiGuardOpenSave,
  uiGuardOpenDiscard,
  uiGuardOpenCancel,
];
