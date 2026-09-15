import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { decodeJcx } from '../../../../src/formats/jcx/encoding/decodeJcx';
import { buildAst, printAst } from '../../../../src/formats/jcx/ast';
import { collectResidualItemLeaves } from '../../../../scripts/jcx/lib/astInvariants';
import type { JcxAstDocument, JcxLineNode } from '../../../../src/formats/jcx/ast';

/**
 * M1.5 T5：AST 保真 fixture 回归。
 *
 * `lossless.test.ts` 已经对 `tests/fixtures/jcx/` 下全部 fixture 做了
 * 「printAst === decoded」「逐行 printNode」「path 唯一性」「diagnostics 透传」
 * 四条通用不变量回归；本文件不重复它们，只针对本轮新增的 7 个 fixture 断言
 * 「结构长什么样」这类更具体的点（§8.12 重复字段、§8.13 body 字段作用域、
 * §12.2/§12.3 voice 别名、§9.3 交替式多声部）。
 *
 * lyrics / showfinger-variants / voice-without-inline 三个矩阵项顺延到 M1.6：
 * AST 保真本身已经由本文件覆盖的通用 fieldLine / directiveLine / bodyLine
 * 结构覆盖到了（它们不需要任何专门的节点形态），**语义断言**（歌词对齐、
 * showfinger 归一化为 boolean、无 inline field 时声部段落归属）才是 M1.6
 * Parser 的工作，留到那时再补 fixture + 测试，而不是说「AST 无法测试」。
 */

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function buildFromFixture(name: string): {
  decoded: string;
  ast: JcxAstDocument;
  lex: ReturnType<typeof lexJcx>;
} {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
  const decoded = decodeJcx(bytes).text;
  const lex = lexJcx(bytes);
  const ast = buildAst(lex);
  return { decoded, ast, lex };
}

function fieldLines(ast: JcxAstDocument, key: string): Extract<JcxLineNode, { kind: 'fieldLine' }>[] {
  return ast.lines.filter(
    (line): line is Extract<JcxLineNode, { kind: 'fieldLine' }> => line.kind === 'fieldLine' && line.key === key,
  );
}

