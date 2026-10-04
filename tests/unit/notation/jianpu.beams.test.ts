/**
 * M2.5 T3.5 —— 简谱减时线按 beam 分组（`jianpu/jianpuBeams.ts` + `layoutJianpu` + `toSvg` 接入）。
 *
 * 覆盖：组横线几何（Q10-a，`[x首 − h, x末 + h]`）、F-10 层级、C1（组不进 nodes）、成员节点只清空逐音
 * 减时线（八度点 / 附点 / 延音线不变）、列宽、SVG（组元素、metric 粗细）、不分组情形与确定性。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { JianpuNode } from '../../../src/notation/jianpu/jianpuGlyphs';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../src/notation/jianpu/toSvg';
import { JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';

const measurer = createDeterministicTextMeasurer();
const H = (JIANPU_METRICS.digitFontSize * JIANPU_METRICS.digitGlyphWidthRatio) / 2;

function layout(body: string, meterLine = 'M:4/4', unit = '1/8', availableWidth = 100_000): JianpuLayout {
  const loaded = loadJcx(['%MUSE2', 'X:1', ...(meterLine === '' ? [] : [meterLine]), `L:${unit}`, 'K:C', 'V:1 style=jianpu', body, ''].join('\n'));
  const voice = buildRenderScore({ score: loaded.score, index: loaded.index }).voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  const meter = loaded.score.meter === undefined ? {} : { meter: loaded.score.meter };
  return layoutJianpu(voice, { score: meter, index: loaded.index, measurer, availableWidth });
}

const beamable = (l: JianpuLayout): Extract<JianpuNode, { kind: 'note' | 'chord' }>[] =>
  l.nodes.flatMap((node) => (node.kind === 'note' || node.kind === 'chord' ? [node] : []));
const levelY = (baseline: number, level: number): number =>
  baseline + JIANPU_METRICS.beamFirstOffset + (level - 1) * JIANPU_METRICS.beamGap;

describe('T3.5 简谱 —— 组与 C1', () => {
  it('h = 4.8（数字视觉半宽）；4/4 下 4 个八分 → 2 组，节点同长同序同 anchor / x / y / width', () => {
    expect(H).toBeCloseTo(4.8, 12);
    const grouped = layout('CDEF|');
    const plain = layout('CDEF|', 'M:C');
    expect(grouped.beams.map((group) => group.eventIds.length)).toEqual([2, 2]);
    expect(grouped.nodes.map((n) => [n.kind, n.anchor, n.x, n.y, n.width, n.glyphWidth, n.fallback])).toEqual(
      plain.nodes.map((n) => [n.kind, n.anchor, n.x, n.y, n.width, n.glyphWidth, n.fallback]),
    );
    expect(plain.beams).toEqual([]);
  });

  it('组成员只清空逐音减时线：八度点（按自己的条数避让）、附点、延音线、数字逐字段不变', () => {
    const grouped = beamable(layout("C,/ D,/ E'3/4 F/4|"));
    const plain = beamable(layout("C,/ D,/ E'3/4 F/4|", 'M:C'));
    expect(grouped.map((n) => n.duration.beams)).toEqual([[], [], [], []]);
    expect(grouped.map((n) => (n.kind === 'note' ? [n.pitchGlyphs, n.text, n.duration.augmentationDots, n.duration.dashes] : n.kind))).toEqual(
      plain.map((n) => (n.kind === 'note' ? [n.pitchGlyphs, n.text, n.duration.augmentationDots, n.duration.dashes] : n.kind)),
    );
  });

  it('同时值组：一条横线覆盖 [x首 − h, x末 + h]，y 与逐音画法第 1 条相同', () => {
    const l = layout('CD|');
    const [c, d] = beamable(l);
    const y = levelY(c?.y ?? 0, 1);
    expect(l.beams[0]?.lines).toEqual([{ level: 1, kind: 'span', segment: { x1: (c?.x ?? 0) - H, y1: y, x2: (d?.x ?? 0) + H, y2: y } }]);
    expect(beamable(layout('CD|', 'M:C'))[0]?.duration.beams[0]?.y1).toBe(y);
    expect(l.beams[0]?.equalSpacing).toBe(true);
  });

  it('八分 + 十六分 + 十六分：第 2 条只覆盖相邻两个十六分；不等距', () => {
    const l = layout('C D/E/|');
    const nodes = beamable(l);
    const y = nodes[0]?.y ?? 0;
    expect(l.beams[0]?.lines.map((line) => [line.level, line.kind, line.segment.x1, line.segment.x2, line.segment.y1])).toEqual([
      [1, 'span', (nodes[0]?.x ?? 0) - H, (nodes[2]?.x ?? 0) + H, levelY(y, 1)],
      [2, 'span', (nodes[1]?.x ?? 0) - H, (nodes[2]?.x ?? 0) + H, levelY(y, 2)],
    ]);
    expect(l.beams[0]?.equalSpacing).toBe(false);
  });

  it('孤立的多出层级：只画在该数字下、以数字中心对称（简谱不区分方向）', () => {
    for (const body of ['C/D|', 'CD/|']) {
      const l = layout(body);
      const nodes = beamable(l);
      const member = body === 'C/D|' ? nodes[0] : nodes[1];
      expect(l.beams[0]?.lines[1]).toEqual({
        level: 2, kind: 'beamlet',
        segment: { x1: (member?.x ?? 0) - H, y1: levelY(member?.y ?? 0, 2), x2: (member?.x ?? 0) + H, y2: levelY(member?.y ?? 0, 2) },
      });
    }
  });

  it('和弦块照常入组；休止 / 装饰 / grace 断组；chordSymbol 不断组', () => {
    expect(layout('[CE] D|').beams.map((g) => g.eventIds.length)).toEqual([2]);
    expect(layout('C/ z/ D/ E/|').beams.map((g) => g.eventIds.length)).toEqual([2]);
    expect(layout('C !trill!D|').beams).toEqual([]);
    expect(layout('C {g}D|').beams).toEqual([]);
    expect(layout('C "G"D|').beams.map((g) => g.eventIds.length)).toEqual([2]);
  });
});

describe('T3.5 简谱 —— 宽度、SVG、不分组', () => {
  it('列宽与不分组时相同（同时值组宽度本就一致）', () => {
    for (const body of ['CDEF GABc|', 'C D/E/ F/4G/4A/ B2|']) {
      expect(layout(body).slots).toEqual(layout(body, 'M:C').slots);
    }
  });

  it('SVG：每组一个 jianpu-beam-group，横线用 jianpu-beam-line 且 stroke-width 取 metric；不分组时没有组元素', () => {
    const svg = serializeSvg(jianpuToSvg(layout('CDEF|')));
    expect(svg.match(/class="jianpu-beam-group"/g)?.length).toBe(2);
    expect(svg.match(new RegExp(`class="jianpu-beam-line" stroke-width="${String(JIANPU_METRICS.beamThickness)}"`, 'g'))?.length).toBe(2);
    expect(JIANPU_METRICS.beamThickness).toBe(1.4);
    expect(serializeSvg(jianpuToSvg(layout('CDEF|', 'M:C')))).not.toContain('jianpu-beam-group');
  });

  it('M:C / M:C| / 7/8：互相逐字段相同且 beams = []；缺席（少一行，sourceRef 整体前移）几何逐字段相同', () => {
    const base = layout('CDEF|', 'M:C');
    expect(base.beams).toEqual([]);
    for (const meterLine of ['M:C|', 'M:7/8']) {
      expect(layout('CDEF|', meterLine)).toStrictEqual(base);
    }
    const absent = layout('CDEF|', '');
    const geometry = (l: JianpuLayout): unknown => [l.slots, l.systems, l.width, l.height, l.beams, l.nodes.map((n) => [n.kind, n.x, n.y, n.width])];
    expect(geometry(absent)).toEqual(geometry(base));
  });

  it('tuplet 所在 measure 不分组（逐音减时线保留），其它 measure 照常', () => {
    const l = layout('(3CDE FG|AB|');
    expect(l.beams.map((group) => group.measureIndex)).toEqual([1]);
    expect(beamable(l).slice(0, 3).every((n) => n.duration.beams.length === 1)).toBe(true);
  });

  it('组成员全部落在同一个 system，且等于组的 systemIndex（窄宽度强制每行一个 measure）', () => {
    const l = layout('CDEF|C/D/E/F/ GA|CD E2|', 'M:4/4', '1/8', 16);
    expect(new Set(l.nodes.map((node) => node.systemIndex)).size).toBe(3);
    const systemOf = new Map(l.nodes.map((node) => [node.anchor.kind === 'event' ? node.anchor.eventId : '', node.systemIndex]));
    expect(l.beams.length).toBeGreaterThan(3);
    for (const group of l.beams) {
      expect(group.eventIds.map((id) => systemOf.get(id))).toEqual(group.eventIds.map(() => group.systemIndex));
    }
  });

  it('6/8：附点四分一拍', () => {
    expect(layout('CDEFGA|', 'M:6/8').beams.map((g) => g.eventIds.length)).toEqual([3, 3]);
  });

  it('确定性：同输入两次逐字段相等', () => {
    expect(layout('C D/E/ [CE]/4D/4E/ F|')).toEqual(layout('C D/E/ [CE]/4D/4E/ F|'));
  });
});
