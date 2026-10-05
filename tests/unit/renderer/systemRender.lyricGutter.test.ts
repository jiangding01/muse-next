/**
 * M2.5 T9c.P —— `buildScoreRender` 的全局左留白纳入简谱歌词左 extent（裁决 D4）。
 *
 * 合同：`leftGutter = max(0, −system.box.origin.x…, −lyricLeft…)`，`lyricLeft` 有目标 = `x − 宽/2`（middle 绘制）、
 * 无目标 = `x`（start 绘制）；`leftOffset = leftGutter + origin.x` 公式不变。期望值由测试侧从 layout 独立复算，
 * 并逐项断言：leftOffset ≥ 0、所有 system 的音乐 x = 0 落在同一 `leftGutter`、每个歌词左缘的页面位置 ≥ 0；
 * 没有简谱歌词的文档与 T9b 公式 `max(0, −origin.x…)` 完全相同；歌词只是 extent 测量，不改 layout。
 */
import { describe, expect, it } from 'vitest';

import type { ScoreLayout } from '../../../src/notation/system/composeLayout';
import { buildScoreRender } from '../../../src/renderer/components/notation/systemRender';
import type { ScoreRender } from '../../../src/renderer/components/notation/systemRender';
import { matrixScoreFrom } from '../notation/renderMatrix.helpers';
import { compose } from '../notation/system.composeLayout.helpers';
import type { Source } from '../notation/system.composeLayout.helpers';
import { externalMeasurer as measurer, screen } from '../notation/systemExternal.helpers';

const LONG = 'abcdefghijklmnopqrstuvwxyzabcdefgh';
const doc = (headers: readonly string[], body: readonly string[]): Source =>
  matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', ...headers, 'K:C', ...body, ''].join('\n'));

const LONG_LYRIC = doc(['V:1 style=jianpu'], ['[V:1]"Am"C D E F|', `w: ${LONG} b c d`]);
const BIG_CHORD = doc(['V:1 style=jianpu'], ['[V:1]"Cmaj7(#11)/G"C D E F|', 'w: a b c d']);
const ORPHAN_LONG = doc(['V:1 style=jianpu'], ['[V:1]z4|', `w: ${LONG}`]);
const TWO_VOICES = doc(['V:1 style=jianpu bracket=2', 'V:2 style=jianpu'], [
  '[V:1]C D E F|G A B c|C D E F|', 'w: a b c d e f g h i j k l',
  '[V:2]C D E F|G A B c|C D E F|', `w: a b c d ${LONG} f g h i j k l`,
]);
const NO_LYRIC = doc(['V:1 style=jianpu'], ['[V:1]"Cmaj7(#11)/G"C D E F|G A B c|']);
const NO_JIANPU = doc(['V:1 style=staff bracket=2', 'V:2 style=tab'], ['[V:1]"Am"C D E F|', `w: ${LONG} b c d`, '[V:2]C D E F|']);

interface Extents {
  readonly chord: number;
  readonly lyrics: readonly { readonly left: number; readonly aligned: boolean; readonly systemIndex: number }[];
}

/** 测试侧独立复算：system 左缘的最小值与每个简谱歌词的左缘。 */
function extentsOf(layout: ScoreLayout): Extents {
  return {
    chord: Math.min(0, ...layout.composed.systems.map((s) => s.box.origin.x)),
    lyrics: layout.voiceLayouts.flatMap((entry) => (entry.notation !== 'jianpu' ? [] : entry.layout.lyrics.map((lyric) => {
      const width = measurer.measure(lyric.text.text, { fontSize: lyric.text.fontSize }).width;
      return { left: lyric.aligned ? lyric.text.x - width / 2 : lyric.text.x, aligned: lyric.aligned, systemIndex: lyric.systemIndex };
    }))),
  };
}

function build(source: Source, width: number): { readonly layout: ScoreLayout; readonly result: ScoreRender; readonly extents: Extents } {
  const layout = compose(source, screen(width));
  return { layout, result: buildScoreRender(layout, source.renderScore, measurer), extents: extentsOf(layout) };
}

/** TextMeasurer 宽度推出的浮点期望用 `toBeCloseTo` 的位数；结构值（origin.x 网格、0、T9b 公式）仍精确断言。 */
const DIGITS = 9;

