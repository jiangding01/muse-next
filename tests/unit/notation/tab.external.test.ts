/**
 * M2.5 T5-2 —— TAB external 路径（用户裁决 A–P + 额外裁决 1–9）。
 *
 * 与简谱同构（共用 `layout/measurePlacement.ts`），这里另外钉住 TAB 特有的三件事：弦线只覆盖本声部真实
 * measure 的范围（G-2a）、最深时值装饰在 external 模式下不补高（H-a）、关系 / stroke / beam 消费 external 节点。
 */
import { describe, expect, it } from 'vitest';

import { equals } from '../../../src/domain';
import { voiceMeasureOnsets } from '../../../src/notation/layout/measureOnsets';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabContext, TabLayout } from '../../../src/notation/tab/layoutTab';
import type { SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import type { ExternalInput } from './systemExternal.helpers';
import { SYSTEM_HEIGHT, composed, externalFor, externalMeasurer, scoreOf, screen, voiceAt } from './systemExternal.helpers';

const TAB = '"Am"Va0 [a0b1] {d8-S-}d10 a5-S-a7 a1 a2 a3|a0/4 a1/4 a2/4 a3/4 a0 a1 a2 a3 a4 a5 a6|a0 a1 a2 a3 a4 a5 a6 a7-S-|a9 a1 a2 a3 a4 a5 a6 a7|';
const source = scoreOf([['jianpu', 'C D E F G A B c|'.repeat(5)], ['tab', TAB]]);
const render = source.renderScore;
const tab = voiceAt(render, 1);

function ctx(availableWidth: number, external?: ExternalInput): TabContext {
  const base = { index: source.index, measurer: externalMeasurer, availableWidth, ...(source.score.meter === undefined ? {} : { meter: source.score.meter }) };
  return external === undefined ? base : { ...base, external };
}
const defaultLayout = (availableWidth: number): TabLayout => layoutTab(tab, ctx(availableWidth));
const externalLayout = (external: ExternalInput): TabLayout => layoutTab(tab, ctx(960, external));

function ownGeometry(input: ExternalInput, local: number): SystemMeasureGeometry | undefined {
  return input.measures.find((m) => m.participation.some((p) => p.voiceId === tab.voiceId && p.kind !== 'absent' && p.localMeasureIndex === local));
}

describe('T5-2 TAB external —— 公共 timeline 与公共边界', () => {
  it.each([['960', 960], ['narrow', 16]] as const)('%s：timed x === geometry.x + xByOffsetIndex[k]，收尾 barline === geometry.x + endX', (_label, width) => {
    const input = externalFor(composed(render, screen(width)), tab.voiceId);
    const layout = externalLayout(input);
    const nodeOf = new Map(layout.nodes.map((node) => [node.anchor.kind === 'event' ? node.anchor.eventId : '', node]));
    let checked = 0;
    for (const slice of splitMeasures(tab.items)) {
      const g = ownGeometry(input, slice.index);
      const timeline = g?.timeline;
      if (g === undefined || timeline === undefined) continue;
      const onsets = voiceMeasureOnsets(slice);
      if (!onsets.resolved) throw new Error('unresolved');
      for (const timed of onsets.timed) {
        const k = timeline.offsets.findIndex((o) => equals(o, timed.onset));
        expect(nodeOf.get(slice.items[timed.itemIndex]?.eventId ?? '')?.x).toBe(g.x + (timeline.xByOffsetIndex[k] ?? Number.NaN));
        checked += 1;
      }
      const last = slice.items[slice.items.length - 1];
      if (last?.event.kind === 'barline') expect(nodeOf.get(last.eventId)?.x).toBe(g.x + timeline.endX);
    }
    expect(checked).toBe(35);
  });

  it('grace 不与所属音符同 x；chordSymbol 与其后续 onset 同 x', () => {
    const layout = externalLayout(externalFor(composed(render), tab.voiceId));
    const [chord, first, , grace, target] = layout.nodes;
    expect([chord?.kind, grace?.kind]).toEqual(['chordSymbol', 'grace']);
    expect(chord?.x).toBe(first?.x);
    expect(grace?.x).toBeLessThan(target?.x ?? 0);
  });
});

describe('T5-2 TAB external —— 与默认路径的不变量（节点 / 诊断 / beam / 关系 / stroke）', () => {
  const plain = defaultLayout(16);
  const external = externalLayout(externalFor(composed(render, screen(16)), tab.voiceId));
  const eventKey = (n: TabLayout['nodes'][number]): string => (n.anchor.kind === 'event' ? n.anchor.eventId : '');

  it('measures 逐字段相等；节点数 / 种类 / anchor / fallback 相等；诊断相等', () => {
    expect(external.measures).toEqual(plain.measures);
    expect(external.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex, n.slotIndex])).toEqual(plain.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex, n.slotIndex]));
    expect(external.diagnostics).toEqual(plain.diagnostics);
  });

  it('beam 归属不变；stroke 跟随 external 节点 x', () => {
    expect(external.beams.map((b) => [b.measureIndex, b.eventIds])).toEqual(plain.beams.map((b) => [b.measureIndex, b.eventIds]));
    expect(external.strokes).toHaveLength(1);
    const target = external.nodes.find((n) => n.anchor.kind === 'event' && external.strokes[0]?.anchor.kind === 'event' && n.anchor.eventId === external.strokes[0].anchor.eventId);
    expect(external.strokes[0]?.text.x).toBe(target?.x);
  });

  it('关系连线（含跨行 slide）段数 / 行谱与默认一致，端点来自 external 节点', () => {
    expect(external.relations.map((r) => [r.kind, r.systemIndex])).toEqual(plain.relations.map((r) => [r.kind, r.systemIndex]));
    // a5-S-a7（第 0 小节第 5、6 列）：线段相对两端节点的偏移与默认路径完全相同，只随节点整体平移。
    const offsets = (layout: TabLayout): number[] => {
      const from = layout.nodes.find((n) => n.measureIndex === 0 && n.slotIndex === 5);
      const to = layout.nodes.find((n) => n.measureIndex === 0 && n.slotIndex === 6);
      const line = layout.relations.find((r) => r.segment === 'whole' && r.x1 > (from?.x ?? 0) && r.x2 <= (to?.x ?? 0));
      return [(line?.x1 ?? Number.NaN) - (from?.x ?? 0), (to?.x ?? 0) - (line?.x2 ?? Number.NaN)];
    };
    expect(offsets(external)).toEqual(offsets(plain));
    expect(offsets(external).every((v) => Number.isFinite(v) && v > 0)).toBe(true);
    expect(new Set(external.nodes.map(eventKey)).size).toBe(external.nodes.length);
  });
});

