import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { buildLineNodes } from '../../../../src/formats/jcx/ast/buildLines';
import { buildBodyLeaves } from '../../../../src/formats/jcx/ast/buildBodyLine';
import { childPath, linePath, parseAstPath, printLine, printNode } from '../../../../src/formats/jcx/ast';
import type { JcxAstNode, JcxBodyNode, JcxLineNode } from '../../../../src/formats/jcx/ast';
import type { JcxFieldKeyToken } from '../../../../src/formats/jcx/lexer/token';

/**
 * M1.5 T3 buildBodyLine 的行为回归：全部基于 `lexJcx` 的真实输出，只验证
 * 「inlineFieldLine / bodyLine 的骨架装箱是否正确」——正文 token 一律扁平映射
 * 为叶子（有专用 kind 的用 dedicated leaf，没有的用通用 `token` leaf），
 * 不做任何 note/chord/grace/tabNote/tabGroup 组合（T4 的事）。
 */

/** 单行源码 → 该行唯一的 `JcxLineNode`（跳过其余行，调用方保证只有一行）。 */
function lexOneLine(source: string): JcxLineNode {
  const lex = lexJcx(source);
  const lines = buildLineNodes(lex);
  const line = lines[0];
  if (line === undefined) {
    throw new Error(`lexOneLine: no line produced for ${JSON.stringify(source)}`);
  }
  return line;
}

/** 断言一组 `JcxBodyNode` 的 path 是 `childPath(base, start..start+n-1)`，连续无重复。 */
function expectContinuousPaths(nodes: readonly JcxBodyNode[], basePath: string, start: number): void {
  nodes.forEach((node, offset) => {
    expect(node.path).toBe(`${basePath}.${start + offset}`);
    expect(parseAstPath(node.path)).not.toBeNull();
  });
}

/**
 * 断言一组节点打印后拼接等于给定原文。用 `printNode` 而不是直接读 `.raw`——
 * `JcxBodyNode` 联合含组合节点（无 `raw` 字段），`printNode` 对叶子等价于
 * `.raw`，对组合节点则递归拼接 children，两种情况都成立。
 */
function expectRawJoin(nodes: readonly JcxAstNode[], expected: string): void {
  expect(nodes.map((n) => printNode(n)).join('')).toBe(expected);
}

describe('buildBodyLine —— inlineFieldLine', () => {
  it('[V:1] 无 trailing：children 5 个（紧凑写法，异常空白 token 因 raw 为空被 TokenBuilder 跳过），trailing 为空数组', () => {
    const line = lexOneLine('[V:1]\n');
    expect(line.kind).toBe('inlineFieldLine');
    if (line.kind !== 'inlineFieldLine') return;
    expect(line.key).toBe('V');
    expect(line.children.length).toBe(5);
    expect(line.trailing).toEqual([]);
    expectContinuousPaths(line.children, 'L0', 0);
    expectRawJoin(line.children, '[V:1]');
    expect(printLine(line)).toBe('[V:1]\n');
  });

  it('[V: 1] 容忍异常空格：仍是 inlineFieldLine，key 不受空格影响', () => {
    const line = lexOneLine('[V: 1]\n');
    expect(line.kind).toBe('inlineFieldLine');
    if (line.kind !== 'inlineFieldLine') return;
    expect(line.key).toBe('V');
    expectContinuousPaths(line.children, 'L0', 0);
    expect(printLine(line)).toBe('[V: 1]\n');
  });

  it('[V:1] CDE：trailing 承载同行正文，children/trailing 共用连续 path', () => {
    const line = lexOneLine('[V:1] CDE\n');
    expect(line.kind).toBe('inlineFieldLine');
    if (line.kind !== 'inlineFieldLine') return;
    expect(line.children.length).toBe(5);
    // trailing 含 `]` 与 `CDE` 之间的空格，共 4 个：whitespace + 3 个 pitchLetter。
    expect(line.trailing.length).toBe(4);
    expect(line.trailing.map((n) => n.kind)).toEqual(['whitespace', 'token', 'token', 'token']);
    for (const node of line.trailing.slice(1)) {
      expect(node.kind).toBe('token');
      if (node.kind === 'token') {
        expect(node.token.kind).toBe('pitchLetter');
      }
    }
    expectRawJoin(line.trailing, ' CDE');
    // trailing 从 children.length（5）开始续编号，不与 children 重号。
    expectContinuousPaths(line.children, 'L0', 0);
    expectContinuousPaths(line.trailing, 'L0', 5);
    expect(printLine(line)).toBe('[V:1] CDE\n');
  });
});

