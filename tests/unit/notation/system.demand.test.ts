/**
 * M2.5 T4-0 —— 整数 tick 网格（`geometryTicks.ts`）与 measure demand（`measureDemand.ts`）。
 *
 * 覆盖：量化方向、整数比例分配（和恰等、份额上界）；唯一需求来源（TAB / 简谱吃 T3.5 最终 spacing、Staff 吃
 * `staffMeasureSpacing`、fallback 为 0、每 voice 只算一次）；跨 voice 取 max、absent 不参与；shared 分量
 * （lead / 段 / tail，chordSymbol 不新增位置）；tier 3；零 timed 各形态；行首预留。
 */
import { describe, expect, it } from 'vitest';

import { spaceItems } from '../../../src/notation/layout/spacing';
import type { MeasureSpacing } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import type { RenderVoice } from '../../../src/notation/model/types';
import { jianpuMeasureSpacing, planJianpuBeams } from '../../../src/notation/jianpu/jianpuBeams';
import { staffLineHeaderReserve } from '../../../src/notation/staff/staffHeader';
import { staffMeasureSpacing } from '../../../src/notation/staff/staffSlotWidths';
import { ceilTicks, distributeTicks, floorTicks, unitsOf } from '../../../src/notation/system/geometryTicks';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import {
  createVoiceSpacings, groupMeasureDemands, lineStartReserveTicks, voiceNotation, voicesOf,
} from '../../../src/notation/system/measureDemand';
import type { MeasureDemand } from '../../../src/notation/system/measureDemand';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import { planTabBeams, tabMeasureSpacing } from '../../../src/notation/tab/tabBeams';
import { widenForTabGlyphs } from '../../../src/notation/tab/tabSlotWidths';
import { matrixScoreFrom } from './renderMatrix.helpers';

const measurer = createDeterministicTextMeasurer();
const TICKS = 1 / SYSTEM_METRICS.geometryQuantum;

/** 每个 body 一个声部（`style` 为空 = 不写 style → fallback），首个声部 `bracket=N` 把它们编成一组。 */
function scoreOf(bodies: readonly (readonly [string, string])[], header = 'M:4/4\nL:1/8'): ReturnType<typeof matrixScoreFrom> {
  const decl = bodies.map(([style], i) => `V:${String(i + 1)}${i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''}${style === '' ? '' : ` style=${style}`}`);
  const lines = bodies.map(([, body], i) => `[V:${String(i + 1)}]${body}`);
  return matrixScoreFrom(['X:1', header, ...decl, 'K:C', ...lines, ''].join('\n'));
}

function demandsOf(bodies: readonly (readonly [string, string])[], header?: string): { readonly demands: readonly MeasureDemand[]; readonly spacings: (v: RenderVoice) => readonly MeasureSpacing[]; readonly voices: readonly RenderVoice[] } {
  const matrix = scoreOf(bodies, header);
  const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
  const timings = buildMeasureTimings(alignment);
  const spacings = createVoiceSpacings(matrix.score, measurer);
  const group = alignment.groups[0];
  const timing = timings.groups[0];
  if (group === undefined || timing === undefined) throw new Error('group missing');
  return { demands: groupMeasureDemands(group.measures, timing.measures, spacings), spacings, voices: matrix.renderScore.voices };
}

const raw = (spacings: (v: RenderVoice) => readonly MeasureSpacing[], voice: RenderVoice | undefined, k: number): number =>
  voice === undefined ? Number.NaN : spacings(voice)[k]?.width ?? Number.NaN;

describe('T4-0 —— 整数 tick 网格', () => {
  it('需求向上、可用宽向下取整；unitsOf 精确还原；非有限 / 负值为 0', () => {
    expect([ceilTicks(17.666666666666668), floorTicks(17.666666666666668)]).toEqual([18091, 18090]);
    expect(unitsOf(ceilTicks(12))).toBe(12);
    expect([ceilTicks(-1), ceilTicks(Number.NaN), floorTicks(Number.POSITIVE_INFINITY)]).toEqual([0, 0, 0]);
    // 极小正值：向上取整到 1 tick（四舍五入会得 0，量化后需求就小于原始值了）。
    expect([ceilTicks(0.0001), floorTicks(0.0001)]).toEqual([1, 0]);
    expect(TICKS).toBe(1024);
  });

  it('distributeTicks：和恰为 extra，每项 ≤ 精确份额上取整，下标顺序确定', () => {
    const weights = [3, 7, 11, 0, 5];
    for (const extra of [0, 1, 25, 26, 997, 123456]) {
      const out = distributeTicks(extra, weights);
      expect(out.reduce((a, b) => a + b, 0)).toBe(extra);
      out.forEach((share, i) => expect(share).toBeLessThanOrEqual(Math.ceil((extra * (weights[i] ?? 0)) / 26)));
    }
    expect(distributeTicks(5, [1, 1, 1])).toEqual([2, 2, 1]);
    // 余数只补给精确份额有小数部分的项：[2,1,1] 分 2 → 精确份额 1 / 0.5 / 0.5，第 0 项已是整数不能再 +1。
    expect(distributeTicks(2, [2, 1, 1])).toEqual([1, 1, 0]);
    expect(distributeTicks(5, [0, 0])).toEqual([0, 5]);
  });

  it('distributeTicks：乘积越过 2^53 仍精确（BigInt）', () => {
    const big = 2 ** 40;
    const out = distributeTicks(big + 3, [big, big * 3]);
    expect(out.reduce((a, b) => a + b, 0)).toBe(big + 3);
    expect(out[0]).toBe(Math.floor((big + 3) / 4) + 1);
  });
});

