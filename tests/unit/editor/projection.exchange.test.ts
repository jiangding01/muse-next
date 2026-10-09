import { describe, expect, it } from 'vitest';

import { buildProjection, createInitialProjection } from '../../../src/editor/projection/build';
import { applyViewPatchToSource } from '../../../src/editor/projection/viewPatch';
import { applyTextPatch } from '../../../src/editor/text/apply';
import { createPrng, randomText } from './prng';

const FEFF = '\uFEFF';
const SOURCE_ALPHABET = ['a', 'b', '\n', '\r', '\r\n', FEFF, '\u240D'];
const INSERT_ALPHABET = ['x', '\n', FEFF, '\u240D'];

describe('M3 T0 —— SourceProjection 交换律与区间外保持（§6.6，固定种子）', () => {
  it('合法 view 补丁：viewOf(apply(s, sourcePatch)) = applyPatch(viewOf(s), p)，补丁外 source 逐字相等', () => {
    const outcomes = new Map<string, number>();
    for (const seed of [2, 19, 64, 2026]) {
      const prng = createPrng(seed);
      for (let caseIndex = 0; caseIndex < 800; caseIndex += 1) {
        const label = `seed=${String(seed)} case=${String(caseIndex)}`;
        const source = (prng.int(3) === 0 ? FEFF : '') + randomText(prng, SOURCE_ALPHABET, 10);
        const projection = createInitialProjection(source);
        const start = prng.int(projection.view.length + 1);
        const end = start + prng.int(projection.view.length - start + 1);
        const viewPatch = { start, end, text: randomText(prng, INSERT_ALPHABET, 3) };
        const result = applyViewPatchToSource(projection, viewPatch);
        outcomes.set(result.ok ? 'accepted' : result.reason, (outcomes.get(result.ok ? 'accepted' : result.reason) ?? 0) + 1);
        if (!result.ok) continue;

        const expectedView = applyTextPatch(projection.view, viewPatch);
        expect(expectedView.ok, label).toBe(true);
        if (!expectedView.ok) continue;
        const next = result.nextProjection;
        expect(next.view, label).toBe(expectedView.text);
        expect(buildProjection(next.source, projection.frame).view, label).toBe(expectedView.text);

        const { sourcePatch } = result;
        expect(next.source.slice(0, sourcePatch.start), label).toBe(source.slice(0, sourcePatch.start));
        expect(next.source.slice(sourcePatch.start + sourcePatch.text.length), label).toBe(source.slice(sourcePatch.end));
        expect(next.source.startsWith(FEFF), label).toBe(projection.frame.protectedLeadingFeff);
      }
    }
    // 防止空转：随机样本里既有接受也有各类拒绝。
    expect(outcomes.get('accepted') ?? 0).toBeGreaterThan(1000);
    expect(outcomes.get('merges-cr-lf') ?? 0).toBeGreaterThan(0);
    expect(outcomes.get('creates-leading-feff') ?? 0).toBeGreaterThan(0);
  });

  it('空补丁不改变 source', () => {
    for (const source of ['', 'a\r\nb', `${FEFF}a\rb\n`]) {
      const result = applyViewPatchToSource(createInitialProjection(source), { start: 0, end: 0, text: '' });
      expect(result).toMatchObject({ ok: true, nextProjection: { source } });
    }
  });
});
