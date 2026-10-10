/**
 * Electron runtime codec probe 驱动脚本（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §25.2，D17）。
 *
 * 用法：`npm run test:electron-codec`（= `tsx scripts/m3/electronCodecProbe.ts`，在系统 Node 上运行）。
 *
 * 1. 用 vite（项目直接依赖）的 JS API 把 `tests/electron/codecProbe.entry.ts` 打成单文件 CJS（iconv-lite 一并打入），
 *    输出与 vite 缓存都放在 `os.tmpdir()` 下的 mkdtemp 目录，不在仓库里留任何产物。
 * 2. 以 `ELECTRON_RUN_AS_NODE=1`（经 spawn 的 env 传入，不用 shell 语法，Windows 兼容）交给开发依赖中的 Electron 二进制执行。
 * 3. 转发 probe 的 stdout，解析最后一行 JSON 摘要并打印汇总。
 *
 * 退出码：子进程非零退出码透传；被信号终止 → 1；spawn 失败 → 127；摘要未通过 `judgeProbe`（JSON 缺失 / 解析失败、
 * 不在 Electron 中执行、用例数量不符、关键用例缺失 / 失败 / 被跳过、`failed > 0`）→ 非零。
 * 临时目录在 finally 中删除；`KEEP_PROBE=1` 时保留并打印路径。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

import { judgeProbe } from './electronCodecSummary';

const REPO_ROOT = resolve(import.meta.dirname, '../..');
const ENTRY = join(REPO_ROOT, 'tests/electron/codecProbe.entry.ts');
const BUNDLE_NAME = 'probe.cjs';

async function bundleProbe(workDir: string): Promise<string> {
  const outDir = join(workDir, 'out');
  await build({
    configFile: false,
    envDir: false,
    root: REPO_ROOT,
    publicDir: false,
    cacheDir: join(workDir, 'vite-cache'),
    logLevel: 'warn',
    ssr: { noExternal: true },
    build: {
      ssr: ENTRY,
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      rolldownOptions: {
        output: { format: 'cjs', entryFileNames: BUNDLE_NAME },
      },
    },
  });
  const bundle = join(outDir, BUNDLE_NAME);
  await stat(bundle);
  return bundle;
}

function electronBinary(): string {
  // electron 包的 main 导出的是开发依赖中 Electron 可执行文件的绝对路径字符串。
  const resolved: unknown = createRequire(import.meta.url)('electron');
  if (typeof resolved !== 'string') throw new Error('electron package did not resolve to an executable path');
  return resolved;
}

interface ChildOutcome {
  readonly code: number;
  readonly stdout: string;
}

function runElectron(binary: string, bundle: string): Promise<ChildOutcome> {
  return new Promise((done) => {
    const child = spawn(binary, [bundle], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.on('error', (error) => {
      process.stderr.write(`[electron-codec] spawn failed: ${error.message}\n`);
      done({ code: 127, stdout });
    });
    child.on('close', (code, signal) => {
      if (signal !== null) {
        process.stderr.write(`[electron-codec] probe terminated by signal ${signal}\n`);
        done({ code: 1, stdout });
        return;
      }
      done({ code: code ?? 1, stdout });
    });
  });
}

async function main(): Promise<number> {
  const workDir = await mkdtemp(join(tmpdir(), 'muse-codec-probe-'));
  try {
    const bundle = await bundleProbe(workDir);
    const outcome = await runElectron(electronBinary(), bundle);
    const verdict = judgeProbe(outcome.code, outcome.stdout);
    if (verdict.summary !== null) {
      const { runtime, passed, failed, skipped, cases } = verdict.summary;
      console.log(
        `[electron-codec] runtime=${JSON.stringify(runtime)} cases=${String(cases.length)} passed=${String(passed)} failed=${String(failed)} skipped=${String(skipped)} exit=${String(outcome.code)}`,
      );
    }
    if (verdict.ok) return 0;
    for (const problem of verdict.problems) process.stderr.write(`[electron-codec] FAIL: ${problem}\n`);
    return outcome.code !== 0 ? outcome.code : 1;
  } finally {
    if (process.env.KEEP_PROBE === '1') console.log(`[electron-codec] kept ${workDir}`);
    else await rm(workDir, { recursive: true, force: true });
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[electron-codec] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 1;
  },
);
