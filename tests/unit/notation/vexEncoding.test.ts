/**
 * T7.4 —— `renderer/integrations/vexflow/vexEncoding.ts` 的映射表测试。
 *
 * 放在 `tests/unit/notation/` 而不是新建 `tests/unit/renderer/`：沿用
 * `scoreView.voiceRender.test.ts` 定下的仓库结构（renderer 侧的纯函数测试与 notation
 * 的测试同目录）。
 *
 * **本文件与被测文件都不 import vexflow**：映射表是纯字符串/字面量，node 环境下即可
 * 全覆盖，不需要 DOM、不需要字体、不需要 canvas。「这些字符串 VexFlow 真的认得吗」这
 * 个问题由被测文件 JSDoc 里逐条记下的 `node_modules/vexflow@5.0.0` 实测依据回答
 * （`Tables.notesInfo` / `Tables.durations` / `BarlineType` 三张表），不是猜的。
 */
import { describe, expect, it } from 'vitest';

import type { Accidental } from '../../../src/domain';
import type {
  StaffBarlineForm, StaffClef, StaffDurationBase, StaffPitch,
} from '../../../src/notation/staff/staffTypes';
import {
  vexAccidentalCode, vexBeginBarlineTypeName, vexClefName, vexDurationCode,
  vexEndBarlineTypeName, vexKey, vexKeySpec, vexRestDurationCode, vexRestKey, vexTimeSpec,
} from '../../../src/renderer/integrations/vexflow/vexEncoding';

function pitch(letter: StaffPitch['letter'], octave: number, accidental?: Accidental): StaffPitch {
  return accidental === undefined
    ? { letter, octave, mixedOctave: false }
    : { letter, octave, accidental, mixedOctave: false };
}

describe('vexAccidentalCode —— Domain 升降号 → VexFlow 记号（五个取值全覆盖）', () => {
  it.each([
    ['^', '#'],
    ['^^', '##'],
    ['_', 'b'],
    ['__', 'bb'],
    ['=', 'n'],
  ] as const)('%s → %s', (domain, code) => {
    expect(vexAccidentalCode(domain)).toBe(code);
  });
});

describe('vexKey —— StaffPitch → VexFlow key', () => {
  it('自然音：小写音名 + /octave', () => {
    expect(vexKey(pitch('C', 4))).toBe('c/4');
    expect(vexKey(pitch('B', 3))).toBe('b/3');
  });

  it('带升降号：后缀写进 key（只影响 VexFlow 对实际音高的认知，不挪符头位置）', () => {
    expect(vexKey(pitch('C', 4, '^'))).toBe('c#/4');
    expect(vexKey(pitch('C', 4, '^^'))).toBe('c##/4');
    expect(vexKey(pitch('E', 4, '_'))).toBe('eb/4');
    expect(vexKey(pitch('E', 4, '__'))).toBe('ebb/4');
    expect(vexKey(pitch('F', 5, '='))).toBe('fn/5');
  });

  it('mixedOctave 不参与编码（octave 已由 staffPitch.ts 定死，adapter 不二次解释）', () => {
    const mixed: StaffPitch = { letter: 'G', octave: 2, mixedOctave: true };
    expect(vexKey(mixed)).toBe('g/2');
  });

  it('负八度也按原样拼（不做范围裁剪）', () => {
    expect(vexKey(pitch('A', 0))).toBe('a/0');
  });
});

describe('vexDurationCode / vexRestDurationCode —— 九种时值 base 全覆盖', () => {
  const TABLE: readonly (readonly [StaffDurationBase, string])[] = [
    ['breve', '1/2'],
    ['whole', 'w'],
    ['half', 'h'],
    ['quarter', 'q'],
    ['eighth', '8'],
    ['sixteenth', '16'],
    ['thirtySecond', '32'],
    ['sixtyFourth', '64'],
    ['hundredTwentyEighth', '128'],
  ];

  it.each(TABLE)('%s → %s', (base, code) => {
    expect(vexDurationCode(base)).toBe(code);
  });

  it('休止在音符时值码后加 r 后缀', () => {
    for (const [base, code] of TABLE) expect(vexRestDurationCode(base)).toBe(`${code}r`);
  });

  it('时值码里永远没有附点（附点走 Dot.buildAndAttach，`qd` 不是合法时值）', () => {
    for (const [, code] of TABLE) expect(code).not.toContain('d');
  });

  it('不产出 `256`（本层最细到 128th）', () => {
    for (const [, code] of TABLE) expect(code).not.toBe('256');
  });
});

