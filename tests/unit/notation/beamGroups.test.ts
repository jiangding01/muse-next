/**
 * M2.5 T3.5 —— TAB / 简谱共用 beam 分组核心（`layout/beamGroups.ts`）。
 *
 * 覆盖 preflight 测试矩阵 A（拍单位）/ B（分组判据）/ C（与跨声部 shared timeline 无关）/
 * D（Rational 精确 floor）/ E（F-10 层级）/ F（组级间距，Q11）/ 与 T3 tuplet 判据的防分叉。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Meter, MusicEvent, Rational } from '../../../src/domain';
import { fromParts } from '../../../src/domain';
import {
  BEAM_MIN_STEM_GAP,
  beatIndex,
  beatUnitOf,
  equalizeGroupSpacing,
  planMeasureBeams,
  planVoiceBeams,
  tupletMemberSet,
} from '../../../src/notation/layout/beamGroups';
import type { MeasureBeamPlan } from '../../../src/notation/layout/beamGroups';
import { SLOT_SPACING_METRICS } from '../../../src/notation/layout/metrics';
import type { MeasureSpacing } from '../../../src/notation/layout/spacing';
import { spaceItems } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import type { MeasureSlice } from '../../../src/notation/layout/systems';
import type { RenderItem, RenderVoice } from '../../../src/notation/model/types';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';

const JIANPU = (event: MusicEvent): boolean => event.kind === 'note' || event.kind === 'chord';
const TAB = (event: MusicEvent): boolean => event.kind === 'tabNote' || event.kind === 'tabGroup';
const r = (value: Rational): string => `${String(value.num)}/${String(value.den)}`;

interface Options {
  readonly meter?: string;
  readonly unit?: string;
  readonly style?: 'jianpu' | 'tab';
}

function source(body: string, { meter = '4/4', unit = '1/8', style = 'jianpu' }: Options = {}): string {
  const meterLine = meter === '' ? [] : [`M:${meter}`];
  return ['%MUSE2', 'X:1', ...meterLine, `L:${unit}`, 'K:C', `V:1 style=${style}`, body, ''].join('\n');
}

function voiceOf(body: string, options: Options = {}): { readonly voice: RenderVoice; readonly meter: Meter | undefined } {
  const matrix = matrixScoreFrom(source(body, options));
  const voice = matrix.renderScore.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return { voice, meter: matrix.score.meter };
}

function plansOf(body: string, options: Options = {}): readonly MeasureBeamPlan[] {
  const { voice, meter } = voiceOf(body, options);
  return planVoiceBeams(splitMeasures(voice.items), voice.voice, meter, options.style === 'tab' ? TAB : JIANPU);
}

/** `'grouped:[0,1][3,4]'`：每组成员的 `itemIndex`；单 measure 便捷版。 */
function shape(plan: MeasureBeamPlan | undefined): string {
  if (plan === undefined) return 'missing';
  return `${plan.status}:${plan.groups.map((g) => `[${g.members.map((m) => String(m.itemIndex)).join(',')}]`).join('')}`;
}

const first = (body: string, options: Options = {}): string => shape(plansOf(body, options)[0]);

/** 防御性输入：按 note 出现顺序替换 duration（`undefined` = 去掉；用尽后保持原值）。 */
function withNoteDurations(voice: RenderVoice, durations: readonly (Rational | undefined)[]): RenderVoice {
  let noteIndex = 0;
  const items = voice.items.map((item): RenderItem => {
    if (item.event.kind !== 'note') return item;
    const position = noteIndex;
    noteIndex += 1;
    if (position >= durations.length) return item;
    const duration = durations[position];
    const { duration: _dropped, ...note } = item.event.note;
    return { ...item, event: { ...item.event, note: duration === undefined ? note : { ...note, duration } } };
  });
  return { ...voice, items };
}

function sliceOf(voice: RenderVoice, k = 0): MeasureSlice {
  const slice = splitMeasures(voice.items)[k];
  if (slice === undefined) throw new Error('slice missing');
  return slice;
}

const QUARTER = fromParts(1, 4);