describe('T5-2 TAB external —— systemIndex / 弦线 / 高度（C / G-2a / H-a / I）', () => {
  const out = composed(render, screen(16));
  const plainInput = externalFor(out, tab.voiceId);
  const sparse = externalFor(out, tab.voiceId, { relabel: (i) => 3 + 10 * i, reverse: true });
  const base = externalLayout(plainInput);
  const layout = externalLayout(sparse);

  it('全局稀疏 index 原样保留、按 index 升序返回、对象原样；节点 y 由同 index 的行谱决定', () => {
    expect(layout.systems.map((s) => s.index)).toEqual([3, 13, 23, 33, 43]);
    layout.systems.forEach((system) => expect(sparse.systems).toContain(system));
    const byIndex = new Map(layout.systems.map((s) => [s.index, s]));
    for (const node of layout.nodes) {
      expect(node.systemIndex).toBe(3 + 10 * (base.nodes[layout.nodes.indexOf(node)]?.systemIndex ?? Number.NaN));
      const top = byIndex.get(node.systemIndex)?.box.origin.y ?? Number.NaN;
      expect(node.y).toBeGreaterThanOrEqual(top);
      expect(node.y).toBeLessThanOrEqual(top + SYSTEM_HEIGHT);
    }
    expect(layout.nodes.map((n) => [n.x, n.y - (byIndex.get(n.systemIndex)?.box.origin.y ?? 0)])).toEqual(
      base.nodes.map((n) => [n.x, n.y - (base.systems.find((s) => s.index === n.systemIndex)?.box.origin.y ?? 0)]),
    );
    expect(layout.relations.map((r) => r.systemIndex)).toEqual(base.relations.map((r) => 3 + 10 * r.systemIndex));
  });

  it('最深时值装饰在 external 模式下不补高（默认路径会补）', () => {
    expect(defaultLayout(16).systems.some((s) => s.box.height > TAB_METRICS.systemHeight)).toBe(true);
    expect(layout.systems.every((s) => s.box.height === SYSTEM_HEIGHT)).toBe(true);
  });

  it('G-2a：弦线只覆盖本声部真实 measure 的范围；本声部没有 measure 的行谱不画弦线', () => {
    expect(layout.staffLines.map((l) => l.systemIndex)).toEqual([3, 13, 23, 33]);
    expect(layout.systems.map((s) => s.index)).toContain(43);
    for (const lines of layout.staffLines) {
      const own = sparse.measures.filter((m) => m.systemIndex === lines.systemIndex && m.participation.some((p) => p.voiceId === tab.voiceId && p.kind !== 'absent'));
      const left = Math.min(...own.map((m) => m.x));
      const right = Math.max(...own.map((m) => m.x + m.width));
      expect(lines.lines.every((line) => line.x1 === left && line.x2 === right)).toBe(true);
    }
  });

  it('absent 不造 measure；宽高取最大外沿', () => {
    expect(layout.measures).toHaveLength(4);
    expect(layout.width).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.x + s.box.width)));
    expect(layout.height).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.y + s.box.height)));
  });
});

