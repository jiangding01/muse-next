/**
 * M2.5 T5 —— 默认路径（不传 `external`）逐字段回归门的**共享计算**（用户裁决 M / 额外裁决 8）。
 *
 * 同一份代码被两处使用：
 * - `scripts/notation/t5-default-golden.ts`：在 `25c3015`（T5 之前）的独立 worktree 里运行，生成
 *   `tests/fixtures/golden/t5-default-layout.sha256.json`；**生成器不是测试，测试永不改写 expected**；
 * - `t5.defaultRegression.test.ts`：在当前代码上重算，与 golden 逐项比对。
 *
 * 覆盖：全部 fixture × 三种记谱（`layoutVoiceAs` 强制，不看 `style`）× 三档宽度（100000 / 960 / 16）；
 * 每项把该 fixture 全部声部的 layout 按键字典序稳定序列化后取 sha256。**不做任何规范化**：任何字段的值
 * 变化都会改变 hash（键的书写顺序不算字段变化）。序列化是**严格**的（review L2）：`-0`、`NaN`、`±Infinity`、
 * 值为 `undefined` 的键、`Map` 都各自编码，不会像裸 `JSON.stringify` 那样被抹平。
 */
import { createHash } from 'node:crypto';

import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { VOICE_NOTATIONS, layoutVoiceAs, matrixMeasurer, matrixScoreFrom } from './renderMatrix.helpers';

export const DEFAULT_GOLDEN_WIDTHS: readonly number[] = [100_000, 960, 16];

export interface DefaultLayoutEntry {
  /** `<fixture>|<width>|<jianpu|tab|staff>` */
  readonly key: string;
  readonly hash: string;
}

/** 键按字典序；`-0` / 非有限数 / `undefined` / `Map` 编码成带标记的值，保证 `JSON.stringify` 不丢信息。 */
function strict(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (typeof value === 'number') return Object.is(value, -0) || !Number.isFinite(value) ? { $number: Object.is(value, -0) ? '-0' : String(value) } : value;
  if (value instanceof Map) return { $map: [...value.entries()].map(([k, v]) => [strict(k), strict(v)]) };
  if (Array.isArray(value)) return value.map(strict);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, strict(v)]));
  }
  return value;
}

export function defaultLayoutEntries(): DefaultLayoutEntry[] {
  const entries: DefaultLayoutEntry[] = [];
  for (const name of fixtureNames) {
    const source = matrixScoreFrom(fixtureBytes(name));
    for (const availableWidth of DEFAULT_GOLDEN_WIDTHS) {
      const ctx = { score: source.score, index: source.index, measurer: matrixMeasurer, availableWidth };
      for (const notation of VOICE_NOTATIONS) {
        const layouts = source.renderScore.voices.map((voice) => layoutVoiceAs(notation, voice, ctx).layout);
        const hash = createHash('sha256').update(JSON.stringify(strict(layouts))).digest('hex');
        entries.push({ key: `${name}|${String(availableWidth)}|${notation}`, hash });
      }
    }
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
