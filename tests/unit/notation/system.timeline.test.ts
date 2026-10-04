/**
 * M2.5 T3 —— `voiceMeasureOnsets`（voice-local literal timing，唯一累计实现）与 `buildMeasureTimings`
 * （小节内 shared timing）。依据 `docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q3 与用户裁决 R1–R6 / N1 / N2
 * （2026-10-04）。全部是 synthetic / 手工构造输入；真实语料只在独立 probe 里只读核对，本文件不引用。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Rational } from '../../../src/domain';
import { voiceId } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import { splitMeasures } from '../../../src/notation/layout/systems';
import type { MeasureSlice } from '../../../src/notation/layout/systems';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import type { RenderItem, RenderVoice } from '../../../src/notation/model/types';
import { anchorKey } from '../../../src/notation/model/types';
import type { SystemGroup } from '../../../src/notation/system/contracts';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import { sliceTotal, voiceMeasureOnsets } from '../../../src/notation/system/measureFeatures';
import type { MeasureAlignment } from '../../../src/notation/system/measureIdentity';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import type { MeasureTimings, SharedMeasureTiming } from '../../../src/notation/system/timeline';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import type { MatrixScore } from './renderMatrix.helpers';
import { anchorResolves, matrixScoreFrom } from './renderMatrix.helpers';

const r = (value: Rational): string => `${String(value.num)}/${String(value.den)}`;

function groupSource(bodies: readonly string[]): string {
  const declarations = bodies.map((_body, i) => `V:${String(i + 1)}${i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''}`);
  const lines = bodies.flatMap((body, i) => (body === '' ? [] : [`[V:${String(i + 1)}]${body}`]));
  return ['X:1', 'M:4/4', 'L:1/4', ...declarations, 'K:C', ...lines, ''].join('\n');
}

interface Run {
  readonly matrix: MatrixScore;
  readonly groups: readonly SystemGroup[];
  readonly alignment: MeasureAlignment;
  readonly timings: MeasureTimings;
}

function fromVoices(matrix: MatrixScore, voices: readonly RenderVoice[], groups?: readonly SystemGroup[]): Run {
  const resolvedGroups = groups ?? groupVoices(matrix.score.voices).groups;
  const alignment = alignMeasures(resolvedGroups, voices);
  return { matrix, groups: resolvedGroups, alignment, timings: buildMeasureTimings(alignment) };
}

function run(bodies: readonly string[]): Run {
  const matrix = matrixScoreFrom(groupSource(bodies));
  return fromVoices(matrix, matrix.renderScore.voices);
}

/** 防御性输入：按 note 出现顺序逐个替换 duration（`undefined` = 去掉；数组用尽后保持原值）。 */
function withNoteDurations(voice: RenderVoice | undefined, durations: readonly (Rational | undefined)[]): RenderVoice[] {
  if (voice === undefined) return [];
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
  return [{ ...voice, items }];
}

function measureOf(timings: MeasureTimings, k: number, g = 0): SharedMeasureTiming | undefined {
  return timings.groups[g]?.measures[k];
}

/** `'shared:0/1,1/4|total=1/1'` / `'degraded:v1#0[tuplet]'` / `'not-compatible'`。 */
function summary(timings: MeasureTimings, g = 0): string[] {
  return (timings.groups[g]?.measures ?? []).map((m) => {
    if (m.status === 'shared') return `shared:${m.offsets.map(r).join(',')}|total=${r(m.total)}`;
    if (m.status === 'degraded') return `degraded:${m.causes.map((c) => `${c.voiceId}#${String(c.memberIndex)}[${c.reasons.join('+')}]`).join(' ')}`;
    return m.status;
  });
}

function firstSlice(body: string, k = 0): MeasureSlice {
  const voice = run([body]).matrix.renderScore.voices[0];
  const slice = voice === undefined ? undefined : splitMeasures(voice.items)[k];
  if (slice === undefined) throw new Error('fixture slice missing');
  return slice;
}

