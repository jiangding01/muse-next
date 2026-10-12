/**
 * 真实窗口 IPC smoke 驱动脚本（M3 T1b-2b-1）。
 *
 * 用法：`npm run test:electron-ipc`（= `tsx scripts/m3/electronIpcSmoke.ts`，系统 Node）；Ubuntu 在 CI 中经 `xvfb-run -a` 运行。
 *
 * 1. 用 vite JS API 把 smoke main 入口 `tests/electron/ipcSmoke/smokeMain.entry.ts` 与**生产** `src/preload/preload.ts`
 *    各打成单文件 CJS（`electron` 保持 external）；输出与缓存都在 `os.tmpdir()` 下的 mkdtemp 目录。
 * 2. 在临时目录生成测试页面：可信页面路径含空格、中文、字面 `%`、`#`（POSIX 另含 `?`）；同目录另一文件作为不可信页面。
 *    另用 vite JS API 按 `vite.renderer.config.ts` 构建**真实生产 renderer**（与 Forge 一致的部分：同一配置文件、build 命令注入生产 CSP、
 *    `base: './'`；不同的部分：关闭 sourcemap、`envDir: false`、没有 Forge 的 expose 插件，均不影响 CSP 与页面加载），
 *    复制到同样含特殊字符的目录；`prod.*` 模式的可信页面指向它（M3 T1c-1）。
 * 3. 逐个启动**完整 Electron** 子进程（不设 `ELECTRON_RUN_AS_NODE`，不加任何关闭沙箱的参数）：`matrix` 跑全部自动化用例；
 *    真实原生对话框与 UNC 身份各在独立子进程中运行，互不污染。每个子进程有独立的总超时，超时即杀掉并判失败。
 * 4. 用 `judgeIpcSmoke` 严格判定并打印逐用例结果与汇总；不通过时退出码非零。
 * 临时目录在 finally 中删除；`KEEP_IPC_SMOKE=1` 时保留并打印路径。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

import { expectedModes, isSmokePlatform, judgeIpcSmoke } from './electronIpcSmokeSummary';
import type { ChildOutcome, SmokePlatform, SmokeVerdict } from './electronIpcSmokeSummary';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const SMOKE_ENTRY = join(REPO_ROOT, 'tests/electron/ipcSmoke/smokeMain.entry.ts');
const PRELOAD_ENTRY = join(REPO_ROOT, 'src/preload/preload.ts');
const PAGE_SOURCE = join(REPO_ROOT, 'tests/electron/ipcSmoke/page.html');
const RENDERER_CONFIG = join(REPO_ROOT, 'vite.renderer.config.ts');
const RENDERER_ROOT = join(REPO_ROOT, 'src/renderer');
/** 以此前缀命名的模式在真实生产 renderer 上运行（与 `casesSecurity.ts` 的 `PRODUCTION_CASES` 一致，由架构守卫钉住）。 */
const PRODUCTION_MODE_PREFIX = 'prod.';
/** `matrix` 子进程的总超时（全部自动化用例；本地 macOS 实测见 HANDOFF）。 */
const MATRIX_TIMEOUT_MS = 180_000;
/** 每个独立用例子进程的总超时。 */
const ISOLATED_TIMEOUT_MS = 45_000;

async function bundle(entry: string, workDir: string, name: string): Promise<string> {
  const outDir = join(workDir, 'out', name);
  await build({
    configFile: false,
    envDir: false,
    root: REPO_ROOT,
    publicDir: false,
    cacheDir: join(workDir, 'vite-cache', name),
    logLevel: 'warn',
    ssr: { noExternal: true, external: ['electron'] },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      rolldownOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: `${name}.cjs` } },
    },
  });
  const file = join(outDir, `${name}.cjs`);
  await stat(file);
  return file;
}

/**
 * 生产 renderer 的构建脚本（ESM，在独立的系统 Node 子进程中执行）。runner 本身经 tsx 运行，tsx 的模块钩子会让 vite 内部
 * 解析 `vite/modulepreload-polyfill` 失败（实测）；放到不带钩子的 `node` 子进程里构建，不为绕过而改动 renderer 配置。
 */
const RENDERER_BUILD_SCRIPT = [
  "import { build } from 'vite';",
  'const options = JSON.parse(process.env.MUSE_RENDERER_BUILD);',
  'await build({ configFile: options.configFile, root: options.root, base: \'./\', mode: \'production\', envDir: false, cacheDir: options.cacheDir,',
  "  logLevel: 'warn', build: { outDir: options.outDir, emptyOutDir: true, sourcemap: false } });",
].join('\n');

