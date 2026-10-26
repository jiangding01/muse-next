/**
 * M3 T3c：字素簇边界（`src/renderer/app/editor/graphemes.ts`；方案 §9.1，Q-C2 保持字素簇口径）。
 */

import { describe, expect, it } from 'vitest';

import { nextGraphemeEnd, previousGraphemeStart } from '../../../src/renderer/app/editor/graphemes';

describe('graphemes —— 光标前后一个字素簇', () => {
  it.each([
    ['ASCII', 'abc', 3, 2],
    ['代理对 emoji', '😀a', 2, 0],
    ['组合符序列（与原生只删一个码点不同）', 'é', 2, 0],
    ['ZWJ 家庭 emoji', '👨‍👩‍👧x', 8, 0],
    ['区域旗帜', '🇨🇳', 4, 0],
    ['孤立 CR 占位符自成一簇', 'a␍b', 2, 1],
    ['view 中的换行自成一簇', 'a\nb', 2, 1],
    ['中文', '你好', 2, 1],
  ])('%s：previousGraphemeStart', (_name, text, offset, expected) => {
    expect(previousGraphemeStart(text, offset)).toBe(expected);
  });

  it.each([
    ['ASCII', 'abc', 0, 1],
    ['代理对 emoji', 'a😀', 1, 3],
    ['组合符序列', 'éx', 0, 2],
    ['ZWJ 家庭 emoji', '👨‍👩‍👧x', 0, 8],
    ['区域旗帜', '🇨🇳a', 0, 4],
    ['view 中的换行', 'a\nb', 1, 2],
  ])('%s：nextGraphemeEnd', (_name, text, offset, expected) => {
    expect(nextGraphemeEnd(text, offset)).toBe(expected);
  });

  it('边界：开头的 previous 与末尾的 next 不越界', () => {
    expect(previousGraphemeStart('abc', 0)).toBe(0);
    expect(nextGraphemeEnd('abc', 3)).toBe(3);
    expect(previousGraphemeStart('', 0)).toBe(0);
    expect(nextGraphemeEnd('', 0)).toBe(0);
  });

  it('代理对永不被拆开：任一 previous / next 结果都不落在高低代理之间', () => {
    const text = 'a😀b🇨🇳c👨‍👩‍👧';
    for (let offset = 0; offset <= text.length; offset += 1) {
      const isMiddle = (at: number): boolean => at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1] ?? '') && /[\uDC00-\uDFFF]/.test(text[at] ?? '');
      if (isMiddle(offset)) continue;
      expect(isMiddle(previousGraphemeStart(text, offset))).toBe(false);
      expect(isMiddle(nextGraphemeEnd(text, offset))).toBe(false);
    }
  });
});
