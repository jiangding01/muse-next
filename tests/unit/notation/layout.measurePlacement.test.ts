/**
 * M2.5 T5-0 —— `layout/measurePlacement.ts`：external 映射、shared 摆放（E-c / J）、tier 3 摆放（F-d）、
 * 校验失败一律 `RangeError`（A2 / 额外裁决 4），以及 max extent（I）。
 */
import { describe, expect, it } from 'vitest';

import type { Rational, VoiceId } from '../../../src/domain';
import { ZERO, fromParts } from '../../../src/domain';
import { externalExtent, mapExternalMeasures, placeExternalMeasure } from '../../../src/notation/layout/measurePlacement';
import type { ExternalMeasureBox, ExternalTimeline } from '../../../src/notation/layout/measurePlacement';
import type { System } from '../../../src/notation/layout/primitives';
import { spaceItems } from '../../../src/notation/layout/spacing';
import type { MeasureSpacing } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import type { MeasureSlice } from '../../../src/notation/layout/systems';
import type { RenderVoice } from '../../../src/notation/model/types';
import { matrixScoreFrom } from './renderMatrix.helpers';

function voiceOf(body: string): RenderVoice {
  const voice = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/8', 'V:1 style=jianpu', 'K:C', `[V:1]${body}`, ''].join('\n')).renderScore.voices[0];
  if (voice === undefined) throw new Error('no voice');
  return voice;
}

function measureOf(body: string, index = 0): { readonly slice: MeasureSlice; readonly spacing: MeasureSpacing } {
  const slice = splitMeasures(voiceOf(body).items)[index];
  if (slice === undefined) throw new Error('no slice');
  return { slice, spacing: spaceItems(slice.items, slice.startIndex) };
}

const eighths = (...n: readonly number[]): Rational[] => n.map((k) => (k === 0 ? ZERO : fromParts(k, 8)));
const kinds = (slice: MeasureSlice): string[] => slice.items.map((item) => item.event.kind);
const widthsOf = (spacing: MeasureSpacing): number[] => spacing.slots.map((s) => s.slot.width);

function box(partial: Partial<ExternalMeasureBox> & { readonly timeline?: ExternalTimeline }): ExternalMeasureBox {
  return { systemIndex: 0, x: 0, width: 400, contentOffsetX: 0, participation: [], ...partial };
}

const system = (index: number, y = 0, width = 400, height = 50): System => ({ index, box: { origin: { x: 0, y }, width, height } });

function twoVoiceIds(): readonly [VoiceId, VoiceId] {
  const voices = matrixScoreFrom(['X:1', 'L:1/8', 'V:1 style=jianpu', 'V:2 style=jianpu', 'K:C', '[V:1]C|', '[V:2]C|', ''].join('\n')).renderScore.voices;
  const [first, second] = voices;
  if (first === undefined || second === undefined) throw new Error('need two voices');
  return [first.voiceId, second.voiceId];
}

