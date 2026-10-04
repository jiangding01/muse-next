/**
 * M2.5 T3.5 —— TAB beam 刻印（`tab/tabBeams.ts` + `layoutTab` 接入）。
 *
 * 覆盖：符干 / 横梁几何（Q8-a）、F-10 层级落几何（Q7-a）、C1（组不进 nodes、节点同长同序同 anchor）、
 * 组成员免逐音减时线宽度项与组级等距（Q11）、行高不变、raw / 缺席 / tuplet / 不可知时值不分组。
 */
import { describe, expect, it } from 'vitest';

import type { Meter } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { spaceItems } from '../../../src/notation/layout/spacing';
import type { MeasureSpacing } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabLayout } from '../../../src/notation/tab/layoutTab';
import { engraveTabBeams, planTabBeams, tabMeasureSpacing } from '../../../src/notation/tab/tabBeams';
import { stringY } from '../../../src/notation/tab/tabGlyphs';
import type { TabNode } from '../../../src/notation/tab/tabGlyphs';
import { widenForTabGlyphs } from '../../../src/notation/tab/tabSlotWidths';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100_000;

function prepare(body: string, meterLine = 'M:4/4'): { readonly voice: RenderVoice; readonly meter: Meter | undefined; readonly index: ReturnType<typeof loadJcx>['index'] } {
  const loaded = loadJcx(['%MUSE2', 'X:1', ...(meterLine === '' ? [] : [meterLine]), 'L:1/4', 'K:C', 'V:1 style=tab', body, ''].join('\n'));
  const voice = buildRenderScore({ score: loaded.score, index: loaded.index }).voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return { voice, meter: loaded.score.meter, index: loaded.index };
}

/** 同一输入两份：带 `M:` 的 meter（`beamed`）与不传 meter（改造前路径，`plain`）。 */
function both(body: string, meterLine = 'M:4/4', availableWidth = WIDE): { readonly beamed: TabLayout; readonly plain: TabLayout } {
  const { voice, meter, index } = prepare(body, meterLine);
  const plain = layoutTab(voice, { index, measurer, availableWidth });
  const beamed = layoutTab(voice, { index, measurer, availableWidth, ...(meter === undefined ? {} : { meter }) });
  return { beamed, plain };
}

const durationNodes = (layout: TabLayout): Extract<TabNode, { kind: 'tabNote' | 'tabGroup' }>[] =>
  layout.nodes.flatMap((node) => (node.kind === 'tabNote' || node.kind === 'tabGroup' ? [node] : []));

function primaryY(staffTop: number, maxBeams: number): number {
  return stringY(staffTop, 6) + TAB_METRICS.stemOffsetY + TAB_METRICS.stemLength + TAB_METRICS.beamFirstOffset + (maxBeams - 1) * TAB_METRICS.beamGap;
}

