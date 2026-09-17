/**
 * T6.5 —— overlay 列（`SlotWidthKind === 'overlay'`，当前只有和弦符号）。
 *
 * 人工复验发现：和弦符号原先按 `untimedSlotWidth` 占一个 12u 的窄列，于是 TAB 每小节
 * 的 `"C"` 都在六线与节奏带上撕开一道空档（`|||| ||||`）。本文件把「零宽 overlay 列」
 * 这个决定钉死：**不贡献段宽**、**`x` 贴后续第一个有实际列宽的事件左缘**、**不参与
 * 等距降级**；同时钉住「其余种类一个都没动」——装饰仍是 `untimed`、小节线仍是
 * `untimed`、时值列仍按字面 `duration` 加权。
 *
 * 纯结构断言，零 SVG 快照、零宿主字体依赖；`TextMeasurer` 一律注入确定性实现（§2.8）。
 * fixture 全部自造，真实语料不进仓库。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { SLOT_SPACING_METRICS } from '../../../src/notation/layout/metrics';
import { itemSlotWidth, spaceItems } from '../../../src/notation/layout/spacing';
import type { MeasureSpacing } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabLayout } from '../../../src/notation/tab/layoutTab';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

function source(body: string, voiceField = 'V:1', fields = 'M:4/4\nL:1/4\nK:C\n'): string {
  return `%MUSE2\nX:1\n${fields}${voiceField}\n${body}\n`;
}

function voiceOf(text: string): RenderVoice {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return voice;
}

/** 整个声部当成一段排布（fixture 只有一个 measure 时等价于该 measure）。 */
function spacingOf(text: string): MeasureSpacing {
  const voice = voiceOf(text);
  const measures = splitMeasures(voice.items);
  const first = measures[0];
  if (first === undefined) throw new Error('fixture 必须至少有一个 measure');
  return spaceItems(first.items, first.startIndex);
}

function jianpu(text: string): JianpuLayout {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutJianpu(voice, {
    score: loaded.score,
    index: loaded.index,
    measurer,
    availableWidth: WIDE,
  });
}

function tab(body: string): TabLayout {
  const loaded = loadJcx(source(body, 'V:1 style=tab'));
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutTab(voice, { index: loaded.index, measurer, availableWidth: WIDE });
}

/** 该 fixture 确实产出了和弦符号事件——否则下面的断言只是在测一个不存在的东西。 */
function expectChordSymbolAt(voice: RenderVoice, offset: number): void {
  expect(voice.items[offset]?.event.kind).toBe('chordSymbol');
}

describe('overlay 列 —— itemSlotWidth 的判定（一处判定）', () => {
  it('和弦符号 → 零宽 overlay 列，不是 untimed', () => {
    const voice = voiceOf(source('"C"C D|'));
    expectChordSymbolAt(voice, 0);
    const item = voice.items[0];
    if (item === undefined) throw new Error('缺少和弦符号 item');
    expect(itemSlotWidth(item)).toEqual({
      width: SLOT_SPACING_METRICS.overlaySlotWidth,
      kind: 'overlay',
    });
    expect(SLOT_SPACING_METRICS.overlaySlotWidth).toBe(0);
  });

  it('装饰仍是 untimed + untimedSlotWidth（T6.5 明确不动它）', () => {
    const voice = voiceOf(source('!TRILL!C D|'));
    const item = voice.items[0];
    if (item === undefined) throw new Error('缺少装饰 item');
    expect(item.event.kind).toBe('decoration');
    expect(itemSlotWidth(item)).toEqual({
      width: SLOT_SPACING_METRICS.untimedSlotWidth,
      kind: 'untimed',
    });
  });

  it('小节线仍是 untimed，时值列仍按字面 duration 加权（既有策略不变）', () => {
    const spacing = spacingOf(source('C|'));
    expect(spacing.slots.map((slot) => slot.widthKind)).toEqual(['timed', 'untimed']);
    expect(spacing.slots[0]?.slot.width).toBe(SLOT_SPACING_METRICS.quarterWidth);
    expect(spacing.slots[1]?.slot.width).toBe(SLOT_SPACING_METRICS.untimedSlotWidth);
  });
});

