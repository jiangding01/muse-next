import { describe, expect, it } from 'vitest';
import { childPath, isTextBlock, linePath, printAst, printLine, printNode } from '../../../../src/formats/jcx/ast';
import type { JcxBodyNode, JcxLineNode } from '../../../../src/formats/jcx/ast';
import { doc, reader, spanning } from './astFixtures';

describe('printAst —— 行级节点', () => {
  const source = '%MUSE2\r\nT: Hello\r\n% c\n\nCDE';
  const r = reader(source);

  const magic: JcxLineNode = (() => {
    const children = [r.leaf({ kind: 'magicHeader', raw: '%MUSE2' })];
    return {
      kind: 'magicHeaderLine',
      path: linePath(0),
      span: spanning(children),
      children,
      eol: '\r\n',
    };
  })();

  const field: JcxLineNode = (() => {
    const children = [
      r.leaf({ kind: 'fieldKey', raw: 'T', key: 'T' }),
      r.leaf({ kind: 'fieldColon', raw: ':' }),
      r.leaf({ kind: 'whitespace', raw: ' ' }),
      r.leaf({ kind: 'fieldValue', raw: 'Hello' }),
    ];
    return {
      kind: 'fieldLine',
      path: linePath(1),
      span: spanning(children),
      key: 'T',
      region: 'header',
      children,
      eol: '\r\n',
    };
  })();

  const comment: JcxLineNode = (() => {
    const children = [r.leaf({ kind: 'comment', raw: '% c' })];
    return {
      kind: 'commentLine',
      path: linePath(2),
      span: spanning(children),
      children,
      eol: '\n',
    };
  })();

  const blank: JcxLineNode = {
    kind: 'blankLine',
    path: linePath(3),
    span: spanning([comment]),
    children: [],
    eol: '\n',
  };

  const body: JcxLineNode = (() => {
    const notes: JcxBodyNode[] = (['C', 'D', 'E'] as const).map((letter, i) => {
      const leaf = r.leaf({ kind: 'pitchLetter', raw: letter });
      return { kind: 'note', path: childPath(linePath(4), i), span: leaf.span, children: [leaf] };
    });
    return {
      kind: 'bodyLine',
      path: linePath(4),
      span: spanning(notes),
      mode: 'pitch',
      items: notes,
      eol: '',
    };
  })();

  const document = doc([magic, field, comment, blank, body], { hasTrailingNewline: false });

  it('逐行拼接（含 CRLF、LF 混用与末行无换行）精确还原原文', () => {
    expect(printAst(document)).toBe(source);
  });

  it('blankLine 无 token 时只贡献 eol', () => {
    expect(printLine(blank)).toBe('\n');
  });

  it('fieldLine 保留冒号后的空白与原值，不做归一化', () => {
    expect(printLine(field)).toBe('T: Hello\r\n');
  });
});

describe('printAst —— 正文嵌套结构', () => {
  const source = '^A2 [ceg] |';
  const r = reader(source);

  const accidental = r.leaf({ kind: 'accidental', raw: '^' });
  const pitch = r.leaf({ kind: 'pitchLetter', raw: 'A' });
  const duration = r.leaf({ kind: 'duration', raw: '2' });
  const note: JcxBodyNode = {
    kind: 'note',
    path: childPath(linePath(0), 0),
    span: spanning([accidental, duration]),
    children: [accidental, pitch, duration],
  };
  const ws1 = r.bodyLeaf('whitespace', { kind: 'whitespace', raw: ' ' });
  const open = r.leaf({ kind: 'chordOpen', raw: '[' });
  const inner: JcxBodyNode[] = (['c', 'e', 'g'] as const).map((letter, i) => {
    const leaf = r.leaf({ kind: 'pitchLetter', raw: letter });
    return {
      kind: 'note',
      path: childPath(childPath(linePath(0), 2), i),
      span: leaf.span,
      children: [leaf],
    };
  });
  const close = r.leaf({ kind: 'chordClose', raw: ']' });
  const chord: JcxBodyNode = {
    kind: 'chord',
    path: childPath(linePath(0), 2),
    span: spanning([open, close]),
    open,
    items: inner,
    close,
  };
  const ws2 = r.bodyLeaf('whitespace', { kind: 'whitespace', raw: ' ' });
  const bar = r.bodyLeaf('barline', { kind: 'barline', raw: '|' });

  const line: JcxLineNode = {
    kind: 'bodyLine',
    path: linePath(0),
    span: spanning([note, bar]),
    mode: 'pitch',
    items: [note, ws1, chord, ws2, bar],
    eol: '',
  };

  it('组合节点由 children 拼接，自身不存 raw', () => {
    expect(printNode(note)).toBe('^A2');
    expect(printNode(chord)).toBe('[ceg]');
    expect(printAst(doc([line], { hasTrailingNewline: false }))).toBe(source);
  });

  it('未闭合的和弦块不补右括号', () => {
    const unclosed: JcxBodyNode = {
      kind: 'chord',
      path: chord.path,
      span: chord.span,
      open,
      items: inner,
    };
    expect(printNode(unclosed)).toBe('[ceg');
  });
});

