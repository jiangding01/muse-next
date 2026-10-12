/**
 * F 组：窗口安全（M3 T1c-1，T1c Preflight r2 §17；用户裁决 Q4）。
 *
 * - `security.subframe-control`（matrix，测试页，`off-for-control`）：威胁对照——不挂安全接线时，同源子 frame 能加载可信页面，
 *   并经 `parent.museDesktop` 调用到 main 的 Open（选择器被调用）。它让 `risk.subframe-parent-bridge` 的硬门有因果意义；若 Electron
 *   行为改变使对照失败，必须停下复核，不得删除对照或改判定。
 * - `prod.*`（各自独立子进程）：可信页面是 runner 构建的**真实生产 renderer**（vite 生产构建，含生产 CSP），窗口经生产安全接线。
 *   控制台监听在加载页面之前挂上，捕捉初始化阶段的 CSP 与资源错误；控制台消息分为「本用例预期的策略拒绝」与「非预期错误」。
 * - CSP 是否生效只看**页面内 DOM 插入**的内容有没有执行；`executeJavaScript` 只用来驱动 DOM 操作和读取结果，它是特权注入、
 *   本身绕过 CSP，不作为证据。
 */

import { BrowserWindow } from 'electron';

import { rendererCsp } from '../../../vite.renderer.csp';
import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';
import { capabilitiesOf, classifyConsole, consoleRecorder, expectEqual, expectTrue, invariantProblems, ownerMeta, verdict } from './context';
import type { ConsoleEntry, SmokeCase, SmokeContext } from './context';
import { openActive } from './casesCapability';
import type { IsolatedCase } from './casesIsolated';
import { childFrame, frameCall } from './casesSender';
import { delay } from './harness';
import { describeOpen } from './replies';
import type { PageResult } from './replies';
import type { SmokeWindow } from './windows';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
export const valueOf = (result: PageResult): unknown => (result.ok ? result.value : `error: ${result.error}`);

/** 控制台记录器的正向探针文本（只在 `prod.renderer-loads` 启动判定之后写入）。 */
const CONSOLE_PROBE = 'muse-smoke-console-probe';

/** 在页面中登记 `securitypolicyviolation` 记录（之后的 DOM 操作产生的违规写入 `window.smokeViolations`）。 */
async function installViolationRecorder(window: SmokeWindow): Promise<void> {
  await window.call(`(() => { window.smokeViolations = []; document.addEventListener('securitypolicyviolation', (event) => window.smokeViolations.push(event.effectiveDirective)); return true; })()`);
}

async function violations(window: SmokeWindow): Promise<string[]> {
  const result = await window.call('window.smokeViolations ?? null');
  return result.ok && Array.isArray(result.value) ? result.value.map((item) => String(item)) : [];
}

/** 轮询页面表达式直到为 true（每次调用都有超时）；到期返回 false。 */
export async function pageCondition(window: SmokeWindow, expression: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await window.call(expression, 2_000);
    if (result.ok && result.value === true) return true;
    await delay(100);
  }
  return false;
}

interface FrameFact {
  readonly url: string;
  readonly origin: string;
  /** 子 frame 里是否真的是应用页面（有 `#root`）；被 CSP 拒绝时 Chromium 提交错误页，`url` 仍是被拒地址，内容不是应用页面。 */
  readonly appDocument: boolean | 'unreadable';
}

/** 主 frame 下所有子 frame 的事实（只读：读取 DOM 是否为应用页面，不调用桥）。 */
async function frameFacts(window: SmokeWindow): Promise<FrameFact[]> {
  const facts: FrameFact[] = [];
  for (const frame of window.win.webContents.mainFrame.frames) {
    const probe = await frameCall(frame, `document.getElementById('root') !== null`);
    facts.push({ url: frame.url.startsWith('file:') ? '<file>' : frame.url, origin: frame.origin, appDocument: probe.ok ? probe.value === true : 'unreadable' });
  }
  return facts;
}

/** 生产 renderer 窗口：控制台记录在加载之前挂上。 */
export async function productionWindow(ctx: SmokeContext): Promise<{ readonly window: SmokeWindow; readonly consoleEntries: ConsoleEntry[] }> {
  const recorder = consoleRecorder();
  const window = await ctx.windows.create({ onCreated: recorder.attach });
  return { window, consoleEntries: recorder.entries };
}