describe('overlay 列 —— 不贡献段宽、x 贴后续列（一处累计）', () => {
  it('和弦符号 + 音符：段宽与没有和弦符号时逐字段相等', () => {
    const plain = spacingOf(source('C D|'));
    const withChord = spacingOf(source('"C"C D|'));
    expect(withChord.width).toBe(plain.width);
    // overlay 列之后的每一列，x / width 与没有和弦符号时完全一致。
    expect(withChord.slots.slice(1).map((slot) => slot.slot.x)).toEqual(
      plain.slots.map((slot) => slot.slot.x),
    );
    expect(withChord.slots.slice(1).map((slot) => slot.slot.width)).toEqual(
      plain.slots.map((slot) => slot.slot.width),
    );
  });

  it('overlay 列的 x 等于后续第一个有实际列宽的事件的 x', () => {
    const spacing = spacingOf(source('"C"C D|'));
    expect(spacing.slots[0]?.widthKind).toBe('overlay');
    expect(spacing.slots[0]?.slot.width).toBe(0);
    expect(spacing.slots[0]?.slot.x).toBe(spacing.slots[1]?.slot.x);
  });

  it('连续两个和弦符号不制造空档：两列同 x、段宽仍与无和弦符号时相等', () => {
    const plain = spacingOf(source('C D|'));
    const doubled = spacingOf(source('"C""G"C D|'));
    expect(doubled.width).toBe(plain.width);
    expect(doubled.slots.slice(0, 2).every((slot) => slot.widthKind === 'overlay')).toBe(true);
    const target = doubled.slots[2]?.slot.x;
    expect(doubled.slots[0]?.slot.x).toBe(target);
    expect(doubled.slots[1]?.slot.x).toBe(target);
  });

  it('measure 末尾的和弦符号（无收尾小节线）：不推宽，x 恰好等于该 measure 末端', () => {
    const plain = spacingOf(source('C D'));
    const trailing = spacingOf(source('C D"C"'));
    const last = trailing.slots[trailing.slots.length - 1];
    if (last === undefined) throw new Error('缺少末列');
    expect(last.widthKind).toBe('overlay');
    expect(last.slot.width).toBe(0);
    expect(trailing.width).toBe(plain.width);
    expect(last.slot.x).toBe(trailing.width);
  });

  it('小节线之前的和弦符号：x 贴到小节线左缘，不额外推宽', () => {
    const plain = spacingOf(source('C D|'));
    const spacing = spacingOf(source('C D"C"|'));
    expect(spacing.width).toBe(plain.width);
    const overlay = spacing.slots[2];
    const barline = spacing.slots[3];
    expect(overlay?.widthKind).toBe('overlay');
    expect(barline?.widthKind).toBe('untimed');
    expect(overlay?.slot.x).toBe(barline?.slot.x);
  });
});

describe('overlay 列 —— 不参与等距降级（§2.6.1 R4 的降级只管有时值的列）', () => {
  it('measure 因 duration 不可知整体退等距时，和弦符号仍是 width=0 的 overlay', () => {
    // 没有 `L:` 时 Domain 只留 durationRaw，`duration` 缺失 → 整段退等距。
    const spacing = spacingOf('%MUSE2\nX:1\nK:C\nV:1\n"C"CDE|\n');
    expect(spacing.equidistant).toBe(true);
    const overlay = spacing.slots[0];
    expect(overlay?.widthKind).toBe('overlay');
    expect(overlay?.slot.width).toBe(SLOT_SPACING_METRICS.overlaySlotWidth);
    for (const slot of spacing.slots.slice(1)) {
      expect(slot.widthKind).toBe('equidistant');
      expect(slot.slot.width).toBe(SLOT_SPACING_METRICS.equidistantSlotWidth);
    }
    // 段宽 = 等距列数 × 等距列宽：overlay 列一点也没加进去。
    expect(spacing.width).toBe(
      (spacing.slots.length - 1) * SLOT_SPACING_METRICS.equidistantSlotWidth,
    );
  });
});

describe('overlay 列 —— 端到端：节点 x 与后续音符对齐，且后续音符位置不被推开', () => {
  it('Jianpu：和弦符号节点 x 等于后续音符 x，后续音符 x 与无和弦符号时相同', () => {
    const plain = jianpu(source('C D|'));
    const withChord = jianpu(source('"C"C D|'));
    const chordNode = withChord.nodes.find((node) => node.kind === 'chordSymbol');
    const firstNote = withChord.nodes.find((node) => node.kind === 'note');
    const plainFirstNote = plain.nodes.find((node) => node.kind === 'note');
    if (chordNode === undefined || firstNote === undefined || plainFirstNote === undefined) {
      throw new Error('fixture 必须同时含和弦符号节点与音符节点');
    }
    expect(chordNode.width).toBe(0);
    expect(chordNode.x).toBe(firstNote.x);
    expect(firstNote.x).toBe(plainFirstNote.x);
    expect(withChord.width).toBe(plain.width);
    // width=0 不影响文本本身的度量：字形仍按 textWidth 画；文本已剥掉最外层 JCX 引号。
    expect(chordNode.kind === 'chordSymbol' && chordNode.textWidth).toBeGreaterThan(0);
    expect(chordNode.kind === 'chordSymbol' && chordNode.text.text).toBe('C');
  });

  it('TAB：和弦符号节点 x 等于后续品位列 x，后续列 x 与无和弦符号时相同', () => {
    const plain = tab('a5 b3 |');
    const withChord = tab('"C"a5 b3 |');
    const chordNode = withChord.nodes.find((node) => node.kind === 'chordSymbol');
    const firstFret = withChord.nodes.find((node) => node.kind === 'tabNote');
    const plainFirstFret = plain.nodes.find((node) => node.kind === 'tabNote');
    if (chordNode === undefined || firstFret === undefined || plainFirstFret === undefined) {
      throw new Error('fixture 必须同时含和弦符号节点与品位节点');
    }
    expect(chordNode.width).toBe(0);
    expect(chordNode.x).toBe(firstFret.x);
    expect(firstFret.x).toBe(plainFirstFret.x);
    expect(withChord.width).toBe(plain.width);
    expect(chordNode.kind === 'chordSymbol' && chordNode.textWidth).toBeGreaterThan(0);
    expect(chordNode.kind === 'chordSymbol' && chordNode.text.text).toBe('C');
  });

  it('TAB：每小节一个和弦符号时六线不再被撕开空档——总宽与完全没有和弦符号时相等', () => {
    const plain = tab('a5 b3 | c2 d4 |');
    const withChords = tab('"C"a5 b3 | "G"c2 d4 |');
    expect(withChords.width).toBe(plain.width);
    expect(withChords.nodes.filter((node) => node.kind === 'chordSymbol')).toHaveLength(2);
  });
});
