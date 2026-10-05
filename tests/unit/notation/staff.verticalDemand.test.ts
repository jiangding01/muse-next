/**
 * M2.5 T9b.S —— Staff 纵向需求（`staff/staffVerticalDemand.ts`）与谱号解析（`staff/staffClef.ts`）。
 *
 * 期望值逐条按公式手算（第一线 y = 32、第五线 = 72、基础层高 96、线距 10、padding 1），写成字面量以便杀死
 * 方向 / 八度 / 字母 / 谱号 / 取首音等变异；只在 notation 层，不涉及渲染器。
 */
import { describe, expect, it } from 'vitest';

import { STAFF_METRICS } from '../../../src/notation/layout/metrics';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import { DEFAULT_STAFF_CLEF, resolveStaffClef, staffClefBottomLine } from '../../../src/notation/staff/staffClef';
import type { StaffNotePitch } from '../../../src/notation/staff/staffTypes';
import { staffLayerDemands, staffLineOffset, staffNoteInk, staffPosition, staffStemTip } from '../../../src/notation/staff/staffVerticalDemand';
import { matrixMeasurer, matrixScoreFrom } from './renderMatrix.helpers';

const BASE = STAFF_METRICS.systemHeight;

function source(body: string, clef: string | undefined, header = 'M:4/4\nL:1/4') {
  const decl = clef === undefined ? 'V:1 style=staff' : `V:1 style=staff clef=${clef}`;
  const loaded = matrixScoreFrom(['X:1', header, decl, 'K:C', `[V:1]${body}`, ''].join('\n'));
  const voice = loaded.renderScore.voices[0];
  if (voice === undefined) throw new Error('no voice');
  return { loaded, voice };
}

/** 每个 measure 归到 `systemOf(measureIndex)`（缺省全部归 system 0）；`indices` 缺省 = [0]。 */
function demands(body: string, options: { clef?: string | undefined; systemOf?: (m: number) => number; indices?: readonly number[] } = {}) {
  const { loaded, voice } = source(body, 'clef' in options ? options.clef : 'treble');
  const systemOf = options.systemOf ?? (() => 0);
  const map = new Map(splitMeasures(voice.items).map((m) => [m.index, systemOf(m.index)]));
  return staffLayerDemands(voice, loaded.index, map, options.indices ?? [0]);
}

const extra = (topExtra: number, bottomExtra: number) => ({ topExtra, bottomExtra, height: BASE + topExtra + bottomExtra });
const at = (body: string, options: Parameters<typeof demands>[1] = {}) => demands(body, options).get(0);

describe('staffClef —— 三态解析唯一实现 + 谱号第五线', () => {
  it('缺席 / 已知 / 未知', () => {
    expect(resolveStaffClef(undefined)).toEqual({ status: 'absent', clef: DEFAULT_STAFF_CLEF });
    for (const clef of ['treble', 'bass', 'alto', 'tenor'] as const) expect(resolveStaffClef(clef)).toEqual({ status: 'declared', clef });
    expect(resolveStaffClef('hexagram')).toEqual({ status: 'unrecognized', clef: 'treble', raw: 'hexagram' });
    expect(DEFAULT_STAFF_CLEF).toBe('treble');
  });

  it('第五线：treble E4 / bass G2 / alto F3 / tenor D3', () => {
    expect(['treble', 'bass', 'alto', 'tenor'].map((clef) => resolveStaffClef(clef).clef).map(staffClefBottomLine))
      .toEqual([{ letter: 'E', octave: 4 }, { letter: 'G', octave: 2 }, { letter: 'F', octave: 3 }, { letter: 'D', octave: 3 }]);
  });

  it.each([[undefined], ['bass'], ['hexagram'], ['treble+8']])('clef=%s：layoutStaff 采用的谱号 = 纯解析结果，诊断不变', (clef) => {
    const { loaded, voice } = source('C D |', clef);
    const layout = layoutStaff(voice, { score: loaded.score, index: loaded.index, measurer: matrixMeasurer, availableWidth: 960 });
    expect(layout.clef).toBe(resolveStaffClef(clef).clef);
    const codes = layout.diagnostics.map((d) => d.code).filter((code) => code.includes('clef'));
    expect(codes).toHaveLength(resolveStaffClef(clef).status === 'declared' ? 0 : 1);
  });
});

