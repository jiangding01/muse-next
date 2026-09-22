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
import { Formatter, Stave, StaveNote, StaveTie, TextNote, Voice, VoiceMode } from 'vexflow/bravura';

import { loadJcx } from '../../../src/formats/jcx';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffEventNode, StaffLayout } from '../../../src/notation/staff/staffTypes';
import { STAFF_METRICS } from '../../../src/notation/layout/metrics';
import { resolveTieNotes } from '../../../src/renderer/integrations/vexflow/vexRelations';
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

/**
 * T7.4 P1 回归 —— **同一小节内的 tie**。
 *
 * 现象：`"Bb"B2- B2 c2 |` 的延音线被画成一个看不出弧形的小点，而跨小节线的
 * `g4 e2- | e2` 正常。浏览器实测定位到真正的原因**不在端点解析**——画出来的 path 是
 * `M135.796 45 … 140.521 45`，恰好等于第一个音符的 `getTieRightX()` 与第二个音符的
 * `getTieLeftX()`，端点一个都没错；错的是**两个符头之间只剩 ≈5px**：当时一个四分音符
 * 列只有 24u，而 Bravura 符头（含符干/升降号）实测 12–24px 宽。修法是把
 * `STAFF_METRICS.minNoteSlotWidth` 按实测重新标定（16 → 40，见该常量的 JSDoc）。
 *
 * 本组用例因此钉两件事：
 * 1. 端点解析没有退化成「两端指向同一个 StaveNote」（那会让 `getFirstX()` 反而大于
 *    `getLastX()` 附近，是最容易悄悄引入的 bug）；
 * 2. 同一小节内相邻两个音符的跨度至少有 `tieContinuationMinSpan`——这正是本表为
 *    「续行段最小可见跨度」定义的那个数，同一条「弧要看得出是弧」的判据。
 */
describe('同一小节内的 tie（T7.4 P1 回归）', () => {
  function staveFor(layout: StaffLayout, built: ReturnType<typeof buildMeasureTickables>): Stave {
    const spec = layout.staves[0];
    if (spec === undefined) throw new Error('至少要有一条 stave');
    // 与 `renderStaff.ts` 的 stave/voice 装配同构（那边还要 ctx，这里只需要排版）。
    const stave = new Stave(spec.x, spec.y, Math.max(spec.width, 1));
    if (spec.clef !== undefined) stave.addClef(spec.clef);
    if (spec.timeSignature !== undefined) {
      stave.addTimeSignature(`${String(spec.timeSignature.numerator)}/${String(spec.timeSignature.denominator)}`);
    }
    const voice = new Voice({ numBeats: 3, beatValue: 4 });
    voice.setMode(VoiceMode.SOFT);
    voice.addTickables([...built.tickables]);
    voice.setStave(stave);
    new Formatter().joinVoices([voice]).formatToStave([voice], stave);
    return stave;
  }

  function prepareTie(body: string) {
    const loaded = loadJcx(`%MUSE2\nX:1\nM:3/4\nL:1/8\nK:Eb\nV:1 style=staff clef=treble\n${body}\n`);
    const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
    const voice = rendered.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const layout = layoutStaff(voice, {
      score: loaded.score, index: loaded.index, measurer, availableWidth: 100000,
    });
    const built = buildMeasureTickables(measureNodes(layout, 0), layout.clef);
    staveFor(layout, built);
    const nodes = new Map(
      layout.nodes.flatMap((node) => (node.anchor.kind === 'event' ? [[node.anchor.eventId, node] as const] : [])),
    );
    return { layout, built, index: { staveNotes: built.staveNotes, nodes } };
  }

  it('notation 层给出的两个端点是不同的事件（不是 from === to）', () => {
    const { layout } = prepareTie('"Bb"B2- B2 c2 |');
    const tie = layout.ties[0];
    expect(tie?.segment).toBe('whole');
    expect(tie?.from?.eventId).toBeDefined();
    expect(tie?.to?.eventId).toBeDefined();
    expect(tie?.from?.eventId).not.toBe(tie?.to?.eventId);
  });

  it('resolveTieNotes 解析出两个**不同的** StaveNote，且 firstX < lastX', () => {
    const { layout, index } = prepareTie('"Bb"B2- B2 c2 |');
    const tie = layout.ties[0];
    if (tie === undefined) throw new Error('应当有一条 tie');
    const notes = resolveTieNotes(tie, index);
    if (notes === undefined) throw new Error('两端都该解析得出来');
    expect(notes.firstNote).toBeDefined();
    expect(notes.lastNote).toBeDefined();
    expect(notes.firstNote).not.toBe(notes.lastNote);
    const staveTie = new StaveTie(notes);
    expect(staveTie.isPartial()).toBe(false);
    expect(staveTie.getFirstX()).toBeLessThan(staveTie.getLastX());
  });

  it('两个符头的横向间距至少有 tieContinuationMinSpan（弧要看得出是弧）', () => {
    const { layout, index } = prepareTie('"Bb"B2- B2 c2 |');
    const tie = layout.ties[0];
    if (tie === undefined || tie.from === undefined || tie.to === undefined) {
      throw new Error('应当有一条两端齐全的 tie');
    }
    const first = index.staveNotes.get(tie.from.eventId);
    const last = index.staveNotes.get(tie.to.eventId);
    if (first === undefined || last === undefined) throw new Error('两端都该有 StaveNote');
    expect(last.getAbsoluteX() - first.getAbsoluteX())
      .toBeGreaterThanOrEqual(STAFF_METRICS.tieContinuationMinSpan);
  });

  it('和弦符号挂在第一个音符上，不影响端点解析（宿主与 tie 起点是同一个 StaveNote）', () => {
    const { layout, built, index } = prepareTie('"Bb"B2- B2 c2 |');
    const tie = layout.ties[0];
    if (tie?.from === undefined) throw new Error('应当有 from 端');
    expect(built.annotations).toHaveLength(1);
    expect(index.staveNotes.get(tie.from.eventId)).toBe(built.tickables[0]);
  });
});
