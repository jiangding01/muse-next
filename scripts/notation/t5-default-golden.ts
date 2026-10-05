/**
 * M2.5 T5 默认路径回归门的 golden 生成器（用户裁决 M / 额外裁决 8）。
 *
 * **只在 T5 之前的基线代码上手动运行**（独立 worktree，检出 `25c3015`，把本脚本与
 * `tests/unit/notation/t5DefaultLayout.helpers.ts` 拷入同路径后执行）：
 *
 *   npx tsx scripts/notation/t5-default-golden.ts <输出路径>
 *
 * 它不是测试，`t5.defaultRegression.test.ts` 只读 golden、永不改写；覆盖范围见 helper 文件头。
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { DEFAULT_GOLDEN_WIDTHS, defaultLayoutEntries } from '../../tests/unit/notation/t5DefaultLayout.helpers';

const out = process.argv[2];
if (out === undefined) {
  throw new Error('用法：npx tsx scripts/notation/t5-default-golden.ts <输出路径>');
}
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const entries = defaultLayoutEntries();
const golden = {
  generatedFrom: commit,
  widths: DEFAULT_GOLDEN_WIDTHS,
  count: entries.length,
  hashes: Object.fromEntries(entries.map((entry) => [entry.key, entry.hash])),
};
writeFileSync(out, `${JSON.stringify(golden, null, 1)}\n`);
console.log(`wrote ${String(entries.length)} entries from ${commit} → ${out}`);