describe('T5-0 映射 —— 按 voiceId + localMeasureIndex，不按数组下标（B / C）', () => {
  const slices = splitMeasures(voiceOf('C D|E F|G A|').items);
  const [voiceId, other] = twoVoiceIds();
  const at = (local: number, systemIndex: number, x: number): ExternalMeasureBox =>
    box({ systemIndex, x, participation: [{ voiceId: other, kind: 'present', localMeasureIndex: 9 }, { voiceId, kind: 'present', localMeasureIndex: local }] });

  it('乱序给出的框按 localMeasureIndex 归位；其它声部与 absent 项被忽略', () => {
    const boxes = [at(2, 7, 30), box({ systemIndex: 7, participation: [{ voiceId, kind: 'absent' }] }), at(0, 5, 10), at(1, 5, 20)];
    const mapped = mapExternalMeasures(voiceId, slices, { measures: boxes, systems: [system(7), system(5), system(6)] });
    expect([0, 1, 2].map((i) => mapped.byLocal.get(i)?.x)).toEqual([10, 20, 30]);
    expect(mapped.systems.map((s) => s.index)).toEqual([5, 6, 7]);
    expect(mapped.systemByIndex.get(6)).toBe(mapped.systems[1]);
  });

  it.each([
    ['缺一个 local measure', [at(0, 5, 0), at(1, 5, 0)], [system(5)]],
    ['local 重复', [at(0, 5, 0), at(1, 5, 0), at(1, 5, 0), at(2, 5, 0)], [system(5)]],
    ['local 越界', [at(0, 5, 0), at(1, 5, 0), at(2, 5, 0), at(3, 5, 0)], [system(5)]],
    ['systemIndex 不在 systems 中', [at(0, 5, 0), at(1, 5, 0), at(2, 9, 0)], [system(5)]],
    ['system index 重复', [at(0, 5, 0), at(1, 5, 0), at(2, 5, 0)], [system(5), system(5)]],
    ['system index 非整数', [at(0, 5, 0), at(1, 5, 0), at(2, 5, 0)], [system(5), system(5.5)]],
    ['system box 含 NaN', [at(0, 5, 0), at(1, 5, 0), at(2, 5, 0)], [{ index: 5, box: { origin: { x: Number.NaN, y: 0 }, width: 400, height: 50 } }]],
    ['system box 宽为负', [at(0, 5, 0), at(1, 5, 0), at(2, 5, 0)], [system(5, 0, -1)]],
  ] as const)('%s → RangeError', (_label, measures, systems) => {
    expect(() => mapExternalMeasures(voiceId, slices, { measures, systems })).toThrow(RangeError);
  });

  it('同一框里本声部出现两次、incompatible 带 timeline、数值非法 → RangeError', () => {
    const ok = [at(1, 5, 0), at(2, 5, 0)];
    const run = (first: ExternalMeasureBox): unknown => mapExternalMeasures(voiceId, slices, { measures: [first, ...ok], systems: [system(5)] });
    const timeline: ExternalTimeline = { offsets: eighths(0, 1), total: fromParts(1, 4), xByOffsetIndex: [0, 20], endX: 40 };
    expect(() => run(box({ systemIndex: 5, participation: [{ voiceId, kind: 'present', localMeasureIndex: 0 }, { voiceId, kind: 'absent' }] }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline, participation: [{ voiceId, kind: 'incompatible', localMeasureIndex: 0 }] }))).toThrow(RangeError);
    const own = [{ voiceId, kind: 'present', localMeasureIndex: 0 }] as const;
    expect(() => run(box({ systemIndex: 5, contentOffsetX: -1, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, width: Number.NaN, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline: { ...timeline, xByOffsetIndex: [0] }, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline: { ...timeline, xByOffsetIndex: [30, 20] }, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, width: 30, timeline, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, contentOffsetX: 10, timeline, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline: { ...timeline, endX: 10 }, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline: { ...timeline, offsets: eighths(1, 1) }, participation: own }))).toThrow(RangeError);
    expect(() => run(box({ systemIndex: 5, timeline: { ...timeline, offsets: eighths(1, 0) }, participation: own }))).toThrow(RangeError);
    expect(run(box({ systemIndex: 5, timeline, participation: own }))).toBeDefined();
  });
});

