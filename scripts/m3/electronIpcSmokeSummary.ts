/**
 * 真实窗口 IPC smoke 结果的防假阳性判定（M3 T1b-2b-1）。纯函数，供 `electronIpcSmoke.ts` 使用并由单元测试做故障注入。
 *
 * 每个 Electron 子进程（`matrix` 与每个独立用例）在 stdout 输出恰好一行 `MUSE_IPC_SMOKE_RESULT <json>`。只有同时满足以下条件才通过：
 * - 本平台应运行的每个模式恰好一个子进程结果；子进程正常退出（退出码 0、非信号、未超时、spawn 成功）；
 * - 结果行恰好一行、JSON 合法、nonce 与本次运行一致、mode 一致；runtime 证明在 Electron 主进程中运行（不是 RunAsNode）、平台一致；
 *   sandbox 证据完整（配置 + 渲染进程的 OS 级沙箱证据、无关闭沙箱的开关、页面无 require / process）；
 * - 用例 id 集合恰为本平台的预期清单（无缺失、无重复、无未知、模式归属正确）；
 * - `pass` 用例必须 `passed`；`observe` 用例必须 `observed` 且有事实说明（observed 与 passed 互不冒充）；
 *   `pass-or-unverified` 用例为 `passed`，或 `unverified` 且写明原因；任何用例都不允许 `skipped`；`failed` 必须为 0。
 *
 * 增删或改名用例时必须同步更新 `SMOKE_CASES`：清单对不上本身就是失败。
 */

export type SmokePlatform = 'darwin' | 'win32' | 'linux';
export type Expectation = 'pass' | 'observe' | 'pass-or-unverified';
export type SmokeStatus = 'passed' | 'failed' | 'observed' | 'unverified' | 'skipped';

export interface CaseSpec {
  readonly id: string;
  /** `matrix`：在共享的自动化子进程中运行；`isolated`：在以用例 id 为模式的独立子进程中运行。 */
  readonly mode: 'matrix' | 'isolated';
  /** 未列出的平台不运行该用例（出现即为未知用例）。 */
  readonly expect: Readonly<Partial<Record<SmokePlatform, Expectation>>>;
}

const ALL_PASS = { darwin: 'pass', win32: 'pass', linux: 'pass' } as const;
const ALL_OBSERVE = { darwin: 'observe', win32: 'observe', linux: 'observe' } as const;
/** 真实原生对话框：macOS 为 gate；Windows / Linux 首轮只做完整观测。 */
const REAL_DIALOG = { darwin: 'pass', win32: 'observe', linux: 'observe' } as const;

const matrix = (id: string, expect: CaseSpec['expect'] = ALL_PASS): CaseSpec => ({ id, mode: 'matrix', expect });
const isolated = (id: string, expect: CaseSpec['expect']): CaseSpec => ({ id, mode: 'isolated', expect });

export const SMOKE_CASES: readonly CaseSpec[] = [
  matrix('env.runtime'),
  matrix('env.sandbox'),
  matrix('bridge.surface'),
  matrix('bridge.no-auto-activate'),
  matrix('identity.file-url'),
  matrix('identity.query'),
  matrix('identity.hash'),
  matrix('identity.win-drive', { win32: 'pass' }),
  isolated('identity.win-unc', { win32: 'pass-or-unverified' }),
  matrix('open.activate'),
  matrix('open.wrong-document'),
  matrix('open.activate-idempotent'),
  matrix('open.reject'),
  matrix('open.reject-after-activate'),
  matrix('open.replace-active'),
  matrix('open.cancel-keeps-active'),
  matrix('open.decode-failure-keeps-active'),
  matrix('open.relative-path'),
  matrix('open.chooser-throws'),
  matrix('open.chooser-rejects'),
  matrix('open.fs-error-hidden'),
  matrix('open.pipeline-throws'),
  matrix('open.ttl-expiry'),
  matrix('open.ttl-starts-at-registration'),
  matrix('nav.reload-clears'),
  matrix('nav.same-document'),
  matrix('nav.foreign-page'),
  matrix('nav.race-start-commit'),
  matrix('nav.early-ipc'),
  matrix('crash.renderer-gone'),
  matrix('close.disposes-owner'),
  matrix('reject.subframe'),
  matrix('reject.unattached-window'),
  matrix('reject.bad-payload'),
  matrix('reject.cross-window-token'),
  matrix('reject.forged-capability'),
  matrix('risk.subframe-parent-bridge', ALL_OBSERVE),
  matrix('dialog.logical-busy'),
  matrix('dialog.same-window-after-reload'),
  matrix('dialog.cross-window'),
  matrix('dialog.parent-window'),
  matrix('dialog.orphaned'),
  matrix('final.invariants'),
  isolated('real.close-settles', REAL_DIALOG),
  isolated('real.reload-keeps-dialog', REAL_DIALOG),
  isolated('real.crash-keeps-dialog', REAL_DIALOG),
  isolated('real.destroy-isolated', REAL_DIALOG),
];