const securitySubframeControl: SmokeCase = {
  id: 'security.subframe-control',
  run: async (ctx) => {
    const window = await ctx.windows.create({ security: 'off-for-control', url: `${ctx.entry.loadUrl}#frame` });
    const frame = await childFrame(window, ctx.entry.loadUrl);
    if (frame === null) return verdict(['control: the same-origin child frame did not load without window security (threat premise changed)']);
    ctx.chooser.enqueue({ kind: 'cancel' });
    const own = await frameCall(frame, 'typeof window.museDesktop');
    const parentBridge = await frameCall(frame, 'typeof parent.museDesktop');
    const viaParent = await frameCall(frame, 'parent.museDesktop.openDocument()');
    const problems: string[] = [];
    expectEqual(problems, 'subframe has no bridge of its own (production sandbox)', valueOf(own), 'undefined');
    expectEqual(problems, 'subframe reaches the parent bridge', valueOf(parentBridge), 'object');
    expectEqual(problems, 'Open through the parent bridge reached main', valueOf(viaParent), { kind: 'canceled' });
    expectEqual(problems, 'chooser called through the parent bridge', ctx.chooser.calls.length, 1);
    return verdict(problems, { threat: 'same-origin subframe → parent.museDesktop.openDocument() → main chooser' });
  },
};

const prodRendererLoads: SmokeCase = {
  id: 'prod.renderer-loads',
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    const rendered = await pageCondition(window, `document.querySelectorAll('.score-system').length > 0`, 10_000);
    await window.call('document.fonts.ready.then(() => true)');
    await delay(300);
    const page = await window.call(`(() => {
      const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return {
        csp: meta ? meta.getAttribute('content') : null,
        cspFirstInHead: document.head.firstElementChild === meta,
        cspMetaCount: document.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').length,
        systems: document.querySelectorAll('.score-system').length,
        layers: [...new Set([...document.querySelectorAll('.system-layer')].map((el) => [...el.classList].find((c) => c.startsWith('system-layer-')) ?? ''))].sort(),
        chordDiagrams: document.querySelectorAll('.chord-grid > *').length,
        svgs: document.querySelectorAll('svg').length,
        bridge: Object.keys(window.museDesktop ?? {}).sort(),
        hasRequire: typeof window.require !== 'undefined',
        hasProcess: typeof window.process !== 'undefined',
      };
    })()`);
    const facts = page.ok && isRecord(page.value) ? page.value : {};
    // 启动阶段的控制台快照先判定；之后用一条探针证明记录器确实在收消息、error 级消息会被判为非预期（防止断言空过）。
    const startup = classifyConsole(consoleEntries, []);
    await window.call(`(console.error('${CONSOLE_PROBE}'), true)`);
    await delay(300);
    const probe = classifyConsole(consoleEntries.filter((entry) => entry.message.includes(CONSOLE_PROBE)), []);
    const problems: string[] = [];
    expectTrue(problems, 'console recorder did not classify the error-level probe as unexpected', probe.unexpected.length === 1 && probe.unexpected[0]?.startsWith('error:') === true);
    expectTrue(problems, 'demo score did not render', rendered);
    expectEqual(problems, 'CSP meta content', facts.csp, rendererCsp('production'));
    expectEqual(problems, 'CSP meta is the first element in head', facts.cspFirstInHead, true);
    expectEqual(problems, 'exactly one CSP meta', facts.cspMetaCount, 1);
    expectTrue(problems, 'main frame is the production renderer identity', matchesPageIdentity(window.win.webContents.mainFrame.url, ctx.entry.identity));
    expectEqual(problems, 'demo layers', facts.layers, ['system-layer-jianpu', 'system-layer-tab']);
    expectEqual(problems, 'demo chord diagrams', facts.chordDiagrams, 3);
    expectEqual(problems, 'bridge methods', facts.bridge, ['activateDocument', 'openDocument', 'rejectDocument']);
    expectEqual(problems, 'page main world has no require / process', [facts.hasRequire, facts.hasProcess], [false, false]);
    expectEqual(problems, 'unexpected console errors or CSP refusals during startup', startup.unexpected, []);
    expectEqual(problems, 'no CSP refusal at all on a normal load', startup.expected, []);
    return verdict(problems, { ...facts, startupConsoleEntries: consoleEntries.filter((entry) => !entry.message.includes(CONSOLE_PROBE)).length, consoleProbeSeen: true });
  },
};