describe('M2.5 T3 —— voiceMeasureOnsets（voice-local literal timing，N1 唯一实现）', () => {
  const onsets = (slice: MeasureSlice): string => {
    const result = voiceMeasureOnsets(slice);
    if (!result.resolved) return result.reason;
    const timed = result.timed.map((t) => `${String(t.itemIndex)}@${r(t.onset)}+${r(t.duration)}`).join(' ');
    const overlays = result.overlays.map((o) => `${String(o.itemIndex)}@${r(o.onset)}`).join(' ');
    return `timed[${timed}] overlays[${overlays}] total=${r(result.total)}`;
  };

  it('#1 1/4 + 1/4 + 1/2 → onsets 0, 1/4, 1/2，total 1', () => {
    expect(onsets(firstSlice('C D E2|'))).toBe('timed[0@0/1+1/4 1@1/4+1/4 2@1/2+1/2] overlays[] total=1/1');
  });

  it('#2 1/3 × 3（durationUnrepresentable）照字面累计', () => {
    expect(onsets(firstSlice('C4/3 C4/3 C4/3|'))).toBe('timed[0@0/1+1/3 1@1/3+1/3 2@2/3+1/3] overlays[] total=1/1');
  });

  it('#3 / #4 非规范化 {2,4} 与大分母：onset 经 add 规范化、精确', () => {
    const voice = run(['CD|']).matrix.renderScore.voices[0];
    const [half] = withNoteDurations(voice, [{ num: 2, den: 4 }, { num: 2, den: 4 }]);
    const slice = half === undefined ? undefined : splitMeasures(half.items)[0];
    expect(slice === undefined ? '' : onsets(slice)).toBe('timed[0@0/1+2/4 1@1/2+2/4] overlays[] total=1/1');
    const big: Rational = { num: 1, den: 2 ** 40 };
    const [tiny] = withNoteDurations(voice, [big, big]);
    const tinySlice = tiny === undefined ? undefined : splitMeasures(tiny.items)[0];
    expect(tinySlice === undefined ? '' : onsets(tinySlice)).toBe(`timed[0@0/1+1/${String(2 ** 40)} 1@1/${String(2 ** 40)}+1/${String(2 ** 40)}] overlays[] total=1/${String(2 ** 39)}`);
  });

  it('#5 / #6 duration undefined → duration-undefined；累加越界 → arithmetic-overflow', () => {
    const voice = run(['CD|']).matrix.renderScore.voices[0];
    const [undef] = withNoteDurations(voice, [undefined]);
    const [huge] = withNoteDurations(voice, [{ num: Number.MAX_SAFE_INTEGER, den: 1 }, { num: Number.MAX_SAFE_INTEGER, den: 1 }]);
    const slices = [undef, huge].map((v) => (v === undefined ? undefined : splitMeasures(v.items)[0]));
    expect(slices.map((s) => (s === undefined ? '' : onsets(s)))).toEqual(['duration-undefined', 'arithmetic-overflow']);
  });

  it('#7 / #8 chordSymbol 前 / 中 / 末与连续 chordSymbol：onset = 当时 off，不推进', () => {
    expect(onsets(firstSlice('"C"C "G"D E2 "F"|'))).toBe('timed[1@0/1+1/4 3@1/4+1/4 4@1/2+1/2] overlays[0@0/1 2@1/4 5@1/1] total=1/1');
    expect(onsets(firstSlice('"C""G"C3 D|'))).toBe('timed[2@0/1+3/4 3@3/4+1/4] overlays[0@0/1 1@0/1] total=1/1');
  });

  it('#9 decoration / grace / unknown / barline 不进入 timing、不推进 off', () => {
    expect(onsets(firstSlice('!trill! {g} x C D2 x E|'))).toBe('timed[3@0/1+1/4 4@1/4+1/2 6@3/4+1/4] overlays[] total=1/1');
  });

  it('N1：sliceTotal 源码里没有第二套累计循环（只是 voiceMeasureOnsets 的投影）', () => {
    const source = readFileSync(join(import.meta.dirname, '../../../src/notation/system/measureFeatures.ts'), 'utf8');
    const body = /export function sliceTotal\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body).toBeDefined();
    expect(body).toMatch(/voiceMeasureOnsets\(/);
    expect(body).not.toMatch(/\bfor\b|\badd\(|\bZERO\b|RangeError/);
  });

  it('#44 sliceTotal 是 voiceMeasureOnsets 的纯投影（fixture 全集）', () => {
    for (const name of fixtureNames) {
      const loaded = loadJcx(fixtureBytes(name));
      for (const voice of buildRenderScore({ score: loaded.score, index: loaded.index }).voices) {
        for (const slice of splitMeasures(voice.items)) {
          const onsetsResult = voiceMeasureOnsets(slice);
          expect(sliceTotal(slice)).toEqual(
            onsetsResult.resolved ? { resolved: true, value: onsetsResult.total } : { resolved: false, reason: onsetsResult.reason },
          );
        }
      }
    }
  });
});

describe('M2.5 T3 —— shared onset 并集', () => {
  it('#10 两声部相同 subdivision', () => {
    expect(summary(run(['CDEF|', 'CDEF|']).timings)).toEqual(['shared:0/1,1/4,1/2,3/4|total=1/1']);
  });

  it('#11 / #13 1/2+1/2 vs 1/4+1/4+1/2 → 并集精确去重', () => {
    expect(summary(run(['C2D2|', 'CDE2|']).timings)).toEqual(['shared:0/1,1/4,1/2|total=1/1']);
  });

  it('#12 三声部不同 subdivision → 排序确定', () => {
    expect(summary(run(['C2D2|', 'CDE2|', 'C3D|']).timings)).toEqual(['shared:0/1,1/4,1/2,3/4|total=1/1']);
  });

  it('#14 与声部顺序置换无关', () => {
    expect(summary(run(['CDE2|', 'C2D2|', 'C3D|']).timings)).toEqual(summary(run(['C3D|', 'C2D2|', 'CDE2|']).timings));
  });

  it('#15 大分母：浮点相等但 Rational 不等的 onset 必须分开、按 cmp 排序', () => {
    const { matrix } = run(['CD|', 'CD|']);
    const [v1, v2] = matrix.renderScore.voices;
    const a: Rational = { num: 2 ** 52, den: 2 ** 52 + 1 };
    const b: Rational = { num: 2 ** 52 + 1, den: 2 ** 52 + 2 };
    expect(a.num / a.den).toBe(b.num / b.den);
    const voices = [
      ...withNoteDurations(v1, [a, { num: 1, den: 2 ** 52 + 1 }]),
      ...withNoteDurations(v2, [b, { num: 1, den: 2 ** 52 + 2 }]),
    ];
    const { timings } = fromVoices(matrix, voices);
    expect(summary(timings)).toEqual([`shared:0/1,${r(a)},${r(b)}|total=1/1`]);
    // 声部顺序对调：浮点稳定排序会把 b 排在 a 前，cmp 必须仍给出升序。
    const swapped = [
      ...withNoteDurations(v1, [b, { num: 1, den: 2 ** 52 + 2 }]),
      ...withNoteDurations(v2, [a, { num: 1, den: 2 ** 52 + 1 }]),
    ];
    expect(summary(fromVoices(matrix, swapped).timings)).toEqual([`shared:0/1,${r(a)},${r(b)}|total=1/1`]);
  });

  it('total ≠ 1 时 offsets 与逐声部 onset 都是绝对值（不按 total 归一化）', () => {
    const { timings } = run(['CD|', 'C2|']);
    expect(summary(timings)).toEqual(['shared:0/1,1/4|total=1/2']);
    const m = measureOf(timings, 0);
    expect(m?.status === 'shared' ? m.voices.map((v) => v.timed.map((t) => r(t.onset))) : []).toEqual([['0/1', '1/4'], ['0/1']]);
  });

  it('durationUnrepresentable（1/3）在 T3 层仍 shared，与 1/2 精确并集', () => {
    expect(summary(run(['C4/3 C4/3 C4/3|', 'C2 C2|']).timings)).toEqual(['shared:0/1,1/3,1/2,2/3|total=1/1']);
  });
});

describe('M2.5 T3 —— D1 / D2 / overflow 退化与 system 诊断（R2）', () => {
  const diagnostics = (timings: MeasureTimings): string[] => timings.diagnostics.map((d) => `${anchorKey(d.anchor)} ${d.level}`);

  it('#16 D1：只列原因声部，发一条 info', () => {
    const { matrix } = run(['CDEF|', 'CDEF|']);
    const [v1, v2] = matrix.renderScore.voices;
    const { timings } = fromVoices(matrix, [...withNoteDurations(v1, [undefined]), ...(v2 === undefined ? [] : [v2])]);
    expect(summary(timings)).toEqual(['degraded:v1#0[duration-undefined]']);
    expect(diagnostics(timings)).toEqual(['event:v1/v1:e0 info']);
  });

  it('#17b T2 记 overflow 但切片本身可解 → 仍按 T2 原因降级（证明不重新累计）', () => {
    const { alignment } = run(['CDEF|', 'CDEF|']);
    const groups = alignment.groups.map((group) => ({
      ...group,
      measures: group.measures.map((measure) => ({
        ...measure,
        members: measure.members.map((member, i) =>
          i === 0 && 'slice' in member ? { ...member, total: { resolved: false as const, reason: 'arithmetic-overflow' as const } } : member,
        ),
      })),
    }));
    expect(summary(buildMeasureTimings({ ...alignment, groups }))).toEqual(['degraded:v1#0[arithmetic-overflow]']);
  });

  it('#17 overflow：沿用 T2 原因，不重新累计', () => {
    const { matrix } = run(['CDEF|', 'CDEF|']);
    const [v1, v2] = matrix.renderScore.voices;
    const huge: Rational = { num: Number.MAX_SAFE_INTEGER, den: 1 };
    const { alignment, timings } = fromVoices(matrix, [...withNoteDurations(v1, [huge, huge]), ...(v2 === undefined ? [] : [v2])]);
    expect(alignment.groups[0]?.measures[0]?.verdict).toBe('compatible');
    expect(summary(timings)).toEqual(['degraded:v1#0[arithmetic-overflow]']);
    expect(diagnostics(timings)).toEqual(['event:v1/v1:e0 info']);
  });

  it('诊断 anchor 是本小节首事件（这里是 chordSymbol），不是首个音符', () => {
    const { timings } = run(['"C"(3CDE F|', 'CDEF|']);
    expect(diagnostics(timings)).toEqual(['event:v1/v1:e0 info']);
  });

  it('#18 D2：tuplet 成员落在本小节 → degraded，一条 info', () => {
    const { timings } = run(['(3CDE F|', 'CDEF|']);
    expect(summary(timings)).toEqual(['degraded:v1#0[tuplet]']);
    expect(diagnostics(timings)).toEqual(['event:v1/v1:e0 info']);
  });

  it('#19 D1 + D2 同一声部 → 合并为一条，message 列出两个原因', () => {
    const { matrix } = run(['(3CDE F|', 'CDEF|']);
    const [v1, v2] = matrix.renderScore.voices;
    const { timings } = fromVoices(matrix, [...withNoteDurations(v1, [undefined]), ...(v2 === undefined ? [] : [v2])]);
    expect(summary(timings)).toEqual(['degraded:v1#0[duration-undefined+tuplet]']);
    expect(timings.diagnostics).toHaveLength(1);
    expect(timings.diagnostics[0]?.message).toMatch(/时值不可知的事件、实际时值未建模的连音成员/);
  });

  it('#20 / #46 两个声部各有不同原因 → causes 分开、按 memberIndex 升序，各一条', () => {
    const { matrix } = run(['(3CDE F|', 'CDEF|']);
    const [v1, v2] = matrix.renderScore.voices;
    const { timings } = fromVoices(matrix, [...(v1 === undefined ? [] : [v1]), ...withNoteDurations(v2, [undefined])]);
    expect(summary(timings)).toEqual(['degraded:v1#0[tuplet] v2#1[duration-undefined]']);
    expect(diagnostics(timings)).toEqual(['event:v1/v1:e0 info', 'event:v2/v2:e0 info']);
  });

  it('#21 tuplet 不落当前小节 → 当前小节不退化', () => {
    expect(summary(run(['CDEF|(3CDE F|', 'CDEF|CDEF|']).timings)).toEqual([
      'shared:0/1,1/4,1/2,3/4|total=1/1',
      'degraded:v1#0[tuplet]',
    ]);
  });

  it('#22 跨小节 tuplet → 只有含成员的小节各自退化', () => {
    expect(summary(run(['C D E (3F|G A B2|C4|', 'CDEF|GAB2|C4|']).timings)).toEqual([
      'degraded:v1#0[tuplet]',
      'degraded:v1#0[tuplet]',
      'shared:0/1|total=1/1',
    ]);
  });
});

describe('M2.5 T3 —— 与 T2 / T2.1 的衔接（verdict 非 compatible 一律跳过）', () => {
  it('#23 / #24 structure-conflict、total-mismatch → not-compatible，T3 不发诊断', () => {
    for (const bodies of [['CDEF|:', 'CDEF|]'], ['CDEF|', 'CD|']]) {
      const { timings } = run(bodies);
      expect(summary(timings)).toEqual(['not-compatible']);
      expect(timings.diagnostics).toEqual([]);
    }
  });

  it('#25 / #26 desynced（含触发点之后的全部 ordinal）→ not-compatible，即使含 tuplet 也不发', () => {
    const { timings } = run(['|CDEF|(3GAB c|', 'CDEF|GABc|']);
    expect(summary(timings)).toEqual(['not-compatible', 'not-compatible', 'not-compatible']);
    expect(timings.diagnostics).toEqual([]);
  });

  it('#27 diagnosticsSuppressed=true → 退化照常记录，T3 诊断全抑制', () => {
    const { matrix } = run(['(3CDE F|', 'CDEF|']);
    const group: SystemGroup = { index: 0, voiceIds: [voiceId(1), voiceId(2), voiceId(99)], connector: 'bracket', evidence: 'declared' };
    const { alignment, timings } = fromVoices(matrix, matrix.renderScore.voices, [group]);
    expect(alignment.groups[0]?.diagnosticsSuppressed).toBe(true);
    expect(summary(timings)).toEqual(['degraded:v1#0[tuplet]']);
    expect(timings.diagnostics).toEqual([]);
  });
});

describe('M2.5 T3 —— singleton / 单一在场声部（R4）', () => {
  it('#28 singleton 正常 shared', () => {
    expect(summary(run(['CDE2|']).timings)).toEqual(['shared:0/1,1/4,1/2|total=1/1']);
  });

  it('#29 / #30 singleton D1、D2 → degraded，不发 system 诊断', () => {
    const d2 = run(['(3CDE F|']);
    expect(summary(d2.timings)).toEqual(['degraded:v1#0[tuplet]']);
    expect(d2.timings.diagnostics).toEqual([]);
    const { matrix } = run(['CDEF|']);
    const d1 = fromVoices(matrix, withNoteDurations(matrix.renderScore.voices[0], [undefined]));
    expect(summary(d1.timings)).toEqual(['degraded:v1#0[duration-undefined]']);
    expect(d1.timings.diagnostics).toEqual([]);
  });

  it('#31 多声部 group 但当前 ordinal 只剩 1 个在场声部 → degraded，不发', () => {
    const { timings } = run(['CDEF|(3CDE F|', 'CDEF|']);
    expect(summary(timings)).toEqual(['shared:0/1,1/4,1/2,3/4|total=1/1', 'degraded:v1#0[tuplet]']);
    expect(timings.diagnostics).toEqual([]);
  });
});

describe('M2.5 T3 —— 零 timed 小节（R3）与 overlay 位置（R1）', () => {
  it('#32 / #33 孤立小节线、decoration / grace / unknown 小节 → offsets = []，total = 0', () => {
    expect(summary(run(['|CDEF|', '|CDEF|']).timings)[0]).toBe('shared:|total=0/1');
    expect(summary(run(['!trill! {g} x|CDEF|', '!trill! x|CDEF|']).timings)[0]).toBe('shared:|total=0/1');
  });

  it('#34 chordSymbol-only → offsets = []、total = 0、measure-end', () => {
    const { timings } = run(['"C"|', '"G"|']);
    expect(summary(timings)).toEqual(['shared:|total=0/1']);
    const m = measureOf(timings, 0);
    expect(m?.status === 'shared' ? m.voices.map((v) => v.overlays.map((o) => o.position.kind)) : []).toEqual([['measure-end'], ['measure-end']]);
  });

  it('timed 之后的末尾 chordSymbol → measure-end，且不进入 offsets', () => {
    const { timings } = run(['CDEF "G"|', 'C2D2|']);
    expect(summary(timings)).toEqual(['shared:0/1,1/4,1/2,3/4|total=1/1']);
    const m = measureOf(timings, 0);
    expect(m?.status === 'shared' ? m.voices[0]?.overlays.map((o) => o.position) : undefined).toEqual([{ kind: 'measure-end' }]);
  });

  it('overlay 的 offsetIndex 是并集下标，不是声部内下标', () => {
    const m = measureOf(run(['C2 "G"D2|', 'CDEF|']).timings, 0);
    expect(m?.status === 'shared' ? m.voices[0]?.overlays : undefined).toEqual([
      { itemIndex: 1, onset: { num: 1, den: 2 }, position: { kind: 'onset', offsetIndex: 2 } },
    ]);
  });

  it('#41 chordSymbol 之后隔着 decoration / grace 才是 timed → 贴到该 timed 的 offset', () => {
    const m = measureOf(run(['C "G"!trill! {g}D E2|', 'CDE2|']).timings, 0);
    expect(m?.status === 'shared' ? m.voices[0]?.overlays : undefined).toEqual([
      { itemIndex: 1, onset: { num: 1, den: 4 }, position: { kind: 'onset', offsetIndex: 1 } },
    ]);
  });

  it('#42 zero-duration timed 反例：后续还有 timed（onset = total）→ 贴到它的 offset，而不是 measure-end', () => {
    const { matrix } = run(['C D E2 "G"F|', 'CDE2|']);
    const [v1, v2] = matrix.renderScore.voices;
    const durations: Rational[] = [{ num: 1, den: 4 }, { num: 1, den: 4 }, { num: 1, den: 2 }, { num: 0, den: 1 }];
    const { timings } = fromVoices(matrix, [...withNoteDurations(v1, durations), ...(v2 === undefined ? [] : [v2])]);
    const m = measureOf(timings, 0);
    expect(summary(timings)).toEqual(['shared:0/1,1/4,1/2,1/1|total=1/1']);
    expect(m?.status === 'shared' ? m.voices[0]?.overlays.map((o) => o.position) : undefined).toEqual([{ kind: 'onset', offsetIndex: 3 }]);
  });
});

describe('M2.5 T3 —— 契约与纯函数', () => {
  it('#37 / #38 / #43 itemIndex 指向原切片事件；offsets[offsetIndex] 等于 onset；memberIndex 不重新编号', () => {
    const { alignment, timings } = run(['"C"CDEF|GABc|', 'CDEF|', '"G"C2D2|GABc|']);
    const measures = alignment.groups[0]?.measures ?? [];
    for (const [k, m] of (timings.groups[0]?.measures ?? []).entries()) {
      if (m.status !== 'shared') continue;
      for (const voice of m.voices) {
        const member = measures[k]?.members[voice.memberIndex];
        expect(member !== undefined && 'slice' in member && member.participation.voiceId === voice.voiceId).toBe(true);
        if (member === undefined || !('slice' in member)) continue;
        for (const t of voice.timed) {
          expect(m.offsets[t.offsetIndex]).toEqual(t.onset);
          expect(['note', 'rest', 'tabNote', 'chord', 'tabGroup']).toContain(member.slice.items[t.itemIndex]?.event.kind);
        }
        for (const o of voice.overlays) {
          expect(member.slice.items[o.itemIndex]?.event.kind).toBe('chordSymbol');
        }
      }
    }
    const second = measureOf(timings, 1);
    expect(second?.status === 'shared' ? second.voices.map((v) => v.memberIndex) : []).toEqual([0, 2]);
  });

  it('#35 / #36 / #39 不改入参、确定性、shared 只含 timing 字段（无 x / endX）', () => {
    const { alignment, timings } = run(['"C"C2D2|', 'CDE2|']);
    const snapshot = JSON.stringify(alignment);
    expect(buildMeasureTimings(alignment)).toEqual(timings);
    expect(JSON.stringify(alignment)).toBe(snapshot);
    const m = measureOf(timings, 0);
    expect(m === undefined ? [] : Object.keys(m).sort()).toEqual(['offsets', 'status', 'total', 'voices']);
  });

  it('#40 诊断：code / level / C3 / ownership / sourceRef / id 稳定', () => {
    const { matrix, timings } = run(['(3CDE F|(3GAB c|', 'CDEF|GABc|']);
    expect(timings.diagnostics.map((d) => d.id)).toEqual([
      `event:v1/v1:e0|${CODES.systemMeasureTimingDegraded}#0`,
      `event:v1/v1:e5|${CODES.systemMeasureTimingDegraded}#0`,
    ]);
    for (const d of timings.diagnostics) {
      expect(d.code).toBe(CODES.systemMeasureTimingDegraded);
      expect(d.level).toBe('info');
      expect(anchorResolves(d.anchor, matrix)).toBe(true);
      if (d.anchor.kind !== 'event') throw new Error('expected event anchor');
      const owner = matrix.index.eventById.get(d.anchor.eventId);
      expect(owner?.voiceId).toBe(d.anchor.voiceId);
      expect(d.sourceRef).toBe(owner?.event.origin);
    }
  });

  it('#47 防御：resolved 成员的切片意外 unresolved → 按实际原因降级，不 throw', () => {
    const { matrix, alignment } = run(['CDEF|', 'CDEF|']);
    const [v1] = withNoteDurations(matrix.renderScore.voices[0], [undefined]);
    const badSlice = v1 === undefined ? undefined : splitMeasures(v1.items)[0];
    const groups = alignment.groups.map((group) => ({
      ...group,
      measures: group.measures.map((measure) => ({
        ...measure,
        members: measure.members.map((member, i) => (i === 0 && 'slice' in member && badSlice !== undefined ? { ...member, slice: badSlice } : member)),
      })),
    }));
    const timings = buildMeasureTimings({ ...alignment, groups });
    expect(summary(timings)).toEqual(['degraded:v1#0[duration-undefined]']);
    expect(timings.diagnostics).toHaveLength(1);
  });
});
