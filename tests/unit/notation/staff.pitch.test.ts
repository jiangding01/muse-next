/**
 * `notation/staff/staffPitch.ts` 契约测试（M2 T7.1）。
 *
 * 覆盖：大小写基准八度、`,`/`'` 叠加、混合方向（`mixedOctave`）、五种 accidental
 * 原样透传、纯函数确定性。全部使用合成 `Pitch` fixture，不引用任何真实曲目
 * （spec §14.1/§14.2）。
 *
 * **`register` 与大小写的对应关系**（对照 `src/formats/jcx/parse/body/scanPitch.ts`）：
 * `register: 'upper'` = 大写字母，`register: 'lower'` = 小写字母——字面值描述的是
 * 字母本身的大小写，不是音高高低。
 */
import { describe, expect, it } from 'vitest';

import type { Accidental, Pitch } from '../../../src/domain';
import { toStaffPitch } from '../../../src/notation/staff/staffPitch';

function pitch(overrides: Partial<Pitch> & Pick<Pitch, 'letter' | 'register'>): Pitch {
  return { ...overrides };
}

describe('toStaffPitch —— 大小写基准八度（spec §14.1）', () => {
  it('大写字母（register: upper）无八度修饰：中央 C 所在八度 = 4', () => {
    expect(toStaffPitch(pitch({ letter: 'C', register: 'upper' }))).toEqual({
      letter: 'C',
      octave: 4,
      mixedOctave: false,
    });
  });

  it('小写字母（register: lower）无八度修饰：比大写高一个八度 = 5（letter 恒为大写字母，大小写事实全归在 register）', () => {
    expect(toStaffPitch(pitch({ letter: 'C', register: 'lower' }))).toEqual({
      letter: 'C',
      octave: 5,
      mixedOctave: false,
    });
  });
});

describe('toStaffPitch —— `,`/`\'` 叠加（spec §14.2）', () => {
  it('单个 `\'`（升八度）：c\' → 5 + 1 = 6', () => {
    const p = pitch({ letter: 'C', register: 'lower', octaveRaw: "'", octaveShift: 1 });
    expect(toStaffPitch(p)).toEqual({ letter: 'C', octave: 6, mixedOctave: false });
  });

  it('三连逗号（降八度叠加）：F,,, → 4 - 3 = 1', () => {
    const p = pitch({ letter: 'F', register: 'upper', octaveRaw: ',,,', octaveShift: -3 });
    expect(toStaffPitch(p)).toEqual({ letter: 'F', octave: 1, mixedOctave: false });
  });

  it('双撇号（升八度叠加）：c\'\' → 5 + 2 = 7', () => {
    const p = pitch({ letter: 'C', register: 'lower', octaveRaw: "''", octaveShift: 2 });
    expect(toStaffPitch(p)).toEqual({ letter: 'C', octave: 7, mixedOctave: false });
  });

  it('单个 `,`（降八度）：C, → 4 - 1 = 3', () => {
    const p = pitch({ letter: 'C', register: 'upper', octaveRaw: ',', octaveShift: -1 });
    expect(toStaffPitch(p)).toEqual({ letter: 'C', octave: 3, mixedOctave: false });
  });
});

describe('toStaffPitch —— 混合方向八度（U23，spec §14.2 UNVERIFIED）', () => {
  it('C,\'：`octaveShift` 缺席但 `octaveRaw` 非空 → 只按 register 定基准八度，mixedOctave = true', () => {
    const p = pitch({ letter: 'C', register: 'upper', octaveRaw: ",'" });
    expect(toStaffPitch(p)).toEqual({ letter: 'C', octave: 4, mixedOctave: true });
  });

  it('小写同样适用：c,\' → 基准八度 5（register 贡献），mixedOctave = true', () => {
    const p = pitch({ letter: 'C', register: 'lower', octaveRaw: ",'" });
    expect(toStaffPitch(p)).toEqual({ letter: 'C', octave: 5, mixedOctave: true });
  });

  it('`octaveRaw` 为空串（未修饰）不算混合方向：mixedOctave 仍为 false', () => {
    const p = pitch({ letter: 'G', register: 'upper', octaveRaw: '' });
    expect(toStaffPitch(p)).toEqual({ letter: 'G', octave: 4, mixedOctave: false });
  });
});

describe('toStaffPitch —— accidental 原样透传（spec §17，五种记号）', () => {
  const ACCIDENTALS: readonly Accidental[] = ['^', '^^', '_', '__', '='];

  it.each(ACCIDENTALS)('accidental = %s 原样出现在结果里', (accidental) => {
    const p = pitch({ letter: 'D', register: 'upper' });
    expect(toStaffPitch(p, accidental)).toEqual({
      letter: 'D',
      octave: 4,
      mixedOctave: false,
      accidental,
    });
  });

  it('不传 accidental 时结果里没有该字段（不是 `undefined` 占位）', () => {
    const p = pitch({ letter: 'D', register: 'upper' });
    const result = toStaffPitch(p);
    expect('accidental' in result).toBe(false);
  });
});

describe('toStaffPitch —— 确定性', () => {
  it('同一输入两次调用结果 toEqual', () => {
    const p = pitch({ letter: 'A', register: 'lower', octaveRaw: "'", octaveShift: 1 });
    expect(toStaffPitch(p, '^')).toEqual(toStaffPitch(p, '^'));
  });
});