export const RESULT_PREFIX = 'MUSE_IPC_SMOKE_RESULT ';

export function isSmokePlatform(value: string): value is SmokePlatform {
  return value === 'darwin' || value === 'win32' || value === 'linux';
}

/** 本平台应运行的子进程模式：`matrix` + 每个本平台的独立用例。 */
export function expectedModes(platform: SmokePlatform): string[] {
  return ['matrix', ...SMOKE_CASES.filter((spec) => spec.mode === 'isolated' && spec.expect[platform] !== undefined).map((spec) => spec.id)];
}

export interface ChildOutcome {
  readonly mode: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly spawnError: string | null;
  readonly stdout: string;
}

export interface JudgedCase {
  readonly id: string;
  readonly mode: string;
  readonly status: SmokeStatus;
  readonly detail: string;
}

export interface ChildReport {
  readonly mode: string;
  readonly runtime: Record<string, unknown> | null;
  readonly sandbox: Record<string, unknown> | null;
}

export interface SmokeCounts {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly observed: number;
  readonly unverified: number;
}

export interface SmokeVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
  readonly cases: readonly JudgedCase[];
  readonly children: readonly ChildReport[];
  readonly counts: SmokeCounts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'observed', 'unverified', 'skipped']);

function isStatus(value: unknown): value is SmokeStatus {
  return typeof value === 'string' && STATUSES.has(value);
}

function runtimeProblems(runtime: unknown, platform: SmokePlatform): string[] {
  if (!isRecord(runtime)) return ['runtime missing'];
  const problems: string[] = [];
  for (const key of ['electron', 'chrome', 'node']) {
    if (typeof runtime[key] !== 'string' || runtime[key] === '') problems.push(`runtime.${key} missing`);
  }
  if (runtime.platform !== platform) problems.push(`runtime.platform ${String(runtime.platform)} is not ${platform}`);
  if (runtime.runAsNode !== false) problems.push('runtime.runAsNode is not false');
  return problems;
}

function sandboxProblems(sandbox: unknown): string[] {
  if (!isRecord(sandbox)) return ['sandbox evidence missing'];
  const problems: string[] = [];
  const prefs = sandbox.webPreferences;
  if (!isRecord(prefs) || prefs.sandbox !== true || prefs.contextIsolation !== true || prefs.nodeIntegration !== false) {
    problems.push('sandbox webPreferences not { sandbox: true, contextIsolation: true, nodeIntegration: false }');
  }
  if (sandbox.rendererSandboxed !== true) problems.push('renderer OS sandbox not proven');
  if (typeof sandbox.method !== 'string' || sandbox.method === '') problems.push('sandbox evidence method missing');
  if (sandbox.sandboxDisabledBySwitch !== false) problems.push('sandbox-disabling switch not proven absent');
  if (sandbox.pageHasRequire !== false || sandbox.pageHasProcess !== false) problems.push('page main world exposes require / process');
  return problems;
}

interface ParsedChild {
  readonly report: ChildReport;
  readonly cases: readonly JudgedCase[];
  readonly problems: readonly string[];
}

