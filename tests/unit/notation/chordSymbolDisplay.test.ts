/**
 * T6.5 —— 和弦符号展示文本（剥掉最外层 JCX 引号）。
 *
 * 纯函数测试，不涉及 Domain / serializer：`ChordSymbol.raw` 保留原文是另一层的事实，
 * 这里只钉「画出来是什么」。fixture 全部自造。
 */
import { describe, expect, it } from 'vitest';

import { chordSymbolDisplayText } from '../../../src/notation/layout/chordSymbolDisplay';

describe('chordSymbolDisplayText —— 剥掉最外层的一对 JCX 双引号', () => {
  it('常规和弦：`"G"` → `G`', () => {
    expect(chordSymbolDisplayText('"G"')).toBe('G');
  });

  it('斜杠和弦：`"D/#F"` → `D/#F`（不解析 root / quality / slash 语义）', () => {
    expect(chordSymbolDisplayText('"D/#F"')).toBe('D/#F');
  });

  it('空和弦：`""` → 空串（不退回原文，也不补任何占位字符）', () => {
    expect(chordSymbolDisplayText('""')).toBe('');
  });

  it('只有左侧引号：`"G` 原样返回（不替作者补全）', () => {
    expect(chordSymbolDisplayText('"G')).toBe('"G');
  });

  it('只有右侧引号：`G"` 原样返回', () => {
    expect(chordSymbolDisplayText('G"')).toBe('G"');
  });

  it('完全不带引号：`Am7` 原样返回', () => {
    expect(chordSymbolDisplayText('Am7')).toBe('Am7');
  });

  it('单个 `"` 字符：长度不足一对，原样返回（不截成空串）', () => {
    expect(chordSymbolDisplayText('"')).toBe('"');
  });

  it('空串原样返回', () => {
    expect(chordSymbolDisplayText('')).toBe('');
  });

  it('内部含引号：只剥最外层一对，`"a"b"` → `a"b`', () => {
    expect(chordSymbolDisplayText('"a"b"')).toBe('a"b');
  });
});