function runRendererBuild(options: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUSE_RENDERER_BUILD: JSON.stringify(options) };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--input-type=module', '-e', RENDERER_BUILD_SCRIPT], { cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', fail);
    child.on('exit', (code, signal) => (code === 0 ? done() : fail(new Error(`renderer build failed: code=${String(code)} signal=${String(signal)}`))));
  });
}

/** 生产 renderer：按 `vite.renderer.config.ts` 做生产构建（`base: './'`），再复制到含特殊字符的目录；返回其中的 `index.html`。 */
async function buildProductionRenderer(workDir: string, platform: SmokePlatform): Promise<string> {
  const outDir = join(workDir, 'out', 'renderer');
  await runRendererBuild({ configFile: RENDERER_CONFIG, root: RENDERER_ROOT, cacheDir: join(workDir, 'vite-cache', 'renderer'), outDir });
  const dir = join(workDir, platform === 'win32' ? 'renderer 中文 %41 #1' : 'renderer 中文 %41 #1 ?q');
  await cp(outDir, dir, { recursive: true });
  const index = join(dir, 'index.html');
  await stat(index);
  return index;
}

function electronBinary(): string {
  const resolved: unknown = createRequire(import.meta.url)('electron');
  if (typeof resolved !== 'string') throw new Error('electron package did not resolve to an executable path');
  return resolved;
}

interface Pages {
  readonly trusted: string;
  readonly foreign: string;
  readonly chars: readonly string[];
}

/** 页面目录名含空格、中文、字面 `%41`、`#`；POSIX 另含 `?`（Windows 文件名不允许 `?`）。 */
async function preparePages(workDir: string, platform: SmokePlatform): Promise<Pages> {
  const chars = platform === 'win32' ? [' ', '中', '%', '#'] : [' ', '中', '%', '#', '?'];
  const dir = join(workDir, platform === 'win32' ? 'page 中文 %41 #1' : 'page 中文 %41 #1 ?q');
  await mkdir(dir, { recursive: true });
  const trusted = join(dir, 'index.html');
  const foreign = join(dir, 'foreign.html');
  await copyFile(PAGE_SOURCE, trusted);
  await copyFile(PAGE_SOURCE, foreign);
  return { trusted, foreign, chars };
}

/** Windows：把盘符改成小写交给 main，验证 `resolvePageEntry` 的盘符规范化与 Chromium 实际 URL 一致。 */
function lowercaseDrive(path: string): string {
  return path.replace(/^([A-Z]):\\/, (_m, drive: string) => `${drive.toLowerCase()}:\\`);
}

/**
 * UNC 形式：`C:\x` → `\\127.0.0.1\C$\x`（管理共享，CI 上可能不可用；不可用时用例记为 unverified）。
 * 不用 `localhost`：WHATWG URL 把 file URL 的 `localhost` 主机规范成空串，`pathToFileURL` 会得到 `file:///C$/…`，UNC 主机丢失。
 */
function uncPath(path: string): string {
  return path.replace(/^([A-Za-z]):\\/, (_m, drive: string) => `\\\\127.0.0.1\\${drive.toUpperCase()}$\\`);
}

/** 子进程退出后最多再等多久让 stdio 关闭（helper 进程继承了管道时 `close` 可能迟迟不来）。 */
const CLOSE_GRACE_MS = 5_000;

