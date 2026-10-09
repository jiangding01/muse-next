import { describe, expect, it } from 'vitest';

import { applyTextPatch } from '../../../src/editor/text/apply';
import {
  RANGE_PATCH_RULES,
  classifyRangePatch,
  transformSourceRange,
  transformSourceRangeThrough,
} from '../../../src/editor/text/transform';
import type { RangeBias, SourceRange, TextPatch } from '../../../src/editor/text/types';
import { createPrng, randomText } from './prng';

const EXCLUDE: RangeBias = { start: 'exclude', end: 'exclude', caret: 'after' };
const ABSORB: RangeBias = { start: 'absorb', end: 'absorb', caret: 'before' };
const r = (start: number, end: number): SourceRange => ({ start, end });
const p = (start: number, end: number, text: string): TextPatch => ({ start, end, text });

describe('M3 T0 —— SourceRange 变换规则（§17.2）', () => {
  it('穷举：a ≤ b < 6、ps ≤ pe < 6、L ≤ 2（含空补丁），每个输入恰好命中一条规则', () => {
    let cases = 0;
    for (let a = 0; a < 6; a += 1) {
      for (let b = a; b < 6; b += 1) {
        for (let ps = 0; ps < 6; ps += 1) {
          for (let pe = ps; pe < 6; pe += 1) {
            for (const text of ['', 'x', 'xy']) {
              const facts = { a, b, ps, pe, len: text.length };
              const hits = RANGE_PATCH_RULES.filter((rule) => rule.when(facts)).map((rule) => rule.name);
              expect(hits, `a=${String(a)} b=${String(b)} ps=${String(ps)} pe=${String(pe)} L=${String(text.length)}`).toHaveLength(1);
              expect(classifyRangePatch(r(a, b), p(ps, pe, text))).toBe(hits[0]);
              cases += 1;
            }
          }
        }
      }
    }
    expect(cases).toBe(21 * 21 * 3);
  });

  it('每条规则都至少被穷举命中一次（防止死规则）', () => {
    const seen = new Set<string>();
    for (let a = 0; a < 5; a += 1)
      for (let b = a; b < 5; b += 1)
        for (let ps = 0; ps < 5; ps += 1)
          for (let pe = ps; pe < 5; pe += 1)
            for (const text of ['', 'x']) seen.add(classifyRangePatch(r(a, b), p(ps, pe, text)) ?? 'none');
    expect([...seen].sort()).toEqual(RANGE_PATCH_RULES.map((rule) => rule.name).sort());
  });

  it.each([
    ['before：补丁在范围之前整体平移', r(5, 7), p(1, 2, 'xyz'), EXCLUDE, r(7, 9)],
    ['before：删除恰好结束于起点', r(5, 7), p(3, 5, ''), EXCLUDE, r(3, 5)],
    ['after：补丁在范围之后不变', r(1, 3), p(4, 5, 'x'), EXCLUDE, r(1, 3)],
    ['after：替换恰好从终点开始', r(1, 3), p(3, 5, 'x'), EXCLUDE, r(1, 3)],
    ['insert-inside：内部插入扩张', r(2, 6), p(4, 4, 'xy'), EXCLUDE, r(2, 8)],
    ['insert-at-start + exclude：平移', r(2, 4), p(2, 2, 'xy'), EXCLUDE, r(4, 6)],
    ['insert-at-start + absorb：吸收', r(2, 4), p(2, 2, 'xy'), ABSORB, r(2, 6)],
    ['insert-at-end + exclude：不变', r(2, 4), p(4, 4, 'xy'), EXCLUDE, r(2, 4)],
    ['insert-at-end + absorb：吸收', r(2, 4), p(4, 4, 'xy'), ABSORB, r(2, 6)],
    ['insert-at-caret + after：光标后移', r(3, 3), p(3, 3, 'xy'), EXCLUDE, r(5, 5)],
    ['insert-at-caret + before：光标不动', r(3, 3), p(3, 3, 'xy'), ABSORB, r(3, 3)],
    ['replace-overlap：补丁在范围内部', r(2, 8), p(4, 5, 'xyz'), EXCLUDE, r(2, 10)],
    ['replace-overlap：补丁覆盖整个范围 → 范围即替换文本', r(3, 5), p(2, 6, 'xy'), EXCLUDE, r(2, 4)],
    ['replace-overlap：左侧部分重叠', r(3, 6), p(1, 4, 'x'), EXCLUDE, r(1, 4)],
    ['replace-overlap：右侧部分重叠', r(3, 6), p(5, 8, 'x'), EXCLUDE, r(3, 6)],
    ['delete-partial：左侧部分删除', r(3, 6), p(1, 4, ''), EXCLUDE, r(1, 3)],
    ['delete-partial：右侧部分删除', r(3, 6), p(5, 8, ''), EXCLUDE, r(3, 5)],
    ['delete-partial：内部删除', r(2, 8), p(4, 5, ''), EXCLUDE, r(2, 7)],
    ['caret-inside：替换内部的光标折叠到替换文本之后', r(4, 4), p(2, 6, 'xy'), EXCLUDE, r(4, 4)],
    ['caret-inside：删除内部的光标折叠到删除点', r(4, 4), p(2, 6, ''), EXCLUDE, r(2, 2)],
    ['noop：空补丁不改变范围', r(2, 4), p(3, 3, ''), EXCLUDE, r(2, 4)],
  ])('%s', (_name, range, patch, bias, expected) => {
    expect(transformSourceRange(range, patch, bias)).toEqual({ kind: 'mapped', range: expected });
  });

  it('非空 replacement 不清空被编辑的音：C → D 与 C, → D 都得到 [10,11)', () => {
    expect(transformSourceRange(r(10, 11), p(10, 11, 'D'), EXCLUDE)).toEqual({ kind: 'mapped', range: r(10, 11) });
    expect(transformSourceRange(r(10, 12), p(10, 12, 'D'), EXCLUDE)).toEqual({ kind: 'mapped', range: r(10, 11) });
    // 只替换升降号之后的内部片段（`^C,` 中的 `C,`）：范围随长度变化伸缩。
    expect(transformSourceRange(r(10, 13), p(11, 13, 'D'), EXCLUDE)).toEqual({ kind: 'mapped', range: r(10, 12) });
  });

  it('只有纯删除整体覆盖非空范围才是 covered（删除点即折叠位置）', () => {
    expect(transformSourceRange(r(3, 5), p(2, 6, ''), EXCLUDE)).toEqual({ kind: 'covered', collapseAt: 2 });
    expect(transformSourceRange(r(3, 5), p(3, 5, ''), EXCLUDE)).toEqual({ kind: 'covered', collapseAt: 3 });
    expect(transformSourceRange(r(3, 5), p(3, 5, 'x'), EXCLUDE).kind).toBe('mapped');
  });

  it('多补丁按顺序变换；被覆盖后删除点继续随后续补丁移动', () => {
    expect(transformSourceRangeThrough(r(4, 6), [p(0, 0, 'ab'), p(0, 1, '')], EXCLUDE)).toEqual({
      kind: 'mapped',
      range: r(5, 7),
    });
    expect(transformSourceRangeThrough(r(4, 6), [p(3, 7, ''), p(0, 0, 'xyz')], EXCLUDE)).toEqual({
      kind: 'covered',
      collapseAt: 6,
    });
  });

  it('畸形输入返回 invalid，不抛异常', () => {
    expect(transformSourceRange(r(3, 2), p(0, 0, 'x'), EXCLUDE)).toEqual({ kind: 'invalid', reason: 'range-malformed' });
    expect(transformSourceRange(r(1, 2), p(3, 2, 'x'), EXCLUDE)).toEqual({ kind: 'invalid', reason: 'patch-malformed' });
    expect(transformSourceRange(r(-1, 2), p(0, 0, 'x'), EXCLUDE).kind).toBe('invalid');
  });

  it('性质：平移 / 不变情形下范围内文本逐字保持；替换重叠时结果覆盖整个替换文本（固定种子）', () => {
    for (const seed of [3, 11, 99]) {
      const prng = createPrng(seed);
      for (let caseIndex = 0; caseIndex < 600; caseIndex += 1) {
        const label = `seed=${String(seed)} case=${String(caseIndex)}`;
        const source = randomText(prng, ['a', 'b', 'c', 'd'], 10);
        const a = prng.int(source.length + 1);
        const b = a + prng.int(source.length - a + 1);
        const ps = prng.int(source.length + 1);
        const pe = ps + prng.int(source.length - ps + 1);
        const patch = p(ps, pe, randomText(prng, ['X', 'Y'], 3));
        const applied = applyTextPatch(source, patch);
        if (!applied.ok) throw new Error(label);
        const outcome = transformSourceRange(r(a, b), patch, prng.pick([EXCLUDE, ABSORB]));
        const kind = classifyRangePatch(r(a, b), patch);
        expect(kind, label).toBeDefined();
        if (outcome.kind === 'covered') {
          expect(kind, label).toBe('delete-covering');
          continue;
        }
        expect(outcome.kind, label).toBe('mapped');
        if (outcome.kind !== 'mapped') continue;
        const { start, end } = outcome.range;
        expect(0 <= start && start <= end && end <= applied.text.length, label).toBe(true);
        if (kind === 'before' || kind === 'after' || kind === 'noop') {
          expect(applied.text.slice(start, end), label).toBe(source.slice(a, b));
        }
        if (kind === 'replace-overlap') {
          expect(start <= ps && end >= ps + patch.text.length, label).toBe(true);
        }
      }
    }
  });
});