describe('printAst —— text block 与 BOM', () => {
  it('闭合的 text block 原样还原，内容行不 trim', () => {
    const source = '%%begintext \n   hi\n%%endtext\n';
    const r = reader(source);
    // lexer 对边界行切的是 whitespace? + textBlockBegin/End + directiveValue?（lexLineKinds.ts）
    const beginChildren = [
      r.leaf({ kind: 'textBlockBegin', raw: '%%begintext' }),
      r.leaf({ kind: 'directiveValue', raw: ' ' }),
    ];
    const content = [r.leaf({ kind: 'textBlockContent', raw: '   hi' })];
    const endChildren = [r.leaf({ kind: 'textBlockEnd', raw: '%%endtext' })];
    const block: JcxLineNode = {
      kind: 'textBlock',
      path: linePath(0),
      span: spanning([...beginChildren, ...endChildren]),
      begin: {
        kind: 'textBlockBoundaryLine',
        path: childPath(linePath(0), 0),
        span: spanning(beginChildren),
        boundary: 'begin',
        children: beginChildren,
        eol: '\n',
      },
      lines: [
        {
          kind: 'textLine',
          path: childPath(linePath(0), 1),
          span: spanning(content),
          children: content,
          eol: '\n',
        },
      ],
      end: {
        kind: 'textBlockBoundaryLine',
        path: childPath(linePath(0), 2),
        span: spanning(endChildren),
        boundary: 'end',
        children: endChildren,
        eol: '\n',
      },
    };
    expect(isTextBlock(block)).toBe(true);
    expect(printAst(doc([block]))).toBe(source);
  });

  it('BOM 与未闭合 text block（end 缺失）同样精确还原', () => {
    const source = '﻿%%begintext\n   hi\n';
    const r = reader(source);
    const bom = r.leaf({ kind: 'bom', raw: '﻿' });
    const beginChildren = [r.leaf({ kind: 'textBlockBegin', raw: '%%begintext' })];
    const content = [r.leaf({ kind: 'textBlockContent', raw: '   hi' })];
    const block: JcxLineNode = {
      kind: 'textBlock',
      path: linePath(0),
      span: spanning([...beginChildren, ...content]),
      begin: {
        kind: 'textBlockBoundaryLine',
        path: childPath(linePath(0), 0),
        span: spanning(beginChildren),
        boundary: 'begin',
        children: beginChildren,
        eol: '\n',
      },
      lines: [
        {
          kind: 'textLine',
          path: childPath(linePath(0), 1),
          span: spanning(content),
          children: content,
          eol: '\n',
        },
      ],
    };
    expect(printAst(doc([block], { hasBom: true, bom }))).toBe(source);
  });
});

describe('printAst —— inline field 行', () => {
  it('内联字段 + 同行正文一起还原', () => {
    const source = '[V:1]CD';
    const r = reader(source);
    const children = [
      r.leaf({ kind: 'inlineFieldOpen', raw: '[' }),
      r.leaf({ kind: 'inlineFieldKey', raw: 'V', key: 'V' }),
      r.leaf({ kind: 'inlineFieldColon', raw: ':' }),
      r.leaf({ kind: 'inlineFieldValue', raw: '1' }),
      r.leaf({ kind: 'inlineFieldClose', raw: ']' }),
    ];
    const trailing: JcxBodyNode[] = (['C', 'D'] as const).map((letter, i) => {
      const leaf = r.leaf({ kind: 'pitchLetter', raw: letter });
      return {
        kind: 'note',
        path: childPath(linePath(0), 5 + i),
        span: leaf.span,
        children: [leaf],
      };
    });
    const line: JcxLineNode = {
      kind: 'inlineFieldLine',
      path: linePath(0),
      span: spanning([...children, ...trailing]),
      key: 'V',
      children,
      trailing,
      eol: '',
    };
    expect(printAst(doc([line], { hasTrailingNewline: false }))).toBe(source);
  });
});

