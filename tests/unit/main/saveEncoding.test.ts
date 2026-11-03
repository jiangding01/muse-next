/**
 * M3 T4 B1：保存前编码与自解码校验的分支逻辑（`saveEncoding.ts`）。
 *
 * 编码向量的正确性以 Electron 运行时探针为准（方案 §25.2；`tests/electron/saveCases.ts`）。这里只用在普通 Node 与
 * Electron 中行为一致的输入（ASCII、常见中文、BOM、孤立 surrogate）验证分支与上限。
 */

import { describe, expect, it } from 'vitest';

import { encodeForSave, hasLoneSurrogate } from '../../../src/main/document/saveEncoding';

describe('hasLoneSurrogate', () => {
  it.each([
    ['', false],
    ['abc 中文', false],
    ['🎵', false],
    ['\uD83C', true],
    ['\uDFB5', true],
    ['a\uDFB5\uD83C', true],
  ])('%j → %s', (text, expected) => {
    expect(hasLoneSurrogate(text)).toBe(expected);
  });
});

describe('encodeForSave', () => {
  it('UTF-8：不补 BOM；source 开头的 U+FEFF 编码为 EF BB BF，byteBom 由写入字节给出', () => {
    const plain = encodeForSave('X:1\r\n', 'utf-8');
    expect(plain).toMatchObject({ ok: true, encoded: { byteBom: 'none', encodingRoundTrip: 'exact' } });
    const bom = encodeForSave('﻿X:1\n', 'utf-8');
    if (!bom.ok) throw new Error('unexpected');
    expect([...bom.encoded.bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bom.encoded.byteBom).toBe('utf8');
  });

  it('换行与孤立 CR 原样编码（不规范化）', () => {
    const result = encodeForSave('A\r\nB\nC\rD', 'utf-8');
    if (!result.ok) throw new Error('unexpected');
    expect(new TextDecoder().decode(result.encoded.bytes)).toBe('A\r\nB\nC\rD');
  });

  it('孤立 surrogate 在两种编码下都给出 unencodable-character（UTF-8 不会被静默替换为 U+FFFD）', () => {
    expect(encodeForSave('A\uD800', 'utf-8')).toEqual({ ok: false, code: 'unencodable-character' });
    expect(encodeForSave('A\uDC00', 'gb18030')).toEqual({ ok: false, code: 'unencodable-character' });
  });

  it('上限：码元数或编码后字节数超过上限 → file-too-large', () => {
    expect(encodeForSave('A'.repeat(11), 'utf-8', 10)).toEqual({ ok: false, code: 'file-too-large' });
    expect(encodeForSave('中'.repeat(4), 'utf-8', 10)).toEqual({ ok: false, code: 'file-too-large' });
    expect(encodeForSave('中'.repeat(3), 'utf-8', 10).ok).toBe(true);
  });

  it('GB18030 → 纯 ASCII：解码判为 UTF-8 但文本相等，校验通过（V6）', () => {
    expect(encodeForSave('X:1\nT:abc\r\n', 'gb18030').ok).toBe(true);
  });

  it('GB18030 中「一」（D2 BB）构成合法 UTF-8 → 自解码文本不同 → encoding-verification-failed（R21）', () => {
    expect(encodeForSave('一', 'gb18030')).toEqual({ ok: false, code: 'encoding-verification-failed' });
  });
});