describe('T5-2 TAB external —— origin.x ≠ 0、y 随 index 递减（review M1）', () => {
  const input = externalFor(composed(render, screen(16)), tab.voiceId, { originX: 37.5, flipY: true });
  const layout = externalLayout(input);

  it('节点 x === origin.x + geometry.x + slot.x；弦线从 origin.x + 本声部最左 measure 起', () => {
    layout.nodes.forEach((node, i) => {
      expect(node.x).toBe(37.5 + (ownGeometry(input, node.measureIndex)?.x ?? Number.NaN) + (layout.slots[i]?.slot.x ?? Number.NaN));
    });
    expect(layout.staffLines.length).toBe(4);
    for (const lines of layout.staffLines) {
      const own = input.measures.filter((m) => m.systemIndex === lines.systemIndex && m.participation.some((p) => p.voiceId === tab.voiceId && p.kind !== 'absent'));
      const left = 37.5 + Math.min(...own.map((m) => m.x));
      const right = 37.5 + Math.max(...own.map((m) => m.x + m.width));
      expect(lines.lines.every((line) => line.x1 === left && line.x2 === right)).toBe(true);
    }
  });

  it('宽含 origin.x；高取最低的行谱，而它不是按 index 排序后的最后一项', () => {
    expect(layout.width).toBe(37.5 + Math.max(...input.systems.map((s) => s.box.width)));
    expect(layout.systems[layout.systems.length - 1]?.box.origin.y).toBe(0);
    expect(layout.height).toBe(Math.max(...input.systems.map((s) => s.box.origin.y + s.box.height)));
  });
});

describe('T5-2 TAB external —— 非法输入一律 RangeError（A2 / 额外裁决 4）', () => {
  const input = externalFor(composed(render), tab.voiceId);
  it('少一个本声部 measure / 少一个 system / 混入另一套 system index → RangeError', () => {
    expect(() => externalLayout({ ...input, measures: input.measures.slice(1) })).toThrow(RangeError);
    expect(() => externalLayout({ ...input, systems: [] })).toThrow(RangeError);
    expect(() => externalLayout({ ...input, systems: input.systems.map((s) => ({ ...s, index: s.index + 1 })) })).toThrow(RangeError);
  });
});
