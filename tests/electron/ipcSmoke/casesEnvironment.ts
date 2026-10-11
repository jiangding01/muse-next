/**
 * A / B 组：运行环境、桥接面与页面身份（M3 T1b-2b-1）。
 */

import { matchesPageIdentity } from '../../../src/main/open/ipcValidation';
import { capabilitiesOf, expectEqual, expectTrue, verdict } from './context';
import type { SmokeCase, SmokeContext } from './context';
import { runtimeEvidence, sandboxEvidence, sandboxProblems } from './evidence';
import { delay } from './harness';
import { describeOpen, isRecord } from './replies';

const envRuntime: SmokeCase = {
  id: 'env.runtime',
  run: () => {
    const runtime = runtimeEvidence();
    const problems: string[] = [];
    expectTrue(problems, 'process.versions.electron missing', runtime.electron !== '');
    expectTrue(problems, 'process.versions.chrome missing', runtime.chrome !== '');
    expectTrue(problems, 'ELECTRON_RUN_AS_NODE is set (not a real Electron app process)', !runtime.runAsNode);
    expectTrue(problems, 'process.type is not browser', process.type === 'browser');
    return Promise.resolve(verdict(problems, { ...runtime }));
  },
};

const envSandbox: SmokeCase = {
  id: 'env.sandbox',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const evidence = await sandboxEvidence(window);
    return verdict(sandboxProblems(evidence), { ...evidence });
  },
};

/** 只保留 URL 最后两段（不在日志中输出本机临时目录的绝对路径）。 */
const tail = (url: string): string => url.split('/').slice(-2).join('/');

const API_METHODS = ['activateDocument', 'openDocument', 'openScore', 'rejectDocument'];

const bridgeSurface: SmokeCase = {
  id: 'bridge.surface',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const result = await window.call(
      `({ keys: Object.keys(window.museDesktop).sort(), types: Object.values(window.museDesktop).map((v) => typeof v), require: typeof require, process: typeof process, ipc: typeof window.ipcRenderer, electron: typeof window.electron })`,
    );
    const problems: string[] = [];
    if (!result.ok || !isRecord(result.value)) return verdict([`page call failed: ${result.ok ? 'malformed' : result.error}`]);
    const value = result.value;
    expectEqual(problems, 'museDesktop keys', value.keys, API_METHODS);
    expectEqual(problems, 'method types', value.types, ['function', 'function', 'function', 'function']);
    expectEqual(problems, 'typeof require', value.require, 'undefined');
    expectEqual(problems, 'typeof process', value.process, 'undefined');
    expectEqual(problems, 'typeof ipcRenderer', value.ipc, 'undefined');
    expectEqual(problems, 'typeof electron', value.electron, 'undefined');
    return verdict(problems);
  },
};

/** 不经页面 activate：候选永远只是 pending，不授权；main 与 preload 都不自动确认。 */
const bridgeNoAutoActivate: SmokeCase = {
  id: 'bridge.no-auto-activate',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    const problems: string[] = [];
    if (reply.kind !== 'opened') return verdict([`expected opened, got ${describeOpen(reply)}`]);
    await delay(300);
    expectEqual(problems, 'capabilities after open', capabilitiesOf(ctx, window.ownerId), [
      { token: reply.ticket.capabilityId, state: 'pending', documentId: reply.ticket.documentId },
    ]);
    expectEqual(problems, 'authorize(pending)', ctx.openIpc.authorize(window.ownerId, reply.ticket.capabilityId), null);
    return verdict(problems);
  },
};