describe('T4-0 —— 唯一需求来源（T3.5 最终 spacing，不 double-count）', () => {
  it('TAB = tabMeasureSpacing（含同时值组等距加宽），不是改造前的 widenForTabGlyphs(spaceItems)', () => {
    const { spacings, voices } = demandsOf([['tab', 'a12// a3// a5// a7// |']], 'M:4/4\nL:1/4');
    const voice = voices[0];
    if (voice === undefined) throw new Error('voice');
    const slice = splitMeasures(voice.items)[0];
    if (slice === undefined) throw new Error('slice');
    const finalSpacing = tabMeasureSpacing(slice, planTabBeams([slice], voice, { kind: 'fraction', num: 4, den: 4, raw: '4/4' })[0], measurer);
    expect(spacings(voice)[0]).toEqual(finalSpacing);
    expect(spacings(voice)[0]?.width).toBeGreaterThan(widenForTabGlyphs(spaceItems(slice.items, 0), slice.items, measurer).width);
  });

  it('简谱 = jianpuMeasureSpacing；Staff = staffMeasureSpacing；fallback 全 0', () => {
    const { spacings, voices } = demandsOf([['jianpu', 'C D/E/ F2|'], ['staff', 'C D/E/ F2|'], ['', 'C D/E/ F2|']]);
    const [j, s, f] = voices;
    if (j === undefined || s === undefined || f === undefined) throw new Error('voices');
    const js = splitMeasures(j.items)[0];
    const ss = splitMeasures(s.items)[0];
    if (js === undefined || ss === undefined) throw new Error('slice');
    expect(spacings(j)[0]).toEqual(jianpuMeasureSpacing(js, planJianpuBeams([js], j, { kind: 'fraction', num: 4, den: 4, raw: '4/4' })[0]));
    expect(spacings(s)[0]).toEqual(staffMeasureSpacing(ss, measurer));
    expect(voiceNotation(f)).toBe('fallback');
    expect(spacings(f)[0]?.width).toBe(0);
    expect(spacings(f)[0]?.slots.every((slot) => slot.slot.width === 0)).toBe(true);
  });

  it('每个 voice 只算一次：同一 voice 两次取回同一数组引用', () => {
    const { spacings, voices } = demandsOf([['jianpu', 'CD|']]);
    const voice = voices[0];
    if (voice === undefined) throw new Error('voice');
    expect(spacings(voice)).toBe(spacings(voice));
  });
});

