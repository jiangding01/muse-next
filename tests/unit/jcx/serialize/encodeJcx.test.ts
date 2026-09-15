import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeJcx } from '../../../../src/formats/jcx/encoding/decodeJcx';
import { encodeJcx } from '../../../../src/formats/jcx/serialize/encodeJcx';

const FIXTURE_DIR = path.join(__dirname, '../../../fixtures/jcx');

function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

describe('encodeJcx — UTF-8', () => {
  it('往返：decodeJcx → encodeJcx 得到与原字节相同的内容', () => {
    const text = '%MUSE2\nT:hello\nK:C\n';
    const { bytes, diagnostics } = encodeJcx(text, 'utf-8');
    expect(diagnostics).toEqual([]);
    expect(new TextDecoder('utf-8').decode(bytes)).toBe(text);
  });

  it('带 BOM 的文本编码后首三字节为 EF BB BF，且只出现一次（不补双 BOM）', () => {
    const bytes = readFixtureBytes('bom-utf8.jcx');
    const decoded = decodeJcx(bytes);
    expect(decoded.hasBom).toBe(true);
    expect(decoded.text.charAt(0)).toBe('\uFEFF');

    const encoded = encodeJcx(decoded.text, 'utf-8');
    expect(Array.from(encoded.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);

    // 只出现一次：字节序列里只有开头这一处 EF BB BF。
    let bomOccurrences = 0;
    for (let index = 0; index + 2 < encoded.bytes.length; index += 1) {
      if (
        encoded.bytes[index] === 0xef &&
        encoded.bytes[index + 1] === 0xbb &&
        encoded.bytes[index + 2] === 0xbf
      ) {
        bomOccurrences += 1;
      }
    }
    expect(bomOccurrences).toBe(1);

    // 编码结果解码回去与原字节完全一致（preserve 场景的最小验证）。
    expect(Array.from(encoded.bytes)).toEqual(Array.from(bytes));
  });

  it('空文本编码得到长度为 0 的字节序列', () => {
    const { bytes, diagnostics } = encodeJcx('', 'utf-8');
    expect(bytes.byteLength).toBe(0);
    expect(diagnostics).toEqual([]);
  });
});

describe('encodeJcx — GB18030', () => {
  it('中文往返：decodeJcx(原字节) 的 text 经 encodeJcx 再 decodeJcx 得到相同 text', () => {
    const bytes = readFixtureBytes('encoding/encoding-gb18030.jcx');
    const decoded = decodeJcx(bytes);
    expect(decoded.encoding).toBe('gb18030');

    const encoded = encodeJcx(decoded.text, 'gb18030');
    expect(encoded.diagnostics).toEqual([]);

    const roundTripped = decodeJcx(encoded.bytes);
    expect(roundTripped.encoding).toBe('gb18030');
    expect(roundTripped.text).toBe(decoded.text);
  });

  it('空文本编码得到长度为 0 的字节序列', () => {
    const { bytes, diagnostics } = encodeJcx('', 'gb18030');
    expect(bytes.byteLength).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it('不可编码字符（孤立 surrogate）默认策略抛错，消息含行列', () => {
    // GB18030 覆盖全部合法 Unicode 标量值（含 emoji、私用区），实测唯一会
    // 触发「不可编码」的是孤立 surrogate——本身不是合法的 Unicode 标量值。
    const text = 'T:AB\nT:\uD800CD';
    expect(() => encodeJcx(text, 'gb18030')).toThrow();
    try {
      encodeJcx(text, 'gb18030');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).name).toBe('JcxEncodingError');
      expect((error as Error).message).toContain('line 2');
      expect((error as Error).message).toContain('column 2');
    }
  });

  it("显式 'replace' 策略：写 '?' 并为每个不可编码字符产出 warning（带行列 span）", () => {
    const text = 'T:AB\nT:\uD800CD';
    const { bytes, diagnostics } = encodeJcx(text, 'gb18030', { onUnencodable: 'replace' });

    const roundTripped = decodeJcx(bytes);
    expect(roundTripped.text).toBe('T:AB\nT:?CD');

    expect(diagnostics).toHaveLength(1);
    const [diagnostic] = diagnostics;
    expect(diagnostic?.code).toBe('jcx.serialize.unencodable-replaced');
    expect(diagnostic?.severity).toBe('warning');
    expect(diagnostic?.span.start).toEqual({ offset: 7, line: 2, column: 2 });
    expect(diagnostic?.span.end).toEqual({ offset: 8, line: 2, column: 3 });
  });

  it('emoji 与私用区字符可正常编码（不触发不可编码分支）', () => {
    const text = 'T:\u{1F600}\uE000';
    const { bytes, diagnostics } = encodeJcx(text, 'gb18030');
    expect(diagnostics).toEqual([]);
    expect(decodeJcx(bytes).text).toBe(text);
  });

  it('60KB 级别中文文本往返：整段快速路径结果正确（不做计时断言）', () => {
    const line = '合唱标题：往返测试，重复内容用于构造较大文本。\n';
    const text = line.repeat(Math.ceil((60 * 1024) / line.length));
    expect(text.length).toBeGreaterThan(20 * 1024);

    const { bytes, diagnostics } = encodeJcx(text, 'gb18030');
    expect(diagnostics).toEqual([]);
    expect(decodeJcx(bytes).text).toBe(text);
  });
});