describe('buildBodyLine —— bodyLine 默认 mode 为 pitch', () => {
  it('没有任何 voice 上下文时，正文行 mode 是 pitch', () => {
    const line = lexOneLine('CDE\n');
    expect(line.kind).toBe('bodyLine');
    if (line.kind !== 'bodyLine') return;
    expect(line.mode).toBe('pitch');
    expectContinuousPaths(line.items, 'L0', 0);
    expect(printLine(line)).toBe('CDE\n');
  });
});

describe('buildBodyLine —— pitch 模式各构造独立成叶子', () => {
  function pitchLine(content: string): readonly JcxBodyNode[] {
    const line = lexOneLine(`${content}\n`);
    expect(line.kind).toBe('bodyLine');
    if (line.kind !== 'bodyLine') throw new Error('expected bodyLine');
    expect(line.mode).toBe('pitch');
    expectContinuousPaths(line.items, 'L0', 0);
    expectRawJoin(line.items, content);
    expect(printLine(line)).toBe(`${content}\n`);
    return line.items;
  }

  it('barline：最长匹配的 |] 整体一个 dedicated 叶子', () => {
    const items = pitchLine('|]');
    expect(items.map((i) => i.kind)).toEqual(['barline']);
    expect(items[0] !== undefined && printNode(items[0])).toBe('|]');
  });

  it('decorationSimple：!p! 映射为 decoration', () => {
    const items = pitchLine('!p!');
    expect(items.map((i) => i.kind)).toEqual(['decoration']);
  });

  it("decorationComplex：!@x'1'! 同样映射为 decoration（形态差异看 token.kind）", () => {
    const items = pitchLine("!@x'1'!");
    expect(items.map((i) => i.kind)).toEqual(['decoration']);
    expect(items[0]?.kind === 'decoration' && items[0].token.kind).toBe('decorationComplex');
  });

  it('chordSymbol：带引号的和弦符号', () => {
    const items = pitchLine('"Cm"');
    expect(items.map((i) => i.kind)).toEqual(['chordSymbol']);
  });

  it('tupletStart：(3 只是标记，不配对', () => {
    const items = pitchLine('(3');
    expect(items.map((i) => i.kind)).toEqual(['tupletStart']);
  });

  it('slurOpen / slurClose：兄弟节点，不建树', () => {
    const items = pitchLine('(A)');
    expect(items.map((i) => i.kind)).toEqual(['slurOpen', 'token', 'slurClose']);
  });

  it('tie：C-D 中的 - 独立成叶子', () => {
    const items = pitchLine('C-D');
    expect(items.map((i) => i.kind)).toEqual(['token', 'tie', 'token']);
  });

  it('brokenRhythm：>/< 各自独立成叶子', () => {
    const items = pitchLine('A>B<C');
    expect(items.map((i) => i.kind)).toEqual(['token', 'brokenRhythm', 'token', 'brokenRhythm', 'token']);
  });

  it('rest / hiddenRest：没有专用叶子 kind，走通用 token 叶子（T3 不提前组合）', () => {
    const items = pitchLine('z Z @');
    expect(items.map((i) => i.kind)).toEqual(['token', 'whitespace', 'token', 'whitespace', 'token']);
    const [restZ, , restZUpper, , hidden] = items;
    expect(restZ?.kind === 'token' && restZ.token.kind).toBe('rest');
    expect(restZUpper?.kind === 'token' && restZUpper.token.kind).toBe('rest');
    expect(hidden?.kind === 'token' && hidden.token.kind).toBe('hiddenRest');
  });

  it('whitespace：多空格原样保留一个叶子，不 collapse', () => {
    const items = pitchLine('A  B');
    expect(items.map((i) => i.kind)).toEqual(['token', 'whitespace', 'token']);
    expect(items[1] !== undefined && printNode(items[1])).toBe('  ');
  });

  it('raw：无法归类的字符降级为 rawToken 叶子', () => {
    const items = pitchLine('~');
    expect(items.map((i) => i.kind)).toEqual(['rawToken']);
  });

  it('accidental / pitchLetter / octaveMark / duration：均无专用叶子 kind，通用 token 叶子', () => {
    const items = pitchLine("^^C,2");
    expect(items.map((i) => i.kind)).toEqual(['token', 'token', 'token', 'token']);
    expect(items.map((i) => (i.kind === 'token' ? i.token.kind : null))).toEqual([
      'accidental',
      'pitchLetter',
      'octaveMark',
      'duration',
    ]);
  });

  it('chordOpen / chordClose：[CEG] 外壳与内容都不建树', () => {
    const items = pitchLine('[CEG]');
    expect(items.map((i) => i.kind)).toEqual(['token', 'token', 'token', 'token', 'token']);
    expect(items.map((i) => (i.kind === 'token' ? i.token.kind : null))).toEqual([
      'chordOpen',
      'pitchLetter',
      'pitchLetter',
      'pitchLetter',
      'chordClose',
    ]);
  });

  it('graceOpen / graceClose：{c} 外壳与内容都不建树', () => {
    const items = pitchLine('{c}');
    expect(items.map((i) => i.kind)).toEqual(['token', 'token', 'token']);
    expect(items.map((i) => (i.kind === 'token' ? i.token.kind : null))).toEqual([
      'graceOpen',
      'pitchLetter',
      'graceClose',
    ]);
  });
});