describe('几何原语 —— 位置 / 中心 y / 符干', () => {
  const pitch = (letter: StaffNotePitch['pitch']['letter'], octave: number) => ({ letter, octave, mixedOctave: false });

  it('谱表位置与中心 y（第一线 0、第五线 40、每级 5）', () => {
    expect(staffPosition(pitch('E', 4), 'treble')).toBe(0);
    expect(staffPosition(pitch('F', 5), 'treble')).toBe(8);
    expect(staffPosition(pitch('C', 8), 'treble')).toBe(26);
    expect(staffPosition(pitch('G', 2), 'bass')).toBe(0);
    expect(staffPosition(pitch('C', 4), 'alto')).toBe(4);
    expect(staffPosition(pitch('C', 4), 'tenor')).toBe(6);
    expect([staffLineOffset(8), staffLineOffset(4), staffLineOffset(0), staffLineOffset(-4)]).toEqual([0, 20, 40, 60]);
  });

  it('符干：离中线最远的音决定方向，平局向下；超八度延长到中线；breve / whole 无符干', () => {
    expect(staffStemTip([3], 'quarter')).toBe(-10);
    expect(staffStemTip([4], 'quarter')).toBe(55);
    expect(staffStemTip([-4, 12], 'quarter')).toBe(95);
    expect(staffStemTip([-4, 10], 'quarter')).toBe(-45);
    expect(staffStemTip([-16], 'quarter')).toBe(20);
    expect(staffStemTip([26], 'quarter')).toBe(20);
    expect(staffStemTip([4], 'whole')).toBeUndefined();
    expect(staffStemTip([4], 'breve')).toBeUndefined();
    expect(staffStemTip([4], 'half')).toBe(55);
  });

  it('32 / 64 / 128 分符干延长（两个方向），16 分不延长', () => {
    expect((['sixteenth', 'thirtySecond', 'sixtyFourth', 'hundredTwentyEighth'] as const).map((base) => staffStemTip([4], base))).toEqual([55, 60, 68, 76]);
    expect((['sixteenth', 'thirtySecond', 'sixtyFourth', 'hundredTwentyEighth'] as const).map((base) => staffStemTip([3], base))).toEqual([-10, -15, -23, -31]);
  });

  it('符干基础长 35 与 flag 延长都锁成边界值：中线延长之后再加 flag（超八度 + 短时值）', () => {
    expect(staffStemTip([3], 'quarter')).toBe(staffLineOffset(3) - 35);
    expect(staffStemTip([-16], 'hundredTwentyEighth')).toBe(-1);
    expect(staffStemTip([-16], 'sixtyFourth')).toBe(7);
    expect(staffStemTip([-16], 'thirtySecond')).toBe(15);
    expect(staffStemTip([26], 'hundredTwentyEighth')).toBe(41);
  });

  it('tie 端点（M-2）：按 Domain memberIndex 而不是 pitches[] 下标；全部唯一才精确，否则整个事件保守扩张', () => {
    // 成员 0 是休止（已剔除）：memberIndex 1 = A3 在 pitches[0]，memberIndex 2 = E6 在 pitches[1]；全音符无符干。
    const chord: StaffNotePitch[] = [{ memberIndex: 1, pitch: pitch('A', 3) }, { memberIndex: 2, pitch: pitch('E', 6) }];
    const whole = { base: 'whole', dots: 0 } as const;
    const ink = (members: ReadonlySet<number> | undefined) => staffNoteInk(chord, whole, 'treble', { members });
    expect(staffNoteInk(chord, whole, 'treble', undefined)).toEqual({ top: -35, bottom: 65 });
    expect(ink(new Set([1]))).toEqual({ top: -35, bottom: 73 });
    expect(ink(new Set([2]))).toEqual({ top: -43, bottom: 65 });
    expect(ink(new Set([1, 2]))).toEqual({ top: -43, bottom: 73 });
    expect(ink(new Set([1, 5]))).toEqual({ top: -43, bottom: 73 });
    expect(ink(new Set([0]))).toEqual({ top: -43, bottom: 73 });
    expect(ink(undefined)).toEqual({ top: -43, bottom: 73 });
  });
});

