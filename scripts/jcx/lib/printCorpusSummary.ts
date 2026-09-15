/**
 * JCX 语料回归 —— AST 级 / parse 级 stdout 输出（M1.5 T6 / M1.6 T10a）。
 *
 * 从 `scripts/jcx/corpus-lex-test.ts` 抽出，避免主脚本超过 §0 固定审查项的
 * 350 行上限。纯打印，不做任何断言——断言逻辑分别在 `astInvariants.ts` /
 * `parseInvariants.ts`，已经通过 `report.failures` 影响退出码；这里的清单
 * （残留通用叶子、diagnostic code 直方图、`UnknownEvent.tokenKind` 去重清单）
 * 都只是观测指标。
 */

import type { ParseSummary } from './parseInvariants';

/** `checkFile` 产出的 `FileReport` 结构性满足这个形状即可，避免循环 import。 */
export interface ParseSectionReport {
  readonly name: string;
  readonly parseOk: boolean;
  readonly parseSummary: ParseSummary | undefined;
  readonly unknownEventTokenKinds: readonly string[];
  readonly diagnosticCodes: readonly string[];
}

function pad(value: string | number, width: number, left = false): string {
  const text = String(value);
  return left ? text.padStart(width) : text.padEnd(width);
}

/**
 * ⑧ item 位置残留的通用叶子清单（观测，不影响退出码）。见
 * `astInvariants.ts` 的 `collectResidualItemLeaves` 口径注释：只统计
 * `bodyLine.items` / `inlineFieldLine.trailing` / chord-grace-tabGroup 的
 * `items`（含嵌套），不算 note/rest/tabNote 内部 children、括号组
 * open/close、字段行外壳 children。
 */
export function printResidualLeafSection(reports: readonly { readonly residualItemLeafKinds: readonly string[] }[]): void {
  const counts = new Map<string, number>();
  for (const report of reports) {
    for (const kind of report.residualItemLeafKinds) {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(
    `residual item-position leaves (kind === 'token' inside items/trailing): ${total} total, ${distinct.length} distinct token kind(s) — observational only, not a failure condition`,
  );
  for (const [kind, count] of distinct) {
    console.log(`  ${pad(count, 4, true)} x  ${kind}`);
  }
}

/**
 * 打印 parse 级输出：逐文件汇总行 + 结尾的 diagnostic code 直方图 /
 * `UnknownEvent.tokenKind` 去重清单。
 */
export function printParseSection(reports: readonly ParseSectionReport[], nameWidth: number): void {
  console.log('');
  const parseOkFiles = reports.filter((r) => r.parseOk).length;
  console.log(`parse level (⑨–⑫) — ${parseOkFiles}/${reports.length} file(s) OK`);
  console.log('');
  console.log(
    `${pad('file', nameWidth)}  ${pad('voices', 6, true)}  ${pad('events', 6, true)}  ${pad('tie(r/u)', 9, true)}  ${pad('slur(c/u)', 9, true)}  ${pad('tuplet(c/i)', 11, true)}  ${pad('tab', 4, true)}  ${pad('lyric', 5, true)}  ${pad('gchord', 6, true)}  ${pad('dir', 4, true)}  ${pad('err', 4, true)}  ${pad('warn', 5, true)}  ${pad('info', 5, true)}`,
  );
  for (const report of reports) {
    const s = report.parseSummary;
    if (s === undefined) {
      console.log(`${pad(report.name, nameWidth)}  (parse threw — see failures above)`);
      continue;
    }
    console.log(
      `${pad(report.name, nameWidth)}  ${pad(s.voices, 6, true)}  ${pad(s.events, 6, true)}  ${pad(`${s.tieResolved}/${s.tieUnresolved}`, 9, true)}  ${pad(`${s.slurClosed}/${s.slurUnclosed}`, 9, true)}  ${pad(`${s.tupletComplete}/${s.tupletIncomplete}`, 11, true)}  ${pad(s.tabRelations, 4, true)}  ${pad(s.lyricLines, 5, true)}  ${pad(s.chordShapes, 6, true)}  ${pad(s.directives, 4, true)}  ${pad(s.diagnosticsBySeverity.error, 4, true)}  ${pad(s.diagnosticsBySeverity.warning, 5, true)}  ${pad(s.diagnosticsBySeverity.info, 5, true)}`,
    );
  }

  const codeCounts = new Map<string, number>();
  const unknownKindCounts = new Map<string, number>();
  for (const report of reports) {
    for (const code of report.diagnosticCodes) {
      codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
    }
    for (const kind of report.unknownEventTokenKinds) {
      unknownKindCounts.set(kind, (unknownKindCounts.get(kind) ?? 0) + 1);
    }
  }

  console.log('');
  const codeDistinct = [...codeCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(`parse-level diagnostic code histogram: ${codeDistinct.length} distinct code(s) — observational only`);
  for (const [code, count] of codeDistinct) {
    console.log(`  ${pad(count, 4, true)} x  ${code}`);
  }

  console.log('');
  const unknownDistinct = [...unknownKindCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  console.log(
    `UnknownEvent tokenKind list: ${unknownDistinct.length} distinct kind(s) — observational only, not a failure condition`,
  );
  for (const [kind, count] of unknownDistinct) {
    console.log(`  ${pad(count, 4, true)} x  ${kind}`);
  }
}