describe('T3.5 A —— 拍单位（冻结表 + Q3-a：表外一律不分组）', () => {
  const fraction = (num: number, den: number): Meter => ({ kind: 'fraction', num, den, raw: `${String(num)}/${String(den)}` });
  const unit = (meter: Meter | undefined): string => {
    const value = beatUnitOf(meter);
    return value === undefined ? 'none' : r(value);
  };

  it('x/4 → 1/4（2/4、3/4、4/4、6/4）；x/2 → 1/2（2/2、3/2）', () => {
    expect([2, 3, 4, 6].map((num) => unit(fraction(num, 4)))).toEqual(['1/4', '1/4', '1/4', '1/4']);
    expect([2, 3].map((num) => unit(fraction(num, 2)))).toEqual(['1/2', '1/2']);
  });

  it('x/8 且 x%3===0 → 3/8（3/8、6/8、9/8、12/8）；5/8、7/8 不分组', () => {
    expect([3, 6, 9, 12].map((num) => unit(fraction(num, 8)))).toEqual(['3/8', '3/8', '3/8', '3/8']);
    expect([5, 7].map((num) => unit(fraction(num, 8)))).toEqual(['none', 'none']);
  });

  it('raw（C / C|）与缺席不分组', () => {
    expect(unit({ kind: 'raw', raw: 'C' })).toBe('none');
    expect(unit({ kind: 'raw', raw: 'C|' })).toBe('none');
    expect(unit(undefined)).toBe('none');
  });

  it('表外分母（/16、/1、/32、/5）与非法 num（0、负数、非整数、NaN）一律不分组，不类推', () => {
    expect([[6, 16], [3, 1], [4, 32], [3, 5]].map(([n, d]) => unit(fraction(n ?? 0, d ?? 0)))).toEqual(['none', 'none', 'none', 'none']);
    expect([0, -3, 1.5, Number.NaN].map((num) => unit(fraction(num, 4)))).toEqual(['none', 'none', 'none', 'none']);
  });

  it('端到端：6/8 下 6 个八分 → 两组 3+3；按 1/8 一拍会变成 0 组', () => {
    expect(first('CDEFGA|', { meter: '6/8' })).toBe('grouped:[0,1,2][3,4,5]');
  });

  it('端到端：5/8、M:C、M:C|、缺席 → meter-not-grouped（每个 measure）', () => {
    for (const meter of ['5/8', 'C', 'C|', '']) {
      expect(plansOf('CDEF|CD|', { meter }).map(shape)).toEqual(['meter-not-grouped:', 'meter-not-grouped:']);
    }
  });
});

