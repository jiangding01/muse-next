/**
 * T7.4 —— `renderer/integrations/vexflow/vexTickables.ts` 的 **tick 语义**测试。
 *
 * 本文件**真的 import vexflow**（`vexflow/bravura`，经由被测模块）并在 **node 环境**下
 * 构造 tickable：实测该入口在 node 下可以加载（它只是用 FontFace API 发起字体加载，
 * 不阻塞模块求值），而 tick 计算完全不碰 DOM。真正需要 DOM 的是 `renderStaff.ts` 的
 * 绘制，那一段留给 T7.5 的 Electron 人工 smoke。
 *
 * 要钉住的事实只有一条，但它是 T6.5 冻结的 overlay 语义的命根子：
 * **和弦符号不得推进时间轴**。`Formatter.createContexts()` 实测无条件执行
 * `ticksUsed.add(tickable.getTicks())`，`ignoreTicks` 只影响 `Voice` 的计数——所以
 * 「和弦符号 = 普通四分 TextNote + ignoreTicks」会把后面每个音符顶右一个四分音符。
 */
import { describe, expect, it } from 'vitest';
import { StaveNote, TextNote } from 'vexflow/bravura';

import { loadJcx } from '../../../src/formats/jcx';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffEventNode, StaffLayout } from '../../../src/notation/staff/staffTypes';
import { buildMeasureTickables } from '../../../src/renderer/integrations/vexflow/vexTickables';

const measurer = createDeterministicTextMeasurer();

function layoutOf(body: string): StaffLayout {
  const loaded = loadJcx(`%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=staff clef=treble\n${body}\n`);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutStaff(voice, {
    score: loaded.score, index: loaded.index, measurer, availableWidth: 100000,
  });
}

function measureNodes(layout: StaffLayout, measureIndex: number): readonly StaffEventNode[] {
  return layout.nodes.filter((node) => node.measureIndex === measureIndex);
}

describe('和弦符号是 overlay：一个 tick 都不占', () => {
  it('小节中间的和弦符号挂成宿主音符的 Annotation，不进 tickable 列表', () => {
    const layout = layoutOf('"C"C D E F |');
    const nodes = measureNodes(layout, 0);
    expect(nodes.some((node) => node.kind === 'chordSymbol')).toBe(true);

    const built = buildMeasureTickables(nodes, layout.clef);
    expect(built.annotations).toHaveLength(1);
    expect(built.annotations[0]?.node.kind).toBe('chordSymbol');
    // 四个音符恰好四个 tickable：和弦符号没有变成第五个。
    expect(built.tickables).toHaveLength(4);
    for (const tickable of built.tickables) expect(tickable).toBeInstanceOf(StaveNote);
  });

  it('宿主音符上确实挂着一个 Annotation 修饰', () => {
    const layout = layoutOf('"Am"C D |');
    const built = buildMeasureTickables(measureNodes(layout, 0), layout.clef);
    const host = built.tickables[0];
    if (!(host instanceof StaveNote)) throw new Error('第一个 tickable 应当是 StaveNote');
    expect(host.getModifiersByType('Annotation')).toHaveLength(1);
  });

  it('段末（后面没有音符/休止）的和弦符号退化成 TextNote，且 getTicks() 必须是 0', () => {
    const layout = layoutOf('C D "G" |');
    const built = buildMeasureTickables(measureNodes(layout, 0), layout.clef);
    expect(built.annotations).toHaveLength(0);
    const trailing = built.tickables[built.tickables.length - 1];
    if (!(trailing instanceof TextNote)) throw new Error('段末和弦符号应当退化成 TextNote');
    expect(trailing.getTicks().value()).toBe(0);
  });

  it('反例：普通 quarter 的 TextNote + ignoreTicks 仍然占 tick（这正是不能那样写的理由）', () => {
    const naive = new TextNote({ text: 'C', duration: 'q' });
    naive.setIgnoreTicks(true);
    expect(naive.getTicks().value()).toBeGreaterThan(0);
  });
});

describe('barline 节点不产生任何 tickable（视觉边界由 Stave 画，避免双线）', () => {
  it('小节线节点既不在 tickables 也不在 entries 里', () => {
    const layout = layoutOf('C D E F |');
    const nodes = measureNodes(layout, 0);
    expect(nodes.some((node) => node.kind === 'barline')).toBe(true);
    const built = buildMeasureTickables(nodes, layout.clef);
    expect(built.entries.some((entry) => entry.node.kind === 'barline')).toBe(false);
    expect(built.tickables).toHaveLength(nodes.filter((n) => n.kind === 'note').length);
  });
});

describe('显式 accidental 双写：key string 带记号 + Accidental 修饰', () => {
  it.each([
    ['^C', 'c#/4'],
    ['=C', 'cn/4'],
    ['_C', 'cb/4'],
    ['__C', 'cbb/4'],
    ['^^C', 'c##/4'],
  ])('%s → key %s，且挂一个 Accidental 修饰', (source, expectedKey) => {
    const layout = layoutOf(`${source} |`);
    const built = buildMeasureTickables(measureNodes(layout, 0), layout.clef);
    const note = built.tickables[0];
    if (!(note instanceof StaveNote)) throw new Error('应当是 StaveNote');
    expect(note.getKeys()).toEqual([expectedKey]);
    expect(note.getModifiersByType('Accidental')).toHaveLength(1);
  });

  it('没有显式 accidental 的音不挂修饰（调号内的升降由 VexFlow 按调号处理，不由我们推断）', () => {
    const layout = layoutOf('C |');
    const built = buildMeasureTickables(measureNodes(layout, 0), layout.clef);
    const note = built.tickables[0];
    if (!(note instanceof StaveNote)) throw new Error('应当是 StaveNote');
    expect(note.getKeys()).toEqual(['c/4']);
    expect(note.getModifiersByType('Accidental')).toHaveLength(0);
  });
});