describe('vexRestKey / vexClefName —— 四种谱号全覆盖', () => {
  const CLEFS: readonly StaffClef[] = ['treble', 'bass', 'alto', 'tenor'];

  it.each([
    ['treble', 'b/4'],
    ['bass', 'd/3'],
    ['alto', 'c/4'],
    ['tenor', 'a/3'],
  ] as const)('%s 的休止定位 key 是 %s', (clef, key) => {
    expect(vexRestKey(clef)).toBe(key);
  });

  it('clef 名逐个映射（四个同形，但表是显式写出来的）', () => {
    for (const clef of CLEFS) expect(vexClefName(clef)).toBe(clef);
  });
});

describe('vexKeySpec —— { tonic, alter } → VexFlow 调号 spec', () => {
  it('alter 缺席 / 为 0 → 只有主音', () => {
    expect(vexKeySpec({ tonic: 'C' })).toBe('C');
    expect(vexKeySpec({ tonic: 'G', alter: 0 })).toBe('G');
  });

  it('alter = 1 / -1 → 拼上 # / b', () => {
    expect(vexKeySpec({ tonic: 'F', alter: 1 })).toBe('F#');
    expect(vexKeySpec({ tonic: 'E', alter: -1 })).toBe('Eb');
    expect(vexKeySpec({ tonic: 'B', alter: -1 })).toBe('Bb');
  });

  it('本层不认识的 alter → undefined（= 不画调号，绝不静默当自然音）', () => {
    expect(vexKeySpec({ tonic: 'C', alter: -2 })).toBeUndefined();
    expect(vexKeySpec({ tonic: 'C', alter: 2 })).toBeUndefined();
  });
});

describe('vexTimeSpec', () => {
  it('num/den 直译', () => {
    expect(vexTimeSpec({ numerator: 4, denominator: 4 })).toBe('4/4');
    expect(vexTimeSpec({ numerator: 6, denominator: 8 })).toBe('6/8');
  });
});

describe('小节线映射 —— 行首 / 行尾两张表（VexFlow 5 的 setBegBarType / setEndBarType 合法集合不同）', () => {
  const FORMS: readonly StaffBarlineForm[] = [
    'single', 'final', 'double', 'start', 'repeatEnd',
    'repeatStart', 'repeatBoth', 'dashed', 'invisible', 'unrecognized',
  ];

  it.each([
    ['single', 'SINGLE'],
    ['final', 'SINGLE'],
    ['double', 'SINGLE'],
    ['start', 'SINGLE'],
    ['repeatEnd', 'SINGLE'],
    ['repeatStart', 'REPEAT_BEGIN'],
    ['repeatBoth', 'REPEAT_BEGIN'],
    ['dashed', 'SINGLE'],
    ['invisible', 'NONE'],
    ['unrecognized', 'SINGLE'],
  ] as const)('行首：%s → %s', (form, name) => {
    expect(vexBeginBarlineTypeName(form)).toBe(name);
  });

  it.each([
    ['single', 'SINGLE'],
    ['final', 'END'],
    ['double', 'DOUBLE'],
    ['start', 'DOUBLE'],
    ['repeatEnd', 'REPEAT_END'],
    ['repeatStart', 'SINGLE'],
    ['repeatBoth', 'REPEAT_BOTH'],
    ['dashed', 'SINGLE'],
    ['invisible', 'NONE'],
    ['unrecognized', 'SINGLE'],
  ] as const)('行尾：%s → %s', (form, name) => {
    expect(vexEndBarlineTypeName(form)).toBe(name);
  });

  it('行首只产 setBegBarType 接受的三个取值（其余会被 VexFlow 静默忽略）', () => {
    const legal = ['SINGLE', 'REPEAT_BEGIN', 'NONE'];
    for (const form of FORMS) expect(legal).toContain(vexBeginBarlineTypeName(form));
  });

  it('行尾永不产 REPEAT_BEGIN（setEndBarType 明确拒绝它）', () => {
    for (const form of FORMS) expect(vexEndBarlineTypeName(form)).not.toBe('REPEAT_BEGIN');
  });

  it('同一个 repeatBoth 在两端映射不同：这正是两张表不能合并的理由', () => {
    expect(vexBeginBarlineTypeName('repeatBoth')).toBe('REPEAT_BEGIN');
    expect(vexEndBarlineTypeName('repeatBoth')).toBe('REPEAT_BOTH');
  });
});
