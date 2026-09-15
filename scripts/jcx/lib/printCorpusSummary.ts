/**
 * JCX 语料回归 —— AST 级 / parse 级 / round-trip 级 stdout 输出
 * （M1.5 T6 / M1.6 T10a / M1.7 T7）。
 *
 * 从 `scripts/jcx/corpus-lex-test.ts` 抽出，避免主脚本超过 §0 固定审查项的
 * 350 行上限。纯打印，不做任何断言——断言逻辑分别在 `astInvariants.ts` /
 * `parseInvariants.ts` / `roundtripInvariants.ts`，已经通过 `report.failures`
 * 影响退出码；这里的清单（残留通用叶子、diagnostic code 直方图、
 * `UnknownEvent.tokenKind` 去重清单、round-trip 三指标）都只是观测指标或
 * （round-trip 的 byte-identical / semantic 两项）已经在别处判过失败的复述。
 */

import type { ParseSummary } from './parseInvariants';
import type { RoundtripSummary } from './roundtripInvariants';

/** `checkFile` 产出的 `FileReport` 结构性满足这个形状即可，避免循环 import。 */
export interface ParseSectionReport {
  /** 匿名编号（如 `#3`），不是真实文件名。 */
  readonly label: string;
  readonly parseOk: boolean;
  readonly parseSummary: ParseSummary | undefined;
  readonly unknownEventTokenKinds: readonly string[];
  readonly diagnosticCodes: readonly string[];
}

/** round-trip 级汇总所需的最小形状，同样用结构类型避免循环 import。 */
export interface RoundtripSectionReport {
  /** 匿名编号（如 `#3`），不是真实文件名。 */
  readonly label: string;
  readonly roundtripSummary: RoundtripSummary | undefined;
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
  console.log(`parse level (⑨–⑬) — ${parseOkFiles}/${reports.length} file(s) OK`);
  console.log('');
  console.log(
    `${pad('no.', nameWidth)}  ${pad('voices', 6, true)}  ${pad('events', 6, true)}  ${pad('tie(r/u)', 9, true)}  ${pad('slur(c/u)', 9, true)}  ${pad('tuplet(c/i)', 11, true)}  ${pad('tab', 4, true)}  ${pad('lyric', 5, true)}  ${pad('gchord', 6, true)}  ${pad('dir', 4, true)}  ${pad('err', 4, true)}  ${pad('warn', 5, true)}  ${pad('info', 5, true)}`,
  );
  for (const report of reports) {
    const s = report.parseSummary;
    if (s === undefined) {
      console.log(`${pad(report.label, nameWidth)}  (parse threw — see failures above)`);
      continue;
    }
    console.log(
      `${pad(report.label, nameWidth)}  ${pad(s.voices, 6, true)}  ${pad(s.events, 6, true)}  ${pad(`${s.tieResolved}/${s.tieUnresolved}`, 9, true)}  ${pad(`${s.slurClosed}/${s.slurUnclosed}`, 9, true)}  ${pad(`${s.tupletComplete}/${s.tupletIncomplete}`, 11, true)}  ${pad(s.tabRelations, 4, true)}  ${pad(s.lyricLines, 5, true)}  ${pad(s.chordShapes, 6, true)}  ${pad(s.directives, 4, true)}  ${pad(s.diagnosticsBySeverity.error, 4, true)}  ${pad(s.diagnosticsBySeverity.warning, 5, true)}  ${pad(s.diagnosticsBySeverity.info, 5, true)}`,
    );
  }

  // M1.7 T0 的事实字段计数（观测）。当前语料实测：brokenRhythms 35（全为 `>`）、
  // unitLengthChanges 10（5 行 body `L:` × 各自影响到的 2 个声部）、
  // lyric bodyRange 94/94（每条 `w:` 行的绑定目标都产生了事件）。
  let brokenRhythms = 0;
  let unitLengthChanges = 0;
  let lyricWithRange = 0;
  let lyricTotal = 0;
  for (const report of reports) {
    const summary = report.parseSummary;
    if (summary === undefined) {
      continue;
    }
    brokenRhythms += summary.brokenRhythms;
    unitLengthChanges += summary.unitLengthChanges;
    lyricWithRange += summary.lyricLinesWithBodyRange;
    lyricTotal += summary.lyricLines;
  }
  console.log('');
  console.log(
    `factual fields (M1.7 T0): brokenRhythms=${brokenRhythms}, unitLengthChanges=${unitLengthChanges}, lyric bodyRange=${lyricWithRange}/${lyricTotal} — observational; their structural refs are asserted as ⑬`,
  );

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

/**
 * round-trip 级（第四级，M1.7 T7）汇总：逐文件三指标 + 总体通过率 + 幂等观测。
 * 失败条件只有 byte-identical / semantic 两项（由 `report.failures` 已经体现在
 * 退出码里）；line-identical 与幂等只报数字。
 */
export function printRoundtripSection(
  reports: readonly RoundtripSectionReport[],
  nameWidth: number,
): void {
  console.log('');
  console.log('round-trip level (M1.7 T7): preserve byte/line-identical + canonical semantic + idempotence');
  console.log('');
  console.log(
    `${pad('no.', nameWidth)}  ${pad('byte', 5)}  ${pad('line', 5)}  ${pad('semantic', 8)}  ${pad('idempotent', 10)}`,
  );

  let byteOk = 0;
  let lineOk = 0;
  let semanticOk = 0;
  let idempotentOk = 0;
  let withSummary = 0;

  for (const report of reports) {
    const s = report.roundtripSummary;
    if (s === undefined) {
      console.log(`${pad(report.label, nameWidth)}  (round-trip threw — see failures above)`);
      continue;
    }
    withSummary += 1;
    if (s.byteIdentical) byteOk += 1;
    if (s.lineIdentical) lineOk += 1;
    if (s.semanticEqual) semanticOk += 1;
    if (s.canonicalIdempotent) idempotentOk += 1;
    console.log(
      `${pad(report.label, nameWidth)}  ${pad(s.byteIdentical ? 'OK' : 'FAIL', 5)}  ${pad(s.lineIdentical ? 'OK' : 'FAIL', 5)}  ${pad(s.semanticEqual ? 'OK' : 'FAIL', 8)}  ${pad(s.canonicalIdempotent ? 'yes' : 'no', 10)}`,
    );
    if (!s.semanticEqual && s.semanticDiffPath !== null) {
      console.log(`${' '.repeat(nameWidth + 2)}  ! semantic diff path: ${s.semanticDiffPath}`);
    }
  }

  console.log('');
  console.log(
    `byte-identical: ${byteOk}/${reports.length} (failure condition, must be 100%)`,
  );
  console.log(`line-identical: ${lineOk}/${reports.length} (diagnostic only, not a failure condition)`);
  console.log(
    `semantic:       ${semanticOk}/${reports.length} (failure condition, must be 100%)`,
  );
  console.log(
    `canonical idempotent: ${idempotentOk}/${withSummary} of file(s) with a summary (observational only)`,
  );
}
