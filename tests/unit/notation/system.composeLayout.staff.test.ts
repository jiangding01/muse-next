/**
 * M2.5 T9b.S —— Staff 纵向需求接入最终 system（composeLayout → layoutStaff external → 切片 → PageModel）。
 *
 * 期望值按公式手算：C8（`c'''`）上扩 64、C2（`C,,`）下扩 62，基础层高 96；`systemGap` / `layerGap` 取 `SYSTEM_METRICS`。
 */
import { describe, expect, it } from 'vitest';

import { STAFF_METRICS, SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffLayout } from '../../../src/notation/staff/staffTypes';
import type { ScoreLayout } from '../../../src/notation/system/composeLayout';
import type { ScoreSystemLayout } from '../../../src/notation/system/contracts';
import { pageModel } from '../../../src/notation/system/pageModel';
import { staffSystemSlice } from '../../../src/renderer/components/notation/systemSlices';
import { compose } from './system.composeLayout.helpers';
import { composed, externalFor, externalMeasurer, scoreOf, screen, voiceAt, withZeroTopInsets } from './systemExternal.helpers';

const BASE = STAFF_METRICS.systemHeight;
const GAP = SYSTEM_METRICS.systemGap;
const HEADER = 'M:4/4\nL:1/4';
const staffScore = (...bodies: string[]) => scoreOf(bodies.map((body) => ['staff', body] as const), HEADER);

function staffLayoutOf(layout: ScoreLayout, voiceIndex: number): StaffLayout {
  const entry = layout.voiceLayouts[voiceIndex];
  if (entry === undefined || entry.notation !== 'staff') throw new Error('no staff entry');
  return entry.layout;
}

function system(layout: ScoreLayout, index: number): ScoreSystemLayout {
  const found = layout.composed.systems.find((s) => s.index === index);
  if (found === undefined) throw new Error(`no system ${String(index)}`);
  return found;
}

const heightsOf = (layout: ScoreLayout) => layout.composed.systems.map((s) => s.layers.map((l) => l.height));

describe('T9b.S —— 单 Staff 声部：只有需要的那一行扩高', () => {
  const layout = compose(staffScore("C D E F| c''' D E F| C D E F| C,, D E F|"), screen(16));

  it('层高 / box 高：96、160、96、158；下一 system 的 origin.y 只多一次 systemGap', () => {
    expect(heightsOf(layout)).toEqual([[BASE], [BASE + 64], [BASE], [BASE + 62]]);
    expect(layout.composed.systems.map((s) => s.box.height)).toEqual([BASE, BASE + 64, BASE, BASE + 62]);
    expect(layout.composed.systems.map((s) => s.box.origin.y)).toEqual([0, BASE + GAP, 2 * BASE + 64 + 2 * GAP, 3 * BASE + 64 + 3 * GAP]);
  });

  it('stave y = 层 box 顶 + topExtra（只有上扩的那一行下移）；layoutStaff 的层 box 就是最终层', () => {
    const staff = staffLayoutOf(layout, 0);
    expect(staff.staves.map((s) => [s.systemIndex, s.y])).toEqual([[0, 0], [1, BASE + GAP + 64], [2, 2 * BASE + 64 + 2 * GAP], [3, 3 * BASE + 64 + 3 * GAP]]);
    expect(staff.systems.map((s) => s.box.height)).toEqual([BASE, BASE + 64, BASE, BASE + 62]);
  });

  it('切片：本地 y = topInset，高 = 最终层高（renderStaff 的 viewBox 取它）', () => {
    const staff = staffLayoutOf(layout, 0);
    expect([0, 1, 2, 3].map((i) => staffSystemSlice(staff, i).staves.map((s) => s.y))).toEqual([[0], [64], [0], [0]]);
    expect([0, 1, 2, 3].map((i) => staffSystemSlice(staff, i).height)).toEqual([BASE, BASE + 64, BASE, BASE + 62]);
  });
});

describe('T9b.S —— 多 Staff 声部：按 (voiceId, systemIndex) 独立', () => {
  const layout = compose(staffScore("c''' D E F| C D E F| C D E F|", 'C D E F| C,, D E F|'), screen(16));

  it('一个声部的高音不抬高另一个声部；同一声部的其它行也不受影响', () => {
    expect(heightsOf(layout)).toEqual([[BASE + 64, BASE], [BASE, BASE + 62], [BASE, BASE]]);
  });

  it('层 top 只在相邻已知层之间加 layerGap；box 高 = 层栈底', () => {
    const first = system(layout, 0);
    expect(first.layers.map((l) => l.top)).toEqual([0, BASE + 64 + SYSTEM_METRICS.layerGap]);
    expect(first.box.height).toBe(2 * BASE + 64 + SYSTEM_METRICS.layerGap);
  });

  it('absent 尾行：第二声部在 system 2 没有 measure，层高 96、没有 stave；第一声部的 stave 不下移', () => {
    const second = staffLayoutOf(layout, 1);
    expect(second.systems.map((s) => [s.index, s.box.height])).toEqual([[0, BASE], [1, BASE + 62], [2, BASE]]);
    expect(second.staves.map((s) => s.systemIndex)).toEqual([0, 1]);
    const tail = system(layout, 2);
    expect(staffLayoutOf(layout, 0).staves.find((s) => s.systemIndex === 2)?.y).toBe(tail.box.origin.y);
    expect(staffSystemSlice(second, 2).staves).toEqual([]);
  });

  it('第二层的 stave y = box 顶 + 层 top + 本层 topExtra', () => {
    const first = system(layout, 0);
    const top = first.layers[1]?.top ?? Number.NaN;
    expect(staffLayoutOf(layout, 1).staves.find((s) => s.systemIndex === 0)?.y).toBe(first.box.origin.y + top);
    expect(staffLayoutOf(layout, 0).staves.find((s) => s.systemIndex === 0)?.y).toBe(first.box.origin.y + 64);
  });
});

