import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { onceKeyed, parseHeader, parseJcxDocument } from '../../../../src/formats/jcx/parse';

/**
 * M1.6 T3：全部走 `lexJcx` → `buildAst` → `parseJcxDocument` 真实链路，
 * 只对投影（字段数组、值对象、诊断 code）断言，不做整树快照。
 */
function fixture(name: string) {
  const ast = buildAst(lexJcx(readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`))));
  return { ast, result: parseJcxDocument(ast) };
}

function parsed(name: string) {
  return fixture(name).result;
}

/** 只看 parse 层新增的诊断（AST/lexer 的那批不在本任务职责内）。 */
function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.')).map((d) => d.code);
}

/** 内联源文本（无对应语料形态，不值得建 fixture 文件），同样走真实链路。 */
function parseSource(source: string) {
  return parseJcxDocument(buildAst(lexJcx(source)));
}

/** 直接跑 parseHeader，用于断言透传给 T4 / T8 的节点引用。 */
function header(name: string) {
  const bag = createDiagnosticBag();
  const ast = buildAst(lexJcx(readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`))));
  return parseHeader(ast, { bag, once: onceKeyed(bag) });
}

describe('minimal fixture', () => {
  const { score, diagnostics } = parsed('minimal');

  it('T:/X: 进 Score，M:/L:/K: 各自解析', () => {
    expect(score.titles).toEqual(['Test Piece One']);
    expect(score.credits).toEqual([]);
    expect(score.notes).toEqual([]);
    expect(score.refNumber).toBe(1);
    expect(score.meter).toEqual({ kind: 'fraction', num: 4, den: 4, raw: '4/4' });
    expect(score.unitLength).toEqual({ num: 1, den: 4 });
    expect(score.key).toEqual({ tonic: 'C', alter: 0, raw: 'C' });
    expect(score.tempo).toBeUndefined();
  });

  it('不产生任何 parse 诊断', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  it('V: 与 w: 不进 Score，只作为节点引用留给 T4 / T8', () => {
    const normalized = header('minimal');
    expect(score.voices).toEqual([]);
    expect(normalized.voiceFields.map((n) => n.key)).toEqual(['V']);
    expect(normalized.voiceFields[0]?.path).toBe('L6');
    expect(normalized.lyricFields).toEqual([]);
  });
});

describe('duplicate-fields fixture（spec §8.12 累加型）', () => {
  const { score, diagnostics } = parsed('duplicate-fields');

  it('多条 T:/C: 保持有序数组，禁止拼接', () => {
    expect(score.titles).toEqual(['First Title', 'Second Title']);
    expect(score.credits).toEqual(['First Composer', 'Second Composer']);
  });

  it('累加型重复不发 overridden', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('header-override fixture（spec §8.12 覆盖型 + §6.2）', () => {
  const { score, diagnostics } = parsed('header-override');

  it('多条 M:/Q: 由后者赢', () => {
    expect(score.meter).toEqual({ kind: 'fraction', num: 6, den: 8, raw: '6/8' });
    expect(score.tempo).toEqual({ beat: { num: 1, den: 4 }, bpm: 96, raw: '1/4=96' });
  });

  it('每次覆盖发一条 info', () => {
    const overridden = diagnostics.filter((d) => d.code === 'jcx.parse.field.overridden');
    expect(overridden).toHaveLength(2);
    expect(overridden.every((d) => d.severity === 'info')).toBe(true);
    expect(overridden.map((d) => d.path)).toEqual(['L4', 'L6']);
  });

  it('第二条 K: 落在 body 区（§6.2 描述头终于首个 K:），按 §8.13 忽略而非覆盖', () => {
    expect(score.key).toEqual({ tonic: 'C', alter: 0, raw: 'C' });
    expect(score.ignoredFields).toEqual([{ name: 'K', rawValue: 'G', origin: 'L9' }]);
    const ignored = diagnostics.filter((d) => d.code === 'jcx.parse.field.ignored-in-body');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]?.severity).toBe('warning');
  });
});

describe('body-field-l fixture（spec §8.5 U06）', () => {
  const { diagnostics } = parsed('body-field-l');
  const normalized = header('body-field-l');

  it('header 的 L: 仍是 Score.unitLength，body 的那条进作用域', () => {
    expect(normalized.unitLength).toEqual({ num: 1, den: 4 });
    expect(normalized.unitLengthScope.entries).toEqual([
      { lineIndex: 8, unitLength: { num: 1, den: 8 }, origin: 'L8' },
    ]);
  });

  it('作用域从该行起生效', () => {
    const scope = normalized.unitLengthScope;
    expect(scope.unitLengthAtLine(7)).toEqual({ num: 1, den: 4 });
    expect(scope.unitLengthAtLine(8)).toEqual({ num: 1, den: 8 });
    expect(scope.unitLengthAt('L9.2')).toEqual({ num: 1, den: 8 });
  });

  it('body 的 L: 发 body-scope info，不发 ignored-in-body', () => {
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.unit-length.body-scope']);
    const [only] = diagnostics.filter((d) => d.code === 'jcx.parse.unit-length.body-scope');
    expect(only?.severity).toBe('info');
    expect(only?.path).toBe('L8');
    expect(only?.message).toContain('U06');
  });

  it('body 的 L: 不进 ignoredFields', () => {
    expect(parsed('body-field-l').score.ignoredFields).toEqual([]);
  });
});

describe('unknown-field fixture（spec §29.1）', () => {
  const { score, diagnostics } = parsed('unknown-field');

  it('未知字母字段收进 unknownFields，保留 raw 与 origin', () => {
    expect(score.unknownFields).toEqual([
      { name: 'S', rawValue: 'some source note', origin: 'L3' },
      { name: 'Z', rawValue: 'some transcriber note', origin: 'L4' },
    ]);
  });

  it('parse 层不重复发未知字段诊断（lexer 已发 warning）', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
    expect(diagnostics.filter((d) => d.code === 'jcx.field.unknown')).toHaveLength(2);
  });
});

describe('inline-percent fixture（spec §5.6 / §8.7）', () => {
  const { score, diagnostics } = parsed('inline-percent');

  it('K:G % 1 sharps 的 % 留在 raw，tonic 仍解析出来', () => {
    expect(score.key).toEqual({ tonic: 'G', alter: 0, raw: 'G % 1 sharps' });
  });

  it('K: 解析不发任何诊断', () => {
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

describe('meter-common-time fixture（spec §8.4 DOC-ONLY）', () => {
  const { score, diagnostics } = parsed('meter-common-time');

  it('M:C 不换算成 4/4，只留 raw', () => {
    expect(score.meter).toEqual({ kind: 'raw', raw: 'C' });
  });

  it('发 meter.unparsed info', () => {
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.meter.unparsed']);
    expect(diagnostics.find((d) => d.code === 'jcx.parse.meter.unparsed')?.severity).toBe('info');
  });

  it('有 L: 时不触发缺省推断', () => {
    expect(score.unitLength).toEqual({ num: 1, den: 4 });
  });
});

describe('no-unit-length-with-meter fixture（spec §8.5）', () => {
  const { score, diagnostics } = parsed('no-unit-length-with-meter');

  it('M:4/4 → 单位音长 1/8', () => {
    expect(score.unitLength).toEqual({ num: 1, den: 8 });
  });

  it('发 defaulted info 并注明来源是文档', () => {
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.unit-length.defaulted']);
    const [only] = diagnostics.filter((d) => d.code === 'jcx.parse.unit-length.defaulted');
    expect(only?.severity).toBe('info');
    expect(only?.message).toContain('help 2.1.2');
    // 诊断挂在描述头最后一条字段行（K:）上，便于编辑器定位。
    expect(only?.path).toBe('L4');
  });
});

describe('no-unit-length-no-meter fixture（方案 §7 E1）', () => {
  const { score, diagnostics } = parsed('no-unit-length-no-meter');

  it('unitLength 留空，不兜底 1/8', () => {
    expect(score.unitLength).toBeUndefined();
    expect(score.meter).toBeUndefined();
  });

  it('发 unresolved warning 而非 error', () => {
    expect(parseCodes(diagnostics)).toEqual(['jcx.parse.unit-length.unresolved']);
    const [only] = diagnostics.filter((d) => d.code === 'jcx.parse.unit-length.unresolved');
    expect(only?.severity).toBe('warning');
    expect(diagnostics.some((d) => d.severity === 'error')).toBe(false);
  });

  it('作用域全程返回 undefined', () => {
    expect(header('no-unit-length-no-meter').unitLengthScope.unitLengthAtLine(9)).toBeUndefined();
  });
});

describe('值形态解析失败的降级（内联源，语料 0 样本）', () => {
  it('X: 非正整数 → refNumber 留空 + ref-number.unparsed info', () => {
    const { score, diagnostics } = parseSource('%MUSE2\nX:one\nT:t\nM:4/4\nL:1/8\nK:C\nV:1\nC|\n');
    expect(score.refNumber).toBeUndefined();
    const [only] = diagnostics.filter((d) => d.code === 'jcx.parse.ref-number.unparsed');
    expect(only?.severity).toBe('info');
    expect(only?.path).toBe('L1');
    // 其余描述头字段不受影响。
    expect(score.unitLength).toEqual({ num: 1, den: 8 });
  });

  it('Q: 非 <分数>=<整数> → 只留 raw + tempo.unparsed info', () => {
    const { score, diagnostics } = parseSource('%MUSE2\nT:t\nM:4/4\nQ:120\nL:1/8\nK:C\nV:1\nC|\n');
    expect(score.tempo).toEqual({ raw: '120' });
    const [only] = diagnostics.filter((d) => d.code === 'jcx.parse.tempo.unparsed');
    expect(only?.severity).toBe('info');
    expect(only?.path).toBe('L3');
  });

  it('header 的 L: 形态不符 → unit-length.unparsed warning，并回落到 M: 缺省推断', () => {
    const { score, diagnostics } = parseSource('%MUSE2\nT:t\nM:2/4\nL:eighth\nK:C\nV:1\nC|\n');
    const codes = parseCodes(diagnostics);
    expect(codes).toEqual(['jcx.parse.unit-length.unparsed', 'jcx.parse.unit-length.defaulted']);
    expect(diagnostics.find((d) => d.code === 'jcx.parse.unit-length.unparsed')?.severity).toBe(
      'warning',
    );
    // M:2/4 < 0.75 → 1/16（spec §8.5）。
    expect(score.unitLength).toEqual({ num: 1, den: 16 });
  });

  it('body 的 L: 形态不符 → warning，且该条不进作用域', () => {
    const bag = createDiagnosticBag();
    const ast = buildAst(lexJcx('%MUSE2\nT:t\nM:4/4\nL:1/8\nK:C\nV:1\nC|\n L:x\nC|\n'));
    const normalized = parseHeader(ast, { bag, once: onceKeyed(bag) });
    expect(normalized.unitLengthScope.entries).toEqual([]);
    expect(bag.list().map((d) => d.code)).toEqual(['jcx.parse.unit-length.unparsed']);
  });
});

describe('parseHeader 的整体不变量', () => {
  it('同一 AST 重复解析结果稳定', () => {
    const { ast } = fixture('header-override');
    expect(parseJcxDocument(ast).score).toEqual(parseJcxDocument(ast).score);
  });

  it('语料常见形态不产生 error 级诊断', () => {
    for (const name of ['minimal', 'duplicate-fields', 'body-field-l', 'inline-percent']) {
      expect(parsed(name).diagnostics.some((d) => d.severity === 'error')).toBe(false);
    }
  });
});