describe('T3.5 TAB —— 组与 C1', () => {
  it('4/4 下 4 个八分 → 2 组；beams 不进 nodes：节点同长、同序、同 anchor、同 x / y / width', () => {
    const { beamed, plain } = both('a0/ a1/ a2/ a3/ |');
    expect(beamed.beams.map((group) => group.eventIds.length)).toEqual([2, 2]);
    expect(beamed.nodes.length).toBe(plain.nodes.length);
    expect(beamed.nodes.map((n) => [n.kind, n.anchor, n.x, n.y, n.width, n.slotIndex, n.fallback])).toEqual(
      plain.nodes.map((n) => [n.kind, n.anchor, n.x, n.y, n.width, n.slotIndex, n.fallback]),
    );
    expect(plain.beams).toEqual([]);
  });

  it('组成员：符干从原 stemTop 延到主梁、底端共线；逐音减时线清空；附点与其它字段不变', () => {
    const { beamed, plain } = both('a0/ a1/ a2 |');
    const [n0, n1, n2] = durationNodes(beamed);
    const [p0, , p2] = durationNodes(plain);
    if (n0 === undefined || n1 === undefined || n2 === undefined || p0 === undefined || p2 === undefined) throw new Error('nodes');
    const y = primaryY(n0.y, 1);
    expect([n0.duration.stem?.y2, n1.duration.stem?.y2]).toEqual([y, y]);
    expect(n0.duration.stem?.y1).toBe(p0.duration.stem?.y1);
    expect([n0.duration.beams, n1.duration.beams]).toEqual([[], []]);
    expect(n0.duration.augmentationDots).toEqual(p0.duration.augmentationDots);
    // 主梁 y 恰好等于逐音画法下那条减时线的 y。
    expect(p0.duration.beams[0]?.y1).toBe(y);
    // 组外四分音符逐字段不变。
    expect(n2).toEqual(p2);
  });

  it('同时值组：一条主梁从组首 x 到组末 x；粗细 metric = 1.4', () => {
    const { beamed } = both('a0/ a1/ |');
    const [n0, n1] = durationNodes(beamed);
    expect(beamed.beams[0]?.lines).toEqual([
      { level: 1, kind: 'span', segment: { x1: n0?.x, y1: primaryY(n0?.y ?? 0, 1), x2: n1?.x, y2: primaryY(n0?.y ?? 0, 1) } },
    ]);
    expect(beamed.beams[0]?.equalSpacing).toBe(true);
    expect(TAB_METRICS.beamThickness).toBe(1.4);
  });

  it('八分 + 十六分 + 十六分：主梁在最深位置，十六分之间的 secondary 横梁朝谱线上移一个 beamGap', () => {
    const { beamed } = both('a0/ a1// a2// a3/ |');
    const nodes = durationNodes(beamed);
    const y = primaryY(nodes[0]?.y ?? 0, 2);
    expect(beamed.beams[0]?.lines.map((line) => [line.level, line.kind, line.segment.x1, line.segment.x2, line.segment.y1])).toEqual([
      [1, 'span', nodes[0]?.x, nodes[2]?.x, y],
      [2, 'span', nodes[1]?.x, nodes[2]?.x, y - TAB_METRICS.beamGap],
    ]);
    expect(nodes.slice(0, 3).map((n) => n.duration.stem?.y2)).toEqual([y, y, y]);
    expect(beamed.beams[0]?.equalSpacing).toBe(false);
  });

  it('beamlet：组首十六分向右、其余孤立十六分向左，长度 = beamLength', () => {
    // 八分 + 十六分：十六分是组末孤立的第 2 层 → 向左；相邻两个十六分则是 secondary span（不是 beamlet）。
    const left = both('a0/ a1// |').beamed;
    const leftNodes = durationNodes(left);
    expect(left.beams[0]?.lines.at(-1)).toEqual({
      level: 2, kind: 'beamlet',
      segment: { x1: (leftNodes[1]?.x ?? 0) - TAB_METRICS.beamLength, y1: primaryY(leftNodes[0]?.y ?? 0, 2) - TAB_METRICS.beamGap, x2: leftNodes[1]?.x, y2: primaryY(leftNodes[0]?.y ?? 0, 2) - TAB_METRICS.beamGap },
    });
    expect(both('a0/ a1// a2// |').beamed.beams[0]?.lines.at(-1)).toMatchObject({ level: 2, kind: 'span' });
    const right = both('a0// a1/ a2// |').beamed;
    const nodes = durationNodes(right);
    const [first, second] = right.beams[0]?.lines.filter((line) => line.kind === 'beamlet') ?? [];
    const y2 = primaryY(nodes[0]?.y ?? 0, 2) - TAB_METRICS.beamGap;
    expect(first?.segment).toEqual({ x1: nodes[0]?.x, y1: y2, x2: (nodes[0]?.x ?? 0) + TAB_METRICS.beamLength, y2 });
    expect(second?.segment).toEqual({ x1: (nodes[2]?.x ?? 0) - TAB_METRICS.beamLength, y1: y2, x2: nodes[2]?.x, y2 });
    expect(leftNodes.length).toBe(2);
  });

  it('tabGroup（和弦）照常入组；休止断组', () => {
    expect(both('[a0/b1/] a2/ |').beamed.beams.map((group) => group.eventIds.length)).toEqual([2]);
    expect(both('a0/ z/ a2/ a3/ |').beamed.beams.map((group) => group.eventIds.length)).toEqual([2]);
  });

  it('行高不变：组的最深横梁与逐音画法同深', () => {
    for (const body of ['a0/ a1/ |', 'a0// a1// a2// a3// |', 'a0/4 a1/4 a2/ |']) {
      const { beamed, plain } = both(body, 'M:4/4', 16);
      expect(beamed.systems).toEqual(plain.systems);
      expect(beamed.height).toBe(plain.height);
    }
  });
});