describe('T5-0 shared 摆放 —— E-c：untimed 保原宽右贴下一锚点，timed 钉在 timeline x', () => {
  const { slice, spacing } = measureOf('!trill!C "Am"D {g}E F|');
  const w = widthsOf(spacing);
  const timeline: ExternalTimeline = { offsets: eighths(0, 1, 2, 3), total: fromParts(1, 2), xByOffsetIndex: [40, 120, 200, 280], endX: 360 };

  it('切片形态：decoration note chordSymbol note grace note note barline', () => {
    expect(kinds(slice)).toEqual(['decoration', 'note', 'chordSymbol', 'note', 'grace', 'note', 'note', 'barline']);
  });

  it('timed x 恰为 xByOffsetIndex；lead / 段中 untimed 右贴；chordSymbol 落在后续 onset；barline 在 endX', () => {
    const placed = placeExternalMeasure(slice, spacing, box({ timeline }));
    const xs = placed.map((s) => s.slot.x);
    expect([xs[1], xs[3], xs[5], xs[6]]).toEqual([40, 120, 200, 280]);
    expect(xs[0]).toBe(40 - (w[0] ?? 0));
    expect(xs[2]).toBe(120);
    expect(xs[4]).toBe(200 - (w[4] ?? 0));
    expect(xs[7]).toBe(360);
    expect(placed.map((s) => s.slot.width)).toEqual([w[0], 80, 0, (xs[4] ?? 0) - 120, w[4], 80, 80, 40]);
  });

  it('decoration / grace 不与所属音符同 x（防重叠）；全部单调、首尾相接、落在 measure 内', () => {
    const placed = placeExternalMeasure(slice, spacing, box({ timeline }));
    expect(placed[0]?.slot.x).not.toBe(placed[1]?.slot.x);
    expect(placed[4]?.slot.x).not.toBe(placed[5]?.slot.x);
    placed.forEach((s, i) => {
      expect(s.slot.width).toBeGreaterThanOrEqual(0);
      const next = placed[i + 1];
      if (next !== undefined && i > 0) expect(s.slot.x + s.slot.width).toBe(next.slot.x);
    });
    expect((placed[7]?.slot.x ?? 0) + (placed[7]?.slot.width ?? 0)).toBe(400);
  });

  it('产出是新对象：slot.index / widthKind 原样，原 spacing 不被修改（额外裁决 7）', () => {
    const before = JSON.stringify(spacing);
    const placed = placeExternalMeasure(slice, spacing, box({ timeline }));
    expect(JSON.stringify(spacing)).toBe(before);
    placed.forEach((s, i) => {
      expect(s).not.toBe(spacing.slots[i]);
      expect(s.slot).not.toBe(spacing.slots[i]?.slot);
      expect(s.slot.index).toBe(spacing.slots[i]?.slot.index);
      expect(s.widthKind).toBe(spacing.slots[i]?.widthKind);
    });
  });

  it('行首 contentOffsetX：lead 段仍右贴首个 onset，且不早于 contentOffsetX', () => {
    const shifted: ExternalTimeline = { ...timeline, xByOffsetIndex: [70, 150, 230, 310], endX: 360 };
    const placed = placeExternalMeasure(slice, spacing, box({ contentOffsetX: 50, timeline: shifted }));
    expect(placed[1]?.slot.x).toBe(70);
    expect(placed[0]?.slot.x).toBe(70 - (w[0] ?? 0));
    expect(placed[0]?.slot.x).toBeGreaterThanOrEqual(50);
  });

  it('同 onset 的后续零时值 timed 从锚点起保原宽向右排（左簇），其余 untimed 仍右贴', () => {
    const m = measureOf('C {g}C0 !trill!D E|');
    expect(kinds(m.slice)).toEqual(['note', 'grace', 'note', 'decoration', 'note', 'note', 'barline']);
    const mw = widthsOf(m.spacing);
    const tl: ExternalTimeline = { offsets: eighths(0, 1, 2), total: fromParts(3, 8), xByOffsetIndex: [0, 100, 200], endX: 300 };
    const xs = placeExternalMeasure(m.slice, m.spacing, box({ timeline: tl })).map((s) => s.slot.x);
    expect(xs[1]).toBe(100 - (mw[1] ?? 0));
    expect(xs[2]).toBe(100);
    expect(xs[3]).toBe(100 + (mw[2] ?? 0));
    expect(xs[4]).toBe(100 + (mw[2] ?? 0) + (mw[3] ?? 0));
    expect(xs[5]).toBe(200);
    expect(xs[6]).toBe(300);
  });

  it('左右簇相交（段内原宽 > 公共区间）、onset 不在 offsets、total 不等、尾 barline 放不下 → RangeError', () => {
    const narrow: ExternalTimeline = { ...timeline, xByOffsetIndex: [40, 41, 200, 280] };
    expect(() => placeExternalMeasure(slice, spacing, box({ timeline: narrow }))).toThrow(RangeError);
    expect(() => placeExternalMeasure(slice, spacing, box({ timeline: { ...timeline, offsets: eighths(0, 1, 2, 5) } }))).toThrow(RangeError);
    expect(() => placeExternalMeasure(slice, spacing, box({ timeline: { ...timeline, total: fromParts(5, 8) } }))).toThrow(RangeError);
    expect(() => placeExternalMeasure(slice, spacing, box({ width: 365, timeline }))).toThrow(RangeError);
    const lead: ExternalTimeline = { ...timeline, xByOffsetIndex: [1, 120, 200, 280] };
    expect(() => placeExternalMeasure(slice, spacing, box({ timeline: lead }))).toThrow(RangeError);
  });
});

