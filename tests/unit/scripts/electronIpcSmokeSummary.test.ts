/**
 * M3 T1b-2b-1：真实窗口 IPC smoke 判定器的防假阳性测试（故障注入）。
 * M3 T1c-1：清单增加安全用例（`risk.subframe-parent-bridge` 收紧为 pass、`security.subframe-control`、5 个 `prod.*`）；判定规则不变。
 */

import { describe, expect, it } from 'vitest';

import { expectedModes, judgeIpcSmoke, RESULT_PREFIX, SMOKE_CASES } from '../../../scripts/m3/electronIpcSmokeSummary';
import { describeValue, expectEqual } from '../../electron/ipcSmoke/context';
import type { ChildOutcome, SmokePlatform, SmokeStatus } from '../../../scripts/m3/electronIpcSmokeSummary';

const NONCE = 'nonce-1';

interface CaseEntry {
  id: string;
  status: SmokeStatus;
  detail?: string;
}

function runtime(platform: SmokePlatform): Record<string, unknown> {
  return { electron: '44.3.0', chrome: '152', node: '24.20.0', platform, runAsNode: false };
}

function sandbox(): Record<string, unknown> {
  return {
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    rendererSandboxed: true,
    method: 'app.getAppMetrics().sandboxed',
    sandboxDisabledBySwitch: false,
    pageHasRequire: false,
    pageHasProcess: false,
  };
}

/** 一个平台的全部合格用例条目，按模式分组。 */
function goodCases(platform: SmokePlatform): Map<string, CaseEntry[]> {
  const byMode = new Map<string, CaseEntry[]>(expectedModes(platform).map((mode) => [mode, []]));
  for (const spec of SMOKE_CASES) {
    const expectation = spec.expect[platform];
    if (expectation === undefined) continue;
    const entry: CaseEntry = expectation === 'observe' ? { id: spec.id, status: 'observed', detail: '{"fact":1}' } : { id: spec.id, status: 'passed' };
    byMode.get(spec.mode === 'matrix' ? 'matrix' : spec.id)?.push(entry);
  }
  return byMode;
}

function line(payload: Record<string, unknown>): string {
  return `${RESULT_PREFIX}${JSON.stringify(payload)}\n`;
}

/** `cases` 用 unknown：反例需要注入畸形条目。 */
function outcome(mode: string, cases: readonly unknown[], platform: SmokePlatform, patch: Record<string, unknown> = {}): ChildOutcome {
  const stdout = line({ nonce: NONCE, mode, runtime: runtime(platform), sandbox: sandbox(), cases, ...patch });
  return { mode, exitCode: 0, signal: null, timedOut: false, spawnError: null, stdout };
}

function goodOutcomes(platform: SmokePlatform): ChildOutcome[] {
  return [...goodCases(platform)].map(([mode, cases]) => outcome(mode, cases, platform));
}

/** 改写某个模式的子进程结果。 */
function withChild(platform: SmokePlatform, mode: string, change: (child: ChildOutcome, cases: CaseEntry[]) => ChildOutcome): ChildOutcome[] {
  const groups = goodCases(platform);
  return [...groups].map(([m, cases]) => (m === mode ? change(outcome(m, cases, platform), cases) : outcome(m, cases, platform)));
}

const problemsOf = (outcomes: ChildOutcome[], platform: SmokePlatform = 'darwin'): readonly string[] => judgeIpcSmoke(platform, NONCE, outcomes).problems;

