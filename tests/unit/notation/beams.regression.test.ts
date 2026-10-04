/**
 * M2.5 T3.5 —— raw / 缺席 `M:` 强回归门（用户裁决 Q14-a）。
 *
 * golden 由 `scripts/notation/beam-regression-golden.ts` 在 `35f7ad9`（T3.5 之前）的独立 worktree
 * 生成并入库；本测试只读、永不改写。规范化只允许两处变化（去掉新增 `beams` 字段、TAB 扫弦
 * `V/U → ↓/↑`），其余 layout / slots / 宽高 / 诊断 / SVG 必须与基线逐字节一致（见 helper 文件头）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import type { BeamsField } from './beamsRegression.helpers';
import { REGRESSION_VARIANTS, REGRESSION_WIDTHS, regressionEntries, withMeterLine } from './beamsRegression.helpers';

interface Golden {
  readonly generatedFrom: string;
  readonly variants: readonly string[];
  readonly widths: readonly number[];
  readonly count: number;
  readonly hashes: Readonly<Record<string, string>>;
}

function isGolden(value: unknown): value is Golden {
  return value !== null && typeof value === 'object' && 'hashes' in value && 'generatedFrom' in value && 'count' in value;
}

const parsed: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/golden/t35-raw-absent.sha256.json'), 'utf8'),
);
if (!isGolden(parsed)) throw new Error('golden 文件形状不对');
const golden = parsed;
const entries = regressionEntries();

/**
 * `beams` 字段在 raw / 缺席 `M:` 下的形态。T3.5 各内部阶段逐步把它从 `absent` 收紧到 `empty`；
 * 最终两种记谱都必须是 `empty`（字段恒在、恒为 `[]`）。
 */
const EXPECTED_BEAMS_FIELD: Readonly<Record<'tab' | 'jianpu', BeamsField>> = { tab: 'empty', jianpu: 'empty' };

describe('T3.5 I —— raw / 缺席 M: 与 35f7ad9 基线 normalized 逐字段相等', () => {
  it('golden 来自 35f7ad9，覆盖全部 fixture × 3 变体 × 2 宽度，条目数与当前一致', () => {
    expect(golden.generatedFrom).toBe('35f7ad9');
    expect(golden.variants).toEqual(REGRESSION_VARIANTS.map((variant) => variant.id));
    expect(golden.widths).toEqual(REGRESSION_WIDTHS);
    expect(fixtureNames.length).toBeGreaterThan(100);
    expect(entries.length).toBe(golden.count);
    expect(entries.map((entry) => entry.key)).toEqual(Object.keys(golden.hashes).sort());
  });

  it('每个 TAB / 简谱声部的 layout + SVG 规范化 hash 与基线相等', () => {
    const mismatched = entries.filter((entry) => golden.hashes[entry.key] !== entry.hash).map((entry) => entry.key);
    expect(mismatched).toEqual([]);
  });

  it('beams 字段形态符合当前阶段约定（最终：恒在且为 []）', () => {
    const bad = entries
      .filter((entry) => entry.beamsField !== EXPECTED_BEAMS_FIELD[entry.key.endsWith('|tab') ? 'tab' : 'jianpu'])
      .map((entry) => `${entry.key} → ${entry.beamsField}`);
    expect(bad).toEqual([]);
  });

  it('覆盖面不是空的：TAB 与简谱都有条目，且至少一条 TAB 含 V/U 扫弦', () => {
    expect(entries.some((entry) => entry.key.endsWith('|tab'))).toBe(true);
    expect(entries.some((entry) => entry.key.endsWith('|jianpu'))).toBe(true);
    expect(entries.some((entry) => entry.strokeVU)).toBe(true);
  });

  it('变体构造：M: 行被替换 / 删除；没有 M: 时插在 X: 之后', () => {
    const decode = (bytes: Uint8Array): string => Buffer.from(bytes).toString('latin1');
    const src = new Uint8Array(Buffer.from('%MUSE2\r\nX:1\r\nM:4/4\r\nL:1/4\r\nK:C\r\n', 'latin1'));
    expect(decode(withMeterLine(src, 'M:C'))).toBe('%MUSE2\r\nX:1\r\nM:C\r\nL:1/4\r\nK:C\r\n');
    expect(decode(withMeterLine(src, undefined))).toBe('%MUSE2\r\nX:1\r\nL:1/4\r\nK:C\r\n');
    const bare = new Uint8Array(Buffer.from('X:1\nK:C\n', 'latin1'));
    expect(decode(withMeterLine(bare, 'M:C|'))).toBe('X:1\nM:C|\nK:C\n');
  });
});
