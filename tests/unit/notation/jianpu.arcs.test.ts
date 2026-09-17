/**
 * T5.2-B —— tie / slur 弧线的几何（M2 方案 v1.1.1 §3.2 / §22）。
 *
 * 两件事被钉死在这里：**弧高随跨度变化**（长跨度不再退化成一条贴着数字行的横线），
 * 以及**跨行谱按行谱切段**（每行谱各画一段，而不是一条从行末折返到行首的超长横线）。
 *
 * 纯结构断言，零 SVG 快照、零宿主字体依赖；`TextMeasurer` 一律注入确定性实现（§2.8）。
 * fixture 全部自造，真实语料不进仓库。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { anchorKey } from '../../../src/notation/model/types';
import type { JianpuArc } from '../../../src/notation/jianpu/jianpuGlyphs';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../src/notation/jianpu/toSvg';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;
/** 窄到一个 measure 就占满一行谱：用来制造多行谱，不依赖任何真实语料。 */
const NARROW = 120;

function layout(body: string, availableWidth = WIDE): JianpuLayout {
  const loaded = loadJcx(`%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1\n${body}\n`);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutJianpu(voice, {
    score: loaded.score,
    index: loaded.index,
    measurer,
    availableWidth,
  });
}

/** 取第 `index` 段弧；不存在就直接失败——断言里不写 `!`，也不静默跳过。 */
function arcOf(result: JianpuLayout, index: number): JianpuArc {
  const arc = result.arcs[index];
  if (arc === undefined) throw new Error(`第 ${String(index)} 段弧不存在`);
  return arc;
}

function spanOf(arc: JianpuArc): number {
  return arc.x2 - arc.x1;
}

describe('jianpu 弧线 —— 弧高随跨度变化（产品决定，不是格式事实）', () => {
  it('相邻两音的 tie 是一段小弧：弧高接近基准值，且远小于上限', () => {
    const result = layout('C-C|');
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    expect(arc.segment).toBe('whole');
    expect(arc.kind).toBe('tie');
    expect(arc.height).toBeGreaterThanOrEqual(JIANPU_METRICS.arcHeightMin);
    expect(arc.height - JIANPU_METRICS.arcHeight).toBeLessThan(2);
    expect(arc.height).toBeLessThan(JIANPU_METRICS.arcHeightMax);
  });

  it('同一行谱内跨度更大的 slur 弧更高，但不超过上限', () => {
    const short = arcOf(layout('(CD)|'), 0);
    const long = arcOf(layout('(CDEFGAB)|'), 0);
    const huge = arcOf(layout('(CDEFGABCDEFGABCDEFGABCDEFGAB)|'), 0);
    expect(spanOf(long)).toBeGreaterThan(spanOf(short));
    expect(long.height).toBeGreaterThan(short.height);
    expect(huge.height).toBeGreaterThan(long.height);
    expect(huge.height).toBe(JIANPU_METRICS.arcHeightMax);
    for (const arc of [short, long, huge]) {
      expect(arc.height).toBeLessThanOrEqual(JIANPU_METRICS.arcHeightMax);
    }
  });
});

