/**
 * M3 T1a：DecodeFailure 前缀分类、byteBom / writeEncoding / encodingRoundTrip 判定。
 *
 * 普通 Node 下的 codec 结果**不能**作为生产编码正确性的 seal 证据（§25.2）；这里只断言两种运行时一致的向量。
 * 映射敏感向量（单字节 0x80、A6D9、FE59、FE61）只在 Electron runtime probe 中断言。
 */

import { describe, expect, it } from 'vitest';

import { classifyDecodeFailure, classifyEncodingRoundTrip, decodeDocumentBytes } from '../../../src/main/document/decodeDocument';
import { bytesOf } from './fakeFileSystem';

const FEFF = '﻿';

describe('classifyDecodeFailure —— 只按字节前缀', () => {
  it.each([
    ['空字节', [], 'decode-invalid-gb18030'],
    ['只有 FE', [0xfe], 'decode-invalid-gb18030'],
    ['只有 FF', [0xff], 'decode-invalid-gb18030'],
    ['只有 EF BB', [0xef, 0xbb], 'decode-invalid-gb18030'],
    ['EF BB BF', [0xef, 0xbb, 0xbf], 'decode-invalid-utf8'],
    ['EF BB BF C3 28', [0xef, 0xbb, 0xbf, 0xc3, 0x28], 'decode-invalid-utf8'],
    ['FF FE', [0xff, 0xfe], 'decode-utf16-unsupported'],
    ['FE FF 00 41', [0xfe, 0xff, 0x00, 0x41], 'decode-utf16-unsupported'],
    ['FF FE 41 00', [0xff, 0xfe, 0x41, 0x00], 'decode-utf16-unsupported'],
    ['41 FF 41', [0x41, 0xff, 0x41], 'decode-invalid-gb18030'],
    ['FE 41（不是 UTF-16 BOM）', [0xfe, 0x41], 'decode-invalid-gb18030'],
  ] as const)('%s → %s', (_label, values, expected) => {
    expect(classifyDecodeFailure(Uint8Array.from(values))).toBe(expected);
  });
});

describe('decodeDocumentBytes —— 成功分支', () => {
  it('ASCII → utf-8、无 BOM、exact', () => {
    expect(decodeDocumentBytes(bytesOf(0x61, 0x62, 0x63))).toEqual({
      ok: true,
      source: 'abc',
      writeEncoding: 'utf-8',
      byteBom: 'none',
      encodingRoundTrip: 'exact',
    });
  });

  it('空文件 → utf-8 空串、exact', () => {
    expect(decodeDocumentBytes(new Uint8Array(0))).toEqual({
      ok: true,
      source: '',
      writeEncoding: 'utf-8',
      byteBom: 'none',
      encodingRoundTrip: 'exact',
    });
  });

  it('UTF-8 中文 → utf-8、exact', () => {
    const result = decodeDocumentBytes(new TextEncoder().encode('中文 T:x'));
    expect(result).toEqual({ ok: true, source: '中文 T:x', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact' });
  });

  it('UTF-8 BOM：source 以 U+FEFF 开头，byteBom utf8，exact', () => {
    const result = decodeDocumentBytes(bytesOf(0xef, 0xbb, 0xbf, 0x41));
    expect(result).toEqual({ ok: true, source: `${FEFF}A`, writeEncoding: 'utf-8', byteBom: 'utf8', encodingRoundTrip: 'exact' });
  });

  it('GB18030 常见中文 D6 D0 CE C4 → gb18030、exact', () => {
    const result = decodeDocumentBytes(bytesOf(0xd6, 0xd0, 0xce, 0xc4));
    expect(result).toEqual({ ok: true, source: '中文', writeEncoding: 'gb18030', byteBom: 'none', encodingRoundTrip: 'exact' });
  });

  it('GB18030 以 U+FEFF 开头（84 31 95 33 D6 D0）：source 首字符 U+FEFF，但 byteBom 仍为 none（不由文本推断）', () => {
    const result = decodeDocumentBytes(bytesOf(0x84, 0x31, 0x95, 0x33, 0xd6, 0xd0));
    expect(result).toEqual({ ok: true, source: `${FEFF}中`, writeEncoding: 'gb18030', byteBom: 'none', encodingRoundTrip: 'exact' });
  });

  it('D2 BB（"一"的 GB18030 字节）恰是合法 UTF-8：被判 utf-8，文本不是"一"', () => {
    const result = decodeDocumentBytes(bytesOf(0xd2, 0xbb));
    expect(result.ok && result.writeEncoding).toBe('utf-8');
    expect(result.ok && result.source).toBe('һ');
  });
});

describe('decodeDocumentBytes —— DecodeFailure', () => {
  it.each([
    ['UTF-16 LE', [0xff, 0xfe, 0x41, 0x00], 'decode-utf16-unsupported'],
    ['UTF-16 BE', [0xfe, 0xff, 0x00, 0x41], 'decode-utf16-unsupported'],
    ['带 BOM 的非法 UTF-8（原生 TypeError）', [0xef, 0xbb, 0xbf, 0xc3, 0x28], 'decode-invalid-utf8'],
    ['EF BB BF D0', [0xef, 0xbb, 0xbf, 0xd0], 'decode-invalid-utf8'],
    ['41 FF 41', [0x41, 0xff, 0x41], 'decode-invalid-gb18030'],
    ['41 81 30', [0x41, 0x81, 0x30], 'decode-invalid-gb18030'],
    ['41 81', [0x41, 0x81], 'decode-invalid-gb18030'],
    ['41 81 7F 41', [0x41, 0x81, 0x7f, 0x41], 'decode-invalid-gb18030'],
    ['84 31 A5 30', [0x84, 0x31, 0xa5, 0x30], 'decode-invalid-gb18030'],
    ['E3 32 9A 36', [0xe3, 0x32, 0x9a, 0x36], 'decode-invalid-gb18030'],
  ] as const)('%s → %s', (_label, values, code) => {
    expect(decodeDocumentBytes(Uint8Array.from(values))).toEqual({ ok: false, code });
  });
});

describe('classifyEncodingRoundTrip', () => {
  it('逐字节相等 → exact；长度或任一字节不同 → unsafe', () => {
    expect(classifyEncodingRoundTrip('abc', 'utf-8', bytesOf(0x61, 0x62, 0x63))).toBe('exact');
    expect(classifyEncodingRoundTrip('abc', 'utf-8', bytesOf(0x61, 0x62))).toBe('unsafe');
    expect(classifyEncodingRoundTrip('abc', 'utf-8', bytesOf(0x61, 0x62, 0x64))).toBe('unsafe');
    expect(classifyEncodingRoundTrip('abc', 'gb18030', bytesOf(0x61, 0x62, 0x63))).toBe('exact');
  });

  it('encodeJcx 抛错（孤立 surrogate + gb18030）→ unsafe，不抛出', () => {
    expect(() => classifyEncodingRoundTrip('a\uD800b', 'gb18030', bytesOf(0x61, 0x3f, 0x62))).not.toThrow();
    expect(classifyEncodingRoundTrip('a\uD800b', 'gb18030', bytesOf(0x61, 0x3f, 0x62))).toBe('unsafe');
  });

  it('UTF-8 下孤立 surrogate 被 TextEncoder 替换为 EF BF BD：与原字节不同 → unsafe', () => {
    expect(classifyEncodingRoundTrip('\uD800', 'utf-8', bytesOf(0x3f))).toBe('unsafe');
  });
});
