/**
 * JCX round-trip fixture 矩阵看板（M1.8 T4，方案 v1.1 §4 T4 / §0a 第 5 条）。
 *
 * 用法：`npm run jcx:fixture-report`
 *
 * 对 `tests/fixtures/jcx/**\/*.jcx`（运行时 glob，总数不写死）跑 vitest 矩阵
 * 同一套判断逻辑——本脚本与 `tests/unit/jcx/serialize/roundtrip.test.ts` /
 * `roundtrip.closure.test.ts` 共同 import `tests/unit/jcx/serialize/
 * fixtureMatrix.ts` 的判定函数，不得各自重新实现一份指标判断（方案 §6 固定
 * 审查项 10，`git grep` 应确认只有这一份逻辑）。
 *
 * 输出六项指标，显式分母：
 *
 * - L1 parse：原始字节无 error 级 diagnostic。
 * - L2 semantic：语义投影相等；`unclosed-chord.jcx` 是唯一豁免，单独报
 *   `pinned known limitation`，不从分母里排除；`unexpected` 是既不相等、
 *   又不匹配豁免记录位置的差异数——非零即 `exit 1`。
 * - L3 preserve：preserve 输出与原字节逐字节相等。
 * - idempotent：`canonical(parse(canonical(x))) === canonical(x)`（观测项）。
 * - closure：canonical document closure 四项（不动点/L2/L3/reparse-clean）
 *   全部成立才算这一格 OK（M1.8 T1，零豁免）。
 * - reparse-clean：只对原始输入无 error 级的 fixture（clean 组）设硬门槛；
 *   malformed 组只观测数量，不设硬门槛。
 *
 * **不含真实语料**——语料级指标（byte/semantic/reparse-clean/closure 11/11、
 * encoding composition）见本地 `npm run jcx:corpus-test`，语料目录本身不进
 * git，CI 上不存在，因此本脚本与 CI 都只覆盖 `tests/fixtures/jcx` 下的自建
 * fixture。
 *
 * 若 `GITHUB_STEP_SUMMARY` 环境变量存在（GitHub Actions 的 job summary 文件），
 * 额外把同一份数字追加为 Markdown；stdout 的纯文本输出不受影响。
 */

import { appendFileSync } from 'node:fs';
import {
  checkClosure,
  checkIdempotent,
  checkL1,
  checkL2,
  checkL3,
  checkReparseClean,
  cleanFixtureNames,
  closureAllOk,
  fixtureNames,
  isL2KnownLimitation,
  malformedFixtureNames,
} from '../../tests/unit/jcx/serialize/fixtureMatrix';

interface Tally {
  ok: number;
  total: number;
}

function tally(): Tally {
  return { ok: 0, total: 0 };
}

function bump(t: Tally, ok: boolean): void {
  t.total += 1;
  if (ok) {
    t.ok += 1;
  }
}

function ratio(t: Tally): string {
  return `${String(t.ok)}/${String(t.total)}`;
}