describe('T3.5 B —— 分组判据（§Q8.2 + Q4/Q5/Q6）', () => {
  it('同拍连续两个八分 → 1 组；跨拍 → 分开；4/4 下 4 个八分 → 2 组；3/4 同理按四分一拍', () => {
    expect(first('CD|')).toBe('grouped:[0,1]');
    expect(first('C2 DE|')).toBe('grouped:[1,2]');
    // z@0 C@1/8 | D@1/4 E@3/8：C 与 D 跨拍分开，D、E 在第 2 拍成组。
    expect(first('z CD E|')).toBe('grouped:[2,3]');
    expect(first('CDEF|')).toBe('grouped:[0,1][2,3]');
    expect(first('CDEFGA|', { meter: '3/4' })).toBe('grouped:[0,1][2,3][4,5]');
  });

  it('十六分组：L:1/16 下 4 个十六分 → 1 组；2/2 下 8 个八分 → 2 组（二分一拍）', () => {
    expect(first('CDEF|', { unit: '1/16' })).toBe('grouped:[0,1,2,3]');
    expect(first('CDEFGABc|', { meter: '2/2' })).toBe('grouped:[0,1,2,3][4,5,6,7]');
  });

  it('八分 + 十六分混合入同一组', () => {
    expect(first('C D/E/|')).toBe('grouped:[0,1,2]');
  });

  it('休止断组（z / Z / @ 同为 rest）', () => {
    expect(first('C/ z/ D/ E/|')).toBe('grouped:[2,3]');
  });

  it('decoration / unknown / grace 断组（Q5-a）；chordSymbol 跳过且不断组（Q4-a）', () => {
    expect(first('C !trill!D|')).toBe('grouped:');
    expect(first('C x D|')).toBe('grouped:');
    expect(first('C {g}D|')).toBe('grouped:');
    expect(first('C "G"D|')).toBe('grouped:[0,2]');
    expect(first('"C"C "G""Am"D|')).toBe('grouped:[1,4]');
  });

  it('barline 断组（防御性：小节线夹在切片中间）', () => {
    const { voice } = voiceOf('CD|');
    const [c, d, bar] = sliceOf(voice).items;
    if (c === undefined || d === undefined || bar === undefined) throw new Error('items missing');
    const slice: MeasureSlice = { index: 0, startIndex: 0, items: [c, bar, d] };
    expect(shape(planMeasureBeams(slice, QUARTER, new Set(), JIANPU))).toBe('grouped:');
    expect(shape(planMeasureBeams({ ...slice, items: [c, d, bar] }, QUARTER, new Set(), JIANPU))).toBe('grouped:[0,1]');
  });

  it('四分不入组；附点四分 + 八分：八分单音 → 不成组（退回旗）', () => {
    expect(first('C2 D2 E2 F2|')).toBe('grouped:');
    expect(first('C3 D|')).toBe('grouped:');
    expect(first('C D2 E|')).toBe('grouped:');
  });

  it('unrepresentable（1/12）自己不入组、照常累计 onset，不禁掉同小节其它组', () => {
    // 1/12 × 3 = 1/4 占满第 1 拍；随后两个八分在第 2 拍成组。
    expect(first('C2/3 D2/3 E2/3 FG|')).toBe('grouped:[3,4]');
    // 同拍里被 unrepresentable 隔开的两段各自成组。
    expect(first('C/ D/ E2/3 F/4 G/4 A2|', { unit: '1/8' })).toBe('grouped:[0,1][3,4]');
  });

  it('duration undefined → 整个 measure 不分组；下一个 measure 照常', () => {
    const { voice } = voiceOf('CD|EF|');
    const plans = planVoiceBeams(splitMeasures(withNoteDurations(voice, [undefined]).items), voice.voice, { kind: 'fraction', num: 4, den: 4, raw: '4/4' }, JIANPU);
    expect(plans.map(shape)).toEqual(['duration-undefined:', 'grouped:[0,1]']);
  });

  it('累加越界 → arithmetic-overflow，整个 measure 不分组', () => {
    const { voice } = voiceOf('CD|');
    const huge = withNoteDurations(voice, [{ num: Number.MAX_SAFE_INTEGER, den: 1 }, { num: Number.MAX_SAFE_INTEGER, den: 1 }]);
    expect(shape(planMeasureBeams(sliceOf(huge), QUARTER, new Set(), JIANPU))).toBe('arithmetic-overflow:');
  });

  it('tuplet 成员 → 整个 measure 不分组（同小节非成员也不分）；别的 measure 照常', () => {
    expect(plansOf('(3CDE FG|AB|').map(shape)).toEqual(['tuplet:', 'grouped:[0,1]']);
  });

  it('不可连梁的 timed 事件断组：TAB 判定下简谱音符不入组；TAB 自己的 tabNote / tabGroup 成组', () => {
    const { voice, meter } = voiceOf('CD|');
    expect(planVoiceBeams(splitMeasures(voice.items), voice.voice, meter, TAB).map(shape)).toEqual(['grouped:']);
    expect(first('a0/ a1/ [a2/b3/] a3// a4// |', { style: 'tab', unit: '1/4' })).toBe('grouped:[0,1][2,3,4]');
  });

  it('Q6-a：只看 onset 所在拍，不看结束点（3/16 + 3/16 跨过拍界仍同组）', () => {
    expect(first('C3/2 D3/2 E|')).toBe('grouped:[0,1]');
  });
});

describe('T3.5 C —— beam 只看本声部，不依赖跨声部 shared timeline', () => {
  function pair(bodies: readonly [string, string]): ReturnType<typeof matrixScoreFrom> {
    return matrixScoreFrom(['X:1', 'M:4/4', 'L:1/8', 'V:1 bracket=2', 'V:2', 'K:C', `[V:1]${bodies[0]}`, `[V:2]${bodies[1]}`, ''].join('\n'));
  }
  function verdictAndPlan(bodies: readonly [string, string], ordinal: number): string {
    const matrix = pair(bodies);
    const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
    const measure = alignment.groups[0]?.measures[ordinal];
    const member = measure?.members[0];
    const plan = member !== undefined && 'slice' in member
      ? planMeasureBeams(member.slice, QUARTER, tupletMemberSet(member.renderVoice.voice), JIANPU)
      : undefined;
    return `${measure?.verdict ?? 'none'} ${shape(plan)}`;
  }

  it('T2 structure-conflict（收尾小节线不同）的 measure：本声部照常成组', () => {
    expect(verdictAndPlan(['CDEF EF GA|', 'CDEF EF GA||'], 0)).toBe('structure-conflict grouped:[0,1][2,3][4,5][6,7]');
  });

  it('T2 total-mismatch 的 measure：本声部照常成组', () => {
    expect(verdictAndPlan(['CD E2|', 'CD E2 F2|'], 0)).toBe('total-mismatch grouped:[0,1]');
  });

  it('T2.1 desynced 的 measure：本声部照常成组', () => {
    expect(verdictAndPlan(['CD E2 F4|CD E2 F4|CD E2 F4|', '|CD E2 F4|CD E2 F4|'], 2)).toBe('desynced grouped:[0,1]');
  });

  it('singleton 声部照常成组', () => {
    expect(first('CD EF|')).toBe('grouped:[0,1][2,3]');
  });
});