describe('buildBodyLine —— tab 模式各构造独立成叶子', () => {
  const header = '%MUSE2\nV:1 style=tab clef=standardtab\nK: C\n';

  it('[V:1] a1*2：切换到 tab 模式后，trailing 含 stringLetter/fret/tabDurSep/duration', () => {
    const source = `${header}[V:1] a1*2\n`;
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    const line = lines[3];
    expect(line?.kind).toBe('inlineFieldLine');
    if (line === undefined || line.kind !== 'inlineFieldLine') return;
    // trailing 含 `]` 与 `a1*2` 之间的那个空格（inline field 之后的正文，不 trim）。
    expect(line.trailing.map((i) => i.kind)).toEqual(['whitespace', 'token', 'token', 'token', 'token']);
    expect(line.trailing.map((i) => (i.kind === 'token' ? i.token.kind : null))).toEqual([
      null,
      'stringLetter',
      'fret',
      'tabDurSep',
      'duration',
    ]);
    expectRawJoin(line.trailing, ' a1*2');
    expect(printLine(line)).toBe('[V:1] a1*2\n');
  });

  it('V a[bc] -S- -H- -P- {ab}：strokePrefix/tabGroup/tabRelation/grace 均正确装箱，mode 为 tab', () => {
    const content = 'V a[bc] -S- -H- -P- {ab}';
    const source = `${header}[V:1] a1\n${content}\n`;
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    const line = lines[4];
    expect(line?.kind).toBe('bodyLine');
    if (line === undefined || line.kind !== 'bodyLine') return;
    expect(line.mode).toBe('tab');
    expectRawJoin(line.items, content);
    expectContinuousPaths(line.items, line.path, 0);

    const kinds = line.items.map((i) => i.kind);
    expect(kinds).toEqual([
      'strokePrefix', // V（悬空前缀，仍是合法 dedicated 叶子）
      'whitespace',
      'token', // stringLetter a
      'token', // tabGroupOpen [
      'token', // stringLetter b
      'token', // stringLetter c
      'token', // tabGroupClose ]
      'whitespace',
      'tabRelation', // -S-
      'whitespace',
      'tabRelation', // -H-
      'whitespace',
      'tabRelation', // -P-
      'whitespace',
      'token', // graceOpen {
      'token', // stringLetter a
      'token', // stringLetter b
      'token', // graceClose }
    ]);
    expect(printLine(line)).toBe(`${content}\n`);
  });
});

describe('buildBodyLine —— 行级 token 混入 body 流（契约之外的输入）', () => {
  it('手工喂一个 fieldKey token 给 buildBodyLeaves：退回通用叶子，不抛异常，raw 保真', () => {
    const zero = { offset: 0, line: 1, column: 0 };
    const one = { offset: 1, line: 1, column: 1 };
    const fieldKeyToken: JcxFieldKeyToken = { kind: 'fieldKey', raw: 'T', key: 'T', span: { start: zero, end: one } };
    const base = linePath(0);

    let nodes: JcxBodyNode[] = [];
    expect(() => {
      nodes = buildBodyLeaves([fieldKeyToken], base, 0);
    }).not.toThrow();

    expect(nodes.length).toBe(1);
    const node = nodes[0];
    expect(node?.kind).toBe('token');
    if (node?.kind === 'token') {
      expect(node.token.kind).toBe('fieldKey');
      expect(node.raw).toBe('T');
    }
    expect(node?.path).toBe(childPath(base, 0));
    expectRawJoin(nodes, 'T');
  });
});

describe('buildBodyLine —— rawLine 永久兜底', () => {
  it('全角冒号字段行（§29.4）仍是 rawLine，不被结构化解析', () => {
    const line = lexOneLine('T：Title\n');
    expect(line.kind).toBe('rawLine');
    expect(printLine(line)).toBe('T：Title\n');
  });
});
