/**
 * 真实窗口 IPC smoke 的 Electron main 入口（M3 T1b-2b-1）。
 *
 * 由 `scripts/m3/electronIpcSmoke.ts` 用 vite 打成 CJS 后作为 Electron 应用入口启动（完整 Electron，不设
 * `ELECTRON_RUN_AS_NODE`、不加任何关闭沙箱的参数）。本文件只负责：初始化 Electron、读取驱动给出的配置、在临时目录生成
 * fixture、向**生产** `registerOpenIpc` 注入受控选择器 / 可暂停 fs / 测试时钟，按模式执行用例并输出结果。
 * Open 协议、窗口事件接线、页面身份全部来自生产模块；这里不实现任何协议逻辑。
 *
 * 模式：`matrix`（全部自动化 IPC 用例，受控选择器）；其余模式各对应一个需要独立进程的用例（真实原生对话框、UNC 身份）。
 * stdout 只输出一行 `MUSE_IPC_SMOKE_RESULT <json>`（带驱动给出的 nonce）；诊断写 stderr。退出码：无失败 0，有失败 1，
 * harness 异常 2。
 */

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';

import { createNodeReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import { resolvePageEntry } from '../../../src/main/ipc/pageIdentity';
import { registerOpenIpc } from '../../../src/main/ipc/registerOpenIpc';
import { createOpenPathChooser } from '../../../src/main/ipc/wireOpenIpcWindow';
import { residueProblems, SECOND_SOURCE, UTF8_SOURCE } from './context';
import type { CaseOutcome, CaseResult, Fixtures, SmokeCase, SmokeContext } from './context';
import { CAPABILITY_CASES } from './casesCapability';
import { DIALOG_CASES, FINAL_CASE } from './casesDialog';
import { ENVIRONMENT_CASES } from './casesEnvironment';
import { NAVIGATION_CASES } from './casesNavigation';
import { ISOLATED_CASES } from './casesIsolated';
import { SENDER_CASES } from './casesSender';
import { runtimeEvidence, sandboxEvidence } from './evidence';
import type { SandboxEvidence } from './evidence';
import { createGatedFileSystem, createManualScheduler, createScriptedChooser, createTestClock, createTokenFaults, withTimeout } from './harness';
import { isRecord } from './replies';
import { createWindowFactory } from './windows';

const RESULT_PREFIX = 'MUSE_IPC_SMOKE_RESULT ';
const CASE_TIMEOUT_MS = 15_000;

export interface SmokeConfig {
  readonly nonce: string;
  readonly mode: string;
  readonly workDir: string;
  readonly preloadPath: string;
  readonly trustedPagePath: string;
  readonly foreignPagePath: string;
  /** 本地可信页面路径（UNC 模式下用于取 sandbox 证据）。 */
  readonly localPagePath: string;
  readonly pathChars: readonly string[];
}

function readConfig(): SmokeConfig {
  const raw = process.env.MUSE_IPC_SMOKE_CONFIG;
  if (raw === undefined) throw new Error('MUSE_IPC_SMOKE_CONFIG missing');
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value)) throw new Error('config is not an object');
  const text = (key: string): string => {
    const field = value[key];
    if (typeof field !== 'string' || field === '') throw new Error(`config.${key} missing`);
    return field;
  };
  const chars = value.pathChars;
  if (!Array.isArray(chars) || !chars.every((c) => typeof c === 'string')) throw new Error('config.pathChars invalid');
  return {
    nonce: text('nonce'),
    mode: text('mode'),
    workDir: text('workDir'),
    preloadPath: text('preloadPath'),
    trustedPagePath: text('trustedPagePath'),
    foreignPagePath: text('foreignPagePath'),
    localPagePath: text('localPagePath'),
    pathChars: chars.filter((c): c is string => typeof c === 'string'),
  };
}