function main(): void {
  const total = fixtureNames.length;
  if (total === 0) {
    console.log('[skip] no fixture under tests/fixtures/jcx — nothing to report.');
    process.exit(0);
  }

  const l1 = tally();
  const l3 = tally();
  const idempotent = tally();
  const closure = tally();
  const reparseClean = tally();

  let l2Exact = 0;
  let l2Pinned = 0;
  let l2Unexpected = 0;
  const unexpectedNames: string[] = [];
  let malformedObservedErrors = 0;

  for (const name of fixtureNames) {
    bump(l1, checkL1(name));
    bump(l3, checkL3(name));
    bump(idempotent, checkIdempotent(name));
    bump(closure, closureAllOk(checkClosure(name)));

    const l2 = checkL2(name);
    if (l2.diffPath === null) {
      l2Exact += 1;
    } else if (isL2KnownLimitation(name) && l2.matchesKnownLimitation) {
      l2Pinned += 1;
    } else {
      l2Unexpected += 1;
      unexpectedNames.push(name);
    }

    if (cleanFixtureNames.includes(name)) {
      bump(reparseClean, checkReparseClean(name).ok);
    } else {
      malformedObservedErrors += checkReparseClean(name).errorCount;
    }
  }

  const lines: string[] = [];
  lines.push('JCX fixture matrix (M1.8 T4, tests/fixtures/jcx only — no corpus)');
  lines.push('');
  lines.push(`fixtures: ${String(total)}`);
  lines.push(`L1 parse (no error):        ${ratio(l1)}`);
  lines.push(
    `L2 semantic exact:          ${String(l2Exact)}/${String(total)}   pinned known limitation: ${String(l2Pinned)}/${String(total)}   unexpected: ${String(l2Unexpected)}`,
  );
  lines.push(`L3 preserve byte-identical: ${ratio(l3)}`);
  lines.push(`idempotent (observational): ${ratio(idempotent)}`);
  lines.push(`closure (fixed point/L2/L3/reparse): ${ratio(closure)}`);
  lines.push(
    `reparse-clean (clean fixtures): ${ratio(reparseClean)}   malformed observed error count: ${String(malformedObservedErrors)} across ${String(malformedFixtureNames.length)} fixture(s)`,
  );
  if (l2Pinned > 0) {
    lines.push('');
    lines.push('pinned known limitation(s):');
    for (const name of fixtureNames) {
      if (isL2KnownLimitation(name) && checkL2(name).matchesKnownLimitation) {
        lines.push(`  - ${name}: ${String(checkL2(name).diffPath)}`);
      }
    }
  }
  if (l2Unexpected > 0) {
    lines.push('');
    lines.push('unexpected L2 difference(s) (not covered by the pinned known limitation):');
    for (const name of unexpectedNames) {
      lines.push(`  - ${name}: ${String(checkL2(name).diffPath)}`);
    }
  }
  lines.push('');
  lines.push(
    'not including real corpus content; corpus-level metrics run locally via `npm run jcx:corpus-test` (corpus is git-ignored, absent in CI).',
  );

  for (const line of lines) {
    console.log(line);
  }

  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (summaryFile !== undefined && summaryFile !== '') {
    const markdown = [
      '## JCX fixture matrix (M1.8 T4)',
      '',
      '| metric | ratio |',
      '| --- | --- |',
      `| fixtures | ${String(total)} |`,
      `| L1 parse (no error) | ${ratio(l1)} |`,
      `| L2 semantic exact | ${String(l2Exact)}/${String(total)} |`,
      `| L2 pinned known limitation | ${String(l2Pinned)}/${String(total)} |`,
      `| L2 unexpected | ${String(l2Unexpected)} |`,
      `| L3 preserve byte-identical | ${ratio(l3)} |`,
      `| idempotent (observational) | ${ratio(idempotent)} |`,
      `| closure (fixed point/L2/L3/reparse) | ${ratio(closure)} |`,
      `| reparse-clean (clean fixtures) | ${ratio(reparseClean)} |`,
      `| malformed observed error count | ${String(malformedObservedErrors)} across ${String(malformedFixtureNames.length)} |`,
      '',
      'Not including real corpus content — corpus-level metrics run locally via `npm run jcx:corpus-test`.',
      '',
    ].join('\n');
    appendFileSync(summaryFile, `${markdown}\n`);
  }

  if (l2Unexpected > 0) {
    console.log('');
    console.log(`FAILED: ${String(l2Unexpected)} unexpected L2 difference(s), see list above.`);
    process.exit(1);
  }
  if (l1.ok !== l1.total || l3.ok !== l3.total || closure.ok !== closure.total || reparseClean.ok !== reparseClean.total) {
    console.log('');
    console.log('FAILED: at least one fixture-level failure condition is below 100%.');
    process.exit(1);
  }

  console.log('');
  console.log(`PASSED: ${String(total)}/${String(total)} fixture(s), all failure conditions at 100%.`);
}

main();
