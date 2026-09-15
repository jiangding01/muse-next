import { describe, expect, it } from 'vitest';
import {
  childPath,
  isDescendantPath,
  linePath,
  parseAstPath,
} from '../../../../src/formats/jcx/ast';

describe('astPath —— 构造与解析', () => {
  it('构造与解析往返', () => {
    expect(linePath(12)).toBe('L12');
    expect(childPath(linePath(12), 3)).toBe('L12.3');
    expect(childPath(childPath(linePath(12), 3), 1)).toBe('L12.3.1');
    expect(parseAstPath('L12')).toEqual({ line: 12, indices: [] });
    expect(parseAstPath('L12.3')).toEqual({ line: 12, indices: [3] });
    expect(parseAstPath('L12.3.1')).toEqual({ line: 12, indices: [3, 1] });
  });

  it('下标 0 与多层深路径', () => {
    expect(linePath(0)).toBe('L0');
    expect(parseAstPath(childPath(childPath(childPath(linePath(0), 0), 0), 0))).toEqual({
      line: 0,
      indices: [0, 0, 0],
    });
  });
});

describe('astPath —— 非法输入', () => {
  it('非法路径字符串返回 null 而不抛异常', () => {
    expect(parseAstPath('')).toBeNull();
    expect(parseAstPath('12')).toBeNull();
    expect(parseAstPath('L')).toBeNull();
    expect(parseAstPath('L1.')).toBeNull();
    expect(parseAstPath('L1.a')).toBeNull();
    expect(parseAstPath('L-1')).toBeNull();
    expect(parseAstPath('L1..2')).toBeNull();
    expect(parseAstPath(' L1')).toBeNull();
  });

  it('非非负整数下标一律抛 RangeError（不静默归一）', () => {
    expect(() => linePath(-1)).toThrow(RangeError);
    expect(() => linePath(2.7)).toThrow(RangeError);
    expect(() => linePath(Number.NaN)).toThrow(RangeError);
    expect(() => linePath(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => childPath(linePath(0), -1)).toThrow(RangeError);
    expect(() => childPath(linePath(0), 0.5)).toThrow(RangeError);
    expect(() => childPath(linePath(0), Number.NaN)).toThrow(RangeError);
  });
});

describe('astPath —— 祖先判定', () => {
  it('只认严格后代', () => {
    expect(isDescendantPath(linePath(1), childPath(linePath(1), 0))).toBe(true);
    expect(isDescendantPath(linePath(1), childPath(childPath(linePath(1), 0), 2))).toBe(true);
    expect(isDescendantPath(linePath(1), linePath(1))).toBe(false);
    expect(isDescendantPath(linePath(1), linePath(10))).toBe(false);
  });
});