describe('T3.5 TAB —— 宽度（Q11）', () => {
  it('同时值组品位宽度不一：前三个十六分的列只加宽到组内最大 gap，末成员列不动；measure 变宽只因等距', () => {
    const { beamed, plain } = both('a12// a3// a5// a7// |');
    const w = (layout: TabLayout): number[] => layout.slots.map((slot) => slot.slot.width);
    const max = w(plain)[0] ?? 0;
    expect(max).toBeGreaterThan(12);
    expect(w(beamed).slice(0, 4)).toEqual([max, max, max, w(plain)[3]]);
    expect(beamed.width).toBeGreaterThan(plain.width);
  });

  it('品位宽度一致的同时值组与不同时值组：列宽与改造前完全相同', () => {
    for (const body of ['a0/ a1/ a2/ a3/ |', 'a0/ a1// a2// a3/4 a4/4 |']) {
      const { beamed, plain } = both(body);
      expect(beamed.slots).toEqual(plain.slots);
    }
  });

  it('组成员免逐音减时线宽度项：列宽被压到 1 时，入组八分只要品位宽，未入组八分仍要 beamLength + beamGap', () => {
    const { voice } = prepare('a0/ a1/ |');
    const slice = splitMeasures(voice.items)[0];
    if (slice === undefined) throw new Error('slice');
    const narrow: MeasureSpacing = {
      ...spaceItems(slice.items, slice.startIndex),
      slots: spaceItems(slice.items, slice.startIndex).slots.map((s) => ({ ...s, slot: { ...s.slot, width: 1 } })),
    };
    const fret = measurer.measure('0', { fontSize: TAB_METRICS.fretFontSize }).width + 2 * TAB_METRICS.fretPaddingX;
    expect(widenForTabGlyphs(narrow, slice.items, measurer).slots[0]?.slot.width).toBe(TAB_METRICS.beamLength + TAB_METRICS.beamGap);
    expect(widenForTabGlyphs(narrow, slice.items, measurer, new Set([0, 1])).slots[0]?.slot.width).toBe(fret);
  });

  it('附点成员免减时线项但保留附点延展', () => {
    const { voice } = prepare('a0*3/8 a1/8 |');
    const slice = splitMeasures(voice.items)[0];
    if (slice === undefined) throw new Error('slice');
    const narrow: MeasureSpacing = { ...spaceItems(slice.items, 0), slots: spaceItems(slice.items, 0).slots.map((s) => ({ ...s, slot: { ...s.slot, width: 1 } })) };
    const fret = measurer.measure('0', { fontSize: TAB_METRICS.fretFontSize }).width + 2 * TAB_METRICS.fretPaddingX;
    const dots = TAB_METRICS.augmentationDotOffsetX + TAB_METRICS.augmentationDotRadius + TAB_METRICS.dashGap;
    expect(widenForTabGlyphs(narrow, slice.items, measurer, new Set([0])).slots[0]?.slot.width).toBe(Math.max(fret, dots));
    expect(widenForTabGlyphs(narrow, slice.items, measurer).slots[0]?.slot.width).toBe(TAB_METRICS.beamLength + TAB_METRICS.beamGap);
  });

  it('tabMeasureSpacing：没有计划 / 没有组时就是改造前的 widenForTabGlyphs(spaceItems(...))', () => {
    const { voice, meter } = prepare('a0/ a1/ a2 |');
    const measures = splitMeasures(voice.items);
    const [slice] = measures;
    if (slice === undefined) throw new Error('slice');
    const legacy = widenForTabGlyphs(spaceItems(slice.items, slice.startIndex), slice.items, measurer);
    expect(tabMeasureSpacing(slice, undefined, measurer)).toEqual(legacy);
    expect(tabMeasureSpacing(slice, planTabBeams(measures, voice, { kind: 'raw', raw: 'C' })[0], measurer)).toEqual(legacy);
    expect(planTabBeams(measures, voice, meter)[0]?.groups.length).toBe(1);
  });
});

