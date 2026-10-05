/**
 * M2.5 T5-3 —— Staff external 路径（tier 1，用户裁决 K-b + 额外裁决 1–9）。
 *
 * 只断言 stave 边界与公共 measure 一致、行首预留不重复、行首 header 判据为 `contentOffsetX > 0`；
 * **不断言** stave 内音符 x（那是渲染器 formatter 的结果，tier 2 归 T5.S）。
 */
import { describe, expect, it } from 'vitest';

import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffContext } from '../../../src/notation/staff/layoutStaff';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { staffLineHeaderReserve } from '../../../src/notation/staff/staffHeader';
import { staffMeasureSpacing } from '../../../src/notation/staff/staffSlotWidths';
import type { StaffLayout } from '../../../src/notation/staff/staffTypes';
import type { ExternalInput } from './systemExternal.helpers';
import { composed, externalFor, externalMeasurer, scoreOf, screen, voiceAt } from './systemExternal.helpers';

const source = scoreOf([['staff', 'C D E F G A B c-|c B A G F E D C|C8|'], ['jianpu', 'C D E F G A B c|'.repeat(4)]]);
const render = source.renderScore;
const staff = voiceAt(render, 0);

function ctx(availableWidth: number, external?: ExternalInput): StaffContext {
  const base = { score: source.score, index: source.index, measurer: externalMeasurer, availableWidth };
  return external === undefined ? base : { ...base, external };
}
const externalLayout = (external: ExternalInput): StaffLayout => layoutStaff(staff, ctx(960, external));
const own = (input: ExternalInput) => input.measures.filter((m) => m.participation.some((p) => p.voiceId === staff.voiceId && p.kind !== 'absent'));

describe('T5-3 Staff external —— tier 1：stave 边界 = 公共 measure', () => {
  it.each([['960', 960], ['narrow', 16]] as const)('%s：stave.x / width 逐个等于 geometry.x / width；同行相邻 stave 首尾相接', (_label, width) => {
    const input = externalFor(composed(render, screen(width)), staff.voiceId);
    const layout = externalLayout(input);
    const geometries = own(input);
    expect(layout.staves.map((s) => [s.systemIndex, s.x, s.width])).toEqual(geometries.map((g) => [g.systemIndex, g.x, g.width]));
    layout.staves.forEach((stave, i) => {
      const next = layout.staves[i + 1];
      if (next !== undefined && next.systemIndex === stave.systemIndex) expect(stave.x + stave.width).toBe(next.x);
      expect(stave.y).toBe(layout.systems.find((s) => s.index === stave.systemIndex)?.box.origin.y);
    });
  });

  it('行首预留只算一次：行首 stave 宽 = 公共宽（已含 contentOffsetX），而非再加 staffLineHeaderReserve', () => {
    const input = externalFor(composed(render, screen(16)), staff.voiceId);
    const layout = externalLayout(input);
    const reserve = staffLineHeaderReserve(source.score);
    expect(reserve).toBeGreaterThan(0);
    const starts = own(input).filter((g) => g.contentOffsetX > 0);
    expect(starts.length).toBe(3);
    for (const g of starts) {
      expect(g.contentOffsetX).toBeGreaterThanOrEqual(reserve);
      const stave = layout.staves.find((s) => s.x === g.x && s.systemIndex === g.systemIndex);
      expect(stave?.width).toBe(g.width);
      expect(stave?.width).not.toBe(g.width + reserve);
    }
  });

  it('header（谱号 / 调号 / 拍号）只在 contentOffsetX > 0 的 stave 上；与 x 是否为 0 无关（K-b）', () => {
    const input = externalFor(composed(render, screen(960)), staff.voiceId);
    const shifted: ExternalInput = { ...input, measures: input.measures.map((m) => ({ ...m, x: m.x + 7 })) };
    const lineStarts = own(input).flatMap((g, local) => (g.contentOffsetX > 0 ? [local] : []));
    expect(lineStarts.length).toBeGreaterThan(1);
    for (const layout of [externalLayout(input), externalLayout(shifted)]) {
      expect(layout.staves.filter((s) => s.clef !== undefined).map((s) => s.measureIndex)).toEqual(lineStarts);
      for (const stave of layout.staves) {
        const header = lineStarts.includes(stave.measureIndex);
        expect([stave.clef !== undefined, stave.keySignature !== undefined, stave.timeSignature !== undefined]).toEqual([header, header, header]);
      }
    }
    expect(shifted.measures.some((m) => m.contentOffsetX > 0 && m.x === 0)).toBe(false);
  });
});