/**
 * 通用不变量：leftOffset ≥ 0、音乐 x = 0 全局对齐、每个歌词左缘的页面位置 ≥ 0。`measured` = gutter 由歌词测量宽度
 * 决定（`(gutter + origin.x) − origin.x` 不保证逐位还原），此时对齐断言用 `toBeCloseTo`，否则精确。
 */
function expectInvariants({ result, extents }: ReturnType<typeof build>, measured = false): void {
  for (const system of result.systems) {
    expect(system.leftOffset).toBeGreaterThanOrEqual(0);
    if (measured) expect(system.leftOffset - system.box.origin.x).toBeCloseTo(result.leftGutter, DIGITS);
    else expect(system.leftOffset - system.box.origin.x).toBe(result.leftGutter);
  }
  for (const lyric of extents.lyrics) expect(result.leftGutter + lyric.left).toBeGreaterThanOrEqual(0);
}

const minLyricLeft = (extents: Extents): number => Math.min(0, ...extents.lyrics.map((l) => l.left));

describe('T9c.P —— 全局 leftGutter 纳入简谱歌词左 extent', () => {
  it.each([[960], [60]] as const)('行首长歌词 > 和弦左墨迹（宽 %s）：gutter = −歌词左缘，且大于和弦留白', (width) => {
    const built = build(LONG_LYRIC, width);
    const lyricLeft = minLyricLeft(built.extents);
    expect(built.extents.chord).toBeLessThan(0);
    expect(lyricLeft).toBeLessThan(built.extents.chord);
    expect(built.result.leftGutter).toBeCloseTo(0 - lyricLeft, DIGITS);
    expectInvariants(built, true);
  });

  it.each([[960], [60]] as const)('和弦左墨迹 > 短歌词（宽 %s）：gutter 仍 = −origin.x（J4 不退化）', (width) => {
    const built = build(BIG_CHORD, width);
    expect(minLyricLeft(built.extents)).toBeLessThan(0);
    expect(minLyricLeft(built.extents)).toBeGreaterThan(built.extents.chord);
    expect(built.result.leftGutter).toBe(0 - built.extents.chord);
    expectInvariants(built);
  });

  it('多个简谱声部 × 多个 system：取全体最小左缘（来自第 2 声部、非首个 system 的行首长歌词）', () => {
    const built = build(TWO_VOICES, 60);
    expect(built.result.systems.length).toBeGreaterThan(1);
    const deepest = built.extents.lyrics.reduce((a, b) => (b.left < a.left ? b : a));
    expect(deepest.systemIndex).toBeGreaterThan(Math.min(...built.result.systems.map((s) => s.index)));
    expect(built.result.leftGutter).toBeCloseTo(0 - deepest.left, DIGITS);
    expectInvariants(built, true);
    // 同一文档在宽屏下长歌词落在行中：gutter 随之变小，但仍满足不变量。
    const wide = build(TWO_VOICES, 960);
    expect(wide.result.leftGutter).toBeLessThan(built.result.leftGutter);
    expectInvariants(wide, true);
  });

  it('无目标歌词以 start 绘制：左缘 = x（不减半宽），行首长串不制造 gutter', () => {
    const built = build(ORPHAN_LONG, 960);
    expect(built.extents.lyrics.map((l) => l.aligned)).toEqual([false]);
    expect(built.extents.lyrics[0]?.left).toBe(0);
    expect(Object.is(built.result.leftGutter, 0)).toBe(true);
    expectInvariants(built);
  });

  it.each([['无歌词', NO_LYRIC], ['无简谱（Staff 歌词 + TAB）', NO_JIANPU]] as const)('%s：与 T9b 公式 max(0, −origin.x…) 完全相同', (_name, source) => {
    for (const width of [960, 60]) {
      const built = build(source, width);
      expect(built.extents.lyrics).toEqual([]);
      expect(built.result.leftGutter).toBe(Math.max(0, ...built.layout.composed.systems.map((s) => 0 - s.box.origin.x)));
      expectInvariants(built);
    }
  });

  it('只做 extent 测量：buildScoreRender 前后 layout 逐字段不变', () => {
    const layout = compose(LONG_LYRIC, screen(960));
    const before = JSON.stringify(layout);
    buildScoreRender(layout, LONG_LYRIC.renderScore, measurer);
    expect(JSON.stringify(layout)).toBe(before);
  });
});
