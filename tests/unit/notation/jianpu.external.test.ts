/**
 * M2.5 T5-1 —— 简谱 external 路径（用户裁决 A–P + 额外裁决 1–9）。
 *
 * 输入由测试侧 helper 从 T4 `composeSystemGeometry` 整理（生产编排归 T8）。断言：timed x 恰为公共 timeline、
 * 全局 / 稀疏 / 乱序 systemIndex 不被当下标、不 restack、空 system 保留、absent 不造 measure、
 * 节点 / anchor / 诊断 / beam 归属与默认路径一致、歌词兜底落在最小 index 的行谱、宽高取 max extent。
 */
import { describe, expect, it } from 'vitest';

import { equals } from '../../../src/domain';
import { arcSystemGeometries, buildArcSegments, legacyArcEndpointX } from '../../../src/notation/jianpu/jianpuArcs';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuContext, JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { voiceMeasureOnsets } from '../../../src/notation/layout/measureOnsets';
import { JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { splitMeasures } from '../../../src/notation/layout/systems';
import type { RenderVoice } from '../../../src/notation/model/types';
import type { SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import type { ExternalInput } from './systemExternal.helpers';
import { SYSTEM_HEIGHT, composed, externalFor, externalMeasurer, scoreOf, screen, voiceAt } from './systemExternal.helpers';

const JIANPU = '!trill!C "Am"D {g}E F G2 A2-|A2 B2 c4|"C"c d e f g a b c\'|C8|\nw: la li lo lu le';
const TAB = 'a0 a1 a2 a3 a4 a5 a6 a7 |'.repeat(5);
const source = scoreOf([['jianpu', JIANPU], ['tab', TAB]]);
const render = source.renderScore;
const jianpu = voiceAt(render, 0);

function ctx(external?: ExternalInput): JianpuContext {
  const base = { score: { ...(source.score.meter === undefined ? {} : { meter: source.score.meter }) }, index: source.index, measurer: externalMeasurer, availableWidth: 960 };
  return external === undefined ? base : { ...base, external };
}

const defaultLayout = (availableWidth = 960): JianpuLayout => layoutJianpu(jianpu, { ...ctx(), availableWidth });
const externalLayout = (external: ExternalInput, voice: RenderVoice = jianpu): JianpuLayout => layoutJianpu(voice, ctx(external));

function ownGeometry(input: ExternalInput, voice: RenderVoice, local: number): SystemMeasureGeometry | undefined {
  return input.measures.find((m) => m.participation.some((p) => p.voiceId === voice.voiceId && p.kind !== 'absent' && p.localMeasureIndex === local));
}

describe('T5-1 简谱 external —— 公共 timeline 与公共边界', () => {
  it.each([['960', 960], ['narrow', 16]] as const)('%s：timed x === geometry.x + xByOffsetIndex[k]，收尾 barline === geometry.x + endX', (_label, width) => {
    const input = externalFor(composed(render, screen(width)), jianpu.voiceId);
    const layout = externalLayout(input);
    const nodeOf = new Map(layout.nodes.map((node) => [node.anchor.kind === 'event' ? node.anchor.eventId : '', node]));
    let checked = 0;
    for (const slice of splitMeasures(jianpu.items)) {
      const g = ownGeometry(input, jianpu, slice.index);
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
    expect(checked).toBe(18);
  });

  it('decoration / grace 不与所属音符同 x；chordSymbol 与其后续 onset 同 x', () => {
    const layout = externalLayout(externalFor(composed(render), jianpu.voiceId));
    const [deco, c, chord, d, grace, e] = layout.nodes;
    expect([deco?.kind, chord?.kind, grace?.kind]).toEqual(['decoration', 'chordSymbol', 'grace']);
    expect(deco?.x).toBeLessThan(c?.x ?? 0);
    expect(grace?.x).toBeLessThan(e?.x ?? 0);
    expect(chord?.x).toBe(d?.x);
  });

  it('node.x / node.width 来自最终 slot（P）：width === slot.width，x === 所在 measure 左缘 + slot.x', () => {
    const input = externalFor(composed(render), jianpu.voiceId);
    const layout = externalLayout(input);
    expect(layout.slots).toHaveLength(layout.nodes.length);
    layout.nodes.forEach((node, i) => {
      const slot = layout.slots[i];
      expect(node.width).toBe(slot?.slot.width);
      const g = ownGeometry(input, jianpu, node.measureIndex);
      expect(node.x).toBe((g?.x ?? Number.NaN) + (slot?.slot.x ?? Number.NaN));
    });
  });
});

describe('T5-1 简谱 external —— 与默认路径的不变量（C1 / C2 / C3、beam、诊断）', () => {
  // 两边都用窄宽度：每个 measure 独占一行，默认换行与 T4 换行一致，跨行 tie 的段数可比。
  const plain = defaultLayout(16);
  const external = externalLayout(externalFor(composed(render, screen(16)), jianpu.voiceId));

  it('measures 逐字段相等；节点数 / 种类 / anchor / fallback 相等；诊断相等', () => {
    expect(external.measures).toEqual(plain.measures);
    expect(external.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex, n.slotIndex])).toEqual(plain.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex, n.slotIndex]));
    expect(external.diagnostics).toEqual(plain.diagnostics);
    expect(external.labels).toEqual(plain.labels);
  });

  it('beam 归属不变、不进 nodes；横梁跟随新的节点 x', () => {
    expect(plain.beams.length).toBeGreaterThan(0);
    expect(external.beams.map((b) => [b.measureIndex, b.eventIds, b.equalSpacing])).toEqual(plain.beams.map((b) => [b.measureIndex, b.eventIds, b.equalSpacing]));
    // 组横线左端 = 首成员 x − 数字视觉半宽（T3.5 Q10）：用 external 节点 x 精确复算，且与默认路径的 x 不同。
    const half = (JIANPU_METRICS.digitFontSize * JIANPU_METRICS.digitGlyphWidthRatio) / 2;
    const xOf = (layout: JianpuLayout): Map<string, number> => new Map(layout.nodes.map((n) => [n.anchor.kind === 'event' ? n.anchor.eventId : '', n.x]));
    const shifted = externalLayout(externalFor(composed(render, screen(16)), jianpu.voiceId, { originX: 37.5 }));
    const [ex, px] = [xOf(shifted), xOf(plain)];
    let moved = 0;
    for (const beam of shifted.beams) {
      const head = beam.eventIds[0] ?? '';
      expect(Math.min(...beam.lines.map((line) => line.segment.x1))).toBe((ex.get(head) ?? Number.NaN) - half);
      if (ex.get(head) !== px.get(head)) moved += 1;
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('跨行 tie 消费 external 节点：段数与默认相同，首段从 external 节点 x 出发（T9c.P D3：不是 x + glyphWidth/2）', () => {
    expect(plain.arcs.length).toBeGreaterThan(1);
    expect(external.arcs.map((a) => [a.kind, a.segment])).toEqual(plain.arcs.map((a) => [a.kind, a.segment]));
    const tied = external.nodes.find((n) => n.kind === 'note' && n.measureIndex === 0 && n.slotIndex === 8);
    expect(tied).toBeDefined();
    expect(external.arcs[0]?.x1).toBe(tied?.x);
  });
});

describe('T9c.P —— 弧线端点：external = 节点 x，默认路径保留历史 x + glyphWidth/2（裁决 D3）', () => {
  const lone = scoreOf([['jianpu', '(C D) E- E F G A B|']]);
  const voice = voiceAt(lone.renderScore, 0);
  const base = { score: {}, index: lone.index, measurer: externalMeasurer, availableWidth: 960 };
  const ext = layoutJianpu(voice, { ...base, external: externalFor(composed(lone.renderScore), voice.voiceId) });
  const legacy = layoutJianpu(voice, base);
  /** 第 0 小节第 `nth` 个 note 节点（按源码顺序）。 */
  const nodeAt = (layout: JianpuLayout, nth: number): JianpuLayout['nodes'][number] | undefined =>
    layout.nodes.filter((n) => n.kind === 'note' && n.measureIndex === 0)[nth];

  it.each([['slur', 0, 1], ['tie', 2, 3]] as const)('同行 %s：whole 段两端恰为首尾节点 x / 历史 x + glyphWidth/2', (kind, from, to) => {
    const pick = (layout: JianpuLayout): JianpuLayout['arcs'][number] | undefined => layout.arcs.find((a) => a.kind === kind);
    const [ea, la] = [pick(ext), pick(legacy)];
    expect([ea?.segment, la?.segment]).toEqual(['whole', 'whole']);
    const [e1, e2, l1, l2] = [nodeAt(ext, from), nodeAt(ext, to), nodeAt(legacy, from), nodeAt(legacy, to)];
    expect([ea?.x1, ea?.x2]).toEqual([e1?.x, e2?.x]);
    expect([la?.x1, la?.x2]).toEqual([(l1?.x ?? Number.NaN) + (l1?.glyphWidth ?? 0) / 2, (l2?.x ?? Number.NaN) + (l2?.glyphWidth ?? 0) / 2]);
  });
});

describe('T9c.P —— 跨 system 弧：external 端点 = node.x，续行 clamp 不变量（x1 ≤ x2、不越出本段 system box）', () => {
  // 窄宽度：每小节独占一行谱。slur 从第 0 行 E 跨到第 1 行 f；tie 从第 1 行末 d' 跨到第 2 行首 d'。
  const cross = scoreOf([['jianpu', "C D (E F G A B c|d e f) g a b c' d'-|d' e' f' g' a' b' c'' d''|"]]);
  const voice = voiceAt(cross.renderScore, 0);
  const base = { score: {}, index: cross.index, measurer: externalMeasurer, availableWidth: 16 };
  const ext = layoutJianpu(voice, { ...base, external: externalFor(composed(cross.renderScore, screen(16)), voice.voiceId) });
  const legacy = layoutJianpu(voice, base);
  /** 全曲第 `nth` 个 note 节点（按源码顺序）。 */
  const noteAt = (layout: JianpuLayout, nth: number): JianpuLayout['nodes'][number] | undefined => layout.nodes.filter((n) => n.kind === 'note')[nth];
  const segmentsOf = (layout: JianpuLayout, kind: 'tie' | 'slur'): JianpuLayout['arcs'] => layout.arcs.filter((a) => a.kind === kind);

  it.each([['external', ext], ['legacy', legacy]] as const)('%s：每段 x1 ≤ x2，且 start / end 段都落在各自 system box 内', (_name, layout) => {
    const boxOf = new Map(layout.systems.map((s) => [s.index, s.box]));
    expect(layout.arcs.map((a) => a.segment)).toEqual(['start', 'end', 'start', 'end']);
    for (const arc of layout.arcs) {
      const box = boxOf.get(arc.systemIndex);
      expect(box).toBeDefined();
      const [left, right] = [box?.origin.x ?? Number.NaN, (box?.origin.x ?? Number.NaN) + (box?.width ?? Number.NaN)];
      expect(arc.x1).toBeLessThanOrEqual(arc.x2);
      expect(arc.x1).toBeGreaterThanOrEqual(left);
      expect(arc.x2).toBeLessThanOrEqual(right);
    }
    // start 段在首端所在行谱、end 段在末端所在行谱（跨行切段确实发生）。
    for (const kind of ['slur', 'tie'] as const) {
      const [start, end] = segmentsOf(layout, kind);
      expect((end?.systemIndex ?? Number.NaN) - (start?.systemIndex ?? Number.NaN)).toBe(1);
    }
  });

  it.each([
    ['external', ext, (n: JianpuLayout['nodes'][number] | undefined): number => n?.x ?? Number.NaN],
    ['legacy', legacy, (n: JianpuLayout['nodes'][number] | undefined): number => (n?.x ?? Number.NaN) + (n?.glyphWidth ?? 0) / 2],
  ] as const)('%s：起点 = 端点策略(首节点)；end 段终点 = clamp(max(端点策略(末节点), x1 + minSpan))', (_name, layout, endpoint) => {
    const [slurStart, slurEnd] = segmentsOf(layout, 'slur');
    const [tieStart, tieEnd] = segmentsOf(layout, 'tie');
    const [e, f, d1, d2] = [noteAt(layout, 2), noteAt(layout, 10), noteAt(layout, 15), noteAt(layout, 16)];
    expect(slurStart?.x1).toBe(endpoint(e));
    expect(tieStart?.x1).toBe(endpoint(d1));
    // slur 末端（f）离行首足够远：终点恰为端点策略本身，不被最小跨度改写。
    expect(slurEnd?.x2).toBe(endpoint(f));
    expect(endpoint(f)).toBeGreaterThan((slurEnd?.x1 ?? Number.NaN) + JIANPU_METRICS.arcContinuationMinSpan);
    // tie 末端（行首 d'）贴着行首：终点由最小跨度撑开。
    expect(tieEnd?.x2).toBe(Math.max(endpoint(d2), (tieEnd?.x1 ?? Number.NaN) + JIANPU_METRICS.arcContinuationMinSpan));
  });

  it('external 与 legacy 的端点确实不同（策略有区分力），且 external 不等于历史 x + glyphWidth/2', () => {
    const [extSlur, legSlur] = [segmentsOf(ext, 'slur')[0], segmentsOf(legacy, 'slur')[0]];
    const e = noteAt(ext, 2);
    expect(e?.glyphWidth).toBeGreaterThan(0);
    expect(extSlur?.x1).not.toBe(legSlur?.x1);
    expect(extSlur?.x1).not.toBe((e?.x ?? Number.NaN) + (e?.glyphWidth ?? 0) / 2);
  });
});

describe('T5-1 简谱 external —— systemIndex / systems / 高度（C / G / H / I）', () => {
  const out = composed(render, screen(16));
  const plainInput = externalFor(out, jianpu.voiceId);
  const sparse = externalFor(out, jianpu.voiceId, { relabel: (i) => 5 + 4 * i, reverse: true });
  const base = externalLayout(plainInput);
  const layout = externalLayout(sparse);

  it('全局稀疏 index 原样保留、不当数组下标；systems 按 index 升序返回、对象原样、不 restack', () => {
    expect(layout.systems.map((s) => s.index)).toEqual([5, 9, 13, 17, 21]);
    layout.systems.forEach((system) => expect(sparse.systems).toContain(system));
    expect(layout.systems.every((s) => s.box.height === SYSTEM_HEIGHT)).toBe(true);
    const byIndex = new Map(layout.systems.map((s) => [s.index, s]));
    for (const node of layout.nodes) {
      expect(byIndex.get(node.systemIndex)?.box.origin.y).toBe(node.y - JIANPU_METRICS.baselineOffset);
    }
    expect(layout.nodes.map((n) => n.x)).toEqual(base.nodes.map((n) => n.x));
    expect(layout.nodes.map((n) => n.systemIndex)).toEqual(base.nodes.map((n) => 5 + 4 * n.systemIndex));
  });

  it('跨稀疏行谱的 tie 只遍历实际存在的行谱，不因 index 不连续抛错', () => {
    expect(layout.arcs.map((a) => a.systemIndex)).toEqual(base.arcs.map((a) => 5 + 4 * a.systemIndex));
  });

  it('本声部没有 measure 的公共行谱仍保留；absent 不造 measure / 节点', () => {
    const own = new Set(layout.nodes.map((n) => n.systemIndex));
    expect(layout.systems.filter((s) => !own.has(s.index)).map((s) => s.index)).toEqual([21]);
    expect(layout.measures).toHaveLength(4);
    expect(new Set(layout.nodes.map((n) => n.measureIndex))).toEqual(new Set([0, 1, 2, 3]));
  });

  it('宽高取全部行谱的最大外沿（输入倒序也不受影响）', () => {
    expect(layout.width).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.x + s.box.width)));
    expect(layout.height).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.y + s.box.height)));
  });

  it('歌词兜底（整行无 target 且 bodyRange 为 null）落在本声部 index 最小的行谱，而非 0', () => {
    const orphan: RenderVoice = {
      ...jianpu,
      voice: {
        ...jianpu.voice,
        lyricLines: jianpu.voice.lyricLines.map((line) => ({
          ...line, bodyRange: null, syllables: line.syllables.map(({ target: _target, ...rest }) => rest),
        })),
      },
    };
    const lyrics = externalLayout(sparse, orphan).lyrics;
    expect(lyrics.length).toBeGreaterThan(0);
    expect(new Set(lyrics.map((l) => l.systemIndex))).toEqual(new Set([5]));
    expect(lyrics[0]?.text.y).toBeGreaterThan(5 * 300);
  });
});

