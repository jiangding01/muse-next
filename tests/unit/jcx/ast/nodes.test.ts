import { describe, expect, it } from 'vitest';
import type { JcxTokenKind } from '../../../../src/formats/jcx/lexer/token';
import { isLeaf, isTokenLeaf, linePath, printNode } from '../../../../src/formats/jcx/ast';
import type {
  JcxBodyLeafKind,
  JcxBodyNode,
  JcxNoteNode,
  JcxTokenLeaf,
} from '../../../../src/formats/jcx/ast';
import { reader } from './astFixtures';
import type { TokenSeed } from './astFixtures';

describe('叶子节点与 token 的关系', () => {
  const seeds: readonly TokenSeed[] = [
    { kind: 'bom', raw: '﻿' },
    { kind: 'whitespace', raw: '  ' },
    { kind: 'magicHeader', raw: '%MUSE2' },
    { kind: 'comment', raw: '% x' },
    { kind: 'fieldKey', raw: 'T', key: 'T' },
    { kind: 'fieldColon', raw: ':' },
    { kind: 'fieldValue', raw: 'Hello' },
    { kind: 'directiveName', raw: 'gchord', name: 'gchord' },
    { kind: 'inlineFieldKey', raw: 'V', key: 'V' },
    { kind: 'textBlockBegin', raw: '%%begintext' },
    { kind: 'rest', raw: 'z', letter: 'z' },
    { kind: 'decorationComplex', raw: '!x!', parts: ['x'] },
    { kind: 'pitchLetter', raw: 'C' },
    { kind: 'barline', raw: '|' },
  ];

  it.each(seeds.map((seed) => [seed.kind, seed] as const))(
    '通用叶子 %s 的 raw 与 span 直接取自 token（span 为同一引用）',
    (_kind, seed) => {
      const leaf: JcxTokenLeaf = reader(seed.raw).leaf(seed);
      expect(leaf.raw).toBe(leaf.token.raw);
      expect(leaf.span).toBe(leaf.token.span);
      expect(printNode(leaf)).toBe(seed.raw);
    },
  );

  it('正文叶子同样与 token 保持同一 raw / span 引用', () => {
    const cases: readonly (readonly [JcxBodyLeafKind, JcxTokenKind, string])[] = [
      ['barline', 'barline', '|'],
      ['repeatEnding', 'repeatEnding', '[1'],
      ['chordSymbol', 'chordSymbol', '"Am"'],
      ['decoration', 'decorationSimple', '.'],
      ['tupletStart', 'tupletStart', '(3'],
      ['slurOpen', 'slurOpen', '('],
      ['slurClose', 'slurClose', ')'],
      ['tie', 'tie', '-'],
      ['brokenRhythm', 'brokenRhythm', '>'],
      ['tabRelation', 'tabRelation', '-S-'],
      ['strokePrefix', 'strokePrefix', 'V'],
      ['whitespace', 'whitespace', ' '],
      ['rawToken', 'raw', '§'],
    ];
    for (const [leafKind, tokenKind, raw] of cases) {
      const leaf = reader(raw).bodyLeaf(leafKind, { kind: tokenKind, raw } as TokenSeed);
      expect(leaf.kind).toBe(leafKind);
      expect(leaf.raw).toBe(leaf.token.raw);
      expect(leaf.span).toBe(leaf.token.span);
      expect(printNode(leaf)).toBe(raw);
    }
  });

  it('边界 A：tie 叶子不能进 note.children（类型层拦截）', () => {
    const r = reader('-');
    const tie = r.leaf({ kind: 'tie', raw: '-' });
    const note: JcxNoteNode = {
      kind: 'note',
      path: linePath(0),
      span: tie.span,
      // @ts-expect-error tie 是 note 的兄弟节点，不属于 note 合并范围（M1.5 边界 A）
      children: [tie],
    };
    expect(note.kind).toBe('note');
  });
});

describe('类型守卫', () => {
  const r = reader('C|');
  const tokenLeaf = r.leaf({ kind: 'pitchLetter', raw: 'C' });
  const bar = r.bodyLeaf('barline', { kind: 'barline', raw: '|' });
  const note: JcxBodyNode = {
    kind: 'note',
    path: linePath(0),
    span: tokenLeaf.span,
    children: [tokenLeaf],
  };

  it('isLeaf 认通用 token 叶子与正文单 token 叶子，不认组合节点', () => {
    expect(isLeaf(tokenLeaf)).toBe(true);
    expect(isLeaf(bar)).toBe(true);
    expect(isLeaf(note)).toBe(false);
  });

  it('isTokenLeaf 只认通用 token 叶子', () => {
    expect(isTokenLeaf(tokenLeaf)).toBe(true);
    expect(isTokenLeaf(bar)).toBe(false);
  });
});