describe('T3.5 D —— Rational 精确 floor（零浮点）', () => {
  const idx = (n: number, d: number, unit: Rational): string => String(beatIndex({ num: n, den: d }, unit));

  it('普通值：0、1/3、恰在拍界 1/4、6/8 下 3/8 与 5/8', () => {
    expect([idx(0, 1, QUARTER), idx(1, 3, QUARTER), idx(1, 4, QUARTER), idx(3, 8, fromParts(3, 8)), idx(5, 8, fromParts(3, 8))]).toEqual(['0', '1', '1', '1', '1']);
  });

  it('拍界前后各差一个极小 Rational（1/2^50）', () => {
    const tiny = 2 ** 50;
    expect(idx(tiny / 4 - 1, tiny, QUARTER)).toBe('0');
    expect(idx(tiny / 4 + 1, tiny, QUARTER)).toBe('1');
  });

  it('对抗样本：先除后 floor、先乘后除两种浮点写法在这里都会多算一拍', () => {
    // 2.5 − 1/D，unit 1/2 → 精确 4；Math.floor 两种写法都给 5。
    const a = { n: 5830445158614552, d: 2332178063445821 };
    expect(idx(a.n, a.d, fromParts(1, 2))).toBe('4');
    expect(Math.floor(a.n / a.d / 0.5)).toBe(5);
    expect(Math.floor((a.n * 2) / a.d)).toBe(5);
    // 6 × 3/8 − 1/D，unit 3/8 → 精确 6；两种浮点写法都给 7。
    const b = { n: 2175137245866493, d: 828623712711045 };
    expect(idx(b.n, b.d, fromParts(3, 8))).toBe('6');
    expect(Math.floor(b.n / b.d / 0.375)).toBe(7);
    expect(Math.floor((b.n * 8) / (b.d * 3))).toBe(7);
  });

  it('负 onset 向负无穷取整（防御性）', () => {
    expect(idx(-1, 8, QUARTER)).toBe('-1');
    expect(idx(-1, 4, QUARTER)).toBe('-1');
  });

  it('源码守卫：beamGroups.ts 不出现 Math.floor / Math.trunc / Number( / parseFloat / `.num /`', () => {
    const src = readFileSync(join(import.meta.dirname, '../../../src/notation/layout/beamGroups.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).not.toMatch(/Math\.floor|Math\.trunc|\bNumber\(|parseFloat|\.num\s*\//);
    expect(src).toMatch(/voiceMeasureOnsets\(/);
  });
});

describe('T3.5 E —— F-10 层级（Q7-a）', () => {
  function levelsOf(body: string, options: Options = {}): string[] {
    const group = plansOf(body, options)[0]?.groups[0];
    return (group?.segments ?? []).map((s) =>
      s.kind === 'span' ? `L${String(s.level)}:${String(s.from)}-${String(s.to)}` : `L${String(s.level)}:${String(s.member)}${s.direction === 'left' ? '<' : '>'}`,
    );
  }

  it('同时值八分：只有一层整组连续；equalSpacing = true，commonBeams = 1', () => {
    const group = plansOf('CDEF|')[0]?.groups[0];
    expect(levelsOf('CDEF|')).toEqual(['L1:0-1']);
    expect([group?.commonBeams, group?.equalSpacing]).toEqual([1, true]);
  });

  it('八分 + 十六分 + 十六分：公共 1 层 + 相邻十六分的 secondary 连续横梁；不等距', () => {
    const group = plansOf('C D/E/|')[0]?.groups[0];
    expect(levelsOf('C D/E/|')).toEqual(['L1:0-2', 'L2:1-2']);
    expect([group?.commonBeams, group?.equalSpacing]).toEqual([1, false]);
  });

  it('孤立的多出层级 → beamlet：组首向右，其余向左', () => {
    expect(levelsOf('C/D|')).toEqual(['L1:0-1', 'L2:0>']);
    expect(levelsOf('CD/|')).toEqual(['L1:0-1', 'L2:1<']);
    expect(levelsOf('C/ D E/|')).toEqual(['L1:0-2', 'L2:0>', 'L2:2<']);
    expect(levelsOf('C3/2 D/|')).toEqual(['L1:0-1', 'L2:1<']);
    // 中间成员的孤立层级同样向左（只有组首向右）：1/16 + 1/32 + 1/16。
    expect(levelsOf('C D/ E|', { unit: '1/16' })).toEqual(['L1:0-2', 'L2:0-2', 'L3:1<']);
  });

  it('三层（三十二分）：每层按最大连续段独立判定，公共层取最小条数', () => {
    expect(levelsOf('C/4 D/4 E/ F/', { unit: '1/8' })).toEqual(['L1:0-3', 'L2:0-3', 'L3:0-1']);
    expect(plansOf('C/4 D/4 E/ F/')[0]?.groups[0]?.commonBeams).toBe(2);
  });

  it('确定性：同输入两次逐字段相等', () => {
    expect(plansOf('C D/E/ F/4F/4F/ G|')).toEqual(plansOf('C D/E/ F/4F/4F/ G|'));
  });
});

describe('T3.5 F —— 组级间距（Q11）', () => {
  function spacingOf(widths: readonly number[], kinds?: readonly ('timed' | 'overlay')[]): MeasureSpacing {
    let x = 0;
    const slots = widths.map((width, i) => {
      const slot = { slot: { index: i, x, width }, widthKind: kinds?.[i] ?? 'timed' };
      x += width;
      return slot;
    });
    return { slots, width: x, equidistant: false };
  }
  function planFor(body: string, options: Options = {}): MeasureBeamPlan {
    const plan = plansOf(body, options)[0];
    if (plan === undefined) throw new Error('plan missing');
    return plan;
  }
  const widths = (spacing: MeasureSpacing): number[] => spacing.slots.map((s) => s.slot.width);
  const xs = (spacing: MeasureSpacing): number[] => spacing.slots.map((s) => s.slot.x);

  it('G_min 就是 minSlotWidth（12）', () => {
    expect(BEAM_MIN_STEM_GAP).toBe(SLOT_SPACING_METRICS.minSlotWidth);
    expect(BEAM_MIN_STEM_GAP).toBe(12);
  });

  it('没有组 / 同时值组 gap 已相等且 ≥ G_min → 返回同一引用', () => {
    const plan = planFor('CDEF|');
    const spacing = spacingOf([12, 12, 12, 12, 12]);
    expect(equalizeGroupSpacing(spacing, planFor('C2 D2|'))).toBe(spacing);
    expect(equalizeGroupSpacing(spacing, plan)).toBe(spacing);
  });

  it('同时值组：gap 只加宽到组内最大值，精确相等；末成员列与组外列不动；x 重新累计', () => {
    // C D E F | → 组 [0,1] [2,3]；第一组 gap = [17.5]，第二组 gap = [12]（单 gap 本就等距）。
    const plan = planFor('CDEF|');
    const spacing = spacingOf([17.5, 12, 12, 12, 12]);
    expect(equalizeGroupSpacing(spacing, plan)).toBe(spacing);
    const triple = planFor('CDEFGA|', { meter: '6/8' });
    const uneven = spacingOf([12, 17.666666666666668, 12, 12, 12, 12, 12]);
    const out = equalizeGroupSpacing(uneven, triple);
    expect(widths(out)).toEqual([17.666666666666668, 17.666666666666668, 12, 12, 12, 12, 12]);
    expect(xs(out)).toEqual([0, 17.666666666666668, 35.333333333333336, 47.333333333333336, 59.333333333333336, 71.33333333333334, 83.33333333333334]);
    expect(out.width).toBe(95.33333333333334);
  });

  it('同时值组全部 gap < G_min → 只加宽到 G_min', () => {
    const out = equalizeGroupSpacing(spacingOf([8, 8, 8, 8, 1]), planFor('CDEF|'));
    expect(widths(out)).toEqual([12, 8, 12, 8, 1]);
  });

  it('不同时值组：不强制等距，只把不足 G_min 的 gap 补到 G_min（beam-specific uplift）', () => {
    const plan = planFor('C D/E/ z2 z2|');
    expect(equalizeGroupSpacing(spacingOf([20, 12, 12, 24, 24, 1]), plan)).toEqual(spacingOf([20, 12, 12, 24, 24, 1]));
    expect(widths(equalizeGroupSpacing(spacingOf([20, 6, 12, 24, 24, 1]), plan))).toEqual([20, 12, 12, 24, 24, 1]);
  });

  it('chordSymbol 零宽列夹在成员之间：计入 gap、自身保持零宽、widthKind 原样', () => {
    const plan = planFor('C "G"D E "A"F|');
    expect(plan.groups.map((g) => g.members.map((m) => m.itemIndex))).toEqual([[0, 2], [3, 5]]);
    const out = equalizeGroupSpacing(spacingOf([12, 0, 12, 12, 0, 12, 1], ['timed', 'overlay', 'timed', 'timed', 'overlay', 'timed', 'timed']), plan);
    expect(widths(out)).toEqual([12, 0, 12, 12, 0, 12, 1]);
  });

  it('gap 契约：成员之间夹着的列宽（即使非零）计入 gap，加宽只落在前一成员自己的列上', () => {
    // 6/8：C "G" D E | F G A → 组 [0,2,3] 与 [4,5,6]；列 1 是 chordSymbol 列，这里人为给 5 宽。
    const plan = planFor('C "G"D E F G A|', { meter: '6/8' });
    expect(plan.groups.map((g) => g.members.map((m) => m.itemIndex))).toEqual([[0, 2, 3], [4, 5, 6]]);
    const out = equalizeGroupSpacing(spacingOf([10, 5, 12, 12, 12, 12, 12, 1]), plan);
    // gap = [10+5, 12] → target 15：列 0 不动（gap 已是 15），列 2 加宽到 15；列 1 保持 5。
    expect(widths(out)).toEqual([10, 5, 15, 12, 12, 12, 12, 1]);
  });

  it('真实 spaceItems：同时值组无异质 → 原样（同一引用）；index / widthKind / equidistant 保留', () => {
    const { voice } = voiceOf('CDEF|');
    const slice = sliceOf(voice);
    const spacing = spaceItems(slice.items, slice.startIndex);
    expect(equalizeGroupSpacing(spacing, planFor('CDEF|'))).toBe(spacing);
    const widened = equalizeGroupSpacing({ ...spacing, slots: spacing.slots.map((s, i) => (i === 0 ? { ...s, slot: { ...s.slot, width: 30 } } : s)) }, planFor('CDEF|'));
    expect(widened.slots.map((s) => [s.slot.index, s.widthKind])).toEqual(spacing.slots.map((s) => [s.slot.index, s.widthKind]));
    expect(widened.equidistant).toBe(spacing.equidistant);
  });
});

describe('T3.5 —— tuplet 判据与 T3 D2 不分叉（全部 fixture）', () => {
  it('T3 记 degraded[tuplet] 的声部小节 ⇔ T3.5 记 tuplet；T3 shared 的小节 T3.5 恒为 grouped', () => {
    let tupletHits = 0;
    let sharedChecked = 0;
    for (const name of fixtureNames) {
      const matrix = matrixScoreFrom(fixtureBytes(name));
      const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
      const timings = buildMeasureTimings(alignment);
      for (const [g, group] of alignment.groups.entries()) {
        for (const [k, measure] of group.measures.entries()) {
          const timing = timings.groups[g]?.measures[k];
          for (const [memberIndex, member] of measure.members.entries()) {
            if (!('slice' in member) || timing === undefined || timing.status === 'not-compatible') continue;
            const plan = planMeasureBeams(member.slice, QUARTER, tupletMemberSet(member.renderVoice.voice), JIANPU);
            if (timing.status === 'shared') {
              sharedChecked += 1;
              expect(plan.status).toBe('grouped');
              continue;
            }
            const cause = timing.causes.find((c) => c.memberIndex === memberIndex);
            const t3Tuplet = cause?.reasons.includes('tuplet') ?? false;
            if (t3Tuplet) tupletHits += 1;
            expect(plan.status === 'tuplet').toBe(t3Tuplet && !cause?.reasons.some((reason) => reason !== 'tuplet'));
          }
        }
      }
    }
    expect(tupletHits).toBeGreaterThan(0);
    expect(sharedChecked).toBeGreaterThan(0);
  });
});
