import { describe, expect, it } from 'vitest';

import { applyTextPatch, applyTextPatches, isPatchInRange } from '../../../src/editor/text/apply';
import type { TextPatch } from '../../../src/editor/text/types';
import { createPrng, randomText } from './prng';

describe('M3 T0 —— TextPatch 应用与逆补丁（§9.2）', () => {
  it('单补丁：替换、插入、删除，并给出逆补丁', () => {
    expect(applyTextPatch('C D E', { start: 2, end: 3, text: 'F' })).toEqual({
      ok: true,
      text: 'C F E',
      inverse: { start: 2, end: 3, text: 'D' },
    });
    expect(applyTextPatch('ab', { start: 1, end: 1, text: 'XY' })).toEqual({
      ok: true,
      text: 'aXYb',
      inverse: { start: 1, end: 3, text: '' },
    });
    expect(applyTextPatch('abc', { start: 0, end: 3, text: '' })).toEqual({
      ok: true,
      text: '',
      inverse: { start: 0, end: 0, text: 'abc' },
    });
  });

  it('越界、倒置、非整数补丁被拒绝（不抛异常）', () => {
    const bad: TextPatch[] = [
      { start: -1, end: 0, text: '' },
      { start: 2, end: 1, text: '' },
      { start: 0, end: 4, text: '' },
      { start: 0.5, end: 1, text: '' },
      { start: Number.NaN, end: 1, text: '' },
    ];
    for (const patch of bad) {
      expect(isPatchInRange('abc', patch)).toBe(false);
      expect(applyTextPatch('abc', patch)).toEqual({ ok: false, reason: 'patch-out-of-range', patchIndex: 0 });
    }
  });

  it('多补丁按顺序应用：第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本', () => {
    // 第一个补丁后文本为 'XYbcd'，第二个补丁 [3,4) 删的是 'c'；若错误地按原文坐标解释，删的会是原文的 'd'，得到 'XYbc'。
    const result = applyTextPatches('abcd', [
      { start: 0, end: 1, text: 'XY' },
      { start: 3, end: 4, text: '' },
    ]);
    expect(result).toEqual({
      ok: true,
      text: 'XYbd',
      inverse: [
        { start: 3, end: 3, text: 'c' },
        { start: 0, end: 2, text: 'a' },
      ],
    });
  });

  it('多补丁中任一越界则整组拒绝，并报告出错补丁下标', () => {
    expect(
      applyTextPatches('abc', [
        { start: 0, end: 1, text: '' },
        { start: 2, end: 3, text: '' },
      ]),
    ).toEqual({ ok: false, reason: 'patch-out-of-range', patchIndex: 1 });
  });

  it('性质：任意顺序补丁序列，apply(inverse(apply(s, ps))) = s（固定种子）', () => {
    const alphabet = ['a', 'b', '\n', '\r', '\uFEFF', '\u240D', '😀'];
    for (const seed of [1, 7, 42, 2026]) {
      const prng = createPrng(seed);
      for (let caseIndex = 0; caseIndex < 400; caseIndex += 1) {
        const source = randomText(prng, alphabet, 12);
        let text = source;
        const patches: TextPatch[] = [];
        for (let k = prng.int(4) + 1; k > 0; k -= 1) {
          const start = prng.int(text.length + 1);
          const end = start + prng.int(text.length - start + 1);
          const patch = { start, end, text: randomText(prng, alphabet, 3) };
          patches.push(patch);
          const step = applyTextPatch(text, patch);
          if (!step.ok) throw new Error(`seed=${String(seed)} case=${String(caseIndex)} 生成了越界补丁`);
          text = step.text;
        }
        const forward = applyTextPatches(source, patches);
        expect(forward, `seed=${String(seed)} case=${String(caseIndex)}`).toMatchObject({ ok: true, text });
        if (!forward.ok) continue;
        const back = applyTextPatches(forward.text, forward.inverse);
        expect(back, `seed=${String(seed)} case=${String(caseIndex)}`).toMatchObject({ ok: true, text: source });
      }
    }
  });
});