describe('T5-1 跨行弧只遍历实际存在的行谱，两端缺失仍抛错（review L4）', () => {
  const layout = defaultLayout(16);
  const first = layout.nodes.find((n) => n.measureIndex === 0 && n.kind === 'note');
  const last = layout.nodes.find((n) => n.measureIndex === 2 && n.kind === 'note');
  if (first === undefined || last === undefined) throw new Error('fixture nodes');
  const request = { anchor: first.anchor, kind: 'tie' as const, first, last, open: false };

  it('行谱齐全时 start / middle / end 三段；缺中间行谱时只画两端', () => {
    expect([first.systemIndex, last.systemIndex]).toEqual([0, 2]);
    expect(buildArcSegments(request, arcSystemGeometries(layout.systems, layout.nodes), legacyArcEndpointX).map((a) => [a.systemIndex, a.segment])).toEqual([[0, 'start'], [1, 'middle'], [2, 'end']]);
    const sparse = arcSystemGeometries(layout.systems.filter((s) => s.index !== 1), layout.nodes);
    expect(buildArcSegments(request, sparse, legacyArcEndpointX).map((a) => [a.systemIndex, a.segment])).toEqual([[0, 'start'], [2, 'end']]);
  });

  it('末端或首端所在行谱不存在 → 抛错，不静默少画', () => {
    expect(() => buildArcSegments(request, arcSystemGeometries(layout.systems.filter((s) => s.index !== 2), layout.nodes), legacyArcEndpointX)).toThrow();
    expect(() => buildArcSegments(request, arcSystemGeometries(layout.systems.filter((s) => s.index !== 0), layout.nodes), legacyArcEndpointX)).toThrow();
  });
});