describe('electronIpcSmokeSummary —— 清单', () => {
  it('用例 id 唯一；每个用例至少在一个平台运行；HIGH-1 / early-ipc / orphan / final 都在清单里', () => {
    const ids = SMOKE_CASES.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of SMOKE_CASES) expect(Object.keys(spec.expect).length).toBeGreaterThan(0);
    for (const id of ['nav.race-start-commit', 'nav.early-ipc', 'dialog.orphaned', 'final.invariants', 'env.sandbox', 'bridge.no-auto-activate']) {
      expect(ids).toContain(id);
    }
  });

  it('Linux forceCrash 风险：只在 Linux 的独立子进程、只观测；crash.renderer-gone 三平台仍为 pass；各平台用例数固定', () => {
    expect(SMOKE_CASES.find((s) => s.id === 'risk.linux-force-crash-stall')).toEqual({ id: 'risk.linux-force-crash-stall', mode: 'isolated', expect: { linux: 'observe' } });
    expect(SMOKE_CASES.find((s) => s.id === 'crash.renderer-gone')?.expect).toEqual({ darwin: 'pass', win32: 'pass', linux: 'pass' });
    expect(expectedModes('linux')).toContain('risk.linux-force-crash-stall');
    expect(expectedModes('darwin')).not.toContain('risk.linux-force-crash-stall');
    expect(expectedModes('win32')).not.toContain('risk.linux-force-crash-stall');
    const count = (platform: SmokePlatform): number => SMOKE_CASES.filter((s) => s.expect[platform] !== undefined).length;
    // M3 T3b：新增 5 个 ui.* 菜单 / 按键用例（三平台 pass；用户授权的最小修改）。
    expect([count('darwin'), count('win32'), count('linux')]).toEqual([63, 66, 64]);
  });

  it('M3 T1c-1 安全用例：子 frame 风险已是 pass 硬门；对照在 matrix；prod.* 各占独立子进程且三平台 pass；全清单只剩已裁决的 observe', () => {
    expect(SMOKE_CASES.find((s) => s.id === 'risk.subframe-parent-bridge')).toEqual({ id: 'risk.subframe-parent-bridge', mode: 'matrix', expect: { darwin: 'pass', win32: 'pass', linux: 'pass' } });
    expect(SMOKE_CASES.find((s) => s.id === 'security.subframe-control')).toEqual({ id: 'security.subframe-control', mode: 'matrix', expect: { darwin: 'pass', win32: 'pass', linux: 'pass' } });
    const production = SMOKE_CASES.filter((s) => s.id.startsWith('prod.'));
    expect(production.map((s) => s.id)).toEqual(['prod.renderer-loads', 'prod.popup-denied', 'prod.subframe-blocked', 'prod.inline-script-blocked', 'prod.navigation-blocked']);
    for (const spec of production) expect(spec).toEqual({ id: spec.id, mode: 'isolated', expect: { darwin: 'pass', win32: 'pass', linux: 'pass' } });
    for (const platform of ['darwin', 'win32', 'linux'] as const) for (const spec of production) expect(expectedModes(platform)).toContain(spec.id);
    const observed = (platform: SmokePlatform): string[] => SMOKE_CASES.filter((s) => s.expect[platform] === 'observe').map((s) => s.id);
    expect(observed('darwin')).toEqual([]);
    expect(observed('win32')).toEqual(['real.close-settles', 'real.reload-keeps-dialog', 'real.crash-keeps-dialog', 'real.destroy-isolated']);
    expect(observed('linux')).toEqual(['real.close-settles', 'real.reload-keeps-dialog', 'real.crash-keeps-dialog', 'real.destroy-isolated', 'risk.linux-force-crash-stall']);
  });

  it('M3 T1c-2 生产 UI 用例：ui.* 各占独立子进程且三平台 pass（ui.win-unc 只在 Windows、允许 unverified）', () => {
    const ui = SMOKE_CASES.filter((s) => s.id.startsWith('ui.'));
    expect(ui.map((s) => s.id)).toEqual([
      'ui.open-commit',
      'ui.cancel-keeps',
      'ui.decode-failure-keeps',
      'ui.reload-isolation',
      'ui.staff-render',
      'ui.activation-held-retry',
      'ui.activation-unresolved',
      'ui.win-unc',
      // M3 T3b：菜单、快捷键与命令桥。
      'ui.menu-template',
      'ui.menu-click-dispatch',
      'ui.menu-routing',
      'ui.key-intercept',
      'ui.reload-keys-blocked',
    ]);
    for (const spec of ui) {
      expect(spec.mode).toBe('isolated');
      expect(spec.expect).toEqual(spec.id === 'ui.win-unc' ? { win32: 'pass-or-unverified' } : { darwin: 'pass', win32: 'pass', linux: 'pass' });
    }
    expect(expectedModes('darwin')).not.toContain('ui.win-unc');
    const asObserved = withChild('linux', 'ui.activation-unresolved', (child) => outcome(child.mode, [{ id: 'ui.activation-unresolved', status: 'observed', detail: 'x' }], 'linux'));
    expect(problemsOf(asObserved, 'linux')).toContain('case must pass, got observed: ui.activation-unresolved');
  });

  it('Linux forceCrash 风险：缺失、以 passed 冒充、或出现在非 Linux 平台都失败', () => {
    expect(problemsOf(goodOutcomes('linux').filter((o) => o.mode !== 'risk.linux-force-crash-stall'), 'linux')).toContain('expected case missing: risk.linux-force-crash-stall');
    const asPassed = withChild('linux', 'risk.linux-force-crash-stall', (child) => outcome(child.mode, [{ id: 'risk.linux-force-crash-stall', status: 'passed' }], 'linux'));
    expect(problemsOf(asPassed, 'linux')).toContain('case is observation-only, got passed: risk.linux-force-crash-stall');
    const onDarwin = [...goodOutcomes('darwin'), outcome('risk.linux-force-crash-stall', [{ id: 'risk.linux-force-crash-stall', status: 'observed', detail: '{}' }], 'darwin')];
    expect(problemsOf(onDarwin)).toContain('unexpected child mode risk.linux-force-crash-stall');
  });

  it('真实原生对话框：macOS 为 gate，Windows / Linux 只观测；UNC 只在 Windows，允许 unverified', () => {
    for (const spec of SMOKE_CASES.filter((s) => s.id.startsWith('real.'))) expect(spec.expect).toEqual({ darwin: 'pass', win32: 'observe', linux: 'observe' });
    expect(SMOKE_CASES.find((s) => s.id === 'identity.win-unc')?.expect).toEqual({ win32: 'pass-or-unverified' });
    expect(expectedModes('linux')).not.toContain('identity.win-unc');
    expect(expectedModes('win32')).toContain('identity.win-unc');
  });
});

