import { describe, expect, it } from 'vitest';

import {
  meterRatio,
  parseKey,
  parseMeter,
  parseTempo,
  parseUnitLength,
  resolveDefaultUnitLength,
  createUnitLengthScope,
} from '../../../../src/formats/jcx/parse';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { SourceSpan } from '../../../../src/formats/jcx/lexer/sourceSpan';

/**
 * M1.6 T3：`M:` / `Q:` / `K:` / `L:` 的值解析是纯函数，这里直接单测形态边界；
 * 端到端行为（谁赢、发什么诊断）在 header.test.ts 走真实链路。
 */
const SPAN: SourceSpan = {
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 3, line: 1, column: 3 },
};

describe('parseMeter（spec §8.4）', () => {
  it.each(['2/4', '3/4', '4/4', '6/8'])('语料形态 %s 解析出 num/den', (raw) => {
    const [num, den] = raw.split('/');
    expect(parseMeter(raw)).toEqual({ kind: 'fraction', num: Number(num), den: Number(den), raw });
  });

  it.each(['C', 'C|', 'none', '(2+3+2)/8', '', '4/0'])(
    'DOC-ONLY / UNVERIFIED 形态 %s 只留 raw',
    (raw) => {
      expect(parseMeter(raw)).toEqual({ kind: 'raw', raw });
    },
  );

  it('meterRatio 只在有数值拍号时给出小数', () => {
    expect(meterRatio(parseMeter('6/8'))).toBeCloseTo(0.75);
    expect(meterRatio(parseMeter('C'))).toBeUndefined();
    expect(meterRatio(undefined)).toBeUndefined();
  });
});

describe('parseTempo（spec §8.6）', () => {
  it('语料形态 1/4=66 解析出 beat 与 bpm', () => {
    expect(parseTempo('1/4=66')).toEqual({ beat: { num: 1, den: 4 }, bpm: 66, raw: '1/4=66' });
  });

  it('beat 按 Rational 约分', () => {
    expect(parseTempo('2/8=90').beat).toEqual({ num: 1, den: 4 });
  });

  it.each(['120', '"Allegro" 1/4=120', '1/4 = 66', '1/0=66', ''])(
    'UNVERIFIED 形态 %s 只留 raw',
    (raw) => {
      expect(parseTempo(raw)).toEqual({ raw });
    },
  );
});

describe('parseKey（spec §8.7）', () => {
  it.each([
    ['C', 'C', 0],
    ['G', 'G', 0],
    ['Eb', 'E', -1],
    ['F#', 'F', 1],
  ])('%s → tonic %s / alter %i', (raw, tonic, alter) => {
    expect(parseKey(raw)).toEqual({ tonic, alter, raw });
  });

  it('语料的行内 % 文本整段留在 raw', () => {
    expect(parseKey('G % 1 sharps')).toEqual({ tonic: 'G', alter: 0, raw: 'G % 1 sharps' });
  });

  it('mode / clef 不解析，只出现在 raw 里', () => {
    expect(parseKey('A Mix')).toEqual({ tonic: 'A', alter: 0, raw: 'A Mix' });
    expect(parseKey('A bass')).toEqual({ tonic: 'A', alter: 0, raw: 'A bass' });
  });

  it.each(['none', 'HP', '', 'x'])('无法识别的 %s 只留 raw', (raw) => {
    expect(parseKey(raw)).toEqual({ raw });
  });
});

describe('parseUnitLength（spec §8.5）', () => {
  it.each([
    ['1/8', { num: 1, den: 8 }],
    ['1/4', { num: 1, den: 4 }],
    ['2/16', { num: 1, den: 8 }],
  ])('%s 解析并约分', (raw, expected) => {
    expect(parseUnitLength(raw)).toEqual(expected);
  });

  it.each(['1/0', 'C', '', '1 / 8'])('形态不符的 %s 返回 undefined', (raw) => {
    expect(parseUnitLength(raw)).toBeUndefined();
  });
});

describe('resolveDefaultUnitLength（spec §8.5 CONFIRMED BY DOCUMENTATION）', () => {
  function resolve(raw: string | undefined) {
    const bag = createDiagnosticBag();
    const meter = raw === undefined ? undefined : parseMeter(raw);
    const value = resolveDefaultUnitLength(meter, bag, SPAN, 'L3');
    return { value, diagnostics: bag.list() };
  }

  it.each([
    ['2/4', 16],
    ['3/8', 16],
    ['6/8', 8],
    ['4/4', 8],
  ])('M:%s → 1/%i', (raw, den) => {
    const { value, diagnostics } = resolve(raw);
    expect(value).toEqual({ num: 1, den });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('jcx.parse.unit-length.defaulted');
    expect(diagnostics[0]?.severity).toBe('info');
  });

  it('defaulted 的 message 写明依据是文档而非语料', () => {
    const [only] = resolve('4/4').diagnostics;
    expect(only?.message).toContain('文档规则');
    expect(only?.message).toContain('非语料证据');
  });

  it('无数值 M: 时不兜底 1/8，发 unresolved warning（E1）', () => {
    for (const raw of [undefined, 'C']) {
      const { value, diagnostics } = resolve(raw);
      expect(value).toBeUndefined();
      expect(diagnostics[0]?.code).toBe('jcx.parse.unit-length.unresolved');
      expect(diagnostics[0]?.severity).toBe('warning');
    }
  });
});

describe('UnitLengthScope（spec §8.5 U06）', () => {
  const scope = createUnitLengthScope({ num: 1, den: 8 }, [
    { lineIndex: 12, unitLength: { num: 1, den: 4 }, origin: 'L12' },
    { lineIndex: 6, unitLength: { num: 1, den: 2 }, origin: 'L6' },
  ]);

  it('entries 按文档位置序排列', () => {
    expect(scope.entries.map((e) => e.lineIndex)).toEqual([6, 12]);
  });

  it('行号在首条 body L: 之前时用 header 值', () => {
    expect(scope.unitLengthAtLine(0)).toEqual({ num: 1, den: 8 });
    expect(scope.unitLengthAtLine(5)).toEqual({ num: 1, den: 8 });
  });

  it('从 L: 所在行起生效，直到被下一条覆盖', () => {
    expect(scope.unitLengthAtLine(6)).toEqual({ num: 1, den: 2 });
    expect(scope.unitLengthAtLine(11)).toEqual({ num: 1, den: 2 });
    expect(scope.unitLengthAtLine(12)).toEqual({ num: 1, den: 4 });
    expect(scope.unitLengthAtLine(999)).toEqual({ num: 1, den: 4 });
  });

  it('按 SourceRef 查询等价于按行号查询', () => {
    expect(scope.unitLengthAt('L12.3.1')).toEqual({ num: 1, den: 4 });
    expect(scope.unitLengthAt('L5.0')).toEqual({ num: 1, den: 8 });
    // 非行路径（文档根）退回 header 值。
    expect(scope.unitLengthAt('D.document')).toEqual({ num: 1, den: 8 });
  });

  it('header 未确定时全程返回 undefined', () => {
    expect(createUnitLengthScope(undefined, []).unitLengthAtLine(3)).toBeUndefined();
  });
});