describe('T3.5 TAB —— 不分组的情形与确定性', () => {
  it('M:C / M:C| / 缺席 / 5/8：与不传 meter 的输出逐字段相同（beams = []）', () => {
    for (const meterLine of ['M:C', 'M:C|', '', 'M:5/8']) {
      const { beamed, plain } = both('a0/ a1/ a2/ a3/ |', meterLine);
      expect(beamed).toStrictEqual(plain);
    }
  });

  it('tuplet 所在 measure 不分组，其它 measure 照常', () => {
    expect(both('(3a0/ a1/ a2/ a3/ |a0/ a1/ |').beamed.beams.map((group) => group.measureIndex)).toEqual([1]);
  });

  it('不可知时值（duration undefined）所在 measure 不分组（该 measure 逐音画法不变），其它 measure 照常', () => {
    const { voice, meter, index } = prepare('a0/ a1/ |a2/ a3/ |');
    let patched = false;
    const items = voice.items.map((item) => {
      if (patched || item.event.kind !== 'tabNote') return item;
      patched = true;
      const { duration: _dropped, ...note } = item.event.note;
      return { ...item, event: { ...item.event, note } };
    });
    const broken = { ...voice, items };
    const withMeter = layoutTab(broken, { index, measurer, availableWidth: WIDE, ...(meter === undefined ? {} : { meter }) });
    const plain = layoutTab(broken, { index, measurer, availableWidth: WIDE });
    expect(withMeter.beams.map((group) => group.measureIndex)).toEqual([1]);
    expect(withMeter.nodes.slice(0, 3)).toEqual(plain.nodes.slice(0, 3));
  });

  it('组成员全部落在同一个 system，且等于组的 systemIndex（窄宽度强制每行一个 measure）', () => {
    const { beamed } = both('a0/ a1/ a2// a3// a4// a5// |a0/ a1/ a2/ a3/ |a0// a1// a2/ |', 'M:4/4', 16);
    expect(new Set(beamed.nodes.map((node) => node.systemIndex)).size).toBe(3);
    const systemOf = new Map(beamed.nodes.map((node) => [node.anchor.kind === 'event' ? node.anchor.eventId : '', node.systemIndex]));
    expect(beamed.beams.length).toBeGreaterThan(3);
    for (const group of beamed.beams) {
      expect(group.eventIds.map((id) => systemOf.get(id))).toEqual(group.eventIds.map(() => group.systemIndex));
    }
  });

  it('engraveTabBeams：没有任何组时原样返回同一个节点数组', () => {
    const { voice, index } = prepare('a0 a1 |');
    const layout = layoutTab(voice, { index, measurer, availableWidth: WIDE });
    const measures = splitMeasures(voice.items);
    expect(engraveTabBeams(layout.nodes, planTabBeams(measures, voice, undefined)).nodes).toBe(layout.nodes);
  });

  it('确定性：同输入两次逐字段相等', () => {
    expect(both('a0/ a1// a2// [a0/b1/] a3// a4// |').beamed).toEqual(both('a0/ a1// a2// [a0/b1/] a3// a4// |').beamed);
  });
});