describe('jianpu 弧线 —— 跨行谱切段（换行后每行谱各画一段）', () => {
  it('跨 2 行谱的 tie 切成 2 段（start + end），不画一条折返的长线', () => {
    const result = layout('CCCC-|CCCC|', NARROW);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);
    expect(result.arcs).toHaveLength(2);
    expect(result.arcs.map((arc) => arc.segment)).toEqual(['start', 'end']);
    expect(result.arcs.map((arc) => arc.systemIndex)).toEqual([0, 1]);
    for (const arc of result.arcs) expect(spanOf(arc)).toBeGreaterThan(0);
  });

  it('跨 2 行谱的 slur 切成 2 段', () => {
    const result = layout('(CDEF|GABC)|', NARROW);
    expect(result.arcs).toHaveLength(2);
    expect(result.arcs.every((arc) => arc.kind === 'slur')).toBe(true);
    expect(result.arcs.map((arc) => arc.segment)).toEqual(['start', 'end']);
  });

  it('跨 3 行谱的 slur 切成 3 段，首 / 中 / 末判别正确', () => {
    const result = layout('(CDEF|GABC|defg)|', NARROW);
    expect(result.systems).toHaveLength(3);
    expect(result.arcs).toHaveLength(3);
    expect(result.arcs.map((arc) => arc.segment)).toEqual(['start', 'middle', 'end']);
    expect(result.arcs.map((arc) => arc.systemIndex)).toEqual([0, 1, 2]);
    // 中段整行贯穿：它比首段的起点更靠左，比末段的终点更靠右。
    expect(arcOf(result, 1).x1).toBeLessThanOrEqual(arcOf(result, 0).x1);
    expect(arcOf(result, 1).x2).toBeGreaterThanOrEqual(arcOf(result, 2).x2);
  });

  it('每段的 x 落在所属行谱的 box 内，y 取该行谱自己的基线偏移', () => {
    const result = layout('(CDEF|GABC|defg)|', NARROW);
    for (const arc of result.arcs) {
      const system = result.systems[arc.systemIndex];
      if (system === undefined) throw new Error('每段弧都必须落在一行谱上');
      const left = system.box.origin.x;
      expect(arc.x1).toBeGreaterThanOrEqual(left);
      expect(arc.x2).toBeLessThanOrEqual(left + system.box.width);
      expect(arc.y).toBe(
        system.box.origin.y + JIANPU_METRICS.baselineOffset + JIANPU_METRICS.arcOffsetY,
      );
    }
  });

  it('每段按本段自己的跨度算弧高，坐标全为有限数', () => {
    const result = layout('(CDEF|GABC|defg)|', NARROW);
    for (const arc of result.arcs) {
      for (const value of [arc.x1, arc.x2, arc.y, arc.height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(arc.height).toBeGreaterThanOrEqual(JIANPU_METRICS.arcHeightMin);
      expect(arc.height).toBeLessThanOrEqual(JIANPU_METRICS.arcHeightMax);
    }
    // 三段跨度互不相同时弧高也随之不同——不是一个跨行谱共用的常数。
    expect(new Set(result.arcs.map((arc) => arc.height)).size).toBeGreaterThan(1);
  });

  it('同一输入两次布局逐字段相等（确定性）', () => {
    expect(layout('(CDEF|GABC|defg)|', NARROW).arcs).toEqual(
      layout('(CDEF|GABC|defg)|', NARROW).arcs,
    );
  });
});

describe('jianpu 弧线 —— 切段只增加视觉段，不增加 relation identity / 诊断', () => {
  it('跨 3 行谱的 3 段共用同一个 anchor，诊断条数与不换行时一致', () => {
    const wide = layout('(CDEF|GABC|defg)|');
    const narrow = layout('(CDEF|GABC|defg)|', NARROW);
    expect(wide.arcs).toHaveLength(1);
    expect(narrow.arcs).toHaveLength(3);
    const keys = new Set(narrow.arcs.map((arc) => anchorKey(arc.anchor)));
    expect(keys.size).toBe(1);
    expect([...keys]).toEqual([anchorKey(arcOf(wide, 0).anchor)]);
    expect(narrow.diagnostics.map((item) => item.code)).toEqual(
      wide.diagnostics.map((item) => item.code),
    );
  });

  it('toSvg 逐段输出一个 g，data-anchor-key 相同、data-arc-segment 区分段', () => {
    const svg = serializeSvg(jianpuToSvg(layout('(CDEF|GABC|defg)|', NARROW)));
    const groups = svg.match(/<g class="jianpu-arc-group"[^>]*>/g) ?? [];
    expect(groups).toHaveLength(3);
    const keys = groups.map((group) => /data-anchor-key="([^"]+)"/.exec(group)?.[1]);
    expect(new Set(keys).size).toBe(1);
    expect(groups.map((group) => /data-arc-segment="([^"]+)"/.exec(group)?.[1])).toEqual([
      'start',
      'middle',
      'end',
    ]);
  });
});

