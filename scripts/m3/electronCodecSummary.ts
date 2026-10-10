/**
 * Electron runtime codec probe 摘要的解析与防假阳性校验（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §25.2）。
 *
 * 纯函数，供 `electronCodecProbe.ts` 使用并由单元测试做故障注入。只有同时满足以下条件才算通过：
 *
 * - 子进程退出码为 0；最后一行 stdout 是 JSON 摘要；`runtime.electron` 是字符串（确实在 Electron 中执行）；
 * - `cases` 的 id 集合恰为 `EXPECTED_CASE_IDS`（无缺失、无多余、无重复），且 `passed + failed + skipped === cases.length`，
 *   各计数与 `cases` 逐项统计一致；
 * - `failed === 0`；除 `SKIPPABLE_CASE_IDS` 外的每个用例都通过且没有被跳过（关键编码向量不可能靠 skip 变绿）。
 *
 * 增删或改名 probe 用例时必须同步更新 `EXPECTED_CASE_IDS`：清单对不上本身就是失败。
 */

/**
 * probe 的完整用例 id 清单（顺序无关，集合必须恰好相等）：静默丢掉、改名或替换任何一个用例都会失败。
 */
export const EXPECTED_CASE_IDS: readonly string[] = [
  'codec.utf8',
  'codec.utf8-bom',
  'codec.gb18030-common',
  'codec.gb18030-leading-feff',
  'codec.mapping-A6D9',
  'codec.mapping-FE59',
  'codec.mapping-FE61',
  'codec.utf16-le',
  'codec.utf16-be',
  'codec.bom-invalid-utf8',
  'codec.invalid-gb18030 41 80 41',
  'codec.invalid-gb18030 41 FF 41',
  'codec.invalid-gb18030 41 81 30',
  'codec.invalid-gb18030 41 81',
  'codec.invalid-gb18030 41 81 7F 41',
  'codec.invalid-gb18030 84 31 A5 30',
  'codec.invalid-gb18030 E3 32 9A 36',
  'codec.encode-decode utf-8 U+0058 U+003A U+0031 U+000A U+0054 U+003',
  'codec.encode-decode utf-8 U+4E2D U+6587 U+6B4C U+8BCD U+000D U+000',
  'codec.encode-decode utf-8 U+FEFF U+0054 U+003A U+0062 U+006F U+006',
  'codec.encode-decode utf-8 U+1D11E U+0020 U+1F3B5',
  'codec.encode-decode gb18030 U+4E2D U+6587',
  'codec.encode-decode gb18030 U+FEFF U+4E2D',
  'codec.encode-decode gb18030 U+FF21 U+FF22 U+0020 U+5168 U+89D2',
  'codec.encode-decode gb18030 U+1F600',
  'codec.encode-decode gb18030 U+E000',
  'codec.gb18030-to-ascii',
  'codec.gb18030-bytes-valid-utf8',
  'codec.candidate-starts-with-utf8-bom',
  'codec.lone-surrogate-gb18030',
  'file.utf8',
  'file.utf8-bom',
  'file.gb18030',
  'file.gb18030-leading-feff',
  'file.utf16-rejected',
  'file.invalid-gb18030-rejected',
  'file.exact-1mib',
  'file.1mib-plus-1-too-large',
  'file.directory',
  'file.missing',
  'file.symlink-realpath',
  'file.permission-denied',
  'file.allocation-only-on-success',
  'file.zero-write',
];

/** 只有这两个用例允许因平台条件跳过（Windows symlink 特权、win32 / root 下的 POSIX 权限）；其余必须执行并通过。 */
export const SKIPPABLE_CASE_IDS: ReadonlySet<string> = new Set(['file.symlink-realpath', 'file.permission-denied']);

export interface ProbeCaseSummary {
  readonly id: string;
  readonly pass: boolean;
  readonly skipped: boolean;
}

export interface ProbeSummary {
  readonly runtime: { readonly electron: string; readonly [key: string]: unknown };
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cases: readonly ProbeCaseSummary[];
}

export type SummaryVerdict =
  | { readonly ok: true; readonly summary: ProbeSummary }
  | { readonly ok: false; readonly problems: readonly string[]; readonly summary: ProbeSummary | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCase(value: unknown): ProbeCaseSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.pass !== 'boolean') return null;
  return { id: value.id, pass: value.pass, skipped: value.skipped === true };
}

/** 解析 stdout 最后一个非空行；任何形状不符都返回 null。 */
export function parseSummary(stdout: string): ProbeSummary | null {
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines[lines.length - 1];
  if (last === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { passed, failed, skipped, runtime, cases } = parsed;
  if (typeof passed !== 'number' || typeof failed !== 'number' || typeof skipped !== 'number') return null;
  if (!isRecord(runtime) || typeof runtime.electron !== 'string' || runtime.electron === '' || !Array.isArray(cases)) return null;
  const parsedCases: ProbeCaseSummary[] = [];
  for (const item of cases) {
    const parsedCase = parseCase(item);
    if (parsedCase === null) return null;
    parsedCases.push(parsedCase);
  }
  return { runtime: { ...runtime, electron: runtime.electron }, passed, failed, skipped, cases: parsedCases };
}

function countProblems(summary: ProbeSummary): string[] {
  const problems: string[] = [];
  const skipped = summary.cases.filter((c) => c.skipped).length;
  const failed = summary.cases.filter((c) => !c.skipped && !c.pass).length;
  const passed = summary.cases.length - skipped - failed;
  if (summary.cases.length !== EXPECTED_CASE_IDS.length) {
    problems.push(`expected ${String(EXPECTED_CASE_IDS.length)} cases, got ${String(summary.cases.length)}`);
  }
  if (summary.passed !== passed || summary.failed !== failed || summary.skipped !== skipped) problems.push('counters disagree with cases');
  return problems;
}

/**
 * 逐用例检查。与 `countProblems` 的数量检查合起来即「id 集合恰为 `EXPECTED_CASE_IDS`」：数量相等且没有缺失，
 * 就不可能有重复或清单外的 id；逐项统计与计数一致，就蕴含 `passed + failed + skipped === cases.length`。
 */
function caseProblems(summary: ProbeSummary): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const item of summary.cases) {
    seen.add(item.id);
    if (item.skipped && !SKIPPABLE_CASE_IDS.has(item.id)) problems.push(`case may not be skipped: ${item.id}`);
    else if (!item.skipped && !item.pass) problems.push(`case failed: ${item.id}`);
  }
  for (const id of EXPECTED_CASE_IDS) {
    if (!seen.has(id)) problems.push(`expected case missing: ${id}`);
  }
  return problems;
}

/** 综合退出码与摘要给出结论；`problems` 为空才算通过。 */
export function judgeProbe(exitCode: number, stdout: string): SummaryVerdict {
  const summary = parseSummary(stdout);
  if (summary === null) {
    const problems = ['missing or invalid JSON summary on the last stdout line'];
    if (exitCode !== 0) problems.push(`probe exited with code ${String(exitCode)}`);
    return { ok: false, problems, summary: null };
  }
  const problems = [...countProblems(summary), ...caseProblems(summary)];
  if (exitCode !== 0) problems.push(`probe exited with code ${String(exitCode)}`);
  return problems.length === 0 ? { ok: true, summary } : { ok: false, problems, summary };
}