describe('AST 保真 fixture: duplicate-fields.jcx（§8.12）', () => {
  const { decoded, ast } = buildFromFixture('duplicate-fields.jcx');

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('两条 T: 各自是独立的 fieldLine，顺序与原文一致', () => {
    const titles = fieldLines(ast, 'T');
    expect(titles).toHaveLength(2);
    expect(titles.map((t) => t.path)).toEqual(['L2', 'L3']);
    const values = titles.map((t) => t.children.find((c) => c.token.kind === 'fieldValue')?.raw);
    expect(values).toEqual(['First Title', 'Second Title']);
  });

  it('两条 C: 各自是独立的 fieldLine，顺序与原文一致', () => {
    const composers = fieldLines(ast, 'C');
    expect(composers).toHaveLength(2);
    expect(composers.map((c) => c.path)).toEqual(['L4', 'L5']);
    const values = composers.map((c) => c.children.find((child) => child.token.kind === 'fieldValue')?.raw);
    expect(values).toEqual(['First Composer', 'Second Composer']);
  });

  it('全部 path 互不相同（无因重复字段导致的碰撞）', () => {
    const paths = ast.lines.map((line) => line.path);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('AST 保真 fixture: body-field-l.jcx（§6.4 / §8.5 / §8.13）', () => {
  const { decoded, ast } = buildFromFixture('body-field-l.jcx');

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('body 区的 " L:" 行仍是 fieldLine，region 为 body', () => {
    const lLines = fieldLines(ast, 'L');
    // 索引 0 是 header 区那条 `L:1/4`；索引 1 是 body 区行首带空格的 ` L:1/8`。
    expect(lLines).toHaveLength(2);
    expect(lLines[0]?.region).toBe('header');
    const bodyLLine = lLines[1];
    expect(bodyLLine?.region).toBe('body');
  });

  it('行首空白是 body L: 行 children 里的第一个叶子', () => {
    const bodyLLine = fieldLines(ast, 'L')[1];
    expect(bodyLLine).toBeDefined();
    const firstChild = bodyLLine?.children[0];
    expect(firstChild?.token.kind).toBe('whitespace');
    expect(firstChild?.raw).toBe(' ');
    const fieldValue = bodyLLine?.children.find((c) => c.token.kind === 'fieldValue');
    expect(fieldValue?.raw).toBe('1/8');
  });
});

describe.each([
  { fixture: 'voice-alias-old.jcx', expectedValue: '1 ins=24 vol=40' },
  { fixture: 'voice-alias-new.jcx', expectedValue: '1 instrument=24 volumn=46 play=1' },
])('AST 保真 fixture: $fixture（§12.2 / §12.3）', ({ fixture, expectedValue }) => {
  const { decoded, ast } = buildFromFixture(fixture);

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('V: 的 fieldValue 原文完整保留，不切分属性', () => {
    const voiceLine = fieldLines(ast, 'V')[0];
    expect(voiceLine).toBeDefined();
    const fieldValue = voiceLine?.children.find((c) => c.token.kind === 'fieldValue');
    expect(fieldValue?.raw).toBe(expectedValue);
  });

  it('V: 的 fieldLine 节点形状只含 T1 定义字段，没有新增 attrs/instrument/volume/style 之类的结构化属性', () => {
    // 用户订正：「AST 任何节点不出现 instrument/volume 字样」这条会和 raw 保真
    // 矛盾（instrument=/volumn= 字面量本就该原样出现在 raw 里）。真正要断言的
    // 是「没有语义归一化、没有新增结构化字段」——M1.5 边界内 V: 字段不切属性，
    // 归一化是 M1.6 Domain 层的工作，这里的 fieldLine 节点形状必须还是 T1 的
    // `JcxFieldLineNode`：`kind` / `path` / `span` / `eol` / `key` / `region` /
    // `children`，不多不少，不存在旁路加出来的 `attrs` / `instrument` /
    // `volume` / `style` 字段。
    const voiceLine = fieldLines(ast, 'V')[0];
    if (voiceLine === undefined) {
      throw new Error('expected a V: fieldLine to exist');
    }
    const actualKeys = Object.keys(voiceLine).sort();
    expect(actualKeys).toEqual(['children', 'eol', 'key', 'kind', 'path', 'region', 'span'].sort());
  });
});

it('voice-alias-new.jcx：volumn 未被改写成 volume（raw 逐字相等）', () => {
  const { ast } = buildFromFixture('voice-alias-new.jcx');
  const voiceLine = fieldLines(ast, 'V')[0];
  const fieldValue = voiceLine?.children.find((c) => c.token.kind === 'fieldValue');
  expect(fieldValue?.raw).toContain('volumn=46');
  expect(fieldValue?.raw).not.toContain('volume=');
});

describe('AST 保真 fixture: voice-no-style.jcx（§12.6.1，lexer fallback 而非 Domain 默认值）', () => {
  const { decoded, ast } = buildFromFixture('voice-no-style.jcx');

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('两条无 style= 的 V: 各自 fieldValue 原文保留', () => {
    const voices = fieldLines(ast, 'V');
    expect(voices).toHaveLength(2);
    const values = voices.map((v) => v.children.find((c) => c.token.kind === 'fieldValue')?.raw);
    expect(values).toEqual(['1', '2']);
  });

  it(
    '后续 bodyLine 的 mode 为 pitch —— 这只是 lexer 在没有 style=tab 信号时的' +
      ' tokenization fallback（§13.2 模式判定默认落在 pitch），不是 Domain 对' +
      ' style 缺省语义的实现；style 缺省时的真实回退语义仍是 §12.6.1 标注的' +
      ' UNVERIFIED，留给 M1.6 验证。',
    () => {
      const bodyLine = ast.lines.find((line) => line.kind === 'bodyLine');
      expect(bodyLine).toBeDefined();
      expect(bodyLine?.kind === 'bodyLine' && bodyLine.mode).toBe('pitch');
    },
  );
});

describe('AST 保真 fixture: voice-unknown-attr.jcx（§12.2 / §29.1）', () => {
  const { decoded, ast, lex } = buildFromFixture('voice-unknown-attr.jcx');

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('foo=bar 原样保留在 fieldValue 里', () => {
    const voiceLine = fieldLines(ast, 'V')[0];
    const fieldValue = voiceLine?.children.find((c) => c.token.kind === 'fieldValue');
    expect(fieldValue?.raw).toBe('1 foo=bar');
  });

  it('diagnostics 直接透传自 lexer——有无诊断由 lexer 现状决定，AST 不新增', () => {
    expect(ast.diagnostics).toBe(lex.diagnostics);
  });
});

describe('AST 保真 fixture: inline-voice-alternating.jcx（§9.3 交替式）', () => {
  const { decoded, ast } = buildFromFixture('inline-voice-alternating.jcx');

  it('printAst 全文还原', () => {
    expect(printAst(ast)).toBe(decoded);
  });

  it('inlineFieldLine 序列按声部交替顺序正确出现', () => {
    const inlineFields = ast.lines.filter((line) => line.kind === 'inlineFieldLine');
    expect(inlineFields).toHaveLength(4);
    for (const line of inlineFields) {
      expect(line.kind === 'inlineFieldLine' && line.key).toBe('V');
    }
    const values = inlineFields.map((line) => {
      if (line.kind !== 'inlineFieldLine') return undefined;
      return line.children.find((c) => c.token.kind === 'inlineFieldValue')?.raw;
    });
    expect(values).toEqual(['1', '2', '1', '2']);
  });

  it('各 bodyLine 的 mode 随声部交替（V:1=tab, V:2=staff/pitch）', () => {
    const bodyLines = ast.lines.filter((line): line is Extract<JcxLineNode, { kind: 'bodyLine' }> => line.kind === 'bodyLine');
    expect(bodyLines).toHaveLength(4);
    expect(bodyLines.map((line) => line.mode)).toEqual(['tab', 'pitch', 'tab', 'pitch']);
  });
});

describe('collectResidualItemLeaves 口径回归（scripts/jcx/lib/astInvariants.ts）', () => {
  // 用户订正：残留通用叶子只统计「item 位置」——bodyLine.items /
  // inlineFieldLine.trailing / chord-grace-tabGroup 的 items（含嵌套）——
  // 不算 note/rest/tabNote 的 children、括号组 open/close、字段行外壳
  // children。这两个固定用例钉住口径，防止语料回归脚本再把组合节点内部的
  // 原料 token（pitchLetter/duration/…）误算成残留。
  function firstBodyLine(source: string) {
    const lex = lexJcx(source);
    const ast = buildAst(lex);
    const line = ast.lines.find((l): l is Extract<JcxLineNode, { kind: 'bodyLine' }> => l.kind === 'bodyLine');
    if (line === undefined) throw new Error('no bodyLine produced');
    return { ast, line };
  }

  it('"C2 |"：note 吃掉了 pitchLetter/duration，残留为 0', () => {
    const { ast } = firstBodyLine('%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nC2 |\n');
    expect(collectResidualItemLeaves(ast)).toEqual([]);
  });

  it('"|2 |"：barline 后裸露的 "2" 没有 pitchLetter 可依附，不能组成 note，残留为 1（duration）', () => {
    const { ast, line } = firstBodyLine('%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\n|2 |\n');
    expect(line.items.map((item) => item.kind)).toEqual(['barline', 'token', 'whitespace', 'barline']);
    expect(collectResidualItemLeaves(ast)).toEqual(['duration']);
  });
});
