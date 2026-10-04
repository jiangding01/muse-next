/**
 * M2.5 T3.5 raw / 缺席 `M:` 回归门的 golden 生成器（用户裁决 Q14-a）。
 *
 * **只在 T3.5 之前的基线代码上手动运行**（独立 worktree，检出 `35f7ad9`，把本脚本与
 * `tests/unit/notation/beamsRegression.helpers.ts` 拷入同路径后执行）：
 *
 *   npx tsx scripts/notation/beam-regression-golden.ts <输出路径>
 *
 * 它不是测试，`beams.regression.test.ts` 只读 golden、永不改写；规范化规则见 helper 文件头。
 */
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

import { REGRESSION_VARIANTS, REGRESSION_WIDTHS, regressionEntries } from '../../tests/unit/notation/beamsRegression.helpers';

const out = process.argv[2];
if (out === undefined) {
  throw new Error('用法：npx tsx scripts/notation/beam-regression-golden.ts <输出路径>');
}
const commit = execSync('git rev-parse --short HEAD').toString().trim();
const entries = regressionEntries();
const golden = {
  generatedFrom: commit,
  variants: REGRESSION_VARIANTS.map((variant) => variant.id),
  widths: REGRESSION_WIDTHS,
  count: entries.length,
  hashes: Object.fromEntries(entries.map((entry) => [entry.key, entry.hash])),
};
writeFileSync(out, `${JSON.stringify(golden, null, 1)}\n`);
console.log(`wrote ${String(entries.length)} entries from ${commit} → ${out}`);
