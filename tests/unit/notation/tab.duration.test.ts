/**
 * T6.2 —— TAB 时值装饰（符干 / 减时线 / 延音短横线 / 附点，纯数据）测试
 * （M2 方案 §3.3 / §6 T6.2）。
 *
 * 只测**几何数据**，不涉及 `toSvg` / renderer（T6.4）。时值来源（`decomposeDuration`
 * 的分解规则本身）已由 `tests/unit/notation/duration.test.ts` 覆盖，这里只测 TAB 层
 * 「拿到 `DurationDecomposition` 之后画成什么形状」这一步——纯合成 fixture，不引用
 * 任何真实曲目。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabContext, TabLayout } from '../../../src/notation/tab/layoutTab';
import { stringY } from '../../../src/notation/tab/tabGlyphs';
import type { TabNode } from '../../../src/notation/tab/tabGlyphs';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

/** `style=tab` 触发 lexer 的模式 B（spec §26.1）：小写字母是弦号，不是音高。 */
function tabHeader(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=tab\n${body}\n`;
}

function layout(text: string, availableWidth = WIDE): TabLayout {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  const ctx: TabContext = { index: loaded.index, measurer, availableWidth };
  return layoutTab(voice, ctx);
}

/**
 * `muse.render.duration.unresolved` / `.unrepresentable` 是**事件级**诊断，由
 * `buildRenderScore` 发出、挂在 `RenderScore.diagnostics` 上——不是 `layoutTab` 自己
 * 收集的 layout 级诊断（`TabLayout.diagnostics` 只含 `eventUnknown` /
 * `barlineUnrecognized` 这类 layout 判定产生的诊断）。核实契约 C2「fallback 节点
 * 至少关联一条诊断」时必须查这里，不能查 `layout(...)` 的返回值。
 */
function eventLevelDiagnosticCodes(text: string): readonly string[] {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  return rendered.diagnostics.map((diagnostic) => diagnostic.code);
}

function nodesOfKind<K extends TabNode['kind']>(
  result: TabLayout,
  kind: K,
): readonly Extract<TabNode, { kind: K }>[] {
  return result.nodes.filter(
    (node): node is Extract<TabNode, { kind: K }> => node.kind === kind,
  );
}

/** 递归收集一个布局产物里的全部数值，用于「所有坐标有限」的整体断言。 */
function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) numbersIn(entry, out);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) numbersIn(entry, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① 基本形态：符干 / 减时线 / 短符干 / 延音短横线
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— base ≤ 1/4：符干 + 减时线', () => {
  it('四分（base = 1/4）：符干存在，无减时线、无延音短横线、无附点', () => {
    const result = layout(tabHeader('a0 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const string6Y = stringY(note.y, TAB_METRICS.stringCount);
    expect(note.duration.unrepresentable).toBe(false);
    const stem = note.duration.stem;
    if (stem === undefined) throw new Error('四分音符应有符干');
    expect(stem.x1).toBe(stem.x2);
    expect(stem.x1).toBe(note.x);
    expect(stem.y1).toBe(string6Y + TAB_METRICS.stemOffsetY);
    expect(stem.y2 - stem.y1).toBe(TAB_METRICS.stemLength);
    expect(note.duration.beams).toEqual([]);
    expect(note.duration.dashes).toEqual([]);
    expect(note.duration.augmentationDots).toEqual([]);
    expect(note.fallback).toBe(false);
  });

  it('八分（base = 1/8）：1 条减时线，从符干底端向下、向右等距', () => {
    const result = layout(tabHeader('a0/ |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const stem = note.duration.stem;
    if (stem === undefined) throw new Error('八分音符应有符干');
    expect(note.duration.beams).toHaveLength(1);
    const beam = note.duration.beams[0];
    if (beam === undefined) throw new Error('缺少减时线');
    expect(beam.y1).toBe(stem.y2 + TAB_METRICS.beamFirstOffset);
    expect(beam.y1).toBe(beam.y2);
    expect(beam.x1).toBe(note.x);
    expect(beam.x2 - beam.x1).toBe(TAB_METRICS.beamLength);
    expect(note.duration.dashes).toEqual([]);
  });

  it('十六分（base = 1/16）：2 条减时线，相邻间距恒为 beamGap', () => {
    const result = layout(tabHeader('a0// |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    expect(note.duration.beams).toHaveLength(2);
    const [first, second] = note.duration.beams;
    if (first === undefined || second === undefined) throw new Error('减时线数量不对');
    expect(second.y1 - first.y1).toBe(TAB_METRICS.beamGap);
    expect(first.x1).toBe(second.x1);
    expect(first.x2).toBe(second.x2);
  });
});

describe('TAB 时值装饰 —— base = 1/2：短符干，无减时线、无延音短横线', () => {
  it('二分音符：短符干（halfStemLength），与四分的长符干明确区分', () => {
    const result = layout(tabHeader('a0*2 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const stem = note.duration.stem;
    if (stem === undefined) throw new Error('二分音符应有短符干');
    expect(stem.y2 - stem.y1).toBe(TAB_METRICS.halfStemLength);
    expect(stem.y2 - stem.y1).toBeLessThan(TAB_METRICS.stemLength);
    expect(note.duration.beams).toEqual([]);
    // 关键：`decomposeDuration` 对 1/2 算出的 dashes 是 1（简谱「延音线」的通用算法），
    // TAB 侧特意不采用它——半符干已经承担了「比四分长」这个视觉差异。
    expect(note.duration.dashes).toEqual([]);
  });
});

describe('TAB 时值装饰 —— base ≥ 1：不画符干，画延音短横线', () => {
  it('全音符（base = 1）：无符干，3 条延音短横线', () => {
    const result = layout(tabHeader('a0*4 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const string6Y = stringY(note.y, TAB_METRICS.stringCount);
    expect(note.duration.stem).toBeUndefined();
    expect(note.duration.dashes).toHaveLength(3);
    for (const dash of note.duration.dashes) {
      expect(dash.y1).toBe(string6Y + TAB_METRICS.stemOffsetY);
      expect(dash.y1).toBe(dash.y2);
      expect(dash.x2 - dash.x1).toBe(TAB_METRICS.dashLength);
    }
    // 相邻两条横线的水平间距恒为 dashLength + dashGap。
    const [d0, d1, d2] = note.duration.dashes;
    if (d0 === undefined || d1 === undefined || d2 === undefined) throw new Error('横线数量不对');
    expect(d1.x1 - d0.x1).toBe(TAB_METRICS.dashLength + TAB_METRICS.dashGap);
    expect(d2.x1 - d1.x1).toBe(TAB_METRICS.dashLength + TAB_METRICS.dashGap);
  });

  it('breve（base = 2/1，L:1/4 下的 *8）：无符干，7 条延音短横线，全部落在槽内且严格早于下一根小节线', () => {
    const result = layout(tabHeader('a0*8 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    const barline = nodesOfKind(result, 'barline')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    if (barline === undefined) throw new Error('缺少 barline 节点');
    expect(note.duration.stem).toBeUndefined();
    expect(note.duration.dashes).toHaveLength(7);
    const lastDash = note.duration.dashes[note.duration.dashes.length - 1];
    if (lastDash === undefined) throw new Error('缺少最后一条延音短横线');
    // 槽宽必须 ≥「延展 + 尾部留白」：最后一条横线的右端严格在槽右边界之内。
    expect(lastDash.x2).toBeLessThan(note.x + note.width);
    // 且严格早于紧随其后的小节线（不会视觉上贴线或穿线）。
    const barlineX = barline.lines[0]?.x1;
    if (barlineX === undefined) throw new Error('缺少小节线坐标');
    expect(lastDash.x2).toBeLessThan(barlineX);
  });
});

describe('TAB 时值装饰 —— 附点', () => {
  it('附点二分（base = 1/2, dots = 1）：附点画在符干右侧', () => {
    const result = layout(tabHeader('a0*3 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const stem = note.duration.stem;
    if (stem === undefined) throw new Error('附点二分音符应有短符干');
    expect(stem.y2 - stem.y1).toBe(TAB_METRICS.halfStemLength);
    expect(note.duration.augmentationDots).toHaveLength(1);
    const dot = note.duration.augmentationDots[0];
    if (dot === undefined) throw new Error('缺少附点');
    expect(dot.x).toBeGreaterThan(stem.x1);
    expect(dot.x).toBe(note.x + TAB_METRICS.augmentationDotOffsetX);
  });
});

// ---------------------------------------------------------------------------
// ② tabGroup 取组时值（末音）
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— tabGroup 按末音时值推导（spec §26.8）', () => {
  it('[a0/b2*2]：末音 b2 是二分，装饰按 2 倍算——短符干，不按首音 a0（八分）画', () => {
    const result = layout(tabHeader('[a0/b2*2] |'));
    const group = nodesOfKind(result, 'tabGroup')[0];
    if (group === undefined) throw new Error('缺少 tabGroup 节点');
    expect(group.durationValue).toEqual({ num: 1, den: 2 });
    const stem = group.duration.stem;
    if (stem === undefined) throw new Error('组时值（末音二分）应有短符干');
    expect(stem.y2 - stem.y1).toBe(TAB_METRICS.halfStemLength);
    expect(group.duration.beams).toEqual([]);
    expect(group.duration.dashes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ③ rest 同规则
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 休止符与音符共用同一套规则', () => {
  it('z*2（二分休止）：短符干，无减时线、无延音短横线，与 tabNote 同构', () => {
    const result = layout(tabHeader('z*2 |'));
    const rest = nodesOfKind(result, 'rest')[0];
    if (rest === undefined) throw new Error('缺少 rest 节点');
    expect(rest.durationValue).toEqual({ num: 1, den: 2 });
    const stem = rest.duration.stem;
    if (stem === undefined) throw new Error('二分休止应有短符干');
    expect(stem.y2 - stem.y1).toBe(TAB_METRICS.halfStemLength);
    expect(rest.duration.beams).toEqual([]);
    expect(rest.duration.dashes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ④ unrepresentable：不画任何装饰
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 无法分解的时值', () => {
  it('1/3（*1/3）：不画任何时值装饰，节点 fallback', () => {
    const result = layout(tabHeader('a0*1/3 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    expect(note.duration.unrepresentable).toBe(true);
    expect(note.duration.stem).toBeUndefined();
    expect(note.duration.beams).toEqual([]);
    expect(note.duration.dashes).toEqual([]);
    expect(note.duration.augmentationDots).toEqual([]);
    expect(note.fallback).toBe(true);
    // 诊断已由 `buildRenderScore` 在 event 级发出（本层不重复报，契约 C2 仍成立）。
    expect(eventLevelDiagnosticCodes(tabHeader('a0*1/3 |'))).toContain(
      'muse.render.duration.unrepresentable',
    );
  });
});

// ---------------------------------------------------------------------------
// ⑤ grace：不占时值，不画任何时值装饰
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 倚音不占时值，不画装饰', () => {
  it('倚音节点没有 duration 字段（不是「空装饰」，是压根不参与这套规则）', () => {
    const result = layout(tabHeader('{d8}d10 |'));
    const grace = nodesOfKind(result, 'grace')[0];
    if (grace === undefined) throw new Error('缺少 grace 节点');
    expect('duration' in grace).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 附点必须计入槽宽下界（2026-09-17 review P1：附点画出槽外）
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 附点计入槽宽下界（requiredDurationExtent）', () => {
  /** 附点全部严格在槽内、且严格早于紧随其后的小节线。 */
  function expectDotsWithinSlotAndBeforeBarline(result: TabLayout, note: { readonly x: number; readonly width: number }): void {
    const noteNode = nodesOfKind(result, 'tabNote')[0];
    if (noteNode === undefined) throw new Error('缺少 tabNote 节点');
    const barline = nodesOfKind(result, 'barline')[0];
    if (barline === undefined) throw new Error('缺少 barline 节点');
    const barlineX = barline.lines[0]?.x1;
    if (barlineX === undefined) throw new Error('缺少小节线坐标');
    expect(noteNode.duration.augmentationDots.length).toBeGreaterThan(0);
    for (const dot of noteNode.duration.augmentationDots) {
      const dotRightEdge = dot.x + TAB_METRICS.augmentationDotRadius;
      expect(dotRightEdge).toBeLessThan(note.x + note.width);
      expect(dotRightEdge).toBeLessThan(barlineX);
    }
  }

  it('a0*7（7/4，双附点全音符：dashes = 3、dots = 2）：两个附点严格在槽内、严格早于小节线', () => {
    const result = layout(tabHeader('a0*7 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    expect(note.duration.dashes).toHaveLength(3);
    expect(note.duration.augmentationDots).toHaveLength(2);
    expectDotsWithinSlotAndBeforeBarline(result, note);
  });

  it('a0*3（附点二分）：附点严格在槽内、严格早于小节线', () => {
    const result = layout(tabHeader('a0*3 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    expectDotsWithinSlotAndBeforeBarline(result, note);
  });

  it('a0*3/2（附点四分）：附点严格在槽内、严格早于小节线', () => {
    const result = layout(tabHeader('a0*3/2 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    expectDotsWithinSlotAndBeforeBarline(result, note);
  });
});

// ---------------------------------------------------------------------------
// ⑦ systemHeight 按实际最深装饰逐行谱回填（2026-09-17 review P1：`beams` 可到 8，
// 固定常量无法一次覆盖所有情形）
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 更细时值按实际深度回填行高，不再靠加大 systemHeight 兜底', () => {
  // `a0*1/16` = 1/64（beams = 4）、`a0*1/64` = 1/256（beams = 6）：两者纵向深度都
  // 超过 `TAB_METRICS.systemHeight`（覆盖到十六分音符、beams = 2）。窄容器把三个
  // measure 拆成三行谱，一行一个 measure。
  const DEEP_SOURCE = tabHeader('a0 b2 | a0*1/16 c3 | a0*1/64 d4 |');

  it('普通行谱（十六分及以内）高度仍等于 systemHeight，不受其它行谱影响', () => {
    const result = layout(DEEP_SOURCE, 40);
    expect(result.systems.length).toBe(3);
    const firstSystem = result.systems[0];
    if (firstSystem === undefined) throw new Error('缺少第一行谱');
    expect(firstSystem.box.height).toBe(TAB_METRICS.systemHeight);
  });

  it('beams = 4 / beams = 6 的行谱按实际深度补高，且严格高于 systemHeight', () => {
    const result = layout(DEEP_SOURCE, 40);
    const deepSystems = result.systems.slice(1);
    expect(deepSystems).toHaveLength(2);
    for (const system of deepSystems) {
      expect(system.box.height).toBeGreaterThan(TAB_METRICS.systemHeight);
    }
    // beams 越多（1/256 比 1/64 更细），需要的行高也越多。
    const [beams4System, beams6System] = deepSystems;
    if (beams4System === undefined || beams6System === undefined) throw new Error('行谱数量不对');
    expect(beams6System.box.height).toBeGreaterThan(beams4System.box.height);
  });

  it('补高之后行谱之间仍互不重叠，且每个节点的装饰都落在所属行谱的 box 高度之内', () => {
    const result = layout(DEEP_SOURCE, 40);
    for (const [index, system] of result.systems.entries()) {
      if (index === 0) continue;
      const previous = result.systems[index - 1];
      if (previous === undefined) throw new Error('system 序列缺项');
      expect(system.box.origin.y).toBeGreaterThanOrEqual(previous.box.origin.y + previous.box.height);
    }

    for (const kind of ['tabNote', 'tabGroup', 'rest'] as const) {
      for (const node of nodesOfKind(result, kind)) {
        const system = result.systems[node.systemIndex];
        if (system === undefined) throw new Error('节点指向了不存在的 system');
        const bottom = system.box.origin.y + system.box.height;
        const { stem, beams, dashes, augmentationDots } = node.duration;
        if (stem !== undefined) {
          expect(stem.y1).toBeLessThanOrEqual(bottom);
          expect(stem.y2).toBeLessThanOrEqual(bottom);
        }
        for (const beam of beams) expect(beam.y1).toBeLessThanOrEqual(bottom);
        for (const dash of dashes) expect(dash.y1).toBeLessThanOrEqual(bottom);
        for (const dot of augmentationDots) expect(dot.y).toBeLessThanOrEqual(bottom);
      }
    }
  });

  it('result.height = 最后一行谱的底边', () => {
    const result = layout(DEEP_SOURCE, 40);
    const lastSystem = result.systems[result.systems.length - 1];
    if (lastSystem === undefined) throw new Error('缺少最后一行谱');
    expect(result.height).toBe(lastSystem.box.origin.y + lastSystem.box.height);
  });

  it('纯函数：同一输入两次布局逐字段相等（含补高后的 systems）', () => {
    expect(layout(DEEP_SOURCE, 40)).toEqual(layout(DEEP_SOURCE, 40));
  });
});

// ---------------------------------------------------------------------------
// ⑧⑨ 整体不变量：装饰全在第 6 弦之下、坐标有限、确定性
// ---------------------------------------------------------------------------

describe('TAB 时值装饰 —— 整体不变量', () => {
  const MIXED_SOURCE = tabHeader('a0 a0/ a0// a0*2 | a0*3 a0*4 a0*8 [a0/b2*2] | z*2 a0*1/3 {d8}d10 |');

  it('所有装饰坐标（符干 / 减时线 / 延音短横线 / 附点）都严格在第 6 弦之下', () => {
    const result = layout(MIXED_SOURCE);
    for (const kind of ['tabNote', 'tabGroup', 'rest'] as const) {
      for (const node of nodesOfKind(result, kind)) {
        const string6Y = stringY(node.y, TAB_METRICS.stringCount);
        const { stem, beams, dashes, augmentationDots } = node.duration;
        if (stem !== undefined) {
          expect(stem.y1).toBeGreaterThan(string6Y);
          expect(stem.y2).toBeGreaterThan(string6Y);
        }
        for (const beam of beams) expect(beam.y1).toBeGreaterThan(string6Y);
        for (const dash of dashes) expect(dash.y1).toBeGreaterThan(string6Y);
        for (const dot of augmentationDots) expect(dot.y).toBeGreaterThan(string6Y);
      }
    }
  });

  it('所有坐标都是有限数（没有 NaN / ±Infinity 漏进几何）', () => {
    const result = layout(MIXED_SOURCE, 60);
    const values = numbersIn({
      systems: result.systems,
      nodes: result.nodes,
      staffLines: result.staffLines,
      slots: result.slots,
      width: result.width,
      height: result.height,
    });
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
  });

  it('纯函数：同一输入两次布局逐字段相等', () => {
    expect(layout(MIXED_SOURCE, 60)).toEqual(layout(MIXED_SOURCE, 60));
  });
});