describe('T4-0 —— 跨 voice max、tier 3、absent', () => {
  it('shared：demand = lead + Σsegments + tail，≥ 每个 voice 整小节 raw 宽；窄 voice 不压缩宽 voice', () => {
    const { demands, spacings, voices } = demandsOf([['tab', 'a12 a3 a5 a7 |'], ['jianpu', 'C D E F|']]);
    const d = demands[0];
    const c = d?.components;
    if (d === undefined || c === undefined) throw new Error('shared demand');
    expect(d.demandTicks).toBe(c.lead + c.segments.reduce((a, b) => a + b, 0) + c.tail);
    for (const voice of voices) expect(d.demandTicks).toBeGreaterThanOrEqual(ceilTicks(raw(spacings, voice, 0)));
    expect(c.segments).toHaveLength(4);
  });

  it('段 = 同 onset 跨 voice 取 max；不同 local 列数 → 段取 max（段内先求和）；chordSymbol 不新增位置', () => {
    const { demands } = demandsOf([['jianpu', 'C !trill!D E F|'], ['jianpu', 'C D "G"E !trill!!mordent!F|']]);
    const c = demands[0]?.components;
    const w = (units: number): number => ceilTicks(units);
    // L:1/8：音符列 12。4 个 onset → 4 段；段 0：voice1 C(12)+装饰(12)=24；段 1：voice2 D(12)+chordSymbol(0)；
    // 段 2：voice2 E(12)+两个装饰(24)=36。chordSymbol 不新增段。
    expect(c?.segments).toEqual([w(24), w(12), w(36), w(12)]);
    expect(c?.tail).toBe(w(12));
    expect(c?.lead).toBe(0);
  });

  it('段内的 grace / unknown 与 decoration 一样计宽、不新增 onset；chordSymbol 之后的 local 列仍属当前段', () => {
    const w = ceilTicks;
    for (const local of ['{g}', 'x', '!trill!']) {
      const { demands } = demandsOf([['jianpu', `C ${local}D E F|`], ['jianpu', 'C D E F|']]);
      expect(demands[0]?.components?.segments).toEqual([w(24), w(12), w(12), w(12)]);
    }
    const chord = demandsOf([['jianpu', 'C "G"!trill!D E F|'], ['jianpu', 'C D E F|']]);
    expect(chord.demands[0]?.components?.segments).toEqual([w(24), w(12), w(12), w(12)]);
  });

  it('段分量各自向上量化：两位数品位列 17.67 → ⌈⌉ 而不是 ⌊⌋（每段 ≥ raw 段需求）', () => {
    const { demands, spacings, voices } = demandsOf([['tab', 'a12 a3 |']]);
    const voice = voices[0];
    if (voice === undefined) throw new Error('voice');
    const rawFirst = spacings(voice)[0]?.slots[0]?.slot.width ?? 0;
    expect(rawFirst).not.toBe(Math.round(rawFirst));
    expect(demands[0]?.components?.segments[0]).toBe(ceilTicks(rawFirst));
    expect((demands[0]?.components?.segments[0] ?? 0) * SYSTEM_METRICS.geometryQuantum).toBeGreaterThanOrEqual(rawFirst);
  });

  it('同一 onset 上多个 timed（零时值 C0 与 D 同 onset）：都归同一段、各自计宽', () => {
    const { demands } = demandsOf([['jianpu', 'C0 D E F|']]);
    expect(demands[0]?.components?.segments).toEqual([24, 12, 12].map(ceilTicks));
  });

  it('各声部 lead 不同：lead 取跨 voice max（不相加）', () => {
    const { demands } = demandsOf([['jianpu', '!trill!C D E F|'], ['jianpu', 'x !trill!C D E F|']]);
    expect(demands[0]?.components?.lead).toBe(ceilTicks(24));
  });

  it('量化后分量之和 < ⌈max 整小节宽⌉ 时，差额补进 tail（demand ≥ 每个 raw voice demand，裁决 J）', () => {
    const matrix = scoreOf([['jianpu', 'C D E F|']]);
    const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
    const timings = buildMeasureTimings(alignment);
    const real = createVoiceSpacings(matrix.score, measurer);
    // 桩：整小节宽比各列之和多 5 个单位（列宽不变）——真实 spacing 不会这样，只为钉住补差分支。
    const padded = (voice: RenderVoice): readonly MeasureSpacing[] => real(voice).map((s) => ({ ...s, width: s.width + 5 }));
    const [demand] = groupMeasureDemands(alignment.groups[0]?.measures ?? [], timings.groups[0]?.measures ?? [], padded);
    const [plain] = groupMeasureDemands(alignment.groups[0]?.measures ?? [], timings.groups[0]?.measures ?? [], real);
    const voice = matrix.renderScore.voices[0];
    if (voice === undefined) throw new Error('voice');
    expect(demand?.demandTicks).toBe(ceilTicks((real(voice)[0]?.width ?? 0) + 5));
    expect(demand?.components?.tail).toBe((plain?.components?.tail ?? 0) + ceilTicks(5));
    const c = demand?.components;
    expect(c === undefined ? -1 : c.lead + c.segments.reduce((a, b) => a + b, 0) + c.tail).toBe(demand?.demandTicks);
  });

  it('lead：首个 onset 之前的装饰 / grace 计入 lead（不并进第 0 段）；tail = 收尾 barline 列', () => {
    const { demands } = demandsOf([['jianpu', '!trill!{g}C D E F|'], ['jianpu', 'C D E F|']]);
    expect(demands[0]?.components).toEqual({ lead: ceilTicks(24), segments: [12, 12, 12, 12].map(ceilTicks), tail: ceilTicks(12) });
  });

  it('tier 3（total-mismatch / structure-conflict）：无分量，demand = ⌈max 整小节宽⌉，仍有需求', () => {
    const mismatch = demandsOf([['jianpu', 'C D E F G A|'], ['jianpu', 'C D|']]);
    expect(mismatch.demands[0]?.components).toBeUndefined();
    const [a, b] = mismatch.voices;
    expect(mismatch.demands[0]?.demandTicks).toBe(ceilTicks(Math.max(raw(mismatch.spacings, a, 0), raw(mismatch.spacings, b, 0))));
    const conflict = demandsOf([['jianpu', 'C D E F|'], ['jianpu', 'C D E F||']]);
    expect(conflict.demands[0]?.components).toBeUndefined();
    expect(conflict.demands[0]?.demandTicks).toBeGreaterThan(0);
  });

  it('absent voice 不参与 max（measure 数不等，前缀对齐后尾部只有一个 voice）', () => {
    const { demands, spacings, voices } = demandsOf([['jianpu', 'CD|CDEFGABc|'], ['jianpu', 'CD|']]);
    expect(demands).toHaveLength(2);
    expect(demands[1]?.demandTicks).toBe(ceilTicks(raw(spacings, voices[0], 1)));
  });

  it('fallback voice 需求 0，不抬高 max', () => {
    const { demands, spacings, voices } = demandsOf([['jianpu', 'C D E F|'], ['', 'C D E F G A B c|']]);
    expect(demands[0]?.demandTicks).toBe(ceilTicks(raw(spacings, voices[0], 0)));
  });
});

