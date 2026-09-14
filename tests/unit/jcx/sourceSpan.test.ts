import { describe, expect, it } from 'vitest';
import {
  createPositionTracker,
  emptySpanAt,
  spanOf,
} from '../../../src/formats/jcx/lexer/sourceSpan';
import type { SourceSpan } from '../../../src/formats/jcx/lexer/sourceSpan';
import { flattenTokens, rawOf } from '../../../src/formats/jcx/lexer/token';
import type { JcxLexLine, JcxToken } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';

const span = (offset: number, length: number): SourceSpan => ({
  start: { offset, line: 1, column: offset },
  end: { offset: offset + length, line: 1, column: offset + length },
});

describe('createPositionTracker', () => {
  it('以 LF 推进行号并重置 0-based column', () => {
    const tracker = createPositionTracker('ab\ncd');
    expect(tracker.current()).toEqual({ offset: 0, line: 1, column: 0 });
    tracker.advance(2);
    expect(tracker.current()).toEqual({ offset: 2, line: 1, column: 2 });
    tracker.advance(1);
    expect(tracker.current()).toEqual({ offset: 3, line: 2, column: 0 });
    tracker.advance(2);
    expect(tracker.current()).toEqual({ offset: 5, line: 2, column: 2 });
  });

  it('CRLF 中的 CR 归属上一行，只有 LF 触发换行', () => {
    const tracker = createPositionTracker('ab\r\ncd');
    tracker.advance(3); // a b \r
    expect(tracker.current()).toEqual({ offset: 3, line: 1, column: 3 });
    tracker.advance(1); // \n
    expect(tracker.current()).toEqual({ offset: 4, line: 2, column: 0 });
  });

  it('BOM 占 1 个 code unit', () => {
    const tracker = createPositionTracker('﻿%MUSE2');
    tracker.advance(1);
    expect(tracker.current()).toEqual({ offset: 1, line: 1, column: 1 });
  });

  it('中文字符各占 1 个 code unit', () => {
    const tracker = createPositionTracker('T:小星星');
    tracker.advance('T:小星星'.length);
    expect(tracker.current()).toEqual({ offset: 5, line: 1, column: 5 });
  });

  it('代理对占 2 个 code unit', () => {
    const text = '𝄞z'; // U+1D11E 高音谱号，UTF-16 长度 2
    expect(text.length).toBe(3);
    const tracker = createPositionTracker(text);
    tracker.advance(2);
    expect(tracker.current()).toEqual({ offset: 2, line: 1, column: 2 });
  });

  it('advance 不会越过文本末尾，且忽略非正数步长', () => {
    const tracker = createPositionTracker('ab');
    expect(tracker.advance(0)).toEqual({ offset: 0, line: 1, column: 0 });
    expect(tracker.advance(-3)).toEqual({ offset: 0, line: 1, column: 0 });
    expect(tracker.advance(99)).toEqual({ offset: 2, line: 1, column: 2 });
  });

  it('spanFrom 用起点快照与当前游标构造 span', () => {
    const text = 'K:G\nz2';
    const tracker = createPositionTracker(text);
    tracker.advance(4);
    const start = tracker.current();
    tracker.advance(2);
    const result = tracker.spanFrom(start);
    expect(result).toEqual({
      start: { offset: 4, line: 2, column: 0 },
      end: { offset: 6, line: 2, column: 2 },
    });
    expect(text.slice(result.start.offset, result.end.offset)).toBe('z2');
  });
});

describe('spanOf / emptySpanAt', () => {
  it('spanOf 按绝对 offset 区间给出跨行位置', () => {
    expect(spanOf('ab\ncd', 3, 5)).toEqual({
      start: { offset: 3, line: 2, column: 0 },
      end: { offset: 5, line: 2, column: 2 },
    });
  });

  it('emptySpanAt 产生零宽 span', () => {
    const position = { offset: 7, line: 3, column: 1 };
    expect(emptySpanAt(position)).toEqual({ start: position, end: position });
  });
});

describe('flattenTokens / rawOf', () => {
  it('按源顺序摊平并拼回原文（§29.5 逐行不变量）', () => {
    const lineOne: JcxToken[] = [
      { kind: 'fieldKey', key: 'K', raw: 'K', span: span(0, 1) },
      { kind: 'fieldColon', raw: ':', span: span(1, 1) },
      { kind: 'fieldValue', raw: 'G', span: span(2, 1) },
      { kind: 'eol', raw: '\r\n', span: span(3, 2) },
    ];
    const lineTwo: JcxToken[] = [
      { kind: 'rest', letter: 'Z', raw: 'Z', span: span(5, 1) },
      { kind: 'duration', raw: '2', span: span(6, 1) },
    ];
    const lines: JcxLexLine[] = [
      { index: 0, span: span(0, 5), kind: 'field', tokens: lineOne },
      { index: 1, span: span(5, 2), kind: 'body', tokens: lineTwo, mode: 'pitch' },
    ];

    expect(rawOf(lineOne)).toBe('K:G\r\n');
    expect(rawOf(lineTwo)).toBe('Z2');
    const all = flattenTokens(lines);
    expect(all).toHaveLength(6);
    expect(rawOf(all)).toBe('K:G\r\nZ2');
  });

  it('空输入拼接为空串', () => {
    expect(rawOf([])).toBe('');
    expect(flattenTokens([])).toEqual([]);
  });
});

describe('createDiagnosticBag', () => {
  it('report/add 累积并支持 hasSeverity 查询', () => {
    const bag = createDiagnosticBag();
    expect(bag.list()).toEqual([]);
    expect(bag.hasSeverity('warning')).toBe(false);

    bag.report('jcx.rest.uppercase-z', 'info', "uppercase rest 'Z'", span(0, 1));
    bag.add({
      code: 'jcx.body.unknown-token',
      severity: 'warning',
      message: 'unknown body token',
      span: span(1, 1),
    });

    expect(bag.list()).toHaveLength(2);
    expect(bag.hasSeverity('info')).toBe(true);
    expect(bag.hasSeverity('warning')).toBe(true);
    expect(bag.hasSeverity('error')).toBe(false);
    expect(bag.list()[0]?.code).toBe('jcx.rest.uppercase-z');
  });

  it('list() 返回快照，不受后续写入影响', () => {
    const bag = createDiagnosticBag();
    bag.report('jcx.field.unknown', 'warning', "unknown field 'Q'", span(0, 1));
    const snapshot = bag.list();
    bag.report('jcx.directive.unknown', 'info', 'unknown directive', span(2, 2));
    expect(snapshot).toHaveLength(1);
    expect(bag.list()).toHaveLength(2);
  });
});