describe('electronIpcSmokeSummary —— 合格输入', () => {
  it.each<SmokePlatform>(['darwin', 'win32', 'linux'])('%s 全部合格时通过，计数正确', (platform) => {
    const verdict = judgeIpcSmoke(platform, NONCE, goodOutcomes(platform));
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    const expected = SMOKE_CASES.filter((s) => s.expect[platform] !== undefined).length;
    expect(verdict.counts.cases).toBe(expected);
    expect(verdict.counts.passed + verdict.counts.observed).toBe(expected);
    expect(verdict.counts.failed + verdict.counts.skipped + verdict.counts.unverified).toBe(0);
  });

  it('UNC 以 unverified 且写明原因时通过（Windows）', () => {
    const outcomes = withChild('win32', 'identity.win-unc', (child, cases) =>
      outcome(child.mode, cases.map((c) => ({ ...c, status: 'unverified', detail: 'stat EACCES' })), 'win32'),
    );
    const verdict = judgeIpcSmoke('win32', NONCE, outcomes);
    expect(verdict.problems).toEqual([]);
    expect(verdict.counts.unverified).toBe(1);
  });
});

describe('electronIpcSmokeSummary —— 反例（必须失败）', () => {
  const matrixWith = (edit: (cases: CaseEntry[]) => CaseEntry[], platform: SmokePlatform = 'darwin'): readonly string[] =>
    problemsOf(withChild(platform, 'matrix', (child, cases) => outcome(child.mode, edit(cases), platform)), platform);

  it('缺失用例', () => {
    expect(matrixWith((cases) => cases.filter((c) => c.id !== 'nav.race-start-commit'))).toContain('expected case missing: nav.race-start-commit');
  });

  it('重复 id', () => {
    expect(matrixWith((cases) => [...cases, { id: 'open.activate', status: 'passed' }])).toContain('duplicate case: open.activate');
  });

  it('未知 id，以及其它平台专属用例出现在本平台', () => {
    expect(matrixWith((cases) => [...cases, { id: 'open.bonus', status: 'passed' }])).toContain('unknown case for darwin: open.bonus');
    expect(matrixWith((cases) => [...cases, { id: 'identity.win-drive', status: 'passed' }])).toContain('unknown case for darwin: identity.win-drive');
  });

  it('failed 大于零', () => {
    expect(matrixWith((cases) => cases.map((c) => (c.id === 'open.reject' ? { ...c, status: 'failed' } : c)))).toContain('case failed: open.reject');
  });

  it('任何用例都不允许 skip', () => {
    expect(matrixWith((cases) => cases.map((c) => (c.id === 'env.sandbox' ? { ...c, status: 'skipped' } : c)))).toContain('case may not be skipped: env.sandbox');
  });

  it('observed 冒充 pass、pass 冒充 observed、observed 没有事实', () => {
    expect(matrixWith((cases) => cases.map((c) => (c.id === 'open.activate' ? { ...c, status: 'observed', detail: 'x' } : c)))).toContain(
      'case must pass, got observed: open.activate',
    );
    expect(matrixWith((cases) => cases.map((c) => (c.id === 'risk.subframe-parent-bridge' ? { ...c, status: 'observed', detail: 'x' } : c)))).toContain(
      'case must pass, got observed: risk.subframe-parent-bridge',
    );
    const linuxObserve = (entry: CaseEntry): readonly string[] =>
      problemsOf(withChild('linux', 'real.close-settles', (child) => outcome(child.mode, [entry], 'linux')), 'linux');
    expect(linuxObserve({ id: 'real.close-settles', status: 'passed' })).toContain('case is observation-only, got passed: real.close-settles');
    expect(linuxObserve({ id: 'real.close-settles', status: 'observed', detail: ' ' })).toContain('observed case has no recorded facts: real.close-settles');
    const prodAsObserved = withChild('darwin', 'prod.subframe-blocked', (child) => outcome(child.mode, [{ id: 'prod.subframe-blocked', status: 'observed', detail: 'x' }], 'darwin'));
    expect(problemsOf(prodAsObserved)).toContain('case must pass, got observed: prod.subframe-blocked');
  });

  it('macOS 的真实对话框 gate 不能以 observed 通过；Linux 的观测用例不能以 passed 冒充', () => {
    const darwin = withChild('darwin', 'real.close-settles', (child) => outcome(child.mode, [{ id: 'real.close-settles', status: 'observed', detail: '{}' }], 'darwin'));
    expect(problemsOf(darwin)).toContain('case must pass, got observed: real.close-settles');
    const linux = withChild('linux', 'real.close-settles', (child) => outcome(child.mode, [{ id: 'real.close-settles', status: 'passed' }], 'linux'));
    expect(problemsOf(linux, 'linux')).toContain('case is observation-only, got passed: real.close-settles');
  });

  it('unverified 只允许登记过的用例，且必须写明原因', () => {
    expect(matrixWith((cases) => cases.map((c) => (c.id === 'identity.file-url' ? { ...c, status: 'unverified', detail: 'x' } : c)))).toContain(
      'case must pass, got unverified: identity.file-url',
    );
    const noReason = withChild('win32', 'identity.win-unc', (child) => outcome(child.mode, [{ id: 'identity.win-unc', status: 'unverified' }], 'win32'));
    expect(problemsOf(noReason, 'win32')).toContain('unverified case has no reason: identity.win-unc');
  });

  it('非零退出 / 信号 / 超时 / spawn 失败', () => {
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, exitCode: 1 })))).toContain('[matrix] exited with code 1');
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, exitCode: null, signal: 'SIGKILL' })))).toContain('[matrix] terminated by signal SIGKILL');
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, timedOut: true })))).toContain('[matrix] timed out');
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, spawnError: 'ENOENT' })))).toContain('[matrix] spawn failed: ENOENT');
  });

  it('未打印摘要、多条摘要、格式错误、伪造 nonce、模式不符', () => {
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, stdout: 'hello\n' })))).toContain(
      '[matrix] expected exactly one result line, got 0',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, stdout: child.stdout + child.stdout })))).toContain(
      '[matrix] expected exactly one result line, got 2',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, stdout: `${RESULT_PREFIX}{not json\n` })))).toContain(
      '[matrix] result line is not valid JSON',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child) => ({ ...child, stdout: `noise ${child.stdout}` })))).toContain(
      '[matrix] result line is not valid JSON',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child, cases) => outcome(child.mode, cases, 'darwin', { nonce: 'forged' })))).toContain(
      '[matrix] nonce mismatch (forged or stale result)',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child, cases) => outcome(child.mode, cases, 'darwin', { mode: 'real.close-settles' })))).toContain(
      '[matrix] result reports mode real.close-settles',
    );
    expect(problemsOf(withChild('darwin', 'matrix', (child, cases) => outcome(child.mode, [...cases, { id: 'x' }], 'darwin')))).toContain(
      '[matrix] malformed case entry',
    );
  });

  it('runtime / sandbox 证据缺失或不成立', () => {
    const patch = (extra: Record<string, unknown>): readonly string[] => problemsOf(withChild('darwin', 'matrix', (child, cases) => outcome(child.mode, cases, 'darwin', extra)));
    expect(patch({ runtime: null })).toContain('[matrix] runtime missing');
    expect(patch({ runtime: { ...runtime('darwin'), electron: '' } })).toContain('[matrix] runtime.electron missing');
    expect(patch({ runtime: { ...runtime('darwin'), runAsNode: true } })).toContain('[matrix] runtime.runAsNode is not false');
    expect(patch({ runtime: runtime('linux') })).toContain('[matrix] runtime.platform linux is not darwin');
    expect(patch({ sandbox: null })).toContain('[matrix] sandbox evidence missing');
    expect(patch({ sandbox: { ...sandbox(), rendererSandboxed: null } })).toContain('[matrix] renderer OS sandbox not proven');
    expect(patch({ sandbox: { ...sandbox(), sandboxDisabledBySwitch: true } })).toContain('[matrix] sandbox-disabling switch not proven absent');
    expect(patch({ sandbox: { ...sandbox(), webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: true } } })).toContain(
      '[matrix] sandbox webPreferences not { sandbox: true, contextIsolation: true, nodeIntegration: false }',
    );
    expect(patch({ sandbox: { ...sandbox(), pageHasRequire: true } })).toContain('[matrix] page main world exposes require / process');
    expect(patch({ sandbox: { ...sandbox(), method: '' } })).toContain('[matrix] sandbox evidence method missing');
  });

  it('子进程缺失、重复、多余；用例由错误的子进程报告', () => {
    const good = goodOutcomes('darwin');
    expect(problemsOf(good.filter((o) => o.mode !== 'real.destroy-isolated'))).toContain('expected exactly one child for mode real.destroy-isolated, got 0');
    const extra = good.find((o) => o.mode === 'matrix');
    expect(extra).toBeDefined();
    if (extra !== undefined) expect(problemsOf([...good, extra])).toContain('expected exactly one child for mode matrix, got 2');
    expect(problemsOf([...good, outcome('bonus', [], 'darwin')])).toContain('unexpected child mode bonus');
    const moved = withChild('darwin', 'real.close-settles', (child) => outcome(child.mode, [], 'darwin'));
    const withMoved = moved.map((o) => (o.mode === 'matrix' ? outcome('matrix', [...(goodCases('darwin').get('matrix') ?? []), { id: 'real.close-settles', status: 'passed' }], 'darwin') : o));
    expect(problemsOf(withMoved)).toContain('case real.close-settles reported by mode matrix, expected real.close-settles');
  });

  it('不能靠减少清单绕过：任何一个子进程整体缺失都会报告其全部用例缺失', () => {
    const problems = problemsOf(goodOutcomes('darwin').filter((o) => o.mode !== 'matrix'));
    const matrixIds = SMOKE_CASES.filter((s) => s.mode === 'matrix' && s.expect.darwin !== undefined).map((s) => s.id);
    for (const id of matrixIds) expect(problems).toContain(`expected case missing: ${id}`);
  });
});