describe('T5-3 Staff external —— origin.x ≠ 0、y 随 index 递减（review M1）', () => {
  const input = externalFor(composed(render, screen(16)), staff.voiceId, { originX: 37.5, flipY: true });
  const layout = externalLayout(input);

  it('stave.x === origin.x + geometry.x，宽不变；宽高取最大外沿', () => {
    expect(layout.staves.map((s) => [s.x, s.width])).toEqual(own(input).map((g) => [37.5 + g.x, g.width]));
    expect(layout.width).toBe(37.5 + Math.max(...input.systems.map((s) => s.box.width)));
    expect(layout.systems[layout.systems.length - 1]?.box.origin.y).toBe(0);
    expect(layout.height).toBe(Math.max(...input.systems.map((s) => s.box.origin.y + s.box.height)));
  });
});

describe('T5-3 Staff external —— 不变量 / systemIndex / absent / 宽高', () => {
  const plain = layoutStaff(staff, ctx(16));
  const out = composed(render, screen(16));
  const sparse = externalFor(out, staff.voiceId, { relabel: (i) => 2 + 3 * i, reverse: true });
  const layout = externalLayout(sparse);

  it('measures / 节点 anchor / 诊断与默认路径相等', () => {
    expect(layout.measures).toEqual(plain.measures);
    expect(layout.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex])).toEqual(plain.nodes.map((n) => [n.kind, n.anchor, n.fallback, n.measureIndex]));
    expect(layout.diagnostics).toEqual(plain.diagnostics);
  });

  it('slot 取最终分配（P / 额外裁决 7）：首项不早于 contentOffsetX，收尾 barline 止于公共宽；拉伸行上与本声部 spacing 不同', () => {
    const input = externalFor(composed(render, screen(960)), staff.voiceId);
    const result = externalLayout(input);
    let stretched = 0;
    for (const slice of splitMeasures(staff.items)) {
      const g = own(input)[slice.index];
      const slots = result.slots.slice(slice.startIndex, slice.startIndex + slice.items.length);
      const spacing = staffMeasureSpacing(slice, externalMeasurer);
      expect(slots[0]?.slot.x).toBeGreaterThanOrEqual(g?.contentOffsetX ?? Number.NaN);
      const last = slots[slots.length - 1];
      expect((last?.slot.x ?? 0) + (last?.slot.width ?? 0)).toBe(g?.width);
      if ((g?.width ?? 0) > spacing.width + (g?.contentOffsetX ?? 0)) stretched += 1;
    }
    expect(stretched).toBeGreaterThan(0);
    result.nodes.forEach((node, i) => expect(node.slot.width).toBe(result.slots[i]?.slot.width));
  });

  it('全局稀疏 index 原样保留、升序返回；跨行 tie 的段行谱随之改写', () => {
    expect(layout.systems.map((s) => s.index)).toEqual([2, 5, 8, 11]);
    expect(layout.staves.map((s) => s.systemIndex)).toEqual([2, 5, 8]);
    expect(plain.ties.length).toBeGreaterThan(1);
    expect(layout.ties.map((t) => [t.segment, t.systemIndex])).toEqual(plain.ties.map((t) => [t.segment, 2 + 3 * t.systemIndex]));
  });

  it('absent 不造 measure / stave；本声部没有 measure 的公共行谱仍保留；宽高取最大外沿', () => {
    expect(layout.measures).toHaveLength(3);
    expect(layout.staves).toHaveLength(3);
    expect(layout.systems.map((s) => s.index)).toContain(11);
    expect(layout.width).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.x + s.box.width)));
    expect(layout.height).toBe(Math.max(...sparse.systems.map((s) => s.box.origin.y + s.box.height)));
  });

  it('非法输入一律 RangeError（A2）', () => {
    expect(() => externalLayout({ ...sparse, measures: sparse.measures.slice(0, 1) })).toThrow(RangeError);
    expect(() => externalLayout({ ...sparse, systems: sparse.systems.filter((s) => s.index !== 2) })).toThrow(RangeError);
    // 去掉本声部本来就没有 measure 的那一行不算违约（它只是空层）。
    expect(externalLayout({ ...sparse, systems: sparse.systems.filter((s) => s.index !== 11) }).staves).toHaveLength(3);
  });
});