/** 可信页面：路径含空格 / 中文 / 字面 `%` / `#`（POSIX 另含 `?`），实际 frame URL 与 main 配置的身份一致，Open 可用。 */
const identityFileUrl: SmokeCase = {
  id: 'identity.file-url',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const frameUrl = window.win.webContents.mainFrame.url;
    const problems: string[] = [];
    expectTrue(problems, 'page path lacks a required special character', ['%', '#', ' ', '中'].every((c) => ctx.trustedPagePath.includes(c)));
    if (process.platform !== 'win32') expectTrue(problems, 'POSIX page path lacks ?', ctx.trustedPagePath.includes('?'));
    expectTrue(problems, 'mainFrame.url does not match configured identity', matchesPageIdentity(frameUrl, ctx.entry.identity));
    expectEqual(problems, 'mainFrame.url equals loadUrl', frameUrl, ctx.entry.loadUrl);
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    expectEqual(problems, 'open from trusted page', reply.kind, 'opened');
    if (reply.kind === 'opened') await window.reject(reply.ticket);
    return verdict(problems, { loadUrlTail: tail(ctx.entry.loadUrl), frameUrlTail: tail(frameUrl), chars: ctx.pathChars });
  },
};

/** 带 query 的同一文件不是可信页面：Open 被拒绝（不调用选择器、不改状态）。 */
const identityQuery: SmokeCase = {
  id: 'identity.query',
  run: async (ctx) => {
    const window = await ctx.windows.create({ url: `${ctx.entry.loadUrl}?x=1` });
    return rejectedOpen(ctx, window.ownerId, await window.openRaw(), window.win.webContents.mainFrame.url);
  },
};

/** hash 不影响页面身份（单页应用不用 hash 路由）：带 hash 的可信页面 Open 可用。 */
const identityHash: SmokeCase = {
  id: 'identity.hash',
  run: async (ctx) => {
    const window = await ctx.windows.create({ url: `${ctx.entry.loadUrl}#section` });
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    const problems: string[] = [];
    expectEqual(problems, 'open from trusted page with hash', describeOpen(reply).split('#')[0], 'opened');
    if (reply.kind === 'opened') await window.reject(reply.ticket);
    return verdict(problems);
  },
};

/** Windows：驱动传入小写盘符路径；main 配置的身份为大写盘符，与 Chromium 规范化后的 frame URL 一致。 */
const identityWinDrive: SmokeCase = {
  id: 'identity.win-drive',
  run: async (ctx) => {
    const window = await ctx.windows.create();
    const frameUrl = window.win.webContents.mainFrame.url;
    const problems: string[] = [];
    expectTrue(problems, 'driver did not pass a lowercase drive letter', /^[a-z]:\\/.test(ctx.trustedPagePath));
    expectTrue(problems, 'loadUrl drive letter is not uppercase', /^file:\/\/\/[A-Z]:\//.test(ctx.entry.loadUrl));
    expectTrue(problems, 'frame URL does not match identity', matchesPageIdentity(frameUrl, ctx.entry.identity));
    ctx.chooser.enqueue({ kind: 'path', path: ctx.fixtures.utf8 });
    const reply = await window.open();
    expectEqual(problems, 'open', reply.kind, 'opened');
    if (reply.kind === 'opened') await window.reject(reply.ticket);
    return verdict(problems, { trustedPagePath: 'lowercase-drive', loadUrl: ctx.entry.loadUrl.slice(0, 12), frameUrl: frameUrl.slice(0, 12) });
  },
};

/** 被拒绝的 Open：invoke 以固定文案失败、不调用选择器、该窗口没有任何能力。 */
export function rejectedOpen(ctx: SmokeContext, ownerId: number, result: { ok: boolean; error?: string }, frameUrl?: string): ReturnType<typeof verdict> {
  const problems: string[] = [];
  expectEqual(problems, 'invoke ok', result.ok, false);
  expectTrue(problems, `error is not the fixed rejection text: ${result.error ?? ''}`, (result.error ?? '').endsWith('Error: Request rejected'));
  expectEqual(problems, 'chooser calls', ctx.chooser.calls.length, 0);
  expectEqual(problems, 'capabilities', capabilitiesOf(ctx, ownerId), []);
  return verdict(problems, frameUrl === undefined ? undefined : { frameUrlHasQuery: frameUrl.includes('?x=1') });
}

export const ENVIRONMENT_CASES: readonly SmokeCase[] = [
  envRuntime,
  envSandbox,
  bridgeSurface,
  bridgeNoAutoActivate,
  identityFileUrl,
  identityQuery,
  identityHash,
  ...(process.platform === 'win32' ? [identityWinDrive] : []),
];