describe('T9b.S —— 跨行 tie 与附点和弦进入最终 system', () => {
  it('resolved 跨行 tie：两端所在的两行都下扩 10；unresolved 只扩源端那一行', () => {
    expect(heightsOf(compose(staffScore('C D E A,-| A, D E F|'), screen(16)))).toEqual([[BASE + 10], [BASE + 10]]);
    expect(heightsOf(compose(staffScore('C D E A,-| z B, D E|'), screen(16)))).toEqual([[BASE + 10], [BASE]]);
  });

  it('相邻音附点和弦：附点下移的那一侧也被包住', () => {
    expect(heightsOf(compose(staffScore('[A,3/2B,3/2] C/2 D E|'), screen(960)))).toEqual([[BASE + 4]]);
  });
});

describe('T9b.S —— 与和弦带共存', () => {
  it('和弦带在层之上：stave y = box 顶 + 带高 + topExtra', () => {
    const layout = compose(staffScore("\"C\"c''' D E F|"), screen(960));
    const first = system(layout, 0);
    const band = first.layers[0]?.top ?? Number.NaN;
    expect(band).toBeGreaterThan(0);
    expect(first.layers.map((l) => l.height)).toEqual([BASE + 64]);
    expect(first.box.height).toBe(band + BASE + 64);
    expect(staffLayoutOf(layout, 0).staves[0]?.y).toBe(first.box.origin.y + band + 64);
  });
});

describe('T9b.S —— layoutStaff 只消费 topInsets（裁决 M3）', () => {
  const source = staffScore('C D E F| C D E F|');
  const voice = voiceAt(source.renderScore, 0);
  const input = withZeroTopInsets(externalFor(composed(source.renderScore, screen(16)), voice.voiceId));
  const run = (topInsets: ReadonlyMap<number, number>) =>
    layoutStaff(voice, { score: source.score, index: source.index, measurer: externalMeasurer, availableWidth: 16, external: { ...input, topInsets } });
  const indices = input.systems.map((s) => s.index);

  it('给定内缩原样加到 stave y 上，不重算（音高再普通也照用）', () => {
    const shifted = run(new Map(indices.map((i) => [i, 7])));
    const plain = run(input.topInsets);
    expect(shifted.staves.map((s) => s.y)).toEqual(plain.staves.map((s) => s.y + 7));
    expect(shifted.systems).toEqual(plain.systems);
  });

  it('层高一致性（L-3）：内缩 + 96 恰等于层高可以；多 1 → RangeError；层高小于 96 → RangeError（不 clamp）', () => {
    const height = input.systems[0]?.box.height ?? Number.NaN;
    expect(height).toBeGreaterThan(BASE);
    expect(run(new Map(indices.map((i) => [i, height - BASE]))).staves.length).toBeGreaterThan(0);
    expect(() => run(new Map(indices.map((i) => [i, height - BASE + 1])))).toThrow(RangeError);
    const short = { ...input, systems: input.systems.map((sys) => ({ ...sys, box: { ...sys.box, height: BASE - 1 } })) };
    expect(() => layoutStaff(voice, { score: source.score, index: source.index, measurer: externalMeasurer, availableWidth: 16, external: short })).toThrow(RangeError);
  });

  it('缺条目 / 多条目 / 负数 / 非有限值 → RangeError（不回退 0）', () => {
    expect(() => run(new Map(indices.slice(1).map((i) => [i, 0])))).toThrow(RangeError);
    expect(() => run(new Map([...indices.map((i): [number, number] => [i, 0]), [999, 0]]))).toThrow(RangeError);
    expect(() => run(new Map(indices.map((i) => [i, -1])))).toThrow(RangeError);
    expect(() => run(new Map(indices.map((i) => [i, Number.NaN])))).toThrow(RangeError);
    expect(() => run(new Map(indices.map((i) => [i, Number.POSITIVE_INFINITY])))).toThrow(RangeError);
    expect(() => run(new Map())).toThrow(RangeError);
  });
});

describe('T9b.S —— PageModel 零修改：box.height 改变自然影响分页', () => {
  const bars = (bar: string) => bar.repeat(16);
  const page = { kind: 'page', contentWidth: SYSTEM_METRICS.page.width - SYSTEM_METRICS.page.marginLeft - SYSTEM_METRICS.page.marginRight } as const;
  const paged = (body: string) => {
    const layout = compose(staffScore(body), page);
    const { target, systems } = layout.composed;
    if (target !== 'page') throw new Error('not page');
    return { layout, model: pageModel({ target, systems }).model };
  };
  const normal = paged(bars('C D E F|'));
  const tall = paged(bars("c''' D E C,,|"));

  it('同样的行谱划分，高 Staff 的每行 = 96 + 64 + 62，页数更多', () => {
    expect(tall.layout.composed.systems.length).toBe(normal.layout.composed.systems.length);
    expect(tall.layout.composed.systems.every((s) => s.box.height === BASE + 64 + 62)).toBe(true);
    expect(normal.layout.composed.systems.every((s) => s.box.height === BASE)).toBe(true);
    expect(tall.model.pages.length).toBeGreaterThan(normal.model.pages.length);
  });

  it('每页的 system 高 + 间隙不超过内容框，且没有 overflow', () => {
    for (const { layout, model } of [normal, tall]) {
      for (const p of model.pages) {
        const heights = p.systemIndices.map((i) => system(layout, i).box.height);
        expect(p.overflow).toBe(false);
        expect(heights.reduce((a, b) => a + b, 0) + GAP * (heights.length - 1)).toBeLessThanOrEqual(p.contentBox.height);
      }
    }
  });
});
