/**
 * M3 T1a：Electron codec probe 摘要校验的故障注入（防假阳性）。
 *
 * 每个注入场景都必须被 `judgeProbe` 判为失败——尤其是「Electron 没启动 / 没有用例 / 全部跳过 / 计数造假」
 * 这类会让 CI 假绿的输出。
 */

import { describe, expect, it } from 'vitest';

import { EXPECTED_CASE_IDS, judgeProbe, SKIPPABLE_CASE_IDS } from '../../../scripts/m3/electronCodecSummary';

interface RawCase {
  readonly id: string;
  readonly pass: boolean;
  readonly skipped?: true;
}

const RUNTIME = { node: '24.20.0', electron: '44.3.0', icu: '78.2', platform: 'darwin' };

function validCases(): RawCase[] {
  return EXPECTED_CASE_IDS.map((id) => ({ id, pass: true }));
}

/** 一个既不是关键编码主路径、也不允许跳过的普通用例，用来证明每一项检查都单独生效。 */
const ORDINARY = 'codec.invalid-gb18030 41 81 30';
const OTHER_ORDINARY = 'codec.encode-decode gb18030 U+1F600';

function summaryLine(cases: readonly RawCase[], overrides: Record<string, unknown> = {}): string {
  const skipped = cases.filter((c) => c.skipped === true).length;
  const failed = cases.filter((c) => c.skipped !== true && !c.pass).length;
  const body = { runtime: RUNTIME, passed: cases.length - skipped - failed, failed, skipped, cases, ...overrides };
  return `diagnostic noise\n${JSON.stringify(body)}\n`;
}

describe('judgeProbe —— 正常输出', () => {
  it('完整、全部通过、退出码 0 → ok', () => {
    expect(judgeProbe(0, summaryLine(validCases())).ok).toBe(true);
  });

  it('允许跳过的两个平台用例被跳过 → 仍 ok', () => {
    const cases = validCases().map((c) => (SKIPPABLE_CASE_IDS.has(c.id) ? { id: c.id, pass: true, skipped: true as const } : c));
    expect(judgeProbe(0, summaryLine(cases)).ok).toBe(true);
  });
});

describe('judgeProbe —— 故障注入必须失败', () => {
  const cases = validCases();
  const scenarios: readonly (readonly [string, number, string])[] = [
    ['stdout 为空（Electron 未启动）', 0, ''],
    ['最后一行不是 JSON', 0, 'all good\n'],
    ['零用例且计数为 0', 0, summaryLine([])],
    ['计数声称全部通过但 cases 为空', 0, summaryLine([], { passed: EXPECTED_CASE_IDS.length })],
    ['缺少 runtime.electron（在普通 Node 中运行）', 0, summaryLine(cases, { runtime: { node: '24.16.0' } })],
    ['runtime.electron 为空串', 0, summaryLine(cases, { runtime: { ...RUNTIME, electron: '' } })],
    ['少一个普通用例', 0, summaryLine(cases.filter((c) => c.id !== ORDINARY))],
    ['多一个清单外的用例', 0, summaryLine([...cases, { id: 'codec.extra', pass: true }])],
    ['普通用例被改名', 0, summaryLine(cases.map((c) => (c.id === ORDINARY ? { id: `${ORDINARY} renamed`, pass: true } : c)))],
    ['计数与 cases 逐项统计不一致', 0, summaryLine(cases, { passed: EXPECTED_CASE_IDS.length - 1, skipped: 1 })],
    ['计数之和与 cases 数量不一致', 0, summaryLine(cases, { passed: EXPECTED_CASE_IDS.length + 1 })],
    ['普通用例失败、退出码 0', 0, summaryLine(cases.map((c) => (c.id === ORDINARY ? { id: c.id, pass: false } : c)))],
    ['关键用例失败', 0, summaryLine(cases.map((c) => (c.id === 'codec.mapping-A6D9' ? { id: c.id, pass: false } : c)))],
    ['关键用例被跳过', 0, summaryLine(cases.map((c) => (c.id === 'codec.invalid-gb18030 41 80 41' ? { id: c.id, pass: true, skipped: true as const } : c)))],
    ['普通、不可跳过的用例被跳过', 0, summaryLine(cases.map((c) => (c.id === ORDINARY ? { id: c.id, pass: true, skipped: true as const } : c)))],
    ['重复的普通用例 id（数量不变）', 0, summaryLine(cases.map((c) => (c.id === OTHER_ORDINARY ? { id: ORDINARY, pass: true } : c)))],
    ['全部跳过', 0, summaryLine(cases.map((c) => ({ id: c.id, pass: true, skipped: true as const })))],
    ['摘要正常但子进程退出码非 0', 2, summaryLine(cases)],
  ];

  it.each(scenarios)('%s', (_label, exitCode, stdout) => {
    expect(judgeProbe(exitCode, stdout).ok).toBe(false);
  });
});
