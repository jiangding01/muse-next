import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { onceKeyed, parseJcxDocument } from '../../../../src/formats/jcx/parse';
import { collectDirectives } from '../../../../src/formats/jcx/parse/directives';

/**
 * M1.6 T9：单元用例直接走 `lexJcx` → `buildAst` → `collectDirectives`；
 * 末尾另有一条经 `parseJcxDocument` 的端到端断言，钉住 `parse/index.ts` 的接线。
 */
function collect(name: string) {
  const ast = buildAst(lexJcx(readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`))));
  const bag = createDiagnosticBag();
  const result = collectDirectives(ast, { bag, once: onceKeyed(bag) });
  return { ast, result, diagnostics: bag.list() };
}

/** 内联源文本（无对应语料形态，不值得建 fixture 文件），同样走真实链路。 */
function collectSource(source: string) {
  const ast = buildAst(lexJcx(source));
  const bag = createDiagnosticBag();
  const result = collectDirectives(ast, { bag, once: onceKeyed(bag) });
  return { ast, result, diagnostics: bag.list() };
}

function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

describe('gchord fixture（spec §10.1/§10.2）', () => {
  const { result, diagnostics } = collect('gchord');

  it('两条 gchord + 一条 showfinger 都进 directives（事实层，原文永不丢）', () => {
    expect(result.directives).toHaveLength(3);
    expect(result.directives.map((d) => d.name)).toEqual(['showfinger', 'gchord', 'gchord']);
    // 约束③：rawValue 是 AST directiveValue 原始 raw，不 trim——名字与值之间的
    // 分隔空白（词法上属于 value 的一部分）原样保留。
    expect(result.directives[1]?.rawValue).toBe(' Em=1;0,2,2,0,0,0');
  });

  it('两条 gchord 均解析成功，进入 chordShapes（派生层，语义解析对副本 trim）', () => {
    expect(result.chordShapes).toHaveLength(2);
    expect(result.chordShapes[0]).toMatchObject({ name: 'Em', capoFret: 1 });
    expect(result.chordShapes[1]).toMatchObject({ name: 'G', capoFret: 1 });
    expect(result.chordShapes[1]?.strings[0]).toMatchObject({ state: 'fretted', fret: 3, finger: 3 });
    // chordShapes 的 rawValue 是喂给解析器的（已 trim）副本，与 directives 的原文分工不同。
    expect(result.chordShapes[0]?.rawValue).toBe('Em=1;0,2,2,0,0,0');
  });

  it('showfinger yes → true', () => {
    expect(result.showFinger).toBe(true);
  });

  it('无 textBlock；不产生任何诊断', () => {
    expect(result.textBlocks).toEqual([]);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('gchord-bad-arity fixture（项数 ≠ 6）', () => {
  const { result, diagnostics } = collect('gchord-bad-arity');

  it('原文仍进 directives（永久保留，约束③），但都不生成 chordShapes', () => {
    expect(result.directives).toHaveLength(2);
    expect(result.chordShapes).toEqual([]);
  });

  it('各发一条 jcx.parse.gchord.malformed warning', () => {
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.gchord.malformed',
      'jcx.parse.gchord.malformed',
    ]);
    expect(diagnostics.every((d) => d.severity === 'warning')).toBe(true);
  });
});

describe('多条成功 gchord（含同名）不去重、不覆盖（用户约束⑤）', () => {
  const { result, diagnostics } = collectSource(
    [
      '%MUSE2',
      '%%gchord Em=1;0,2,2,0,0,0',
      '%%gchord Em=2;0,2,2,0,0,0',
      'X:1',
      'T:Duplicate Gchord Name',
      'M:4/4',
      'L:1/4',
      'K:C',
      'V:1',
      'CDEF|',
      '',
    ].join('\n'),
  );

  it('两条同名 Em 都成功解析，按文档顺序全部进入 chordShapes', () => {
    expect(result.chordShapes).toHaveLength(2);
    expect(result.chordShapes.map((c) => ({ name: c.name, capoFret: c.capoFret }))).toEqual([
      { name: 'Em', capoFret: 1 },
      { name: 'Em', capoFret: 2 },
    ]);
  });

  it('不发任何诊断（两条都合法，没有 malformed 也没有覆盖语义）', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('showfinger-variants fixture（1/yes/true/0/maybe，全部成功值互相覆盖）', () => {
  const { result, diagnostics } = collect('showfinger-variants');

  it('5 条 showfinger 都进 directives', () => {
    expect(result.directives).toHaveLength(5);
    expect(result.directives.every((d) => d.name === 'showfinger')).toBe(true);
  });

  it('最后一条可解析的值（0 → false）覆盖之前的 true；maybe 不更新', () => {
    expect(result.showFinger).toBe(false);
  });

  it('第 2/3/4 条（均成功）各发 overridden；第 5 条（maybe）只发 unparsed，不发 overridden', () => {
    // 第 1 条 "1" 是首次设置成功值，不构成「覆盖」，不发 overridden（约束②）。
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.directive.overridden',
      'jcx.parse.directive.overridden',
      'jcx.parse.directive.overridden',
      'jcx.parse.showfinger.unparsed',
    ]);
  });
});

describe('showfinger-malformed-then-valid fixture（1 → maybe → 0，用户约束②新增用例）', () => {
  const { result, diagnostics } = collect('showfinger-malformed-then-valid');

  it('中间的 malformed 值不清空已生效的 showFinger', () => {
    // 第 2 条 "maybe" 只应发 unparsed，不应把 showFinger 重置为 undefined。
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.showfinger.unparsed',
      'jcx.parse.directive.overridden',
    ]);
  });

  it('第 3 条 "0" 仍然覆盖的是第 1 条的成功值 true，不是被 malformed 抹去后的 undefined', () => {
    expect(result.showFinger).toBe(false);
  });
});

describe('text-block fixture（spec §11）', () => {
  const { result, diagnostics } = collect('text-block');

  it('内容行原样保留，禁止 trim', () => {
    expect(result.textBlocks).toHaveLength(1);
    const block = result.textBlocks[0];
    expect(block?.closed).toBe(true);
    expect(block?.lines).toEqual([
      '      first text line',
      '                  % not a comment here',
      '                  T: not a field here',
    ]);
  });

  it('不产生任何诊断（begintext/endtext 不是 directiveLine，不重复收集）', () => {
    expect(result.directives).toEqual([]);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('unknown-directive fixture（未知指令名）', () => {
  const { result, diagnostics } = collect('unknown-directive');

  it('未知指令与已知 DOC-ONLY 指令都只进 directives，不解析值', () => {
    expect(result.directives.map((d) => d.name)).toEqual(['nosuchdirective', 'jpbeamspace']);
    expect(result.chordShapes).toEqual([]);
    expect(result.showFinger).toBeUndefined();
  });

  it('collectDirectives 本身不发诊断（未知指令名的 info 属于 lexer 职责）', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('directive-spaced fixture（%% 与名字之间带空白；rawValue 不 trim）', () => {
  const { result, diagnostics } = collect('directive-spaced');

  it('continueall / indent 原文进 directives，rawValue 是 AST 原始值（约束③：不 trim）', () => {
    expect(result.directives).toEqual([
      { name: 'continueall', rawValue: ' yes', origin: expect.any(String) },
      { name: 'indent', rawValue: ' 2.5cm', origin: expect.any(String) },
    ]);
  });

  it('不产生任何诊断', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('端到端：parseJcxDocument 把 T9 的产物写进 Score（gchord.jcx）', () => {
  const source = readFileSync(resolve(__dirname, '../../../fixtures/jcx/gchord.jcx'), 'utf-8');
  const { score, diagnostics } = parseJcxDocument(buildAst(lexJcx(source)));

  it('directives / chordShapes / showFinger 都落到 Score 上', () => {
    // fixture 有 3 条 `%%`（showfinger + 2 条 gchord），其中 2 条 gchord 解析成和弦图。
    expect(score.directives.map((directive) => directive.name)).toEqual([
      'showfinger',
      'gchord',
      'gchord',
    ]);
    expect(score.chordShapes).toHaveLength(2);
    expect(score.chordShapes.map((chord) => chord.name)).toEqual(['Em', 'G']);
    expect(score.showFinger).toBe(true);
  });

  it('端到端无 error 级诊断', () => {
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});