describe('staffLayerDemands —— 四种谱号的高 / 低音', () => {
  it.each([
    ['treble 常规音域', "C D E F G A B c d e f g a b c' d'|", 'treble', extra(0, 0)],
    ["treble E6（上 3 线，刚越界）", "e'|", 'treble', extra(4, 0)],
    ["treble D6（恰在界内）", "d'|", 'treble', extra(0, 0)],
    ["treble C8", "c'''|", 'treble', extra(64, 0)],
    ['treble A3（下 2 线）', 'A,|', 'treble', extra(0, 2)],
    ['treble G3', 'G,|', 'treble', extra(0, 7)],
    ['treble C2', 'C,,|', 'treble', extra(0, 62)],
    ['bass C5', 'c|', 'bass', extra(19, 0)],
    ['bass C1', 'C,,,|', 'bass', extra(0, 37)],
    ['bass 常规音域', 'G,, C, E, G, C|', 'bass', extra(0, 0)],
    ["alto C6", "c'|", 'alto', extra(24, 0)],
    ['alto C2', 'C,,|', 'alto', extra(0, 32)],
    ['alto C3（恰在界内）', 'C,|', 'alto', extra(0, 0)],
    ["tenor C6", "c'|", 'tenor', extra(34, 0)],
    ['tenor E2', 'E,,|', 'tenor', extra(0, 12)],
    ['tenor A2（恰在界内）', 'A,,|', 'tenor', extra(0, 0)],
  ] as const)('%s', (_label, body, clef, expected) => {
    expect(at(body, { clef })).toEqual(expected);
  });

  it('八度修饰逐级生效：E5 → E6 → E7', () => {
    expect([at('e|'), at("e'|"), at("e''|")].map((d) => d?.topExtra)).toEqual([0, 4, 39]);
  });

  it('同一行上下同时扩高', () => {
    expect(at("c''' C,,|")).toEqual(extra(64, 62));
  });

  it('未知 / 缺席谱号按 treble 计算（与 layoutStaff 同一解析）', () => {
    expect(at("c'''|", { clef: 'hexagram' })).toEqual(at("c'''|", { clef: 'treble' }));
    expect(at('C,,|', { clef: undefined })).toEqual(extra(0, 62));
    expect(at('c|', { clef: 'bass' })).not.toEqual(at('c|', { clef: 'hexagram' }));
  });
});

describe('staffLayerDemands —— 和弦 / 符干 / 升降号 / 附点 / tie', () => {
  it('和弦取最低与最高音：[A3 A5] 符干向上越顶，A3 符头越底', () => {
    expect(at('[A,a]|')).toEqual(extra(14, 2));
  });

  it('符干平局向下：[A3 C6] 和 = 2 × 中线 → 向下（向上会得到 top 24 / bottom 2）', () => {
    expect(at("[A,c']|")).toEqual(extra(0, 32));
  });

  it('32 / 64 / 128 分符干延长：B4 单音与 [G4 C6] 和弦', () => {
    expect([at('B/4|'), at('B/8|'), at('B/16|'), at('B/32|')]).toEqual([extra(0, 0), extra(0, 0), extra(0, 5), extra(0, 13)]);
    expect([at("[Gc']|"), at("[G/8c'/8]|")]).toEqual([extra(0, 2), extra(0, 7)]);
  });

  it('whole 无符干：A3 全音符只有符头越底', () => {
    expect(at('A,4|')).toEqual(extra(0, 2));
  });

  it.each([
    ["^e'", extra(13, 0)], ["_e'", extra(17, 0)], ["=e'", extra(13, 0)], ["^^e'", extra(5, 0)], ["__e'", extra(17, 0)],
    ['^A,', extra(0, 11)], ['_A,', extra(0, 4)], ['=A,', extra(0, 11)], ['^^A,', extra(0, 3)], ['__A,', extra(0, 4)],
  ] as const)('升降号 %s', (note, expected) => {
    expect(at(`${note}|`)).toEqual(expected);
  });

  it.each([
    ["E6 附点（上扩 7）", "e'3/2|", extra(6, 0)],
    ['A3 附点（下扩 7）', 'A,3/2|', extra(0, 4)],
    ['相邻音和弦 [A3 B3] 附点：A3 的附点被迫下移', '[A,3/2B,3/2]|', extra(0, 4)],
    ['相邻音和弦 [E6 F6] 附点', "[e'3/2f'3/2]|", extra(11, 0)],
    ['C8 附点', "c'''3/2|", extra(66, 0)],
    ['C2 附点', 'C,,3/2|', extra(0, 64)],
    ['双附点 [A3 B3]', '[A,7/4B,7/4]|', extra(0, 4)],
  ] as const)('附点双向包络：%s', (_label, body, expected) => {
    expect(at(body)).toEqual(expected);
  });

  it('tie 端点：A3–A3 下扩到 13；C4–C4 恰在边界（96），B3–B3 越界一级', () => {
    expect(at('A,-A,|')).toEqual(extra(0, 10));
    expect(at('C-C|')).toEqual(extra(0, 0));
    expect(at('B,-B,|')).toEqual(extra(0, 5));
    expect(at('A, A,|')).toEqual(extra(0, 2));
  });

  it("tie 端点在和弦里唯一落到 A3：E6 不被保守扩张", () => {
    expect(at("[A,-e'] [A,e']|")).toEqual(extra(4, 32));
  });

  it('时值降级的占位不计音高墨迹（C8 的五倍四分时值画不出符头）', () => {
    expect(at("c'''5|")).toEqual(extra(0, 0));
  });
});