function parseChild(outcome: ChildOutcome, platform: SmokePlatform, nonce: string): ParsedChild {
  const tag = `[${outcome.mode}]`;
  const problems: string[] = [];
  if (outcome.spawnError !== null) problems.push(`${tag} spawn failed: ${outcome.spawnError}`);
  if (outcome.timedOut) problems.push(`${tag} timed out`);
  if (outcome.signal !== null) problems.push(`${tag} terminated by signal ${outcome.signal}`);
  if (outcome.exitCode !== 0) problems.push(`${tag} exited with code ${String(outcome.exitCode)}`);
  const lines = outcome.stdout.split(/\r?\n/).filter((line) => line.includes(RESULT_PREFIX.trim()));
  const empty: ParsedChild = { report: { mode: outcome.mode, runtime: null, sandbox: null }, cases: [], problems };
  if (lines.length !== 1) {
    problems.push(`${tag} expected exactly one result line, got ${String(lines.length)}`);
    return empty;
  }
  const line = lines[0] ?? '';
  let parsed: unknown;
  try {
    parsed = line.startsWith(RESULT_PREFIX) ? JSON.parse(line.slice(RESULT_PREFIX.length)) : null;
  } catch {
    parsed = null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.cases)) {
    problems.push(`${tag} result line is not valid JSON`);
    return empty;
  }
  if (parsed.nonce !== nonce) problems.push(`${tag} nonce mismatch (forged or stale result)`);
  if (parsed.mode !== outcome.mode) problems.push(`${tag} result reports mode ${String(parsed.mode)}`);
  problems.push(...runtimeProblems(parsed.runtime, platform).map((p) => `${tag} ${p}`));
  problems.push(...sandboxProblems(parsed.sandbox).map((p) => `${tag} ${p}`));
  const cases: JudgedCase[] = [];
  for (const item of parsed.cases) {
    if (!isRecord(item) || typeof item.id !== 'string' || !isStatus(item.status) || (item.detail !== undefined && typeof item.detail !== 'string')) {
      problems.push(`${tag} malformed case entry`);
      continue;
    }
    cases.push({ id: item.id, mode: outcome.mode, status: item.status, detail: typeof item.detail === 'string' ? item.detail : '' });
  }
  const runtime = isRecord(parsed.runtime) ? parsed.runtime : null;
  const sandbox = isRecord(parsed.sandbox) ? parsed.sandbox : null;
  return { report: { mode: outcome.mode, runtime, sandbox }, cases, problems };
}

function statusProblem(spec: CaseSpec, expectation: Expectation, item: JudgedCase): string | null {
  if (item.status === 'skipped') return `case may not be skipped: ${item.id}`;
  if (item.status === 'failed') return `case failed: ${item.id}`;
  if (expectation === 'pass') return item.status === 'passed' ? null : `case must pass, got ${item.status}: ${item.id}`;
  if (expectation === 'observe') {
    if (item.status !== 'observed') return `case is observation-only, got ${item.status}: ${item.id}`;
    return item.detail.trim() === '' ? `observed case has no recorded facts: ${spec.id}` : null;
  }
  if (item.status === 'passed') return null;
  if (item.status === 'unverified') return item.detail.trim() === '' ? `unverified case has no reason: ${item.id}` : null;
  return `case must pass or be unverified, got ${item.status}: ${item.id}`;
}

function count(cases: readonly JudgedCase[], status: SmokeStatus): number {
  return cases.filter((item) => item.status === status).length;
}

/** 综合全部子进程结果给出结论；`problems` 为空才算通过。 */
export function judgeIpcSmoke(platform: SmokePlatform, nonce: string, outcomes: readonly ChildOutcome[]): SmokeVerdict {
  const problems: string[] = [];
  const modes = expectedModes(platform);
  for (const mode of modes) {
    const n = outcomes.filter((outcome) => outcome.mode === mode).length;
    if (n !== 1) problems.push(`expected exactly one child for mode ${mode}, got ${String(n)}`);
  }
  for (const outcome of outcomes) {
    if (!modes.includes(outcome.mode)) problems.push(`unexpected child mode ${outcome.mode}`);
  }
  const children = outcomes.map((outcome) => parseChild(outcome, platform, nonce));
  const cases = children.flatMap((child) => child.cases);
  problems.push(...children.flatMap((child) => child.problems));

  const seen = new Set<string>();
  for (const item of cases) {
    const spec = SMOKE_CASES.find((candidate) => candidate.id === item.id);
    const expectation = spec?.expect[platform];
    if (seen.has(item.id)) problems.push(`duplicate case: ${item.id}`);
    seen.add(item.id);
    if (spec === undefined || expectation === undefined) {
      problems.push(`unknown case for ${platform}: ${item.id}`);
      continue;
    }
    const expectedMode = spec.mode === 'matrix' ? 'matrix' : spec.id;
    if (item.mode !== expectedMode) problems.push(`case ${item.id} reported by mode ${item.mode}, expected ${expectedMode}`);
    const problem = statusProblem(spec, expectation, item);
    if (problem !== null) problems.push(problem);
  }
  for (const spec of SMOKE_CASES) {
    if (spec.expect[platform] !== undefined && !seen.has(spec.id)) problems.push(`expected case missing: ${spec.id}`);
  }

  const counts: SmokeCounts = {
    cases: cases.length,
    passed: count(cases, 'passed'),
    failed: count(cases, 'failed'),
    skipped: count(cases, 'skipped'),
    observed: count(cases, 'observed'),
    unverified: count(cases, 'unverified'),
  };
  return { ok: problems.length === 0, problems, cases, children: children.map((child) => child.report), counts };
}
