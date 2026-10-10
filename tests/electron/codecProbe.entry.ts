/**
 * Electron runtime codec probe 入口（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §25.2，D17：进入 CI）。
 *
 * 由 `scripts/m3/electronCodecProbe.ts` 用 vite 打成单文件 CJS，再以 `ELECTRON_RUN_AS_NODE=1` 交给开发依赖中的
 * Electron 二进制执行——这样 ICU / TextDecoder 与 Electron main 一致，结论才可作为生产编码正确性的证据。
 *
 * - 文件名不以 `.test.ts` 结尾：不被 vitest 收集（普通 Node 的 codec 结果不是 seal 证据）。
 * - 开头自检：必须在 Electron（`process.versions.electron`）、`ELECTRON_RUN_AS_NODE === '1'`、且 GB18030 fatal
 *   解码器可构造；任一不满足 → 退出码 2。
 * - stdout 最后一行是单行 JSON 摘要；诊断写 stderr。退出码：全部通过 0，有失败 1，harness 自身异常 2。
 */

import { runCodecVectors } from './codecVectors';
import { runFileCases } from './fileCases';
import { createRecorder } from './probeHarness';

function selfCheck(): string | null {
  if (process.versions.electron === undefined) return 'not running inside Electron (process.versions.electron missing)';
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return 'ELECTRON_RUN_AS_NODE is not "1"';
  try {
    new TextDecoder('gb18030', { fatal: true });
  } catch {
    return 'TextDecoder("gb18030", { fatal: true }) is not constructible';
  }
  return null;
}

async function main(): Promise<number> {
  const problem = selfCheck();
  if (problem !== null) {
    process.stderr.write(`[codec-probe] self-check failed: ${problem}\n`);
    return 2;
  }

  const recorder = createRecorder();
  await runCodecVectors(recorder);
  await runFileCases(recorder);

  const cases = recorder.cases;
  const skipped = cases.filter((item) => item.skipped === true).length;
  const failed = cases.filter((item) => !item.pass).length;
  const passed = cases.length - skipped - failed;
  for (const item of cases) {
    const mark = item.skipped === true ? 'SKIP' : item.pass ? 'PASS' : 'FAIL';
    process.stderr.write(`[codec-probe] ${mark} ${item.id}${item.detail === undefined ? '' : ` — ${item.detail}`}\n`);
  }
  const summary = {
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron,
      icu: process.versions.icu,
      platform: process.platform,
    },
    passed,
    failed,
    skipped,
    cases,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`[codec-probe] harness error: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
    process.exitCode = 2;
  },
);