async function writeFixtures(dir: string): Promise<Fixtures> {
  await mkdir(dir, { recursive: true });
  const fixtures: Fixtures = {
    dir,
    utf8: join(dir, 'utf8 score.jcx'),
    second: join(dir, 'second score.jcx'),
    utf16: join(dir, 'utf16 score.jcx'),
  };
  await writeFile(fixtures.utf8, UTF8_SOURCE, 'utf8');
  await writeFile(fixtures.second, SECOND_SOURCE, 'utf8');
  await writeFile(fixtures.utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('X:1\nK:C\n', 'utf16le')]));
  return fixtures;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message.split('\n')[0] ?? ''}` : String(error);
}

async function runCase(ctx: SmokeContext, smokeCase: SmokeCase, checkResidue: boolean): Promise<CaseResult> {
  ctx.chooser.reset();
  ctx.scheduler.clear();
  let outcome: CaseOutcome;
  try {
    // 只有 renderer 崩溃用例声明了更长的预算（诊断观察窗口）；其余用例仍为默认值。
    outcome = await withTimeout(smokeCase.run(ctx), smokeCase.timeoutMs ?? CASE_TIMEOUT_MS, smokeCase.id);
  } catch (error) {
    outcome = { status: 'failed', detail: `threw ${describeError(error)}` };
  }
  await ctx.windows.closeAll();
  const residue = checkResidue ? residueProblems(ctx) : [];
  // 残留检查之后强制回收测试侧资源，避免一个失败用例连锁影响后续用例（失败本身已记录）。
  ctx.fs.releaseAll();
  ctx.chooser.reset();
  ctx.tokenFaults.clear();
  if (residue.length > 0 && outcome.status !== 'failed') outcome = { status: 'failed', detail: [residue.join('; '), outcome.detail ?? ''].join(' | ') };
  else if (residue.length > 0) outcome = { status: 'failed', detail: `${outcome.detail ?? ''} | ${residue.join('; ')}` };
  return outcome.detail === undefined ? { id: smokeCase.id, status: outcome.status } : { id: smokeCase.id, status: outcome.status, detail: outcome.detail };
}

/** 取一次独立的 sandbox 证据（不登记窗口，不影响协调器状态）。 */
async function collectSandbox(ctx: SmokeContext, url: string): Promise<SandboxEvidence | null> {
  try {
    const window = await ctx.windows.create({ wire: false, url });
    const evidence = await sandboxEvidence(window);
    await ctx.windows.closeAll();
    return evidence;
  } catch (error) {
    process.stderr.write(`[ipc-smoke] sandbox evidence failed: ${describeError(error)}\n`);
    return null;
  }
}

async function main(): Promise<number> {
  const config = readConfig();
  app.setPath('userData', join(config.workDir, 'user-data', config.mode.replace(/[^a-z0-9.-]/gi, '_')));
  // 用例之间所有窗口都会关闭：不能让应用随之退出。
  app.on('window-all-closed', () => undefined);
  await app.whenReady();

  const fixtures = await writeFixtures(join(config.workDir, 'fixtures 中文', config.mode.replace(/[^a-z0-9.-]/gi, '_')));
  const entry = resolvePageEntry({ devServerUrl: undefined, indexFilePath: config.trustedPagePath, platform: process.platform });
  const local = resolvePageEntry({ devServerUrl: undefined, indexFilePath: config.localPagePath, platform: process.platform });
  const foreign = resolvePageEntry({ devServerUrl: undefined, indexFilePath: config.foreignPagePath, platform: process.platform });
  const chooser = createScriptedChooser<BrowserWindow>();
  const fs = createGatedFileSystem(createNodeReadOnlyFileSystem());
  const clock = createTestClock();
  const scheduler = createManualScheduler(clock);
  const tokenFaults = createTokenFaults();
  const isolated = ISOLATED_CASES.find((item) => item.id === config.mode);
  const realChooser = createOpenPathChooser((parent: BrowserWindow, options) => dialog.showOpenDialog(parent, options));

  const openIpc = registerOpenIpc({
    ipc: ipcMain,
    windowForSender: (sender) => BrowserWindow.fromWebContents(sender),
    pageIdentity: entry.identity,
    // 真实原生对话框用例使用与产品完全相同的选择器；其余用例使用 main 持有的受控选择器。
    chooseOpenPath: isolated?.realDialog === true ? realChooser : (parent) => chooser.choose(parent),
    fs,
    platform: process.platform,
    now: () => clock.now(),
    issueToken: () => tokenFaults.issue(() => randomUUID()),
    schedule: (delayMs, task) => scheduler.schedule(delayMs, task),
  });
  const windows = createWindowFactory({ openIpc, preloadPath: config.preloadPath, defaultUrl: entry.loadUrl });
  const ctx: SmokeContext = {
    openIpc,
    chooser,
    fs,
    clock,
    scheduler,
    tokenFaults,
    windows,
    entry,
    foreignUrl: foreign.loadUrl,
    fixtures,
    pathChars: config.pathChars,
    trustedPagePath: config.trustedPagePath,
  };

  const sandbox = await collectSandbox(ctx, local.loadUrl);
  const results: CaseResult[] = [];
  if (config.mode === 'matrix') {
    const cases = [...ENVIRONMENT_CASES, ...CAPABILITY_CASES, ...NAVIGATION_CASES, ...SENDER_CASES, ...DIALOG_CASES];
    for (const smokeCase of cases) results.push(await runCase(ctx, smokeCase, true));
    results.push(await runCase(ctx, FINAL_CASE, false));
  } else if (isolated !== undefined) {
    results.push(await runCase(ctx, isolated, false));
  } else {
    throw new Error(`unknown mode ${config.mode}`);
  }

  for (const item of results) {
    process.stderr.write(`[ipc-smoke] ${item.status.toUpperCase()} ${item.id}${item.detail === undefined ? '' : ` — ${item.detail}`}\n`);
  }
  const payload = { nonce: config.nonce, mode: config.mode, runtime: runtimeEvidence(), sandbox, cases: results };
  process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(payload)}\n`);
  return results.some((item) => item.status === 'failed') ? 1 : 0;
}

main().then(
  (code) => app.exit(code),
  (error: unknown) => {
    process.stderr.write(`[ipc-smoke] harness error: ${describeError(error)}\n`);
    app.exit(2);
  },
);