describe('smoke 断言 expectEqual —— BigInt 与失败信息（CI run 38142547427 回归）', () => {
  const check = (actual: unknown, expected: unknown): string[] => {
    const problems: string[] = [];
    expectEqual(problems, 'v', actual, expected);
    return problems;
  };

  it('含 BigInt 的相同对象判相等', () => {
    expect(check({ dev: 1n, ino: 2n, nested: [3n] }, { dev: 1n, ino: 2n, nested: [3n] })).toEqual([]);
  });

  it('BigInt 不同 → 明确失败且不抛出', () => {
    expect(check({ dev: 1n }, { dev: 2n })).toEqual(['v: expected {"dev":"2n"}, got {"dev":"1n"}']);
  });

  it('actual 为含 BigInt 的能力记录、expected 为 null → 明确报告不相等，且 token / 路径被脱敏', () => {
    const record = { token: 'secret-token', realpath: '/Users/x/a.jcx', displayPath: '/Users/x/a.jcx', lastKnownDiskFingerprint: 'abc', identity: { dev: 5n, ino: 6n } };
    const problems = check(record, null);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('expected null, got');
    expect(problems[0]).toContain('"dev":"5n"');
    expect(problems[0]).not.toMatch(/secret-token|\/Users\/x|abc/);
  });

  it('普通对象、数组、undefined 的比较不受影响', () => {
    expect(check({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toEqual([]);
    expect(check([1, 2], [2, 1])).toHaveLength(1);
    expect(check(undefined, undefined)).toEqual([]);
    expect(check(undefined, null)).toEqual(['v: expected null, got undefined']);
    expect(check({ a: undefined }, {})).toHaveLength(1);
  });

  it('无法格式化的值不会被当成相等，格式化失败也不抛出', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(check(cyclic, null)).toEqual(['v: expected null, got <unprintable object>']);
    expect(describeValue(10n)).toBe('"10n"');
  });
});