describe('T5-0 零 timed shared（J，跟随 E-c）', () => {
  const zeroTimeline = (endX: number): ExternalTimeline => ({ offsets: [], total: ZERO, xByOffsetIndex: [], endX });

  it.each([
    ['barline-only', '|C|', 0, ['barline']],
    ['decoration + barline', '!trill!|', 0, ['decoration', 'barline']],
    ['grace / unknown + barline', '{g}&x&|', 0, ['grace', 'unknown', 'unknown', 'unknown', 'barline']],
    ['chordSymbol-only，无尾 barline', 'C|"Am"', 1, ['chordSymbol']],
  ] as const)('%s：非尾项保原宽右贴 endX，尾 barline 在 endX', (_label, body, index, expected) => {
    const m = measureOf(body, index);
    expect(kinds(m.slice)).toEqual(expected);
    const placed = placeExternalMeasure(m.slice, m.spacing, box({ contentOffsetX: 10, timeline: zeroTimeline(150) }));
    const last = m.slice.items.length - 1;
    const tail = m.slice.items[last]?.event.kind === 'barline';
    let suffix = 0;
    for (let j = (tail ? last : last + 1) - 1; j >= 0; j -= 1) {
      suffix += m.spacing.slots[j]?.slot.width ?? 0;
      expect(placed[j]?.slot.x).toBe(150 - suffix);
      expect(placed[j]?.slot.x).toBeGreaterThanOrEqual(10);
    }
    if (tail) expect(placed[last]?.slot).toEqual({ index: m.spacing.slots[last]?.slot.index, x: 150, width: 250 });
  });

  it('无尾 barline 的有 timed measure：末项止于 endX，不越过', () => {
    const m = measureOf('C|D E', 1);
    expect(kinds(m.slice)).toEqual(['note', 'note']);
    const placed = placeExternalMeasure(m.slice, m.spacing, box({ timeline: { offsets: eighths(0, 1), total: fromParts(1, 4), xByOffsetIndex: [0, 50], endX: 120 } }));
    expect(placed.map((s) => [s.slot.x, s.slot.width])).toEqual([[0, 50], [50, 70]]);
  });
});

describe('T5-0 tier 3 摆放 —— F-d', () => {
  const { slice, spacing } = measureOf('C D E2|');
  const w = widthsOf(spacing);
  const tailW = w[3] ?? 0;
  const bodyRaw = spacing.slots[3]?.slot.x ?? 0;

  it('非尾项按本声部比例拉满 contentOffsetX → width − 尾宽；尾 barline 保原宽钉右；timeline 缺席即不读', () => {
    const b = box({ width: 30 + 2 * spacing.width, contentOffsetX: 30 });
    const placed = placeExternalMeasure(slice, spacing, b);
    const scale = (b.width - tailW - 30) / bodyRaw;
    expect(scale).toBeGreaterThan(1);
    [0, 1, 2].forEach((j) => expect(placed[j]?.slot.x).toBe(30 + (spacing.slots[j]?.slot.x ?? 0) * scale));
    expect(placed[3]?.slot).toEqual({ index: spacing.slots[3]?.slot.index, x: b.width - tailW, width: tailW });
    expect((placed[2]?.slot.x ?? 0) + (placed[2]?.slot.width ?? 0)).toBe(b.width - tailW);
  });

  it('bodyRaw = 0（只有零宽 chordSymbol + barline）不除零：内容落在 contentOffsetX，宽 0', () => {
    const m = measureOf('"Am"|');
    const placed = placeExternalMeasure(m.slice, m.spacing, box({ width: 100, contentOffsetX: 20 }));
    const tw = m.spacing.slots[1]?.slot.width ?? 0;
    expect(placed.map((s) => [s.slot.x, s.slot.width])).toEqual([[20, 0], [100 - tw, tw]]);
  });

  it('本声部原宽大于公共内容宽（scale < 1）→ RangeError', () => {
    expect(() => placeExternalMeasure(slice, spacing, box({ width: spacing.width + 9, contentOffsetX: 10 }))).toThrow(RangeError);
    expect(placeExternalMeasure(slice, spacing, box({ width: spacing.width + 10, contentOffsetX: 10 }))).toHaveLength(4);
  });
});

describe('T5-0 max extent（I）', () => {
  it('不依赖数组顺序与「最后一项」；没有 system 时为 undefined', () => {
    const systems = [system(3, 500, 200, 40), system(1, 0, 300, 60), system(2, 900, 100, 10)];
    expect(externalExtent(systems)).toEqual({ width: 300, height: 910 });
    expect(externalExtent([system(2, 900, 100, 10), system(1, 0, 300, 960)])).toEqual({ width: 300, height: 960 });
    // 最后一项既不是最低、也不是最宽：取「最后一项」的实现在这里必然算错。
    expect(externalExtent([system(1, 900, 400, 10), system(2, 0, 100, 60)])).toEqual({ width: 400, height: 910 });
    expect(externalExtent([])).toBeUndefined();
  });
});
