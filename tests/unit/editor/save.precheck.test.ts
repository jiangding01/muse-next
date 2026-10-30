/**
 * M3 T4 B1：保存前孤立 surrogate 预检（`src/editor/save/precheck.ts`，方案 §11.7）。
 * 表驱动 + 性质测试（确定性 PRNG，失败消息带 seed 与下标）。
 */

import { describe, expect, it } from 'vitest';

import { findUnencodableCharacters } from '../../../src/editor/save/precheck';
import { createPrng, randomText } from './prng';

const HIGH = '\uD83C';
const LOW = '\uDFB5';
const PAIR = `${HIGH}${LOW}`; // 🎵

describe('findUnencodableCharacters —— 表驱动', () => {
  it.each([
    ['空文本', '', []],
    ['纯 ASCII', 'X:1\nK:C\n', []],
    ['中文与合法代理对', `中文${PAIR}\r\n${PAIR}`, []],
    ['开头 U+FEFF 与非首位置 U+FEFF', '﻿A﻿B', []],
  ])('%s：零诊断', (_name, source, expected) => {
    expect(findUnencodableCharacters(source)).toEqual(expected);
  });

  it('孤立高代理（行中、行尾、文末）与孤立低代理都被定位', () => {
    const source = `AB${HIGH}C\nD${LOW}\n${HIGH}`;
    expect(findUnencodableCharacters(source)).toEqual([
      { offset: 2, line: 1, column: 2, codeUnit: 0xd83c },
      { offset: 6, line: 2, column: 1, codeUnit: 0xdfb5 },
      { offset: 8, line: 3, column: 0, codeUnit: 0xd83c },
    ]);
  });

  it('相邻：低 + 高（顺序颠倒）两个都孤立；高 + 高 + 低只有第一个孤立', () => {
    expect(findUnencodableCharacters(`${LOW}${HIGH}`).map((item) => item.offset)).toEqual([0, 1]);
    expect(findUnencodableCharacters(`${HIGH}${HIGH}${LOW}`).map((item) => item.offset)).toEqual([0]);
  });

  it('行列约定：CRLF 的 \\r 属于上一行；孤立 CR 不换行；列以 UTF-16 码元计', () => {
    expect(findUnencodableCharacters(`ab\r\n${LOW}`)[0]).toMatchObject({ line: 2, column: 0 });
    expect(findUnencodableCharacters(`ab\rc${LOW}`)[0]).toMatchObject({ line: 1, column: 4 });
    expect(findUnencodableCharacters(`${PAIR}${LOW}`)[0]).toMatchObject({ line: 1, column: 2 });
  });
});

describe('findUnencodableCharacters —— 性质测试', () => {
  const alphabet = ['a', '中', '\n', '\r', '\r\n', '﻿', PAIR, ' '];

  it('只由合法字符组成的随机文本永远零诊断', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const text = randomText(createPrng(seed), alphabet, 40);
      expect(findUnencodableCharacters(text), `seed ${String(seed)}`).toEqual([]);
    }
  });

  it('在合法随机文本的码点边界插入一个孤立代理：恰好报告一个、偏移正确、行列与 \\n 计数一致', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const prng = createPrng(seed);
      const pieces: string[] = [];
      const count = prng.int(20);
      for (let i = 0; i < count; i += 1) pieces.push(prng.pick(alphabet));
      const at = prng.int(pieces.length + 1);
      const lone = prng.pick([HIGH, LOW]);
      const before = pieces.slice(0, at).join('');
      const after = pieces.slice(at).join('');
      // 孤立高代理后面紧跟低代理会配成对；插入点之后若以代理对开头，高代理会与之配对——跳过这种组合。
      if (lone === HIGH && after.startsWith(LOW)) continue;
      if (lone === LOW && before.endsWith(HIGH)) continue;
      const found = findUnencodableCharacters(`${before}${lone}${after}`);
      const message = `seed ${String(seed)}, at ${String(at)}`;
      expect(found, message).toHaveLength(1);
      const lineStart = before.lastIndexOf('\n') + 1;
      expect(found[0], message).toEqual({
        offset: before.length,
        line: before.split('\n').length,
        column: before.length - lineStart,
        codeUnit: lone.charCodeAt(0),
      });
    }
  });
});
