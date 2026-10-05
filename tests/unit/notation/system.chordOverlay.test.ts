/**
 * M2.5 T6 —— `system/chordOverlay.ts`：和弦图 overlay 的水平规划（用户裁决 A–N + 附加裁决 1–10）。
 *
 * 覆盖：T6-0 analysis 暴露；精确查表；来源选择（去重 / 冲突 / 非 carrier / 同声部多个 / 多 group）；shared 与 tier 3 的 x；
 * footprint 取实际 ChordLayout 局部包围；F-4 碰撞（含降级后继续参与）；诊断只含 T6 三码且顺序稳定；108 宽几何；C1 与纯度。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { equals, fromParts, ZERO } from '../../../src/domain';
import type { Rational } from '../../../src/domain';
import { layoutChord } from '../../../src/notation/chord/layoutChord';
import { placeExternalMeasure } from '../../../src/notation/layout/measurePlacement';
import { CHORD_METRICS, SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import type { RenderScore } from '../../../src/notation/model/types';
import { planChordOverlays } from '../../../src/notation/system/chordOverlay';
import type { ChordOverlayPlan, ChordOverlayPlanning } from '../../../src/notation/system/chordOverlay';
import type { ComposedSystemGeometry } from '../../../src/notation/system/composeSystem';
import type { SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import { createVoiceSpacings } from '../../../src/notation/system/measureDemand';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';
import { composed, externalFor, externalMeasurer as measurer, screen } from './systemExternal.helpers';

const G = 'G=1;3(3),2(2),0,0,0,3(4)';
const C = 'C=1;X,3(3),2(2),0,1(1),0';
const BAR = 'a0 a1 a2 a3 a4 a5 a6 a7|';

function scoreOf(bodies: readonly string[], gchords: readonly string[] = [], bracket = true): ReturnType<typeof matrixScoreFrom> {
  const decl = bodies.map((_, i) => `V:${String(i + 1)}${bracket && i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''} style=tab`);
  const lines = bodies.map((body, i) => `[V:${String(i + 1)}]${body}`);
  return matrixScoreFrom(['%MUSE2', ...gchords.map((g) => `%%gchord ${g}`), 'X:1', 'M:4/4', 'L:1/8', ...decl, 'K:C', ...lines, ''].join('\n'));
}

function run(render: RenderScore, width = 960): { readonly out: ComposedSystemGeometry; readonly plan: ChordOverlayPlanning } {
  const out = composed(render, screen(width));
  return { out, plan: planChordOverlays(render, out, measurer) };
}

const eventIdOf = (p: ChordOverlayPlan): string => p.anchor.eventId;
const codesOf = (plan: ChordOverlayPlanning): string[] => plan.diagnostics.map((d) => d.code);

function chordEvents(render: RenderScore, voice = 0): { readonly eventId: string; readonly text: string }[] {
  return (render.voices[voice]?.items ?? []).flatMap((it) => (it.event.kind === 'chordSymbol' ? [{ eventId: it.eventId, text: it.event.symbol.raw }] : []));
}

function geometry(out: ComposedSystemGeometry, groupIndex: number, ordinal: number): SystemMeasureGeometry {
  const g = out.lines.filter((l) => l.groupIndex === groupIndex).flatMap((l) => l.measures).find((m) => m.measureOrdinal === ordinal);
  if (g === undefined) throw new Error('no geometry');
  return g;
}

function onsetX(g: SystemMeasureGeometry, onset: Rational): number {
  const tl = g.timeline;
  if (tl === undefined) throw new Error('not shared');
  const k = tl.offsets.findIndex((o) => equals(o, onset));
  return g.x + (tl.xByOffsetIndex[k] ?? Number.NaN);
}

describe('T6-0 —— ComposedSystemGeometry.analysis（附加裁决 1 / 2）', () => {
  const render = scoreOf([`"G"${BAR}`, BAR]).renderScore;
  const out = composed(render);

  it('analysis 等于独立跑一次 T1 / T2 / T3 的结果；diagnostics 仍是 renderScore + T1 + T2 + T3', () => {
    const grouping = groupVoices(render.score.voices);
    const alignment = alignMeasures(grouping.groups, render.voices);
    const timings = buildMeasureTimings(alignment);
    expect(out.analysis).toEqual({ grouping, alignment, timings });
    expect(out.diagnostics).toEqual([...render.diagnostics, ...grouping.diagnostics, ...alignment.diagnostics, ...timings.diagnostics]);
  });

  it('analysis 只存数据：任何层级都没有函数', () => {
    const seen = new Set<unknown>();
    const hasFunction = (value: unknown): boolean => {
      if (typeof value === 'function') return true;
      if (value === null || typeof value !== 'object' || seen.has(value)) return false;
      seen.add(value);
      return Object.values(value).some(hasFunction);
    };
    expect(hasFunction(out.analysis)).toBe(false);
  });
});

describe('T6 —— chordDiagramWidth = 108 的几何（裁决 N）', () => {
  const shapes = scoreOf([`"G"${BAR}`], [G, C, 'Cm=5;X,8(1),10(3),10(4),9(2),8(1)']).score.chordShapes;
  it.each(shapes.map((s, i) => [s.name, i] as const))('%s：弦间距 > 按弦点直径，网格宽高为正，按弦点不越界', (_name, index) => {
    const shape = shapes[index];
    if (shape === undefined) throw new Error('shape');
    const layout = layoutChord(shape, { showFinger: undefined, measurer, width: SYSTEM_METRICS.chordDiagramWidth });
    const strings = layout.gridLines.filter((l) => l.kind === 'string').map((l) => l.x1);
    const frets = layout.gridLines.filter((l) => l.kind === 'fret').map((l) => l.y1);
    expect(layout.width).toBe(108);
    expect((strings[1] ?? 0) - (strings[0] ?? 0)).toBeGreaterThan(2 * CHORD_METRICS.fingerDotRadius);
    expect((strings[strings.length - 1] ?? 0) - (strings[0] ?? 0)).toBeGreaterThan(0);
    expect((frets[frets.length - 1] ?? 0) - (frets[0] ?? 0)).toBeGreaterThan(0);
    for (const mark of layout.strings) {
      if (mark.kind === 'fretted') expect([mark.cx - mark.r >= 0, mark.cx + mark.r <= layout.width]).toEqual([true, true]);
    }
  });
});

describe('T6 —— 精确查表（§Q5.1）', () => {
  it('0 命中只画名无诊断；1 命中带图；>1 同名只画名 + ambiguous warning，shapeIndex 缺席', () => {
    const source = scoreOf([`"G"a0 a1 a2 a3 a4 a5 a6 a7|"Am"${BAR}"C"${BAR}`], [G, C, C]);
    const { plan } = run(source.renderScore, 100_000);
    const byText = new Map(plan.plans.map((p) => [p.displayText, p]));
    expect([byText.get('G')?.form, byText.get('G')?.shapeIndex]).toEqual(['diagram', 0]);
    expect([byText.get('Am')?.form, byText.get('Am')?.shapeIndex]).toEqual(['name', undefined]);
    expect([byText.get('C')?.form, 'shapeIndex' in (byText.get('C') ?? {})]).toEqual(['name', false]);
    const ambiguous = plan.diagnostics.filter((d) => d.code === CODES.chordNameAmbiguous);
    expect(ambiguous).toHaveLength(1);
    const cItem = source.renderScore.voices[0]?.items.find((it) => it.event.kind === 'chordSymbol' && it.event.symbol.raw === '"C"');
    expect([ambiguous[0]?.level, ambiguous[0]?.anchor, ambiguous[0]?.sourceRef]).toEqual(['warning', { kind: 'event', voiceId: source.renderScore.voices[0]?.voiceId, eventId: cItem?.eventId }, cItem?.sourceRef]);
  });

  it('零归一化：大小写、尾随空格、slash 写法不同都不命中', () => {
    const source = scoreOf([`"g"${BAR}"G "${BAR}"D/#F"${BAR}"D/F#"${BAR}`], [G, 'D/F#=2;X,X,0,2(1),3(3),2(2)']);
    const { plan } = run(source.renderScore, 100_000);
    expect(plan.plans.map((p) => [p.displayText, p.form])).toEqual([['g', 'name'], ['G ', 'name'], ['D/#F', 'name'], ['D/F#', 'diagram']]);
    expect(plan.diagnostics.filter((d) => d.code === CODES.chordNameAmbiguous)).toEqual([]);
  });
});

describe('T6 —— 来源选择（§Q5.2 + 附加裁决 4–7）', () => {
  const at0 = (plan: ChordOverlayPlanning): ChordOverlayPlan[] => plan.plans.filter((p) => p.measureOrdinal === 0);

  it('同位置同文本跨声部去重，anchor 取 carrier；不发诊断', () => {
    const source = scoreOf([`"G"${BAR}`, `"G"${BAR}`]);
    const { plan } = run(source.renderScore);
    expect(plan.plans.map(eventIdOf)).toEqual([chordEvents(source.renderScore, 0)[0]?.eventId]);
    expect(plan.diagnostics).toEqual([]);
  });

  it('同位置不同文本：两个都保留、同一 x（不横向并排）；冲突 warning 挂非 base 事件', () => {
    const source = scoreOf([`"G"${BAR}`, `"C"${BAR}`]);
    const { plan } = run(source.renderScore);
    const plans = at0(plan);
    expect(plans.map((p) => p.displayText)).toEqual(['G', 'C']);
    expect(plans[0]?.x).toBe(plans[1]?.x);
    const conflict = plan.diagnostics.filter((d) => d.code === CODES.chordSymbolConflict);
    expect(conflict.map((d) => [d.level, d.anchor.kind === 'event' ? d.anchor.eventId : ''])).toEqual([['warning', chordEvents(source.renderScore, 1)[0]?.eventId]]);
  });

  it('G / G / C → 2 个 overlay、1 条冲突；G / C / C → 2 个 overlay、2 条冲突', () => {
    const ggc = run(scoreOf([`"G"${BAR}`, `"G"${BAR}`, `"C"${BAR}`]).renderScore).plan;
    expect([at0(ggc).map((p) => p.displayText), codesOf(ggc).filter((c) => c === CODES.chordSymbolConflict).length]).toEqual([['G', 'C'], 1]);
    const gccSource = scoreOf([`"G"${BAR}`, `"C"${BAR}`, `"C"${BAR}`]);
    const gcc = run(gccSource.renderScore).plan;
    expect(at0(gcc).map((p) => p.displayText)).toEqual(['G', 'C']);
    expect(at0(gcc)[1]?.anchor.eventId).toBe(chordEvents(gccSource.renderScore, 1)[0]?.eventId);
    expect(gcc.diagnostics.filter((d) => d.code === CODES.chordSymbolConflict).map((d) => (d.anchor.kind === 'event' ? d.anchor.eventId : ''))).toEqual([
      chordEvents(gccSource.renderScore, 1)[0]?.eventId, chordEvents(gccSource.renderScore, 2)[0]?.eventId,
    ]);
  });

  it('carrier 在该位置缺席时非 carrier 的符号照样成 overlay；同声部同位置多个逐个保留、不判冲突', () => {
    const source = scoreOf([`"G"${BAR}`, `a0 a1 a2 a3 "Em"a4 a5 a6 a7|`]);
    const { plan } = run(source.renderScore);
    expect(plan.plans.map((p) => p.displayText)).toEqual(['G', 'Em']);
    expect(plan.diagnostics).toEqual([]);
    const same = run(scoreOf([`"Am""Em"${BAR}`]).renderScore).plan;
    expect([same.plans.map((p) => p.displayText), same.plans[0]?.x === same.plans[1]?.x, same.diagnostics]).toEqual([['Am', 'Em'], true, []]);
  });

  it('去重只在「同位置 + 不同声部」：同一声部 G,G 两个都保留；不同位置的同名各自保留；tier 3 两个声部同名都保留', () => {
    const sameVoice = run(scoreOf([`"G""G"${BAR}`]).renderScore).plan;
    expect([sameVoice.plans.map((p) => p.displayText), sameVoice.diagnostics]).toEqual([['G', 'G'], []]);
    const otherPosition = run(scoreOf([`"G"${BAR}`, `a0 a1 a2 a3 "G"a4 a5 a6 a7|`]).renderScore).plan;
    expect([otherPosition.plans.map((p) => p.displayText), otherPosition.diagnostics]).toEqual([['G', 'G'], []]);
    const tier3Source = scoreOf([`"G"a0 a1 a2 a3|`, `"G"${BAR}`]);
    const tier3 = run(tier3Source.renderScore);
    expect(tier3.out.analysis.timings.groups[0]?.measures[0]?.status).toBe('not-compatible');
    expect([tier3.plan.plans.map((p) => p.anchor.voiceId), tier3.plan.diagnostics]).toEqual([tier3Source.renderScore.voices.map((v) => v.voiceId), []]);
  });

  it('顺序契约：shared 先去重、后查表——同名 C,C 去重成 1 个 overlay，ambiguous 只 1 条且挂保留者（附加裁决）', () => {
    const source = scoreOf([`"C"${BAR}`, `"C"${BAR}`], [C, C]);
    const { plan } = run(source.renderScore);
    expect(plan.plans.map(eventIdOf)).toEqual([chordEvents(source.renderScore, 0)[0]?.eventId]);
    const ambiguous = plan.diagnostics.filter((d) => d.code === CODES.chordNameAmbiguous);
    expect(ambiguous.map((d) => (d.anchor.kind === 'event' ? d.anchor.eventId : ''))).toEqual([chordEvents(source.renderScore, 0)[0]?.eventId]);
  });

  it('顺序契约：tier 3 不跨声部去重，每个事件都是保留候选，因而各自独立查表与报 ambiguous', () => {
    const source = scoreOf([`"C"a0 a1 a2 a3|`, `"C"${BAR}`], [C, C]);
    const { out, plan } = run(source.renderScore);
    expect(out.analysis.timings.groups[0]?.measures[0]?.status).toBe('not-compatible');
    expect(plan.plans).toHaveLength(2);
    const ambiguous = plan.diagnostics.filter((d) => d.code === CODES.chordNameAmbiguous);
    expect(ambiguous.map((d) => (d.anchor.kind === 'event' ? d.anchor.eventId : ''))).toEqual(
      [chordEvents(source.renderScore, 0)[0]?.eventId, chordEvents(source.renderScore, 1)[0]?.eventId],
    );
  });

  it('同一声部 G,C 与另一声部 C：v2 的 C 与 base 不同 → 1 条冲突，但它与 v1 的 C 同文本被去重（review NIT 2 定为契约）', () => {
    const source = scoreOf([`"G""C"${BAR}`, `"C"${BAR}`]);
    const { plan } = run(source.renderScore);
    expect(plan.plans.map((p) => [p.displayText, p.anchor.voiceId])).toEqual([['G', source.renderScore.voices[0]?.voiceId], ['C', source.renderScore.voices[0]?.voiceId]]);
    expect(plan.diagnostics.map((d) => [d.code, d.anchor.kind === 'event' ? d.anchor.eventId : ''])).toEqual([[CODES.chordSymbolConflict, chordEvents(source.renderScore, 1)[0]?.eventId]]);
  });

  it('多个 group 各自独立：同文本不跨 group 去重，groupIndex / systemIndex 各归各', () => {
    const { out, plan } = run(scoreOf([`"G"${BAR}`, `"G"${BAR}`], [], false).renderScore);
    expect(plan.plans.map((p) => p.groupIndex)).toEqual([0, 1]);
    expect(plan.plans.map((p) => p.systemIndex)).toEqual([geometry(out, 0, 0).systemIndex, geometry(out, 1, 0).systemIndex]);
    expect(plan.plans[1]?.systemIndex).toBeGreaterThan(0);
    expect(plan.diagnostics).toEqual([]);
  });
});

describe('T6 —— shared x 只消费 T3 OverlayOnset（裁决 B-a / C-b）', () => {
  it('小节中途的 onset、measure-end、零 timed 小节、systemIndex ≠ 0', () => {
    const source = scoreOf([`"G"a0 a1 a2 a3 "C"a4 a5 a6 a7|a0 a1 a2 a3 a4 a5 a6 a7 "Am"|"Em"|`]);
    const { out, plan } = run(source.renderScore, 16);
    const [g0, g1, g2] = [geometry(out, 0, 0), geometry(out, 0, 1), geometry(out, 0, 2)];
    expect(plan.plans.map((p) => [p.displayText, p.x, p.systemIndex])).toEqual([
      ['G', onsetX(g0, ZERO), g0.systemIndex],
      ['C', onsetX(g0, fromParts(4, 8)), g0.systemIndex],
      ['Am', g1.x + (g1.timeline?.endX ?? Number.NaN), g1.systemIndex],
      ['Em', g2.x + (g2.timeline?.endX ?? Number.NaN), g2.systemIndex],
    ]);
    expect(g2.timeline?.offsets).toEqual([]);
    expect(g1.systemIndex).toBeGreaterThan(0);
  });

  it('T3 为唯一真源：和弦后紧跟 decoration 时 overlay 仍在 onset x，而 T5 自排的 primary 节点在其左侧', () => {
    const source = scoreOf([`"G"!trill!a0 a1 a2 a3 a4 a5 a6 a7|`]);
    const { out, plan } = run(source.renderScore);
    const g0 = geometry(out, 0, 0);
    expect(plan.plans[0]?.x).toBe(onsetX(g0, ZERO));
    const voice = source.renderScore.voices[0];
    if (voice === undefined) throw new Error('voice');
    const layout = layoutTab(voice, { index: source.index, measurer, availableWidth: 1, external: externalFor(out, voice.voiceId) });
    expect(layout.nodes.find((n) => n.kind === 'chordSymbol')?.x).toBeLessThan(plan.plans[0]?.x ?? 0);
  });
});

describe('T6 —— tier 3 x 与 T5 external 自排同源（裁决 D-a / F）', () => {
  function tier3Case(bodies: readonly string[], expectStatus: string) {
    const source = scoreOf(bodies);
    const { out, plan } = run(source.renderScore);
    const statuses = out.analysis.timings.groups[0]?.measures.map((m) => m.status) ?? [];
    expect(statuses).toContain(expectStatus);
    return { source, out, plan };
  }

  it.each([
    // 和弦放在小节中途：自排 x 才与 contentOffsetX 不同（防止「tier 3 只取小节起点」蒙混过关）。
    ['total-mismatch', [`a0 "G"a1 a2 a3|`, BAR], 'not-compatible'],
    ['structure-conflict', [`a0 a1 "G"a2 a3 a4 a5 a6 a7||`, BAR], 'not-compatible'],
    ['desynced', [`|a0 a1 a2 a3 a4 a5 a6 a7|a0 a1 "G"a2 a3 a4 a5 a6 a7|`, `${BAR}${BAR}`], 'not-compatible'],
    ['degraded（tuplet）', [`a0 "G"(3a1 a2 a3 a4 a5 a6 a7|`, BAR], 'degraded'],
  ] as const)('%s：overlay x === 该 voice external layout 中 chordSymbol 节点的 x', (_label, bodies, status) => {
    const { source, out, plan } = tier3Case(bodies, status);
    const voice = source.renderScore.voices[0];
    if (voice === undefined) throw new Error('voice');
    const layout = layoutTab(voice, { index: source.index, measurer, availableWidth: 1, external: externalFor(out, voice.voiceId), ...(source.score.meter === undefined ? {} : { meter: source.score.meter }) });
    const chordNode = layout.nodes.find((n) => n.kind === 'chordSymbol');
    const overlay = plan.plans.find((p) => p.displayText === 'G');
    expect(overlay?.x).toBe(chordNode?.x);
    const timing = out.analysis.timings.groups[0]?.measures[overlay?.measureOrdinal ?? -1];
    expect(timing?.status).not.toBe('shared');
    const slice = splitMeasures(voice.items).find((s) => s.items.some((it) => it.eventId === overlay?.anchor.eventId));
    const g = geometry(out, 0, overlay?.measureOrdinal ?? -1);
    if (slice === undefined) throw new Error('slice');
    const spacing = createVoiceSpacings(source.score, measurer)(voice)[slice.index];
    if (spacing === undefined) throw new Error('spacing');
    const j = slice.items.findIndex((it) => it.eventId === overlay?.anchor.eventId);
    expect(overlay?.x).toBe(g.x + (placeExternalMeasure(slice, spacing, g)[j]?.slot.x ?? Number.NaN));
    expect(overlay?.x).toBeGreaterThan(g.x + g.contentOffsetX);
  });

  it('tier 3 不跨声部去重 / 判冲突：两个声部各自的和弦都保留、无 conflict', () => {
    const { plan } = tier3Case([`"G"a0 a1 a2 a3|`, `"C"${BAR}`], 'not-compatible');
    expect(plan.plans.map((p) => p.displayText)).toEqual(['G', 'C']);
    expect(plan.diagnostics).toEqual([]);
  });
});

describe('T6 —— footprint 与 F-4 碰撞（裁决 G / H / I）', () => {
  const dense = `"G"a0 "G"a1 "G"a2 "G"a3 "G"a4 "G"a5 "G"a6 "G"a7|`;

  it('带图 footprint = 实际 ChordLayout 局部包围（网格 / 居中名字 / capo）平移到 x − width/2；只画名 = x ± 名宽/2', () => {
    const longName = 'Cmaj7add9sus4/G#';
    const source = scoreOf([`"${longName}"${BAR}${BAR}${BAR}"Cm"${BAR}${BAR}${BAR}"Am"${BAR}`], [`${longName}=1;X,3(3),2(2),0,0,0`, 'Cm=5;X,8(1),10(3),10(4),9(2),8(1)']);
    const { plan } = run(source.renderScore, 100_000);
    for (const p of plan.plans) {
      if (p.form === 'diagram') {
        const shape = source.score.chordShapes[p.shapeIndex ?? -1];
        if (shape === undefined) throw new Error('diagram 必带有效 shapeIndex');
        const layout = layoutChord(shape, { showFinger: source.score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth });
        // 独立预言（review LOW-1）：ChordLayout 每个元素的实际横向范围都落在 footprint 内。
        const local = p.x - layout.width / 2;
        const spans: (readonly [number, number])[] = [
          ...layout.gridLines.map((l) => [Math.min(l.x1, l.x2), Math.max(l.x1, l.x2)] as const),
          ...layout.strings.map((m) => {
            if (m.kind === 'fretted') return [m.cx - m.r, m.cx + m.r] as const;
            if (m.kind === 'open') return [m.x - m.r, m.x + m.r] as const;
            const w = measurer.measure(m.text, { fontSize: CHORD_METRICS.nameFontSize }).width;
            return [m.x - w / 2, m.x + w / 2] as const;
          }),
          [layout.name.x - layout.name.width / 2, layout.name.x + layout.name.width / 2],
          ...(layout.capoLabel === undefined ? [] : [[layout.capoLabel.x, layout.capoLabel.x + layout.capoLabel.width] as const]),
        ];
        for (const [l, r] of spans) expect([local + l >= p.footprint.left, local + r <= p.footprint.right]).toEqual([true, true]);
        const origin = p.x - layout.width / 2;
        const capo = layout.capoLabel;
        expect(p.footprint).toEqual({
          left: origin + Math.min(0, layout.name.x - layout.name.width / 2, ...(capo === undefined ? [] : [capo.x])),
          right: origin + Math.max(layout.width, layout.name.x + layout.name.width / 2, ...(capo === undefined ? [] : [capo.x + capo.width])),
          height: layout.height,
        });
      } else {
        const size = measurer.measure(p.displayText, { fontSize: CHORD_METRICS.nameFontSize });
        expect(p.footprint).toEqual({ left: p.x - size.width / 2, right: p.x + size.width / 2, height: size.height });
        expect(size.width).toBeGreaterThan(0);
      }
    }
    expect(plan.plans.map((p) => p.form)).toEqual(['diagram', 'diagram', 'name']);
    expect((plan.plans[0]?.footprint.right ?? 0) - (plan.plans[0]?.footprint.left ?? 0)).toBeGreaterThan(SYSTEM_METRICS.chordDiagramWidth);
  });

  it('密集同名和弦：降级者以名字框继续参与（与按裁决规则独立重放的结果一致）；x 不动；每次降级一条 info', () => {
    const source = scoreOf([dense + dense], [G]);
    const { out, plan } = run(source.renderScore);
    const shape = source.score.chordShapes[0];
    if (shape === undefined) throw new Error('shape');
    const layout = layoutChord(shape, { showFinger: source.score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth });
    const nameHalf = measurer.measure('G', { fontSize: CHORD_METRICS.nameFontSize }).width / 2;
    // 独立重放：按 x 顺序，带图框与已接受的任一框（含降级后的名字框）严格重叠 → 降级。
    const accepted: { l: number; r: number }[] = [];
    let onlyNameWitness = false;
    const expected = plan.plans.map((p) => {
      const diag = { l: p.x - layout.width / 2, r: p.x + layout.width / 2 };
      const hit = accepted.some((a) => diag.l < a.r && a.l < diag.r);
      const hitDiagram = accepted.some((a, i) => i === 0 && diag.l < a.r && a.l < diag.r);
      if (hit && !hitDiagram) onlyNameWitness = true;
      accepted.push(hit ? { l: p.x - nameHalf, r: p.x + nameHalf } : diag);
      return hit ? 'name' : 'diagram';
    });
    expect(plan.plans.map((p) => p.form)).toEqual(expected);
    expect(onlyNameWitness).toBe(true);
    expect(expected.filter((f) => f === 'diagram').length).toBeLessThan(expected.length / 2);
    const g0 = geometry(out, 0, 0);
    expect(plan.plans.slice(0, 8).map((p) => p.x)).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => onsetX(g0, n === 0 ? ZERO : fromParts(n, 8))));
    const collisions = plan.diagnostics.filter((d) => d.code === CODES.chordDiagramCollision);
    expect(collisions.map((d) => [d.level, d.anchor.kind === 'event' ? d.anchor.eventId : ''])).toEqual(
      plan.plans.filter((_, i) => expected[i] === 'name').map((p) => ['info', p.anchor.eventId]),
    );
  });

  it('名字在前、带图在后且重叠 → 带图降级；两个只画名的框重叠 → 不处理、不发诊断', () => {
    const { plan } = run(scoreOf([`"Am"a0 "G"a1 a2 a3 a4 a5 a6 a7|`], [G]).renderScore);
    expect([plan.plans.map((p) => p.form), codesOf(plan)]).toEqual([['name', 'name'], [CODES.chordDiagramCollision]]);
    const names = run(scoreOf([`"Am"a0 "Em"a1 a2 a3 a4 a5 a6 a7|`]).renderScore).plan;
    expect([names.plans.map((p) => p.form), names.diagnostics]).toEqual([['name', 'name'], []]);
  });

  it('相距足够远的两张图都带图；行首和弦的图伸出 system 左缘时不 clamp、不降级', () => {
    const { out, plan } = run(scoreOf([`"G"${BAR}${BAR}"G"${BAR}`], [G]).renderScore, 100_000);
    const [a, b] = plan.plans;
    expect((b?.x ?? 0) - (a?.x ?? 0)).toBeGreaterThan(SYSTEM_METRICS.chordDiagramWidth);
    expect(plan.plans.map((p) => p.form)).toEqual(['diagram', 'diagram']);
    expect(a?.x).toBe(onsetX(geometry(out, 0, 0), ZERO));
    expect(a?.footprint.left).toBeLessThan(0);
    expect(plan.diagnostics).toEqual([]);
  });

  it('碰撞只在同一 system 内判断：不同 system 同一 x 的两张图都带图', () => {
    const { plan } = run(scoreOf([`"G"${BAR}"G"${BAR}`], [G]).renderScore, 16);
    expect(plan.plans.map((p) => p.systemIndex)).toEqual([0, 1]);
    expect(plan.plans[0]?.x).toBe(plan.plans[1]?.x);
    expect([plan.plans.map((p) => p.form), plan.diagnostics]).toEqual([['diagram', 'diagram'], []]);
  });

  it('严格重叠：两张图恰好首尾相接（相距 = 图宽）不算碰撞', () => {
    const source = scoreOf([`"G"${BAR}"G"${BAR}`], [G]);
    const out = composed(source.renderScore, screen(100_000));
    const shape = source.score.chordShapes[0];
    if (shape === undefined) throw new Error('shape');
    const width = layoutChord(shape, { showFinger: source.score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth }).width;
    const first = geometry(out, 0, 0);
    const startX = onsetX(first, ZERO) - first.x;
    // 把第二个 measure 平移到两张图恰好首尾相接的位置（其余几何不变）。
    const shifted: ComposedSystemGeometry = {
      ...out,
      lines: out.lines.map((line) => ({ ...line, measures: line.measures.map((m) => (m.measureOrdinal === 1 ? { ...m, x: first.x + width + startX - (onsetX(m, ZERO) - m.x) } : m)) })),
    };
    const plan = planChordOverlays(source.renderScore, shifted, measurer);
    expect((plan.plans[1]?.x ?? 0) - (plan.plans[0]?.x ?? 0)).toBe(width);
    expect(plan.plans[0]?.footprint.right).toBe(plan.plans[1]?.footprint.left);
    expect([plan.plans.map((p) => p.form), plan.diagnostics]).toEqual([['diagram', 'diagram'], []]);
  });

  it('稳定排序 systemIndex → x → measureOrdinal → voiceOrder → itemIndex', () => {
    const { plan } = run(scoreOf([`"G"${BAR}"Am"${BAR}`, `"C"${BAR}a0 "Em"a1 a2 a3 a4 a5 a6 a7|`]).renderScore, 16);
    const keys = plan.plans.map((p) => [p.systemIndex, p.x, p.measureOrdinal]);
    const sorted = [...keys].sort((x, y) => (x[0] ?? 0) - (y[0] ?? 0) || (x[1] ?? 0) - (y[1] ?? 0) || (x[2] ?? 0) - (y[2] ?? 0));
    expect(keys).toEqual(sorted);
    expect(plan.plans.map((p) => p.displayText)).toEqual(['G', 'C', 'Am', 'Em']);
    // x 优先于声部序：第二个声部的和弦在 x 上更早，必须排在前面。
    const byX = run(scoreOf([`a0 a1 a2 a3 "G"a4 a5 a6 a7|`, `"C"${BAR}`]).renderScore).plan;
    expect(byX.plans.map((p) => p.displayText)).toEqual(['C', 'G']);
  });
});

describe('T6 —— 诊断、C1、纯度、确定性（附加裁决 2 / 3 / 9）', () => {
  it('只含 T6 三码（不重复合并 composed.diagnostics）；顺序 = 冲突 → 歧义 → 碰撞；id 稳定', () => {
    const source = scoreOf([`"G"a0 "C"a1 a2 a3 a4 a5 a6 a7|a0 a1 a2 a3|`, `"Am"${BAR}${BAR}`], [G, C, C]);
    const { out, plan } = run(source.renderScore);
    expect(out.diagnostics.length).toBeGreaterThan(0);
    expect(codesOf(plan)).toEqual([CODES.chordSymbolConflict, CODES.chordNameAmbiguous]);
    const dense = run(scoreOf([`"G"a0 "G"a1 "C"a2 a3 a4 a5 a6 a7|`, `"Am"${BAR}`], [G, C, C]).renderScore).plan;
    expect(codesOf(dense)).toEqual([CODES.chordSymbolConflict, CODES.chordNameAmbiguous, CODES.chordDiagramCollision]);
    expect(new Set(plan.diagnostics.map((d) => d.id)).size).toBe(plan.diagnostics.length);
    expect(run(source.renderScore).plan.diagnostics).toEqual(plan.diagnostics);
  });

  it('C1：overlay 不进 voice nodes——TAB 布局的 chordSymbol 节点数仍等于事件数；输入不被修改；两次逐字段相等', () => {
    const source = scoreOf([`"G"a0 "C"a1 a2 a3 a4 a5 a6 a7|`, `"Am"${BAR}`], [G]);
    const out = composed(source.renderScore);
    const before = JSON.stringify([source.renderScore, out]);
    const first = planChordOverlays(source.renderScore, out, measurer);
    expect(JSON.stringify([source.renderScore, out])).toBe(before);
    expect(planChordOverlays(source.renderScore, out, measurer)).toEqual(first);
    for (const voice of source.renderScore.voices) {
      const layout = layoutTab(voice, { index: source.index, measurer, availableWidth: 960 });
      const events = voice.items.filter((it) => it.event.kind === 'chordSymbol').length;
      expect(layout.nodes.filter((n) => n.kind === 'chordSymbol')).toHaveLength(events);
    }
    expect(first.plans.length).toBeGreaterThan(0);
  });

  it('输入不变量失败一律 RangeError：缺少某个 measure 的公共几何、shared measure 缺 timeline（review NIT 1）', () => {
    const source = scoreOf([`"G"${BAR}${BAR}`]);
    const out = composed(source.renderScore);
    const missing: ComposedSystemGeometry = { ...out, lines: out.lines.map((l) => ({ ...l, measures: l.measures.filter((m) => m.measureOrdinal !== 1) })) };
    expect(() => planChordOverlays(source.renderScore, missing, measurer)).toThrow(RangeError);
    const noTimeline: ComposedSystemGeometry = { ...out, lines: out.lines.map((l) => ({ ...l, measures: l.measures.map(({ timeline: _t, ...rest }) => rest) })) };
    expect(() => planChordOverlays(source.renderScore, noTimeline, measurer)).toThrow(RangeError);
  });

  it('chordOverlay.ts 不 import 任何 voice layout 入口', () => {
    const source = readFileSync(join(import.meta.dirname, '../../../src/notation/system/chordOverlay.ts'), 'utf8');
    expect(/from '\.\.\/(tab|jianpu|staff)\/layout(Tab|Jianpu|Staff)'/.test(source)).toBe(false);
  });
});

describe('T6 —— 全部 fixture × 两档宽度：不抛错、不静默丢弃 chordSymbol', () => {
  it('每个 chordSymbol 事件要么有自己的 plan，要么是被去重的跨声部同文本事件（同小节、同 x 有同名 plan）', () => {
    let events = 0;
    for (const name of fixtureNames) {
      const source = matrixScoreFrom(fixtureBytes(name));
      for (const width of [960, 16]) {
        const { plan } = run(source.renderScore, width);
        const planned = new Set(plan.plans.map(eventIdOf));
        for (const voice of source.renderScore.voices) {
          for (const item of voice.items) {
            if (item.event.kind !== 'chordSymbol') continue;
            events += 1;
            if (planned.has(item.eventId)) continue;
            const text = item.event.symbol.raw.replace(/^"(.*)"$/s, '$1');
            expect(plan.plans.some((p) => p.displayText === text && p.anchor.voiceId !== voice.voiceId), `${name}@${String(width)}`).toBe(true);
          }
        }
        // 空和弦符号 `""` 的显示文本为空串，量宽恰为 0（真实测量，不是把只画名当 0）；其余必为正宽。
        for (const p of plan.plans) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(p.footprint.right - p.footprint.left > 0 || p.displayText === '').toBe(true);
        }
      }
    }
    expect(events).toBeGreaterThan(0);
  });
});
