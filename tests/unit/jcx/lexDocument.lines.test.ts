import { describe, expect, it } from 'vitest';
import {
  hasTrailingNewline,
  lexDocument,
  splitLines,
} from '../../../src/formats/jcx/lexer/lexDocument';
import { rawOf } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';

describe('splitLines', () => {
  it('纯 LF：每行 eol 均为 \\n', () => {
    const lines = splitLines('a\nb\nc\n');
    expect(lines.map((l) => l.content)).toEqual(['a', 'b', 'c']);
    expect(lines.map((l) => l.eol)).toEqual(['\n', '\n', '\n']);
    expect(lines.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('纯 CRLF：每行 eol 均为 \\r\\n', () => {
    const lines = splitLines('a\r\nb\r\nc\r\n');
    expect(lines.map((l) => l.content)).toEqual(['a', 'b', 'c']);
    expect(lines.map((l) => l.eol)).toEqual(['\r\n', '\r\n', '\r\n']);
  });

  it('混合行尾：每行各自记录自己的 eol', () => {
    const text = 'a\r\nb\nc\r\nd';
    const lines = splitLines(text);
    expect(lines.map((l) => l.content)).toEqual(['a', 'b', 'c', 'd']);
    expect(lines.map((l) => l.eol)).toEqual(['\r\n', '\n', '\r\n', '']);
  });

  it('末尾无换行：最后一行 eol 为空串', () => {
    const lines = splitLines('a\nb');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ content: 'b', eol: '' });
  });

  it('孤立 \\r（不紧跟 \\n）留在 content 内部，不被当作行尾', () => {
    const lines = splitLines('a\rb\nc');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ content: 'a\rb', eol: '\n' });
    expect(lines[1]).toMatchObject({ content: 'c', eol: '' });
  });

  it('空文本得到 0 行（决定见函数注释：空文本没有可归属为一行的字节）', () => {
    expect(splitLines('')).toEqual([]);
  });

  it('仅一个换行符：产生 1 行，content 为空串，eol 为 \\n，不额外产生第二行空行', () => {
    const lines = splitLines('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ content: '', eol: '\n' });
  });

  it('文本恰好以换行结尾（含内容）：不产生多余的末尾空行', () => {
    const lines = splitLines('a\nb\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.content)).toEqual(['a', 'b']);
  });

  it('每行 span 与 text.slice(start.offset, end.offset) 一致', () => {
    const text = 'ab\r\ncd\nef';
    const lines = splitLines(text);
    for (const line of lines) {
      expect(text.slice(line.span.start.offset, line.span.end.offset)).toBe(
        line.content + line.eol,
      );
    }
  });

  it('index 与 span.start.line（1-based）保持一致的递增关系', () => {
    const lines = splitLines('a\nb\nc');
    expect(lines.map((l) => l.span.start.line)).toEqual([1, 2, 3]);
  });
});

describe('hasTrailingNewline', () => {
  it('空文本视为无末尾换行', () => {
    expect(hasTrailingNewline('')).toBe(false);
  });

  it('以 \\n 结尾（含 CRLF）视为有末尾换行', () => {
    expect(hasTrailingNewline('a\n')).toBe(true);
    expect(hasTrailingNewline('a\r\n')).toBe(true);
  });

  it('末尾无换行符', () => {
    expect(hasTrailingNewline('a')).toBe(false);
    expect(hasTrailingNewline('a\nb')).toBe(false);
  });

  it('仅一个换行符也视为有末尾换行', () => {
    expect(hasTrailingNewline('\n')).toBe(true);
  });
});

describe('lexDocument：BOM', () => {
  it('文本以 BOM 开头时，产出独立 bom token，不计入 content', () => {
    const bag = createDiagnosticBag();
    const text = '﻿%MUSE2\nX:1\n';
    const lines = lexDocument(text, bag);
    const first = lines[0];
    expect(first?.tokens[0]).toMatchObject({ kind: 'bom', raw: '﻿' });
    // BOM 之后紧跟内容 token（此处是纯正文 raw token，不含 BOM 字符）。
    const rawToken = first?.tokens.find((t) => t.kind === 'raw');
    expect(rawToken?.raw).toBe('%MUSE2');
    expect(rawOf(first?.tokens ?? [])).toBe('﻿%MUSE2\n');
  });

  it('无 BOM 时不产生 bom token', () => {
    const bag = createDiagnosticBag();
    const lines = lexDocument('%MUSE2\n', bag);
    expect(lines[0]?.tokens.some((t) => t.kind === 'bom')).toBe(false);
  });
});

describe('lexDocument：空文本 / 单换行', () => {
  it('空文本得到 0 行', () => {
    const bag = createDiagnosticBag();
    expect(lexDocument('', bag)).toEqual([]);
  });

  it('单个换行符得到 1 行 blank', () => {
    const bag = createDiagnosticBag();
    const lines = lexDocument('\n', bag);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.kind).toBe('blank');
    expect(rawOf(lines[0]?.tokens ?? [])).toBe('\n');
  });
});

describe('lexDocument：行首/行尾空白拆分', () => {
  it('行首与行尾空白各自独立成 whitespace token，中段是 raw', () => {
    const bag = createDiagnosticBag();
    const lines = lexDocument('  K:C  \n', bag);
    const tokens = lines[0]?.tokens ?? [];
    expect(tokens.map((t) => [t.kind, t.raw])).toEqual([
      ['whitespace', '  '],
      ['raw', 'K:C'],
      ['whitespace', '  '],
      ['eol', '\n'],
    ]);
  });

  it('纯空白行（含 Tab）kind 为 blank，只含 whitespace + eol', () => {
    const bag = createDiagnosticBag();
    const lines = lexDocument('  \t \n', bag);
    expect(lines[0]?.kind).toBe('blank');
    const tokens = lines[0]?.tokens ?? [];
    expect(tokens.every((t) => t.kind === 'whitespace' || t.kind === 'eol')).toBe(true);
  });

  it('完全空的行（content 为空串）blank 且无 whitespace token', () => {
    const bag = createDiagnosticBag();
    const lines = lexDocument('a\n\nb\n', bag);
    const blankLine = lines[1];
    expect(blankLine?.kind).toBe('blank');
    expect(blankLine?.tokens.map((t) => t.kind)).toEqual(['eol']);
  });
});

describe('lexDocument：每行 span 与 token 覆盖一致', () => {
  it('逐行 tokens 的 raw 拼接与 text.slice(span) 相等', () => {
    const bag = createDiagnosticBag();
    const text = '﻿%MUSE2\r\n  K:C \nz\n';
    const lines = lexDocument(text, bag);
    for (const line of lines) {
      expect(rawOf(line.tokens)).toBe(
        text.slice(line.span.start.offset, line.span.end.offset),
      );
    }
  });

  it('lexDocument 不抛异常（异常/边界输入）', () => {
    const bag = createDiagnosticBag();
    expect(() => lexDocument('', bag)).not.toThrow();
    expect(() => lexDocument('\r', bag)).not.toThrow();
    expect(() => lexDocument('﻿', bag)).not.toThrow();
  });
});