const prodPopupDenied: SmokeCase = {
  id: 'prod.popup-denied',
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    const before = BrowserWindow.getAllWindows().length;
    const result = await window.call(`(() => {
      const blank = window.open('about:blank');
      const trusted = window.open(location.href);
      const link = document.createElement('a');
      link.href = location.href;
      link.target = '_blank';
      document.body.appendChild(link);
      link.click();
      link.remove();
      return { blankIsNull: blank === null, trustedIsNull: trusted === null };
    })()`);
    await delay(800);
    const popups = ctx.security.events(window.ownerId).filter((block) => block.kind === 'popup');
    const problems: string[] = [];
    expectEqual(problems, 'window.open returns null', valueOf(result), { blankIsNull: true, trustedIsNull: true });
    expectEqual(problems, 'no new window', BrowserWindow.getAllWindows().length, before);
    expectEqual(problems, 'popup attempts denied by the window-open handler', popups.length, 3);
    expectEqual(problems, 'unexpected console errors', classifyConsole(consoleEntries, []).unexpected, []);
    return verdict(problems, { popupEvents: popups.map((block) => block.event) });
  },
};

const prodSubframeBlocked: SmokeCase = {
  id: 'prod.subframe-blocked',
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    await installViolationRecorder(window);
    const seq = ownerMeta(ctx, window.ownerId)?.latestRequestSeq;
    await window.call(`(() => {
      const trusted = document.createElement('iframe');
      trusted.src = location.href.split('#')[0];
      document.body.appendChild(trusted);
      const srcdoc = document.createElement('iframe');
      srcdoc.srcdoc = '<script>parent.smokeSrcdocRan = true; if (parent.museDesktop) parent.museDesktop.openDocument();<' + '/script>';
      document.body.appendChild(srcdoc);
      return true;
    })()`);
    await delay(1_500);
    const frames = await frameFacts(window);
    const trustedLoaded = frames.some((frame) => frame.appDocument === true);
    const srcdocRan = await window.call('window.smokeSrcdocRan === true');
    const pageViolations = await violations(window);
    const blocks = ctx.security.events(window.ownerId).filter((block) => block.kind === 'subframe-navigation');
    const classified = classifyConsole(consoleEntries, ['frame-src', 'child-src', 'script-src']);
    const layers = {
      cspFrameSrc: pageViolations.some((d) => d === 'frame-src' || d === 'child-src'),
      mainWillFrameNavigate: blocks.some((block) => block.url === ctx.entry.loadUrl),
      srcdocScriptRefused: pageViolations.some((d) => d.startsWith('script-src')) || classified.expected.some((d) => d.startsWith('csp:script-src')),
      srcdocNavigationBlocked: blocks.some((block) => block.url.startsWith('about:srcdoc')),
    };
    const problems: string[] = [];
    expectEqual(problems, 'the app page loaded inside a subframe', trustedLoaded, false);
    expectEqual(problems, 'srcdoc inline script executed', valueOf(srcdocRan), false);
    expectTrue(problems, 'trusted-page subframe was not refused by CSP frame-src or main will-frame-navigate', layers.cspFrameSrc || layers.mainWillFrameNavigate);
    expectTrue(problems, 'srcdoc script was neither refused by CSP nor kept from navigating', layers.srcdocScriptRefused || layers.srcdocNavigationBlocked);
    expectEqual(problems, 'chooser called from a subframe', ctx.chooser.calls.length, 0);
    expectEqual(problems, 'an Open request reached main from a subframe', ownerMeta(ctx, window.ownerId)?.latestRequestSeq, seq);
    expectEqual(problems, 'unexpected console errors', classified.unexpected, []);
    return verdict(problems, { layers, frames, pageViolations, expectedRefusals: classified.expected });
  },
};

