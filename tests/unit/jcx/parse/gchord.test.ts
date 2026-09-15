import { describe, expect, it } from 'vitest';

import { parseGChordValue } from '../../../../src/formats/jcx/parse/gchord';

/**
 * M1.6 T9：`parseGChordValue` 是纯函数，直接测，不经 AST。
 * `origin` 用固定占位字符串——本测试不关心 origin 的具体取值，只关心是否透传。
 */
const ORIGIN = 'L1';

describe('parseGChordValue（旧 parseGChord.test.ts 用例迁移 + 新增边界用例）', () => {
  // 迁移说明（用户 2026-09-15 追加约束④）：只迁移案例本身，不继承旧 scaffold
  // （`src/formats/jcx/parseGChord.ts`）的宽松行为——旧实现字段名是 `baseFret`
  // （新 Domain 是 `capoFret`，spec §10.1 明确是变调夹品位）、且手指号正则允许
  // `[1-5]`（新实现按 spec 严格收窄到 1–4，5 判定不合法，见下方「指法越界」用例）、
  // 且旧实现对 capo 只做 `Number.parseInt` 不做区间校验（新实现严格 1–20，见下方
  // capo 越界用例）。本用例本身的取值（capo=1，finger∈{3,4}）落在新旧规则的交集
  // 内，两者结果一致，所以迁移后断言不变；分歧点由新增的边界用例单独覆盖。
  it('迁移：带指法的完整语法（旧用例）', () => {
    const chord = parseGChordValue('G=1;3(3),2(2),0,0,0,3(4)', ORIGIN);

    expect(chord?.name).toBe('G');
    expect(chord?.capoFret).toBe(1);
    expect(chord?.strings[0]).toMatchObject({ state: 'fretted', fret: 3, finger: 3 });
    expect(chord?.strings[2]).toMatchObject({ state: 'open', fret: 0 });
  });

  it('解析成功：无指法的简单和弦', () => {
    const chord = parseGChordValue('Em=1;0,2,2,0,0,0', ORIGIN);

    expect(chord).toEqual({
      name: 'Em',
      capoFret: 1,
      strings: [
        { state: 'open', fret: 0 },
        { state: 'fretted', fret: 2 },
        { state: 'fretted', fret: 2 },
        { state: 'open', fret: 0 },
        { state: 'open', fret: 0 },
        { state: 'open', fret: 0 },
      ],
      barres: [],
      rawValue: 'Em=1;0,2,2,0,0,0',
      origin: ORIGIN,
    });
  });

  it('禁弹弦 X（仅大写）与 barres 恒为空数组', () => {
    const chord = parseGChordValue('X7=2;X,0,2,0,1,0', ORIGIN);

    expect(chord?.strings[0]).toEqual({ state: 'muted', fret: null });
    expect(chord?.barres).toEqual([]);
  });

  it('小写 `x` 不是禁弹弦：spec §10.1 与语料只 CONFIRMED 大写，整条 gchord 解析失败', () => {
    expect(parseGChordValue('X7=2;x,0,2,0,1,0', ORIGIN)).toBeUndefined();
  });

  it('capo 非法：非数字', () => {
    expect(parseGChordValue('G=abc;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('capo 非法：负数', () => {
    expect(parseGChordValue('G=-1;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('capo 非法：0（用户约束①：0 只是弦位的「空弦」记法，不是合法 capo）', () => {
    expect(parseGChordValue('G=0;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('capo 非法：21（spec §10.1 上界 20，越界判定失败，不夹紧）', () => {
    expect(parseGChordValue('G=21;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('capo 合法边界：20（上界本身合法）', () => {
    const chord = parseGChordValue('G=20;0,0,0,0,0,0', ORIGIN);
    expect(chord?.capoFret).toBe(20);
  });

  it('fret 非法：25（spec §10.1 上界 24，越界判定该弦位不合法）', () => {
    expect(parseGChordValue('G=1;25,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('fret 合法边界：24（上界本身合法）', () => {
    const chord = parseGChordValue('G=1;24,0,0,0,0,0', ORIGIN);
    expect(chord?.strings[0]).toMatchObject({ state: 'fretted', fret: 24 });
  });

  it('弦数 = 5（不足）判定失败', () => {
    expect(parseGChordValue('G=1;0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('弦数 = 7（过多）判定失败', () => {
    expect(parseGChordValue('G=1;0,0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('指法越界：3(5) 判定该弦位不合法', () => {
    expect(parseGChordValue('G=1;3(5),0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('指法为 0：3(0) 判定该弦位不合法', () => {
    expect(parseGChordValue('G=1;3(0),0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('禁弹弦带指法：X(1) 判定该弦位不合法（横按/禁弹+指法组合 UNVERIFIED，不猜）', () => {
    expect(parseGChordValue('G=1;X(1),0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('空 value 判定失败', () => {
    expect(parseGChordValue('', ORIGIN)).toBeUndefined();
  });

  it('无 = 判定失败', () => {
    expect(parseGChordValue('G1;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('无 ; 判定失败', () => {
    expect(parseGChordValue('G=1 0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });

  it('名字为空判定失败', () => {
    expect(parseGChordValue('=1;0,0,0,0,0,0', ORIGIN)).toBeUndefined();
  });
});
