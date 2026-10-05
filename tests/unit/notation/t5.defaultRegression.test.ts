/**
 * M2.5 T5 —— 默认路径（不传 `external`）与 `25c3015` 逐字段相等（用户裁决 M / 额外裁决 8）。
 *
 * golden 由 `scripts/notation/t5-default-golden.ts` 在 `25c3015` 的独立 worktree 生成并入库；本测试只读、
 * 永不改写，也不做任何规范化（覆盖范围见 `t5DefaultLayout.helpers.ts` 文件头）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { VOICE_NOTATIONS } from './renderMatrix.helpers';
import { DEFAULT_GOLDEN_WIDTHS, defaultLayoutEntries } from './t5DefaultLayout.helpers';

interface Golden {
  readonly generatedFrom: string;
  readonly widths: readonly number[];
  readonly count: number;
  readonly hashes: Readonly<Record<string, string>>;
}

function isGolden(value: unknown): value is Golden {
  return value !== null && typeof value === 'object' && 'hashes' in value && 'generatedFrom' in value && 'count' in value && 'widths' in value;
}

const parsed: unknown = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../fixtures/golden/t5-default-layout.sha256.json'), 'utf8'),
);
if (!isGolden(parsed)) throw new Error('golden 文件形状不对');
const golden = parsed;
const entries = defaultLayoutEntries();

describe('T5 —— 默认路径与 25c3015 逐字段相等', () => {
  it('golden 来自 25c3015，覆盖全部 fixture × 3 记谱 × 3 宽度，键集合与当前一致', () => {
    expect(golden.generatedFrom).toBe('25c3015');
    expect(golden.widths).toEqual(DEFAULT_GOLDEN_WIDTHS);
    expect(fixtureNames.length).toBeGreaterThan(100);
    expect(entries.length).toBe(fixtureNames.length * VOICE_NOTATIONS.length * DEFAULT_GOLDEN_WIDTHS.length);
    expect(entries.length).toBe(golden.count);
    expect(entries.map((entry) => entry.key)).toEqual(Object.keys(golden.hashes).sort());
  });

  it('每一项 layout 的 sha256 与 golden 相同', () => {
    const drifted = entries.filter((entry) => golden.hashes[entry.key] !== entry.hash).map((entry) => entry.key);
    expect(drifted).toEqual([]);
  });
});
