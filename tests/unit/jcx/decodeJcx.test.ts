import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeJcx } from '../../../src/formats/jcx/encoding/decodeJcx';

const FIXTURE_DIR = path.join(
  __dirname,
  '../../../tests/fixtures/jcx/encoding',
);

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

describe('decodeJcx', () => {
  it('无 BOM 的 UTF-8 文本判定为 utf-8 且 hasBom 为 false', () => {
    const bytes = readFixture('encoding-utf8.jcx');
    const result = decodeJcx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(false);
    expect(result.text.startsWith('%MUSE2')).toBe(true);
    expect(result.text).toContain('T:测试标题');
  });

  it('带 UTF-8 BOM 的文本判定为 utf-8，hasBom 为 true，且 BOM 不被剥离', () => {
    const bytes = readFixture('encoding-bom.jcx');
    const result = decodeJcx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(true);
    expect(result.text.charAt(0)).toBe('﻿');
    expect(result.text.slice(1).startsWith('%MUSE2')).toBe(true);
  });

  it('GB18030 编码的中文文件判定为 gb18030 并正确解码', () => {
    const bytes = readFixture('encoding-gb18030.jcx');
    const result = decodeJcx(bytes);
    expect(result.encoding).toBe('gb18030');
    expect(result.hasBom).toBe(false);
    expect(result.text).toContain('T:合唱标题');
    expect(result.text).toContain('V:1 name="领唱"');
  });

  it('纯 ASCII 文本判定为 utf-8', () => {
    const bytes = new TextEncoder().encode('%MUSE2\nT:hello\nK:C\n');
    const result = decodeJcx(bytes);
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(false);
    expect(result.text).toBe('%MUSE2\nT:hello\nK:C\n');
  });

  it('非法 UTF-8 字节序列回退到 GB18030', () => {
    // 单字节 0xC1 0xEC 是 GB18030 的“领”字前两字节顺序里常见的
    // 非法 UTF-8 起始序列（不是合法的 UTF-8 多字节序列）。
    const bytes = new Uint8Array([0x54, 0x3a, 0xc1, 0xec, 0x0a]); // "T:" + 0xC1 0xEC + "\n"
    const result = decodeJcx(bytes);
    expect(result.encoding).toBe('gb18030');
    expect(result.hasBom).toBe(false);
    expect(result.text.startsWith('T:')).toBe(true);
  });

  it('UTF-16 LE BOM 判定为不支持，抛出 name === "JcxEncodingError" 的 Error', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x54, 0x00]);
    expect(() => decodeJcx(bytes)).toThrow();
    try {
      decodeJcx(bytes);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('JcxEncodingError');
    }
  });

  it('UTF-16 BE BOM 判定为不支持，抛出 name === "JcxEncodingError" 的 Error', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x54]);
    try {
      decodeJcx(bytes);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('JcxEncodingError');
    }
  });

  it('空输入判定为 utf-8，text 为空字符串', () => {
    const result = decodeJcx(new Uint8Array());
    expect(result.encoding).toBe('utf-8');
    expect(result.hasBom).toBe(false);
    expect(result.text).toBe('');
  });
});
