/**
 * T6.1 —— TAB（吉他六线谱）布局地基（M2 方案 §3.3 / §6 T6.1）。
 *
 * 主轴是**纯 Domain → Layout 的结构断言**：零 SVG 快照、零宿主字体依赖。`TextMeasurer`
 * 一律注入 T2 的 `createDeterministicTextMeasurer`（§2.8）。
 *
 * 用例里**不出现「拍」的假设**（P1-3）：所有时值都写成 `1/4` / `1/16` 这样相对全音符的
 * 绝对音长。语料相关的断言只用合成 fixture，不引用任何真实曲目。
 *
 * 本步覆盖的是地基：六线几何、measure/system 复用、事件节点放置、可见 fallback + 诊断。
 * 时值装饰、`-S-/-H-/-P-` 连线、stroke 方向记号、`toSvg` 属于 T6.2–T6.4，这里不测。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { DomainIndex, Score } from '../../../src/domain';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { spaceItems } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabContext, TabLayout } from '../../../src/notation/tab/layoutTab';
import { stringY } from '../../../src/notation/tab/tabGlyphs';
import type { TabNode, TabTextNode } from '../../../src/notation/tab/tabGlyphs';
import { widenForTabGlyphs } from '../../../src/notation/tab/tabSlotWidths';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

/** `style=tab` 触发 lexer 的模式 B（spec §26.1）：小写字母是弦号，不是音高。 */
function tabHeader(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=tab\n${body}\n`;
}

/** 对照用的 pitch 模式（模式 A）声部：用来构造「pitch 事件落进 TAB 布局」的越界场景。 */
function pitchHeader(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly ctx: TabContext;
}

function prepare(text: string, availableWidth = WIDE): Prepared {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return {
    score: loaded.score,
    index: loaded.index,
    voice,
    ctx: { index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): TabLayout {
  const prepared = prepare(text, availableWidth);
  return layoutTab(prepared.voice, prepared.ctx);
}

function codesOf(result: TabLayout): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function nodesOfKind<K extends TabNode['kind']>(
  result: TabLayout,
  kind: K,
): readonly Extract<TabNode, { kind: K }>[] {
  return result.nodes.filter(
    (node): node is Extract<TabNode, { kind: K }> => node.kind === kind,
  );
}

/**
 * 文本占位节点（装饰 / 和弦符号 / 未知 / 范围外）共用一个节点类型、`kind` 是四选一的
 * 联合，因此不能用上面的 `Extract` 取——单列一个类型守卫。
 */
function isTextNode(node: TabNode): node is TabTextNode {
  return (
    node.kind === 'decoration' ||
    node.kind === 'chordSymbol' ||
    node.kind === 'unknown' ||
    node.kind === 'outOfScope'
  );
}

function textNodes(result: TabLayout, kind: TabTextNode['kind']): readonly TabTextNode[] {
  return result.nodes.filter(isTextNode).filter((node) => node.kind === kind);
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
// ① 六线几何（§3.3：第 1 弦最上，弦号递增向下）
// ---------------------------------------------------------------------------

describe('TAB 六线几何 —— stringY / staffLines', () => {
  it('第 1 弦最上，六根弦 y 严格单调递增，相邻间距恒为 lineGap', () => {
    const staffTop = 100;
    const ys = ([1, 2, 3, 4, 5, 6] as const).map((index) => stringY(staffTop, index));
    expect(ys[0]).toBe(staffTop);
    for (const [offset, y] of ys.entries()) {
      if (offset === 0) continue;
      const previous = ys[offset - 1];
      if (previous === undefined) throw new Error('弦号序列缺项');
      expect(y).toBeGreaterThan(previous);
      expect(y - previous).toBe(TAB_METRICS.lineGap);
    }
  });

  it('每行谱恰好六条水平弦线，线长等于该 system box 宽（= 该行实际内容宽）', () => {
    const result = layout(tabHeader('a0 b2 |'));
    expect(result.staffLines).toHaveLength(result.systems.length);
    for (const staff of result.staffLines) {
      const system = result.systems[staff.systemIndex];
      if (system === undefined) throw new Error('staffLines 指向了不存在的 system');
      expect(staff.lines).toHaveLength(TAB_METRICS.stringCount);
      for (const [index, line] of staff.lines.entries()) {
        expect(line.y1).toBe(line.y2); // 水平线
        expect(line.y1).toBe(system.box.origin.y + TAB_METRICS.staffTopOffset + index * TAB_METRICS.lineGap);
        expect(line.x1).toBe(system.box.origin.x);
        expect(line.x2).toBe(system.box.origin.x + system.box.width);
      }
    }
  });

  it('节点的 y 就是所属 system 的第 1 弦线 y（staff 顶线）', () => {
    const result = layout(tabHeader('a0 b2 |'));
    for (const node of result.nodes) {
      const system = result.systems[node.systemIndex];
      if (system === undefined) throw new Error('节点指向了不存在的 system');
      expect(node.y).toBe(system.box.origin.y + TAB_METRICS.staffTopOffset);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 品位文本（spec §26.3：`digit+ | "x"`）
// ---------------------------------------------------------------------------

describe('TAB 品位文本 —— 多位品位与 x', () => {
  it('c12 是**整体一个** text "12"，不是两个字符；弦号取第 3 弦', () => {
    const result = layout(tabHeader('a0 b2 c12 |'));
    const notes = nodesOfKind(result, 'tabNote');
    expect(notes.map((node) => node.fret.text.text)).toEqual(['0', '2', '12']);
    expect(notes.map((node) => node.fret.stringIndex)).toEqual([1, 2, 3]);
  });

  it('fret 为 x（spec §26.3：由和弦图决定品位的右手拨弦）显示为 x', () => {
    const result = layout(tabHeader('[ax/bx/] |'));
    const groups = nodesOfKind(result, 'tabGroup');
    expect(groups).toHaveLength(1);
    expect(groups[0]?.frets.map((fret) => fret.text.text)).toEqual(['x', 'x']);
  });

  it('品位数字画在弦线上，白底矩形纵向覆盖该弦线（遮住被数字穿过的那一段）', () => {
    const result = layout(tabHeader('c12 |'));
    const note = nodesOfKind(result, 'tabNote')[0];
    if (note === undefined) throw new Error('缺少 tabNote 节点');
    const lineY = stringY(note.y, note.fret.stringIndex);
    expect(note.fret.backdrop.origin.y).toBeLessThan(lineY);
    expect(note.fret.backdrop.origin.y + note.fret.backdrop.height).toBeGreaterThan(lineY);
  });
});

// ---------------------------------------------------------------------------
// ③ tabGroup：同一列、按弦分行
// ---------------------------------------------------------------------------

describe('TAB 音符组 —— 同时拨响的多根弦（spec §26.8）', () => {
  it('成员按 stringIndex 升序分行、x 全相同（同一列纵向排开），y 逐弦下移', () => {
    const result = layout(tabHeader('V[ax/bx/cx/] |'));
    const group = nodesOfKind(result, 'tabGroup')[0];
    if (group === undefined) throw new Error('缺少 tabGroup 节点');
    expect(group.frets.map((fret) => fret.stringIndex)).toEqual([1, 2, 3]);
    const xs = new Set(group.frets.map((fret) => fret.text.x));
    expect(xs.size).toBe(1);
    for (const fret of group.frets) {
      expect(fret.backdrop.origin.y + fret.backdrop.height / 2).toBeCloseTo(
        stringY(group.y, fret.stringIndex),
      );
    }
  });

  it('同一根弦上的多个品位全部照画（会重叠）+ 一条 warning，不挑也不丢', () => {
    const prepared = prepare(tabHeader('[a0/a3/] |'));
    const result = layoutTab(prepared.voice, prepared.ctx);
    const group = nodesOfKind(result, 'tabGroup')[0];
    if (group === undefined) throw new Error('缺少 tabGroup 节点');
    expect(group.frets.map((fret) => fret.text.text)).toEqual(['0', '3']);
    expect(group.frets.map((fret) => fret.stringIndex)).toEqual([1, 1]);
    expect(group.fallback).toBe(true);
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabGroupDuplicateString);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('warning');
    expect(hits[0]?.anchor).toEqual({
      kind: 'event',
      voiceId: prepared.voice.voiceId,
      eventId: prepared.voice.items[0]?.eventId,
    });
  });

  it('弦号不重复的组不发重复诊断', () => {
    expect(codesOf(layout(tabHeader('[a0/b3/] |')))).not.toContain(CODES.tabGroupDuplicateString);
  });

  it('组时值取末音已由 Domain 解算，布局只透传不重新解释（spec §26.8）', () => {
    const { voice } = prepare(tabHeader('[ax/bx/] |'));
    const event = voice.items[0]?.event;
    if (event?.kind !== 'tabGroup') throw new Error('fixture 应产生 tabGroup');
    const result = layout(tabHeader('[ax/bx/] |'));
    expect(nodesOfKind(result, 'tabGroup')[0]?.durationValue).toEqual(event.duration);
  });
});

// ---------------------------------------------------------------------------
// ④ 槽宽：只加宽、不缩窄
// ---------------------------------------------------------------------------

describe('widenForTabGlyphs —— TAB-local 视觉下界（不改 shared spacing）', () => {
  it('两位品位把过窄的槽撑宽，且撑宽后的宽度 = 文本宽 + 2×fretPaddingX', () => {
    const { voice } = prepare(tabHeader('c12/4 |'));
    const measure = splitMeasures(voice.items)[0];
    if (measure === undefined) throw new Error('缺少 measure');
    const base = spaceItems(measure.items, measure.startIndex);
    const widened = widenForTabGlyphs(base, measure.items, measurer);
    expect(widened).not.toBe(base);
    const expected =
      measurer.measure('12', { fontSize: TAB_METRICS.fretFontSize }).width +
      2 * TAB_METRICS.fretPaddingX;
    expect(widened.slots[0]?.slot.width).toBeCloseTo(expected);
    // 只加宽、不缩窄：逐槽核对，且总宽单调不减。
    for (const [offset, slot] of widened.slots.entries()) {
      expect(slot.slot.width).toBeGreaterThanOrEqual(base.slots[offset]?.slot.width ?? 0);
      expect(slot.widthKind).toBe(base.slots[offset]?.widthKind);
      expect(slot.slot.index).toBe(base.slots[offset]?.slot.index);
    }
    expect(widened.width).toBeGreaterThan(base.width);
  });

  it('不需要加宽的 measure 返回**同一个引用**（没被动过就是没被动过）', () => {
    const { voice } = prepare(tabHeader('a0/4 b2/4 |'));
    const measure = splitMeasures(voice.items)[0];
    if (measure === undefined) throw new Error('缺少 measure');
    const base = spaceItems(measure.items, measure.startIndex);
    expect(widenForTabGlyphs(base, measure.items, measurer)).toBe(base);
  });
});

// ---------------------------------------------------------------------------
// ⑤⑥ 可见 fallback + 诊断（契约 C1 / C2 / C3）
// ---------------------------------------------------------------------------

describe('TAB 降级呈现 —— 未知事件与越界事件', () => {
  it('C1：未知 token 恰好一个可见节点，文本原样转述', () => {
    const result = layout(tabHeader('a0 ?? |'));
    const unknowns = textNodes(result, 'unknown');
    expect(unknowns).toHaveLength(1);
    expect(unknowns[0]?.text.text).toBe('??');
    expect(unknowns[0]?.fallback).toBe(true);
    expect(codesOf(result)).toContain(CODES.eventUnknown);
  });

  it('TAB 模式下的大写字母 C/D 在 Domain 里就是未知 token（spec §26.2 UNVERIFIED，不当音高解）', () => {
    const { voice } = prepare(tabHeader('C D |'));
    expect(voice.items.slice(0, 2).map((item) => item.event.kind)).toEqual(['unknown', 'unknown']);
  });

  it('C2/C3：pitch 模式的 note 事件进入 TAB 布局 → outOfScope 占位 + warning，anchor 指向该事件', () => {
    // 模式 B 的 lexer 不会产出 note 事件（上一条用例已证），故用模式 A 的声部手造这组
    // 越界输入：把 pitch 声部的 `RenderVoice` 直接喂给 `layoutTab`。
    const prepared = prepare(pitchHeader('C D |'));
    const result = layoutTab(prepared.voice, prepared.ctx);
    const outOfScope = textNodes(result, 'outOfScope');
    expect(outOfScope).toHaveLength(2);
    for (const node of outOfScope) expect(node.fallback).toBe(true);
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabEventOutOfScope);
    expect(hits).toHaveLength(2);
    for (const hit of hits) expect(hit.level).toBe('warning');
    expect(hits.map((hit) => hit.anchor)).toEqual(
      prepared.voice.items.slice(0, 2).map((item) => ({
        kind: 'event',
        voiceId: prepared.voice.voiceId,
        eventId: item.eventId,
      })),
    );
  });

  it('C2/C3：倚音成员是 pitch 模式音符 → 文本占位 + warning，anchor 指向该倚音事件', () => {
    const prepared = prepare(pitchHeader('{C}D |'));
    const result = layoutTab(prepared.voice, prepared.ctx);
    const grace = nodesOfKind(result, 'grace')[0];
    if (grace === undefined) throw new Error('缺少 grace 节点');
    expect(grace.frets).toEqual([]);
    expect(grace.outOfScopeTexts).toHaveLength(1);
    expect(grace.fallback).toBe(true);
    // 同一 fixture 里的 `D`（pitch 音符）也会各发一条，这里只取挂在倚音事件上的那条。
    const graceAnchor = {
      kind: 'event',
      voiceId: prepared.voice.voiceId,
      eventId: prepared.voice.items[0]?.eventId,
    };
    const hits = result.diagnostics.filter(
      (d) => d.code === CODES.tabEventOutOfScope && d.anchor.kind === 'event'
        && d.anchor.eventId === graceAnchor.eventId,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('warning');
    expect(hits[0]?.anchor).toEqual(graceAnchor);
  });

  it('多成员倚音与 tabGroup 同构：整组一次水平偏移，成员同一列、按弦分行', () => {
    const result = layout(tabHeader('{a0b12}c3 |'));
    const grace = nodesOfKind(result, 'grace')[0];
    if (grace === undefined) throw new Error('缺少 grace 节点');
    expect(grace.frets.map((fret) => fret.text.text)).toEqual(['0', '12']);
    expect(grace.frets.map((fret) => fret.stringIndex)).toEqual([1, 2]);
    const xs = new Set(grace.frets.map((fret) => fret.text.x));
    expect(xs.size).toBe(1);
    for (const fret of grace.frets) {
      expect(fret.backdrop.origin.y + fret.backdrop.height / 2).toBeCloseTo(
        stringY(grace.y, fret.stringIndex),
      );
    }
  });

  it('休止 z 照常占位；倚音成员是 TAB 音符时画小字号品位', () => {
    const result = layout(tabHeader('{d8}d10*6 z/ |'));
    const grace = nodesOfKind(result, 'grace')[0];
    if (grace === undefined) throw new Error('缺少 grace 节点');
    expect(grace.frets.map((fret) => fret.text.text)).toEqual(['8']);
    expect(grace.frets[0]?.text.fontSize).toBe(TAB_METRICS.graceFontSize);
    expect(grace.outOfScopeTexts).toEqual([]);
    expect(nodesOfKind(result, 'rest')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 小节线
// ---------------------------------------------------------------------------

describe('TAB 小节线 —— 贯穿六线，表外形态一律 unrecognized', () => {
  it('单线从第 1 弦贯穿到第 6 弦（barlineOverhang 参与上下外扩）', () => {
    const result = layout(tabHeader('a0 |'));
    const barline = nodesOfKind(result, 'barline')[0];
    if (barline === undefined) throw new Error('缺少 barline 节点');
    expect(barline.form).toBe('single');
    expect(barline.lines).toHaveLength(1);
    const line = barline.lines[0];
    if (line === undefined) throw new Error('缺少小节线线段');
    expect(line.x1).toBe(line.x2); // 竖线
    expect(line.y1).toBe(stringY(barline.y, 1) - TAB_METRICS.barlineOverhang);
    expect(line.y2).toBe(stringY(barline.y, TAB_METRICS.stringCount) + TAB_METRICS.barlineOverhang);
  });

  it('`||` 不在 spec §18 的四种 CONFIRMED 形态内 → unrecognized 单线 + 诊断', () => {
    const result = layout(tabHeader('a0 ||'));
    const barline = nodesOfKind(result, 'barline')[0];
    expect(barline?.form).toBe('unrecognized');
    expect(barline?.lines).toHaveLength(1);
    expect(barline?.fallback).toBe(true);
    expect(codesOf(result)).toContain(CODES.barlineUnrecognized);
  });

  it('`|]` 画细 + 粗两根线，两根都贯穿六线', () => {
    const result = layout(tabHeader('a0 |]'));
    const barline = nodesOfKind(result, 'barline')[0];
    if (barline === undefined) throw new Error('缺少 barline 节点');
    expect(barline.form).toBe('final');
    expect(barline.lines).toHaveLength(2);
    expect(barline.thickLineIndices).toEqual([1]);
    for (const line of barline.lines) {
      expect(line.y1).toBe(stringY(barline.y, 1) - TAB_METRICS.barlineOverhang);
      expect(line.y2).toBe(stringY(barline.y, TAB_METRICS.stringCount) + TAB_METRICS.barlineOverhang);
    }
  });

  it('`|:` 粗线在左、反复点在两根线右侧，全部坐标有限且贯穿六线', () => {
    const result = layout(tabHeader('|: a0 |'));
    const barline = nodesOfKind(result, 'barline')[0];
    if (barline === undefined) throw new Error('缺少 barline 节点');
    expect(barline.form).toBe('repeat-start');
    expect(barline.fallback).toBe(false);
    expect(barline.lines).toHaveLength(2);
    expect(barline.thickLineIndices).toEqual([0]);
    expect(barline.repeatDots).toHaveLength(2);
    const rightLine = barline.lines[1];
    if (rightLine === undefined) throw new Error('缺少第二根线');
    for (const dot of barline.repeatDots) {
      expect(dot.x).toBeGreaterThan(rightLine.x1);
      expect(Number.isFinite(dot.x) && Number.isFinite(dot.y)).toBe(true);
      expect(dot.y).toBeGreaterThan(stringY(barline.y, 1));
      expect(dot.y).toBeLessThan(stringY(barline.y, TAB_METRICS.stringCount));
    }
    for (const line of barline.lines) {
      expect(line.y1).toBe(stringY(barline.y, 1) - TAB_METRICS.barlineOverhang);
      expect(line.y2).toBe(stringY(barline.y, TAB_METRICS.stringCount) + TAB_METRICS.barlineOverhang);
    }
    expect(codesOf(result)).not.toContain(CODES.barlineUnrecognized);
  });

  it('`:|` 粗线在右、反复点在两根线左侧，全部坐标有限且贯穿六线', () => {
    const result = layout(tabHeader('a0 :|'));
    const barline = nodesOfKind(result, 'barline')[0];
    if (barline === undefined) throw new Error('缺少 barline 节点');
    expect(barline.form).toBe('repeat-end');
    expect(barline.fallback).toBe(false);
    expect(barline.lines).toHaveLength(2);
    expect(barline.thickLineIndices).toEqual([1]);
    expect(barline.repeatDots).toHaveLength(2);
    const leftLine = barline.lines[0];
    if (leftLine === undefined) throw new Error('缺少第一根线');
    for (const dot of barline.repeatDots) {
      expect(dot.x).toBeLessThan(leftLine.x1);
      expect(Number.isFinite(dot.x) && Number.isFinite(dot.y)).toBe(true);
    }
    for (const line of barline.lines) {
      expect(line.y1).toBe(stringY(barline.y, 1) - TAB_METRICS.barlineOverhang);
      expect(line.y2).toBe(stringY(barline.y, TAB_METRICS.stringCount) + TAB_METRICS.barlineOverhang);
    }
    expect(codesOf(result)).not.toContain(CODES.barlineUnrecognized);
  });
});

// ---------------------------------------------------------------------------
// ⑧⑨⑩ 换行 / 确定性 / 有限性 / Domain 不变
// ---------------------------------------------------------------------------

describe('TAB 换行与整体不变量', () => {
  const NARROW_SOURCE = tabHeader('a0 b2 | c3 d4 | e5 f6 |');

  it('窄容器下拆成多行谱，行与行的垂直范围互不重叠', () => {
    const result = layout(NARROW_SOURCE, 60);
    expect(result.systems.length).toBeGreaterThan(1);
    for (const [index, system] of result.systems.entries()) {
      if (index === 0) continue;
      const previous = result.systems[index - 1];
      if (previous === undefined) throw new Error('system 序列缺项');
      expect(system.box.origin.y).toBeGreaterThanOrEqual(
        previous.box.origin.y + previous.box.height,
      );
    }
    expect(result.height).toBe(
      (result.systems[result.systems.length - 1]?.box.origin.y ?? 0) +
        (result.systems[result.systems.length - 1]?.box.height ?? 0),
    );
  });

  it('纯函数：同一输入两次布局逐字段相等', () => {
    expect(layout(NARROW_SOURCE, 60)).toEqual(layout(NARROW_SOURCE, 60));
  });

  it('所有坐标都是有限数（没有 NaN / ±Infinity 漏进几何）', () => {
    const result = layout(tabHeader('{d8}d10*6 [ax/bx/] c12 z/ ?? |]'), 60);
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

  it('Domain 未被修改：事件对象仍是同一引用，Score 逐字段不变', () => {
    const prepared = prepare(tabHeader('a0 b2 c12 |'));
    const before = structuredClone(prepared.score);
    const result = layoutTab(prepared.voice, prepared.ctx);
    expect(result.nodes.length).toBeGreaterThan(0);
    expect(prepared.score).toEqual(before);
    expect(prepared.voice.items[0]?.event).toBe(prepared.score.voices[0]?.events[0]);
  });
});
