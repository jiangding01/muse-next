import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { buildLineNodes } from '../../../../src/formats/jcx/ast/buildLines';
import { isTextBlock, parseAstPath, printAst, printNode } from '../../../../src/formats/jcx/ast';
import { buildAst } from '../../../../src/formats/jcx/ast';
import type { JcxLineNode } from '../../../../src/formats/jcx/ast';

/**
 * T2 buildLineNodes 的行为回归：每种非正文行 kind 一个断言组，全部基于
 * `lexJcx` 的真实输出（不手搓 token），只验证「分组是否正确」。
 */

describe('buildLineNodes —— magicHeaderLine / commentLine / blankLine', () => {
  const source = '%MUSE2\n% a comment\n\nCDE\n';
  const lex = lexJcx(source);
  const lines = buildLineNodes(lex);

  it('magic header 行映射为 magicHeaderLine', () => {
    const line = lines[0] as JcxLineNode;
    expect(line.kind).toBe('magicHeaderLine');
    expect(line.path).toBe('L0');
    if (line.kind !== 'textBlock') {
      expect(line.eol).toBe('\n');
    }
  });

  it('% 注释行映射为 commentLine，含行尾', () => {
    const line = lines[1] as JcxLineNode;
    expect(line.kind).toBe('commentLine');
    if (line.kind === 'commentLine') {
      expect(line.children.map((c) => c.raw).join('')).toBe('% a comment');
      expect(line.eol).toBe('\n');
    }
  });

  it('空行映射为 blankLine，children 可以是空数组', () => {
    const line = lines[2] as JcxLineNode;
    expect(line.kind).toBe('blankLine');
    if (line.kind === 'blankLine') {
      expect(line.eol).toBe('\n');
    }
  });

  it('body 行本任务降级为 rawLine，children 数等于该行全部 token 数', () => {
    const line = lines[3] as JcxLineNode;
    expect(line.kind).toBe('rawLine');
    const bodyLine = lex.lines[3];
    if (line.kind === 'rawLine' && bodyLine) {
      // 该行有 eol，故 rawLine.children 数 = 原始 tokens 数 - 1（eol 不进 children）。
      expect(line.children.length).toBe(bodyLine.tokens.length - 1);
    }
  });

  it('无损：printAst(buildAst(lex)) === source', () => {
    expect(printAst(buildAst(lex))).toBe(source);
  });
});

describe('buildLineNodes —— fieldLine 的 key / region', () => {
  it('K: 之前的字段行是 header，K: 本身是 header，K: 之后的字段行是 body', () => {
    const source = 'T: Title\nK: C\nL: 1/4\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);

    const t = lines[0];
    const k = lines[1];
    const l = lines[2];
    expect(t?.kind).toBe('fieldLine');
    expect(k?.kind).toBe('fieldLine');
    expect(l?.kind).toBe('fieldLine');
    if (t?.kind === 'fieldLine' && k?.kind === 'fieldLine' && l?.kind === 'fieldLine') {
      expect(t.key).toBe('T');
      expect(t.region).toBe('header');
      expect(k.key).toBe('K');
      expect(k.region).toBe('header');
      expect(l.key).toBe('L');
      expect(l.region).toBe('body');
    }
  });

  it('全文没有 K: 时，所有字段行都留在 header', () => {
    const source = 'T: Title\nC: Composer\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    for (const line of lines) {
      expect(line.kind).toBe('fieldLine');
      if (line.kind === 'fieldLine') {
        expect(line.region).toBe('header');
      }
    }
  });
});

describe('buildLineNodes —— directiveLine', () => {
  it('%%name value 映射为 directiveLine，name 取自 directiveName token', () => {
    const source = '%%staffwidth 200\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    const line = lines[0];
    expect(line?.kind).toBe('directiveLine');
    if (line?.kind === 'directiveLine') {
      expect(line.name).toBe('staffwidth');
      expect(printNode(line)).toBe(source);
    }
  });
});

describe('buildLineNodes —— rawLine 兜底', () => {
  it('全角冒号字段行（§29.4）映射为 rawLine', () => {
    const source = 'T：Title\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    expect(lines[0]?.kind).toBe('rawLine');
  });

  it('inlineFieldLine 本任务暂降级为 rawLine', () => {
    const source = '[V:1] CDE\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    const line = lines[0];
    expect(line?.kind).toBe('rawLine');
    if (line?.kind === 'rawLine') {
      expect(printNode(line)).toBe(source);
    }
  });
});

describe('buildLineNodes —— textBlock', () => {
  it('闭合的 text block：begin + 内容行 + end，path 用 childPath(Lx, n) 编号', () => {
    const source = 'T: t\n%%begintext\nhello\nworld\n%%endtext\nK: C\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);

    // lines: [T field(L0), textBlock(L1), K field(L5)]
    expect(lines.length).toBe(3);
    const block = lines[1];
    expect(block?.kind).toBe('textBlock');
    if (block !== undefined && isTextBlock(block)) {
      expect(block.path).toBe('L1');
      expect(block.begin.path).toBe('L1.0');
      expect(block.begin.boundary).toBe('begin');
      expect(block.lines.map((l) => l.path)).toEqual(['L1.1', 'L1.2']);
      expect(block.lines.map((l) => l.children.map((c) => c.raw).join(''))).toEqual(['hello', 'world']);
      expect(block.end?.path).toBe('L1.3');
      expect(block.end?.boundary).toBe('end');
      // textBlock 覆盖的是 4 条物理行（begin + 2 内容行 + end），
      // printNode 应精确等于这 4 行原文的拼接。
      expect(printNode(block)).toBe('%%begintext\nhello\nworld\n%%endtext\n');
    }

    expect(printAst(buildAst(lex))).toBe(source);
  });

  it('未闭合的 text block 延伸到文件末尾，end 缺失', () => {
    const source = '%%begintext\nhello\nworld';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    expect(lines.length).toBe(1);
    const block = lines[0];
    if (block !== undefined && isTextBlock(block)) {
      expect(block.end).toBeUndefined();
      expect(block.lines.map((l) => l.path)).toEqual(['L0.1', 'L0.2']);
      expect(printNode(block)).toBe(source);
    }
    expect(printAst(buildAst(lex))).toBe(source);
  });

  it('孤立的 %%endtext（无匹配 begin）降级为 rawLine', () => {
    const source = '%%endtext\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    expect(lines.length).toBe(1);
    expect(lines[0]?.kind).toBe('rawLine');
    expect(printAst(buildAst(lex))).toBe(source);
  });
});

describe('buildLineNodes —— BOM 不重复出现', () => {
  it('首行 children 不含 bom token，document.bom 单独持有它', () => {
    const source = '﻿%MUSE2\n';
    const lex = lexJcx(source);
    const ast = buildAst(lex);
    expect(ast.bom?.raw).toBe('﻿');
    const first = ast.lines[0];
    if (first?.kind === 'magicHeaderLine') {
      expect(first.children.some((c) => c.token.kind === 'bom')).toBe(false);
      expect(printNode(first)).toBe('%MUSE2\n');
    }
    expect(printAst(ast)).toBe(source);
  });
});

describe('buildLineNodes —— path 唯一且可解析（textBlock 之外）', () => {
  it('非 textBlock 行的 path 都能被 parseAstPath 解析', () => {
    const source = 'T: t\nK: C\nCDE\n';
    const lex = lexJcx(source);
    const lines = buildLineNodes(lex);
    for (const line of lines) {
      expect(parseAstPath(line.path)).not.toBeNull();
    }
  });
});