describe('T4-0 —— 零 timed 的 shared measure（offsets = []，空分量仍有需求）', () => {
  const zero = (second: string): MeasureDemand | undefined =>
    demandsOf([['jianpu', `CD| ${second}`], ['jianpu', `CD| ${second}`]]).demands[1];

  it('barline-only：lead 0、tail = 小节线列，demand > 0', () => {
    expect(zero('|')).toMatchObject({ components: { lead: 0, segments: [], tail: ceilTicks(12) } });
  });

  it('decoration + barline / grace + barline / unknown + barline：local 列进 lead', () => {
    for (const body of ['!trill!|', '{g}|', 'x|']) {
      expect(zero(body)?.components).toEqual({ lead: ceilTicks(12), segments: [], tail: ceilTicks(12) });
    }
  });

  it('chordSymbol-only（零宽 overlay + 收尾小节线）：lead 0、tail 12', () => {
    expect(zero('"G"|')?.components).toEqual({ lead: 0, segments: [], tail: ceilTicks(12) });
  });

  it('无收尾 barline：tail 0，全部进 lead；chordSymbol 单独结尾时 demand 可为 0', () => {
    expect(zero('!trill!')?.components).toEqual({ lead: ceilTicks(12), segments: [], tail: 0 });
    expect(zero('"G"')?.demandTicks).toBe(0);
  });
});

describe('T4-0 —— 行首预留（§Q4.4，裁决 F / M）', () => {
  const reserveOf = (bodies: readonly (readonly [string, string])[]): number => {
    const matrix = scoreOf(bodies);
    return lineStartReserveTicks(matrix.renderScore.voices, matrix.score);
  };

  it('只有 Staff：⌈谱号 + 调号 + 拍号预留⌉；TAB / 简谱 / fallback 为 0；Staff + TAB 取 max（不相加）', () => {
    const matrix = scoreOf([['staff', 'CD|']]);
    const staff = ceilTicks(staffLineHeaderReserve(matrix.score));
    expect(staff).toBeGreaterThan(0);
    expect(reserveOf([['staff', 'CD|']])).toBe(staff);
    expect(reserveOf([['tab', 'a0 a1 |']])).toBe(0);
    expect(reserveOf([['jianpu', 'CD|']])).toBe(0);
    expect(reserveOf([['', 'CD|']])).toBe(0);
    expect(reserveOf([['staff', 'CD|'], ['tab', 'a0 a1 |']])).toBe(staff);
    expect(reserveOf([['staff', 'CD|'], ['staff', 'CD|']])).toBe(staff);
  });

  it('voicesOf：按 voiceIds 顺序取 voice，缺失 id 跳过', () => {
    const matrix = scoreOf([['jianpu', 'CD|'], ['tab', 'a0 |']]);
    const [a, b] = matrix.renderScore.voices;
    if (a === undefined || b === undefined) throw new Error('voices');
    expect(voicesOf([b.voiceId, a.voiceId], matrix.renderScore.voices)).toEqual([b, a]);
  });
});
