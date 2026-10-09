import { describe, expect, it } from 'vitest';

import { buildProjection, createInitialProjection, detectDominantEol } from '../../../src/editor/projection/build';
import { CR_PLACEHOLDER } from '../../../src/editor/projection/types';

const FEFF = '\uFEFF';

describe('M3 T0 —— SourceProjection 构建（§6.1–§6.4）', () => {
  it.each([
    ['LF', 'a\nb\n', 'a\nb\n', [], []],
    ['CRLF', 'a\r\nb\r\n', 'a\nb\n', [1, 4], []],
    ['LF 与 CRLF 混合', 'a\nb\r\nc', 'a\nb\nc', [3], []],
    ['孤立 CR 呈现为登记的占位符', 'a\rb', `a${CR_PLACEHOLDER}b`, [], [1]],
    ['CR CR LF：第一个 CR 孤立，后两个构成 CRLF', 'a\r\r\nb', `a${CR_PLACEHOLDER}\nb`, [2], [1]],
    ['空文件', '', '', [], []],
    ['末尾无换行', 'a\r\nb', 'a\nb', [1], []],
    ['末尾孤立 CR', 'a\r', `a${CR_PLACEHOLDER}`, [], [1]],
  ])('%s', (_name, source, view, crlf, loneCr) => {
    const projection = createInitialProjection(source);
    expect(projection.view).toBe(view);
    expect(projection.crlfSourceStarts).toEqual(crlf);
    expect(projection.loneCrSourceOffsets).toEqual(loneCr);
    expect(projection.protectedPrefixLength).toBe(0);
  });

  it('用户输入的 U+240D 是普通字符，不进入占位符位置表', () => {
    const projection = createInitialProjection(`a${CR_PLACEHOLDER}b\rc`);
    expect(projection.view).toBe(`a${CR_PLACEHOLDER}b${CR_PLACEHOLDER}c`);
    expect(projection.loneCrSourceOffsets).toEqual([3]);
  });

  it('受保护的开头 U+FEFF 不进入 view；只有它时 view 为空', () => {
    const only = createInitialProjection(FEFF);
    expect(only.view).toBe('');
    expect(only.protectedPrefixLength).toBe(1);
    expect(only.frame.protectedLeadingFeff).toBe(true);

    const withCrlf = createInitialProjection(`${FEFF}a\r\nb`);
    expect(withCrlf.view).toBe('a\nb');
    expect(withCrlf.crlfSourceStarts).toEqual([2]);
  });

  it('非首位置的 U+FEFF 与受保护前缀之后的第二个 U+FEFF 都是普通内容', () => {
    expect(createInitialProjection(`a${FEFF}b`).view).toBe(`a${FEFF}b`);
    const second = createInitialProjection(`${FEFF}${FEFF}a`);
    expect(second.view).toBe(`${FEFF}a`);
    expect(second.protectedPrefixLength).toBe(1);
  });

  it.each([
    ['只有 LF', 'a\nb\n', 'lf'],
    ['CRLF 多于 LF', 'a\r\nb\r\nc\n', 'crlf'],
    ['LF 多于 CRLF', 'a\r\nb\nc\n', 'lf'],
    ['并列回退 LF', 'a\r\nb\n', 'lf'],
    ['没有换行回退 LF', 'abc', 'lf'],
    ['孤立 CR 不参与统计', 'a\rb\rc\r\n', 'crlf'],
  ] as const)('dominant EOL：%s', (_name, source, expected) => {
    expect(detectDominantEol(source)).toBe(expected);
  });

  it('dominant EOL 冻结在 frame 中：后续版本沿用打开时的值，不随 source 重新统计', () => {
    const opened = createInitialProjection('a\r\nb\r\n');
    const later = buildProjection('a\nb\nc\nd\n', opened.frame);
    expect(later.frame.dominantEol).toBe('crlf');
  });

  it('frame 与 source 的受保护前缀不一致属于内部不变量错误', () => {
    expect(() => buildProjection('abc', { protectedLeadingFeff: true, dominantEol: 'lf' })).toThrow();
    expect(() => buildProjection(`${FEFF}abc`, { protectedLeadingFeff: false, dominantEol: 'lf' })).toThrow();
  });
});