describe('jianpu 弧线 —— 端点对准数字字形而非时值槽位（不是格式事实，回归修复）', () => {
  it('四分音符 tie 到全音符：末端落在数字字形内，不是槽位中心', () => {
    const result = layout('C-C4|');
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    const lastNode = result.nodes[1];
    if (lastNode === undefined) throw new Error('全音符节点必须存在');
    expect(arc.x2).toBeGreaterThanOrEqual(lastNode.x);
    expect(arc.x2).toBeLessThanOrEqual(lastNode.x + lastNode.glyphWidth);
    expect(arc.x2).toBeLessThan(lastNode.x + lastNode.width / 2);
  });

  // T6.5 起，跨行末段的终点**不再**夹在字形 bbox 内：目标是行首第一个数字时
  // `[内容左界, 字形中心]` 只剩几个单位，弧会退化成尖角（人工复验发现）。末段因此
  // 保证 `arcContinuationMinSpan` 的最小可见跨度——它仍从字形中心起算，只是允许向右
  // 越过字形；同行谱内的整条弧（`whole`）不受影响，见上一条用例。
  it('跨行 tie 末段：全音符换行到下一行谱后，末端从数字起算并保证最小可见跨度', () => {
    const result = layout('CCCC-|C4|', NARROW);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);
    expect(result.arcs).toHaveLength(2);
    const endArc = arcOf(result, 1);
    expect(endArc.segment).toBe('end');
    const lastNode = result.nodes.find(
      (node) => node.systemIndex === endArc.systemIndex && node.kind === 'note',
    );
    if (lastNode === undefined) throw new Error('换行后的全音符节点必须存在');
    expect(endArc.x2).toBeGreaterThanOrEqual(lastNode.x);
    expect(spanOf(endArc)).toBeGreaterThanOrEqual(JIANPU_METRICS.arcContinuationMinSpan);
    expect(endArc.x2).toBeLessThan(lastNode.x + lastNode.width / 2);
  });

  it('零成员 chord 作 slur 端点：glyphWidth 为 0，弧线坐标仍全部有限', () => {
    const result = layout('([]D) {}C|');
    const chord = result.nodes.find((node) => node.kind === 'chord');
    const grace = result.nodes.find((node) => node.kind === 'grace');
    if (chord === undefined || grace === undefined) throw new Error('fixture 必须含零成员 chord 与 grace');
    expect(chord.glyphWidth).toBe(0);
    expect(grace.glyphWidth).toBe(0);
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    expect([arc.x1, arc.x2, arc.y, arc.height].every(Number.isFinite)).toBe(true);
    expect(arc.x1).toBe(chord.x);
  });

  it('首端为全音符时 x1 也落在数字字形内', () => {
    const result = layout('C4-C|');
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    const firstNode = result.nodes[0];
    if (firstNode === undefined) throw new Error('全音符节点必须存在');
    expect(arc.x1).toBeGreaterThanOrEqual(firstNode.x);
    expect(arc.x1).toBeLessThanOrEqual(firstNode.x + firstNode.glyphWidth);
    expect(arc.x1).toBeLessThan(firstNode.x + firstNode.width / 2);
  });
});

describe('jianpu 弧线 —— A 类恢复状态不受切段影响（§22）', () => {
  it('未解析的 tie 仍是单端一小截弧 + tie.unresolved', () => {
    const result = layout('C-|');
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    expect(arc.open).toBe(true);
    expect(arc.segment).toBe('whole');
    // `x1` 现在从字形中心（含 measurer 度量的浮点宽度）起算，容许浮点误差。
    expect(spanOf(arc)).toBeCloseTo(JIANPU_METRICS.arcOpenLength);
    expect(result.diagnostics.map((item) => item.code)).toContain(CODES.tieUnresolved);
  });

  it('未闭合的 slur 即便后面还有多行谱，也只画首端那一段，不为对端造端点', () => {
    const result = layout('(CDEF|GABC|defg|', NARROW);
    const open = result.arcs.filter((arc) => arc.open);
    expect(open).toHaveLength(1);
    const first = open[0];
    if (first === undefined) throw new Error('单端弧必须存在');
    expect(first.systemIndex).toBe(0);
    expect(first.segment).toBe('whole');
    expect(spanOf(first)).toBeCloseTo(JIANPU_METRICS.arcOpenLength);
    expect(result.diagnostics.map((item) => item.code)).toContain(CODES.slurUnclosed);
  });
});