/** 杀掉子进程及其 helper：POSIX 杀整个进程组（spawn 时 detached），Windows 用 taskkill 杀进程树。 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程已退出。
  }
}

function runChild(binary: string, mainBundle: string, config: Record<string, unknown>, mode: string, timeoutMs: number): Promise<ChildOutcome> {
  return new Promise((done) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUSE_IPC_SMOKE_CONFIG: JSON.stringify({ ...config, mode }) };
    delete env.ELECTRON_RUN_AS_NODE;
    // POSIX 上 detached 让子进程成为新进程组的组长，超时可以连同 helper 一起杀掉；runner 仍等待它结束（不 unref）。
    const child = spawn(binary, [mainBundle], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stdout = '';
    let timedOut = false;
    let spawnError: string | null = null;
    let finished = false;
    let graceTimer: NodeJS.Timeout | null = null;
    const finish = (code: number | null, signal: string | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (graceTimer !== null) clearTimeout(graceTimer);
      done({ mode, exitCode: code, signal, timedOut, spawnError, stdout });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      process.stderr.write(`[electron-ipc] ${mode}: timed out after ${String(timeoutMs)} ms, killing process tree\n`);
      killTree(child.pid);
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
    });
    child.on('error', (error) => {
      spawnError = error.message;
      finish(null, null);
    });
    child.on('exit', (code, signal) => {
      // 主进程已退出：给 stdio 一段宽限期；仍未关闭（残留 helper 持有管道）就杀掉进程树并按退出结果收尾。
      graceTimer = setTimeout(() => {
        process.stderr.write(`[electron-ipc] ${mode}: stdio still open ${String(CLOSE_GRACE_MS)} ms after exit, killing leftovers\n`);
        killTree(child.pid);
        finish(code, signal);
      }, CLOSE_GRACE_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

function report(platform: SmokePlatform, verdict: SmokeVerdict): void {
  for (const item of verdict.cases) {
    console.log(`[electron-ipc] ${item.status.toUpperCase().padEnd(10)} ${item.id}${item.detail === '' ? '' : ` — ${item.detail}`}`);
  }
  for (const child of verdict.children) {
    console.log(`[electron-ipc] child=${child.mode} runtime=${JSON.stringify(child.runtime)}`);
    console.log(`[electron-ipc] child=${child.mode} sandbox=${JSON.stringify(child.sandbox)}`);
  }
  const observed = verdict.cases.filter((item) => item.status === 'observed').map((item) => item.id);
  const unverified = verdict.cases.filter((item) => item.status === 'unverified').map((item) => `${item.id} (${item.detail})`);
  console.log(`[electron-ipc] observation-only: ${observed.length === 0 ? 'none' : observed.join(', ')}`);
  console.log(`[electron-ipc] unverified: ${unverified.length === 0 ? 'none' : unverified.join('; ')}`);
  const { cases, passed, failed, skipped, observed: nObserved, unverified: nUnverified } = verdict.counts;
  console.log(
    `[electron-ipc] platform=${platform} children=${String(verdict.children.length)} cases=${String(cases)} passed=${String(passed)} failed=${String(failed)} skipped=${String(skipped)} observed=${String(nObserved)} unverified=${String(nUnverified)} verdict=${verdict.ok ? 'PASS' : 'FAIL'}`,
  );
}

async function main(): Promise<number> {
  const platform = process.platform;
  if (!isSmokePlatform(platform)) throw new Error(`unsupported platform ${platform}`);
  const workDir = await mkdtemp(join(tmpdir(), 'muse-ipc-smoke-'));
  try {
    const [mainBundle, preloadPath] = [await bundle(SMOKE_ENTRY, workDir, 'smokeMain'), await bundle(PRELOAD_ENTRY, workDir, 'preload')];
    const pages = await preparePages(workDir, platform);
    const productionPage = await buildProductionRenderer(workDir, platform);
    const nonce = randomUUID();
    const local = platform === 'win32' ? lowercaseDrive(pages.trusted) : pages.trusted;
    const base = { nonce, workDir, preloadPath, foreignPagePath: pages.foreign, localPagePath: pages.trusted, pathChars: pages.chars };
    const binary = electronBinary();
    const outcomes: ChildOutcome[] = [];
    for (const mode of expectedModes(platform)) {
      const trustedPagePath = mode === 'identity.win-unc' ? uncPath(pages.trusted) : mode.startsWith(PRODUCTION_MODE_PREFIX) ? productionPage : local;
      const timeout = mode === 'matrix' ? MATRIX_TIMEOUT_MS : ISOLATED_TIMEOUT_MS;
      process.stderr.write(`[electron-ipc] starting child ${mode}\n`);
      outcomes.push(await runChild(binary, mainBundle, { ...base, trustedPagePath }, mode, timeout));
    }
    const verdict = judgeIpcSmoke(platform, nonce, outcomes);
    report(platform, verdict);
    if (verdict.ok) return 0;
    for (const problem of verdict.problems) process.stderr.write(`[electron-ipc] FAIL: ${problem}\n`);
    return 1;
  } finally {
    if (process.env.KEEP_IPC_SMOKE === '1') console.log(`[electron-ipc] kept ${workDir}`);
    else await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[electron-ipc] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  },
);