const prodInlineScriptBlocked: SmokeCase = {
  id: 'prod.inline-script-blocked',
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    await installViolationRecorder(window);
    await window.call(`(() => {
      const script = document.createElement('script');
      script.textContent = 'window.smokeInlineRan = true;';
      document.body.appendChild(script);
      const button = document.createElement('button');
      button.setAttribute('onclick', 'window.smokeHandlerRan = true;');
      document.body.appendChild(button);
      button.click();
      button.remove();
      return true;
    })()`);
    await delay(500);
    const ran = await window.call('[window.smokeInlineRan === true, window.smokeHandlerRan === true]');
    const pageViolations = await violations(window);
    const classified = classifyConsole(consoleEntries, ['script-src']);
    const problems: string[] = [];
    expectEqual(problems, 'DOM-inserted inline script / inline handler executed', valueOf(ran), [false, false]);
    expectTrue(problems, 'inline <script> refusal not recorded', pageViolations.some((d) => d === 'script-src-elem' || d === 'script-src'));
    expectTrue(problems, 'inline handler refusal not recorded', pageViolations.some((d) => d === 'script-src-attr' || d === 'script-src'));
    expectEqual(problems, 'unexpected console errors', classified.unexpected, []);
    return verdict(problems, { pageViolations, expectedRefusals: classified.expected });
  },
};

interface NavigationRecord {
  readonly target: string;
  readonly urlUnchanged: boolean;
  readonly pageAlive: boolean;
  readonly generationBefore: number | null;
  readonly generationAfter: number | null;
  readonly blockedByPolicy: boolean;
  /** 实际拦下导航的事件（Electron 对主 frame 先发 `will-frame-navigate`，被拦下后不再发 `will-navigate`）。 */
  readonly blockEvent: string | null;
  /** 拦截回调触发时 generation 已前进 ⇔ `did-start-navigation`（经生产接线 resetOwner）先于拦截发生。 */
  readonly didStartBeforeBlock: boolean | null;
  readonly activeCapabilities: number;
  readonly oldTokenAuthorized: boolean;
  /** 导航被拦下、页面存活、但能力已被导航开始时的 resetOwner 吊销（用户裁决 A：接受的 fail-closed 事实）。 */
  readonly silentRevocation: boolean;
}

/** 被安全策略拦下的导航（file / http）必须恰好呈现用户裁决 A 接受的模式；任何偏离都失败并停下复核。 */
function policyBlockedProblems(record: NavigationRecord): string[] {
  const problems: string[] = [];
  const label = record.target;
  expectTrue(problems, `${label}: not blocked by window security`, record.blockedByPolicy);
  expectEqual(problems, `${label}: did-start-navigation (resetOwner) before the block`, record.didStartBeforeBlock, true);
  expectTrue(problems, `${label}: generation did not advance by exactly one`, record.generationBefore !== null && record.generationAfter === record.generationBefore + 1);
  expectEqual(problems, `${label}: active capabilities after the blocked navigation`, record.activeCapabilities, 0);
  expectEqual(problems, `${label}: old token still authorized after resetOwner`, record.oldTokenAuthorized, false);
  return problems;
}

/** Chromium 自己拒绝的导航（顶层 data:）：不经安全策略；要么根本没开始导航（能力不变），要么同样是 fail-closed 的吊销模式。 */
function chromiumRefusedProblems(record: NavigationRecord): string[] {
  const problems: string[] = [];
  const label = record.target;
  expectEqual(problems, `${label}: unexpectedly blocked by window security`, record.blockedByPolicy, false);
  const untouched = record.generationAfter === record.generationBefore && record.oldTokenAuthorized && record.activeCapabilities === 1;
  const revoked = record.generationBefore !== null && record.generationAfter === record.generationBefore + 1 && !record.oldTokenAuthorized && record.activeCapabilities === 0;
  expectTrue(problems, `${label}: capability state is neither untouched nor fail-closed revoked`, untouched || revoked);
  return problems;
}