describe('jianpu 弧线 —— 跨行谱续行段的最小可见跨度（T6.5，产品决定）', () => {
  /** 该行谱的 box 左右界；找不到就直接失败，不拿 0 兜底。 */
  function boxOf(result: JianpuLayout, systemIndex: number): { left: number; right: number } {
    const system = result.systems.find((item) => item.index === systemIndex);
    if (system === undefined) throw new Error(`第 ${String(systemIndex)} 行谱必须存在`);
    return { left: system.box.origin.x, right: system.box.origin.x + system.box.width };
  }

  it('跨 2 行谱的 tie：start 与 end 两段都至少有 arcContinuationMinSpan 的跨度', () => {
    // 末端是下一行谱的**第一个**数字：修复前 `[内容左界, 字形中心]` 只剩几个单位。
    const result = layout('CCCC-|C|', NARROW);
    expect(result.arcs).toHaveLength(2);
    for (const [index, segment] of (['start', 'end'] as const).entries()) {
      const arc = arcOf(result, index);
      expect(arc.segment).toBe(segment);
      expect(spanOf(arc)).toBeGreaterThanOrEqual(JIANPU_METRICS.arcContinuationMinSpan);
    }
  });

  it('跨 3 行谱的 slur：三段都不反向、都落在各自行谱的 box 内，续行两段满足最小跨度', () => {
    const result = layout('(CDEF|GABC|d)|', NARROW);
    expect(result.arcs).toHaveLength(3);
    for (const arc of result.arcs) {
      const box = boxOf(result, arc.systemIndex);
      expect(Number.isFinite(arc.x1)).toBe(true);
      expect(Number.isFinite(arc.x2)).toBe(true);
      expect(arc.x1).toBeLessThanOrEqual(arc.x2);
      expect(arc.x1).toBeGreaterThanOrEqual(box.left);
      expect(arc.x2).toBeLessThanOrEqual(box.right);
    }
    for (const arc of result.arcs.filter((item) => item.segment !== 'middle')) {
      expect(spanOf(arc)).toBeGreaterThanOrEqual(JIANPU_METRICS.arcContinuationMinSpan);
    }
  });

  it('极窄 system（box 比最小跨度还窄）允许退化：夹在 box 内、仍 finite、不反向', () => {
    // `availableWidth = 1` → 每个 measure 独占一行谱，行谱 box 宽 = 该 measure 宽；
    // 末行谱只有一个十六分音符、又没有收尾小节线，box 只有一个 `minSlotWidth` 宽，
    // 比 `arcContinuationMinSpan` 还窄——此时末段只能退化到 box 右界，不许越界。
    const result = layout('CCCC-|C/16', 1);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);
    expect(result.arcs).toHaveLength(2);
    const endArc = arcOf(result, 1);
    const endBox = boxOf(result, endArc.systemIndex);
    expect(endBox.right - endBox.left).toBeLessThan(JIANPU_METRICS.arcContinuationMinSpan);
    expect(spanOf(endArc)).toBeLessThan(JIANPU_METRICS.arcContinuationMinSpan);
    for (const arc of result.arcs) {
      const box = boxOf(result, arc.systemIndex);
      expect(Number.isFinite(arc.x1)).toBe(true);
      expect(Number.isFinite(arc.x2)).toBe(true);
      expect(Number.isFinite(arc.height)).toBe(true);
      expect(arc.x1).toBeLessThanOrEqual(arc.x2);
      expect(arc.x1).toBeGreaterThanOrEqual(box.left);
      expect(arc.x2).toBeLessThanOrEqual(box.right);
    }
  });

  it('同一行谱内的 whole 弧几何不受影响：两端仍精确等于各自的字形中心', () => {
    const result = layout('(CD)|');
    expect(result.arcs).toHaveLength(1);
    const arc = arcOf(result, 0);
    expect(arc.segment).toBe('whole');
    const [first, last] = [result.nodes[0], result.nodes[1]];
    if (first === undefined || last === undefined) throw new Error('fixture 必须有两个音符节点');
    expect(arc.x1).toBe(first.x + first.glyphWidth / 2);
    expect(arc.x2).toBe(last.x + last.glyphWidth / 2);
  });
});