describe('staffLayerDemands —— tie 端点按行谱分别计入（M-1 / M-2 / M-3）', () => {
  const perSystem = (body: string, indices: readonly number[]) => [...demands(body, { systemOf: (m) => m, indices }).entries()];

  it('resolved 跨行 tie：from 所在行与 to 所在行都扩张', () => {
    expect(perSystem('C D E A,-| A, D E F|', [0, 1])).toEqual([[0, extra(0, 10)], [1, extra(0, 10)]]);
    expect(perSystem('C D E A,| A, D E F|', [0, 1])).toEqual([[0, extra(0, 2)], [1, extra(0, 2)]]);
  });

  it('unresolved tie：只有源端所在行扩张，不把下一行的下一个音当终点', () => {
    expect(perSystem('C D E A,-| z B, D E|', [0, 1])).toEqual([[0, extra(0, 10)], [1, extra(0, 0)]]);
    expect(perSystem('C D E A,-| B, D E F|', [0, 1])).toEqual([[0, extra(0, 10)], [1, extra(0, 5)]]);
  });

  it('和弦成员 tie：休止成员使 memberIndex ≠ pitches[] 下标，仍只扩 A3（两行都是）', () => {
    expect(perSystem("[z4A,4-e'4] | [z4A,4e'4]|", [0, 1])).toEqual([[0, extra(4, 10)], [1, extra(4, 10)]]);
  });

  it('同一事件挂多条 tie：成员端点取并集，不是第一条 / 最后一条覆盖', () => {
    // 第 2 个和弦是成员 0 的终点，同时是成员 0、成员 1 的起点；第 3 个和弦是两条的终点。
    expect(perSystem("[A,4-e'4] | [A,4e'4]- | [A,4e'4]|", [0, 1, 2])).toEqual([[0, extra(4, 10)], [1, extra(12, 10)], [2, extra(12, 10)]]);
  });

  it('同一事件既有成员端点又有整事件端点：整事件生效（保守），且不波及其它行', () => {
    expect(perSystem("[A,4-e'4]-4 | [A,4e'4]|", [0, 1])).toEqual([[0, extra(12, 10)], [1, extra(4, 2)]]);
  });
});

describe('staffLayerDemands —— 行谱归属', () => {
  it('两行谱只有一行扩高；absent 尾行 = 96、inset 0；每项都有条目', () => {
    const result = demands("C D | c''' |", { systemOf: (m) => m, indices: [0, 1, 2] });
    expect([...result.entries()]).toEqual([[0, extra(0, 0)], [1, extra(64, 0)], [2, extra(0, 0)]]);
  });

  it('全局稀疏 systemIndex 原样作键；不在 systemIndices 里的行谱不出条目', () => {
    const result = demands("C,, | c''' |", { systemOf: (m) => 7 + 3 * m, indices: [7, 10] });
    expect([...result.entries()]).toEqual([[7, extra(0, 62)], [10, extra(64, 0)]]);
  });

  it('同一输入逐字段相等（纯函数）', () => {
    expect(demands("[A,-e'] [A,e'] | C,, |", { systemOf: (m) => m, indices: [0, 1] }))
      .toEqual(demands("[A,-e'] [A,e'] | C,, |", { systemOf: (m) => m, indices: [0, 1] }));
  });
});