const prodNavigationBlocked: SmokeCase = {
  id: 'prod.navigation-blocked',
  run: async (ctx) => {
    const { window, consoleEntries } = await productionWindow(ctx);
    // 旁观窗口：被拦截的导航不得影响其它窗口的授权（跨窗口影响即 STOP）。
    const bystander = await ctx.windows.create();
    const bystanderTicket = await openActive(ctx, bystander, ctx.fixtures.second);
    await window.call(`(window.smokeMarker = 'alive', true)`);
    const generation = (): number | null => ownerMeta(ctx, window.ownerId)?.generation ?? null;
    const records: NavigationRecord[] = [];
    const invariants: string[] = [];
    for (const target of [ctx.foreignUrl, 'http://127.0.0.1:9/', 'data:text/html,<p>blocked</p>']) {
      // 每个目标前重新 Open + 激活一个新能力，逐个目标独立记录能力状态。
      const ticket = await openActive(ctx, window, ctx.fixtures.utf8);
      const before = generation();
      const seen = ctx.security.events(window.ownerId).length;
      await window.call(`(location.href = ${JSON.stringify(target)}, true)`, 3_000);
      await delay(1_000);
      // 按新增的导航拦截事件判定（不比较 URL 文本：Chromium 可能规范化 data: 等 URL）。
      const block = ctx.security.events(window.ownerId).slice(seen).find((item) => item.kind === 'navigation');
      const alive = await window.call('window.smokeMarker');
      records.push({
        target: target === ctx.foreignUrl ? '<foreign file page>' : target,
        urlUnchanged: window.win.webContents.mainFrame.url === ctx.entry.loadUrl,
        pageAlive: valueOf(alive) === 'alive',
        generationBefore: before,
        generationAfter: generation(),
        blockedByPolicy: block !== undefined,
        blockEvent: block?.event ?? null,
        didStartBeforeBlock: block === undefined || before === null || block.generationAtBlock === null ? null : block.generationAtBlock > before,
        activeCapabilities: capabilitiesOf(ctx, window.ownerId).filter((c) => c.state === 'active').length,
        oldTokenAuthorized: ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) !== null,
        silentRevocation: generation() !== before && valueOf(alive) === 'alive',
      });
      invariants.push(...invariantProblems(ctx));
    }
    ctx.chooser.enqueue({ kind: 'cancel' });
    const reopen = describeOpen(await window.open());
    const classified = classifyConsole(consoleEntries, [], [/Not allowed to navigate top frame to data URL/i]);
    const problems: string[] = [];
    for (const record of records) {
      expectTrue(problems, `${record.target}: main frame URL changed`, record.urlUnchanged);
      expectTrue(problems, `${record.target}: page did not survive`, record.pageAlive);
    }
    const [foreign, http, data] = records;
    if (foreign === undefined || http === undefined || data === undefined) problems.push('navigation records missing');
    else problems.push(...policyBlockedProblems(foreign), ...policyBlockedProblems(http), ...chromiumRefusedProblems(data));
    expectEqual(problems, 'coordinator invariants after each blocked navigation', invariants, []);
    expectTrue(problems, 'blocked navigation affected another window (bystander token lost)', ctx.openIpc.authorize(bystander.ownerId, bystanderTicket.capabilityId) !== null);
    expectEqual(problems, 'page can still Open after blocked navigations', reopen, 'canceled');
    expectEqual(problems, 'unexpected console errors', classified.unexpected, []);
    // 硬门判 PASS 的同时单独标记 ACCEPTED RISK：旧授权被提前吊销，不是「旧能力保持不变」。
    const acceptedRisk = records.some((record) => record.silentRevocation)
      ? 'ACCEPTED RISK (user decision A): blocked page-initiated navigation revokes the window capabilities at did-start-navigation; the page stays alive without any signal'
      : null;
    return verdict(problems, { acceptedRisk, records, bystanderAuthorized: true, expectedRefusals: classified.expected });
  },
};

/** matrix 子进程中的安全用例（测试页）。 */
export const SECURITY_MATRIX_CASES: readonly SmokeCase[] = [securitySubframeControl];

/** 真实生产 renderer 用例：每个占一个独立子进程，runner 以 `prod.` 前缀识别并让该子进程的可信页面指向生产 renderer。 */
export const PRODUCTION_CASES: readonly IsolatedCase[] = [prodRendererLoads, prodPopupDenied, prodSubframeBlocked, prodInlineScriptBlocked, prodNavigationBlocked].map(
  (item) => ({ ...item, realDialog: false }),
);