describe('T5-1 简谱 external —— origin.x ≠ 0、y 随 index 递减（review M1）', () => {
  const input = externalFor(composed(render, screen(16)), jianpu.voiceId, { originX: 37.5, flipY: true });
  const layout = externalLayout(input);

  it('节点 x === origin.x + geometry.x + slot.x；timed 恰在 origin.x + geometry.x + xByOffsetIndex[k]', () => {
    const nodeOf = new Map(layout.nodes.map((node) => [node.anchor.kind === 'event' ? node.anchor.eventId : '', node]));
    layout.nodes.forEach((node, i) => {
      expect(node.x).toBe(37.5 + (ownGeometry(input, jianpu, node.measureIndex)?.x ?? Number.NaN) + (layout.slots[i]?.slot.x ?? Number.NaN));
    });
    let checked = 0;
    for (const slice of splitMeasures(jianpu.items)) {
      const g = ownGeometry(input, jianpu, slice.index);
      const onsets = voiceMeasureOnsets(slice);
      if (g?.timeline === undefined || !onsets.resolved) continue;
      for (const timed of onsets.timed) {
        const k = g.timeline.offsets.findIndex((o) => equals(o, timed.onset));
        expect(nodeOf.get(slice.items[timed.itemIndex]?.eventId ?? '')?.x).toBe(37.5 + g.x + (g.timeline.xByOffsetIndex[k] ?? Number.NaN));
        checked += 1;
      }
    }
    expect(checked).toBe(18);
  });

  it('宽含 origin.x；高取最低的行谱，而它不是按 index 排序后的最后一项', () => {
    expect(layout.width).toBe(37.5 + Math.max(...input.systems.map((s) => s.box.width)));
    expect(layout.systems[layout.systems.length - 1]?.box.origin.y).toBe(0);
    expect(layout.height).toBe(Math.max(...input.systems.map((s) => s.box.origin.y + s.box.height)));
    expect(layout.height).toBeGreaterThan(SYSTEM_HEIGHT);
  });
});

describe('T5-1 简谱 external —— 非法输入一律 RangeError，不回退（A2 / 额外裁决 4）', () => {
  const input = externalFor(composed(render), jianpu.voiceId);
  it.each([
    ['少一个本声部 measure', { ...input, measures: input.measures.slice(1) }],
    ['少一个 system', { ...input, systems: input.systems.slice(1) }],
    ['公共宽小于本声部需求', { ...input, measures: input.measures.map((m) => ({ ...m, width: m.width / 4, timeline: undefined })) }],
  ] as const)('%s', (_label, broken) => {
    const fixed: ExternalInput = { measures: broken.measures.map(({ timeline, ...rest }) => (timeline === undefined ? rest : { ...rest, timeline })), systems: broken.systems };
    expect(() => externalLayout(fixed)).toThrow(RangeError);
  });
});
