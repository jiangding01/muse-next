/**
 * T5.2-C —— 歌词首行不得与数字下方装饰相交的几何回归（M2 方案 v1.1.1 §3.2）。
 *
 * 起因是真实成品 JCX 的人工 smoke：歌词首行与数字下方装饰（低八度点 / 减时线）重叠。
 * 几何探针确认根因是旧的 `lyricFirstOffset: 18` 小于最深下方装饰（两个低八度点，
 * `octaveDotFirstOffset + octaveDotGap + octaveDotRadius` = 14.5u）加歌词字形高度
 * （`lyricFontSize` = 12u）——18 < 14.5 + 12 = 26.5，必然相交。
 *
 * 本文件守的是一条几何不变量：**歌词字形顶 > 同一行谱内所有下方装饰的最深底边**。
 * 它不钉死任何具体数值（改常量不会让本文件失败，只要新数值仍满足这条不变量），
 * 因此把常量改回 18 会让这条不变量在断言 A 处失败——这正是本文件要守的场景。
 *
 * fixture **一律自造**（无意义音节 `la` / `li` / …），不引用 legacy-corpus 或任何真实语料，
 * 不出现真实标题 / 作者 / 歌词。断言全部是结构断言：零 SVG 快照、零宿主字体依赖。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { decomposeDuration } from '../../../src/notation/model/duration';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { barlineBottom, barlineTop, digitMidline, digitTop } from '../../../src/notation/jianpu/jianpuGlyphs';
import type { JianpuNode } from '../../../src/notation/jianpu/jianpuGlyphs';
import {
  buildBarlineGlyphs,
  buildDurationGlyphs,
  buildPitchGlyphs,
  classifyBarline,
} from '../../../src/notation/jianpu/jianpuGlyphBuilders';
import type { JianpuPitch } from '../../../src/notation/jianpu/pitchToNumber';

const measurer = createDeterministicTextMeasurer();

/**
 * 自造 fixture：`L:1/16` 让未写时值的音符默认落在十六分音符（两条减时线）；
 * `C,,` / `D,,` 是连续两个低八度音（各两个低八度点）；`E6` 是附点四分音符
 * （`6 × 1/16 = 3/8`，一个附点）；`[G,,B]` 是含低八度成员的和弦，覆盖
 * `pitchGlyphs.octaveDots`（含 chord members）这条路径。窄 `availableWidth`
 * 把两个 measure 拆成两行谱，两段 `w:` 制造两行歌词。
 */
const BODY = "C,, D,, E6 F|[G,,B] A B c|\nw: la li lo lu ta ti tu te\nw: na ne ni no nu nv nw nx";
const NARROW = 100;

function source(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/16\nK:C\nV:1 style=jianpu\n${body}\n`;
}

function layout(body: string, availableWidth: number): JianpuLayout {
  const loaded = loadJcx(source(body));
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

/** 与 `layout` 同源，但允许自定义 `fields`（改 `L:` 拿到不同减时线条数）。 */
function layoutSource(body: string, fields: string): JianpuLayout {
  const loaded = loadJcx(`%MUSE2\nX:1\n${fields}V:1 style=jianpu\n${body}\n`);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutJianpu(voice, {
    score: loaded.score,
    index: loaded.index,
    measurer,
    availableWidth: 100000,
  });
}

/**
 * 一个节点（note / rest / chord，含 chord 的每个 member）在下方能画出的所有装饰点的
 * y 坐标：减时线的两个端点、附点、八度点（+ 半径顶到最深处）。barline 的
 * `glyphs.lines` 按任务要求不检查（不与歌词框相交不用管）。
 */
function decorationYsOf(node: JianpuNode): readonly number[] {
  const ys: number[] = [];
  const pushDuration = (duration: { beams: readonly { y1: number; y2: number }[]; augmentationDots: readonly { y: number }[] }): void => {
    for (const beam of duration.beams) {
      ys.push(beam.y1, beam.y2);
    }
    for (const dot of duration.augmentationDots) {
      ys.push(dot.y);
    }
  };
  const pushOctaveDots = (octaveDots: readonly { y: number }[]): void => {
    for (const dot of octaveDots) {
      ys.push(dot.y + JIANPU_METRICS.octaveDotRadius);
    }
  };

  if (node.kind === 'note') {
    pushDuration(node.duration);
    pushOctaveDots(node.pitchGlyphs.octaveDots);
  } else if (node.kind === 'rest') {
    pushDuration(node.duration);
  } else if (node.kind === 'chord') {
    pushDuration(node.duration);
    for (const member of node.members) {
      if (member.pitchGlyphs !== undefined) pushOctaveDots(member.pitchGlyphs.octaveDots);
    }
  }
  return ys;
}

/** 某一行谱内，所有 note/rest/chord 节点能画出的下方装饰点里最靠下的一个 y。 */
function deepestDecorationY(result: JianpuLayout, systemIndex: number): number | undefined {
  let deepest: number | undefined;
  for (const node of result.nodes) {
    if (node.systemIndex !== systemIndex) continue;
    for (const y of decorationYsOf(node)) {
      if (deepest === undefined || y > deepest) deepest = y;
    }
  }
  return deepest;
}

describe('歌词首行字形顶 > 低八度点底（T5.2-C：守的是这一条几何不变量，不是具体数值）', () => {
  it('断言 A：每个非 skip 歌词节点的字形顶严格大于同一行谱内所有下方装饰的最深底边', () => {
    const result = layout(BODY, NARROW);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);
    expect(result.lyrics.length).toBeGreaterThan(0);

    for (const lyric of result.lyrics) {
      expect(lyric.syllableKind).not.toBe('skip');
      const glyphTop = lyric.text.y - JIANPU_METRICS.lyricFontSize;
      const deepest = deepestDecorationY(result, lyric.systemIndex);
      if (deepest === undefined) continue;
      expect(glyphTop).toBeGreaterThan(deepest);
    }
  });

  it('断言 B：第二行歌词（verseIndex 1）字形顶 ≥ 第一行歌词基线；行距不小于字号', () => {
    const result = layout(BODY, NARROW);
    // 行距不小于字号 → 两行文本的纵向范围天然不相交，这是断言成立的前提，先钉一下。
    expect(JIANPU_METRICS.lyricLineGap).toBeGreaterThanOrEqual(JIANPU_METRICS.lyricFontSize);

    for (const system of result.systems) {
      const rows = result.lyrics.filter((lyric) => lyric.systemIndex === system.index);
      const verse0 = rows.find((lyric) => lyric.verseIndex === 0);
      const verse1 = rows.find((lyric) => lyric.verseIndex === 1);
      if (verse0 === undefined || verse1 === undefined) continue;
      const verse1GlyphTop = verse1.text.y - JIANPU_METRICS.lyricFontSize;
      expect(verse1GlyphTop).toBeGreaterThanOrEqual(verse0.text.y);
    }
  });

  it('断言 D（U-Polish Phase A item 3）：固定层序「数字 → 减时线 → 低八度点」——不论减时线条数，低八度点恒在最深一条减时线之下，从不相交也不翻转', () => {
    // `L:1/32`：四分音符基准下 32 分音符有 3 条减时线；`C,,` 是低两个八度（2 个低点）。
    // `L:1/4` 作为「无减时线」的对照组（0 条减时线场景）。
    const withBeams = layoutSource('C,, D,,|', 'M:4/4\nL:1/32\nK:C\n');
    const withoutBeams = layoutSource('C,, D,,|', 'M:4/4\nL:1/4\nK:C\n');

    for (const layoutResult of [withBeams, withoutBeams]) {
      for (const node of layoutResult.nodes) {
        if (node.kind !== 'note') continue;
        const beamYs = node.duration.beams.flatMap((beam) => [beam.y1, beam.y2]);
        const lowDotYs = node.pitchGlyphs.octaveDots
          .filter((dot) => dot.y > node.y) // 只看低方向（below）的点
          .map((dot) => dot.y - JIANPU_METRICS.octaveDotRadius); // 点的上边缘
        if (beamYs.length === 0 || lowDotYs.length === 0) continue;
        const deepestBeamY = Math.max(...beamYs);
        const shallowestDotEdge = Math.min(...lowDotYs);
        expect(shallowestDotEdge).toBeGreaterThan(deepestBeamY);
      }
    }
  });

  it('断言 D 续：减时线越多，低八度点整体越往下让（同一起点，单调不减），层序本身不因此翻转', () => {
    const oneBeam = layoutSource('C,,|', 'M:4/4\nL:1/8\nK:C\n');
    const threeBeams = layoutSource('C,,|', 'M:4/4\nL:1/32\nK:C\n');
    const dotYOf = (r: JianpuLayout): number => {
      const note = r.nodes.find((n) => n.kind === 'note');
      const dot = note?.kind === 'note' ? note.pitchGlyphs.octaveDots[0] : undefined;
      if (dot === undefined) throw new Error('缺少低八度点');
      return dot.y;
    };
    expect(dotYOf(threeBeams)).toBeGreaterThanOrEqual(dotYOf(oneBeam));
  });

  it('断言 C：相邻行谱纵向不相交，最后一行歌词基线落在所在行谱 box 底边之内', () => {
    const result = layout(BODY, NARROW);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);

    for (let i = 1; i < result.systems.length; i += 1) {
      const previous = result.systems[i - 1];
      const current = result.systems[i];
      if (previous === undefined || current === undefined) continue;
      expect(current.box.origin.y).toBeGreaterThanOrEqual(previous.box.origin.y + previous.box.height);
    }

    const lastVerseBySystem = new Map<number, number>();
    for (const lyric of result.lyrics) {
      const known = lastVerseBySystem.get(lyric.systemIndex);
      if (known === undefined || lyric.verseIndex > known) lastVerseBySystem.set(lyric.systemIndex, lyric.verseIndex);
    }
    for (const lyric of result.lyrics) {
      if (lyric.verseIndex !== lastVerseBySystem.get(lyric.systemIndex)) continue;
      const system = result.systems[lyric.systemIndex];
      expect(system).toBeDefined();
      if (system === undefined) continue;
      expect(lyric.text.y).toBeLessThanOrEqual(system.box.origin.y + system.box.height);
    }
  });
});

/**
 * U-Polish Phase A 用户裁决补充（compare-04 一组几何不变量）：直接调用字形构造函数
 * （`buildDurationGlyphs`/`buildPitchGlyphs`/`buildBarlineGlyphs`），不经过 JCX 解析——
 * 这样每条不变量只依赖它自己关心的输入，不与 parse/spacing 的其它规则耦合，钉的是
 * `jianpuGlyphBuilders.ts` 自身的几何契约。
 */
describe('U-Polish Phase A 补充几何不变量（用户裁决，对应 compare-04 fixture）', () => {
  it('断言 E：延音线 y 恒等于 digitMidline(baselineY)；长度 == dashLength；数字→首线、线→线均等距（== dashGap）', () => {
    const baselineY = 100;
    // 全音符（duration = 1，相对全音符的绝对音长）：base=1、dots=0 → dashes=3，覆盖“多条等距”。
    const decomposition = decomposeDuration({ num: 1, den: 1 });
    if (decomposition.kind !== 'glyph') throw new Error('全音符必须可分解');
    const glyphs = buildDurationGlyphs(decomposition, 0, baselineY);
    expect(glyphs.dashes.length).toBeGreaterThanOrEqual(2);
    const mid = digitMidline(baselineY);
    for (const dash of glyphs.dashes) {
      expect(dash.y1).toBe(mid);
      expect(dash.y2).toBe(mid);
      expect(dash.x2 - dash.x1).toBe(JIANPU_METRICS.dashLength);
    }
    expect(glyphs.dashes[0]?.x1).toBe(JIANPU_METRICS.dashFirstOffset);
    // “与数字等距”：数字→首线的间距和线→线的间距是同一个数。
    expect(JIANPU_METRICS.dashFirstOffset).toBe(JIANPU_METRICS.dashGap);
    for (let i = 1; i < glyphs.dashes.length; i += 1) {
      const prev = glyphs.dashes[i - 1];
      const cur = glyphs.dashes[i];
      if (prev === undefined || cur === undefined) continue;
      expect(cur.x1 - prev.x2).toBe(JIANPU_METRICS.dashGap);
    }
  });

  it('断言 F：附点 y 恒等于 digitMidline(baselineY)；紧贴数字右侧（首偏移 == augmentationDotFirstOffset）', () => {
    const baselineY = 50;
    // 附点四分音符：duration = 3/8（相对全音符），base=1/4、dots=1。
    const decomposition = decomposeDuration({ num: 3, den: 8 });
    if (decomposition.kind !== 'glyph') throw new Error('附点四分音符必须可分解');
    const glyphs = buildDurationGlyphs(decomposition, 0, baselineY);
    expect(glyphs.augmentationDots).toHaveLength(1);
    expect(glyphs.augmentationDots[0]?.y).toBe(digitMidline(baselineY));
    expect(glyphs.augmentationDots[0]?.x).toBe(JIANPU_METRICS.augmentationDotFirstOffset);
  });

  it('断言 G：高八度点「顶距数字顶」== octaveDotGap；相邻两点间距同样 == octaveDotGap', () => {
    const baselineY = 80;
    const pitch: JianpuPitch = { number: 4, octaveDots: 2, octaveDotDirection: 'above', mixedOctave: false };
    const glyphs = buildPitchGlyphs(pitch, 0, baselineY, 0);
    expect(glyphs.octaveDots).toHaveLength(2);
    expect(digitTop(baselineY) - (glyphs.octaveDots[0]?.y ?? 0)).toBe(JIANPU_METRICS.octaveDotGap);
    expect((glyphs.octaveDots[0]?.y ?? 0) - (glyphs.octaveDots[1]?.y ?? 0)).toBe(JIANPU_METRICS.octaveDotGap);
  });

  it('断言 H：1/2 条减时线 × 1/2 个低八度点全部四种组合——低八度点恒严格在最深一条减时线之下，层序不因组合翻转', () => {
    const baselineY = 60;
    for (const beamCount of [1, 2]) {
      for (const dots of [1, 2]) {
        const pitch: JianpuPitch = { number: 5, octaveDots: dots, octaveDotDirection: 'below', mixedOctave: false };
        const glyphs = buildPitchGlyphs(pitch, 0, baselineY, beamCount);
        expect(glyphs.octaveDots).toHaveLength(dots);
        const deepestBeamY =
          baselineY + JIANPU_METRICS.beamFirstOffset + (beamCount - 1) * JIANPU_METRICS.beamGap;
        const shallowestDotEdge = Math.min(
          ...glyphs.octaveDots.map((dot) => dot.y - JIANPU_METRICS.octaveDotRadius),
        );
        expect(shallowestDotEdge).toBeGreaterThan(deepestBeamY);
      }
    }
  });

  it('断言 I：四种 CONFIRMED 小节线形态 + unrecognized（`|` `||` `|:` `:|` `|]`）在同一基线下 top/bottom 完全一致', () => {
    const baselineY = 40;
    const top = barlineTop(baselineY);
    const bottom = barlineBottom(baselineY);
    for (const raw of ['|', '||', '|:', ':|', '|]']) {
      const form = classifyBarline(raw);
      const glyphs = buildBarlineGlyphs(form, 0, baselineY);
      expect(glyphs.lines.length).toBeGreaterThan(0);
      for (const line of glyphs.lines) {
        expect(line.y1).toBe(top);
        expect(line.y2).toBe(bottom);
      }
    }
  });

  it('断言 M（二次裁决，反复记号 `|:`/`:|`）：线高与数字行接近（barlineTop/Bottom 之和 ≈ 1.1×digitFontSize，且比首版 1.2× 更矮）', () => {
    const baselineY = 40;
    const top = barlineTop(baselineY);
    const bottom = barlineBottom(baselineY);
    const totalHeight = bottom - top;
    expect(totalHeight).toBeCloseTo(JIANPU_METRICS.digitFontSize * 1.1, 1);
    expect(totalHeight).toBeLessThan(JIANPU_METRICS.digitFontSize * 1.2);
  });

  it('断言 N（二次裁决）：反复点围绕 digitMidline 对称（不是围绕基线），间距 == repeatDotOffsetY×2', () => {
    const baselineY = 40;
    const glyphs = buildBarlineGlyphs('repeat-start', 0, baselineY);
    expect(glyphs.repeatDots).toHaveLength(2);
    const [upper, lower] = glyphs.repeatDots;
    if (upper === undefined || lower === undefined) throw new Error('反复点应有两个');
    const mid = digitMidline(baselineY);
    expect(mid - upper.y).toBe(JIANPU_METRICS.repeatDotOffsetY);
    expect(lower.y - mid).toBe(JIANPU_METRICS.repeatDotOffsetY);
    expect(lower.y - upper.y).toBe(JIANPU_METRICS.repeatDotOffsetY * 2);
  });

  it('断言 O（二次裁决）：`|:` 与 `:|` 镜像一致——线形态互换、点集合以小节线中点镜像对称', () => {
    const baselineY = 40;
    const start = buildBarlineGlyphs('repeat-start', 0, baselineY);
    const end = buildBarlineGlyphs('repeat-end', 0, baselineY);
    // 线段集合完全一致（同一对 x 位置、同一 top/bottom），只是粗线下标互换。
    expect(start.lines).toEqual(end.lines);
    expect(start.thickLineIndices).toEqual([0]);
    expect(end.thickLineIndices).toEqual([1]);
    // 点数、点的纵向偏移完全一致，只是取左侧还是右侧互换（镜像）。
    expect(start.repeatDots).toHaveLength(2);
    expect(end.repeatDots).toHaveLength(2);
    const startYs = start.repeatDots.map((dot) => dot.y);
    const endYs = end.repeatDots.map((dot) => dot.y);
    expect(startYs).toEqual(endYs);
    // `repeat-start` 的点在第二条线右侧、`repeat-end` 的点在第一条线左侧，到各自最近
    // 线的水平距离相等（== repeatDotOffsetX），即镜像对称而非巧合重合。
    const secondLineX = JIANPU_METRICS.barlineCompositeGap;
    expect((start.repeatDots[0]?.x ?? 0) - secondLineX).toBe(JIANPU_METRICS.repeatDotOffsetX);
    expect(0 - (end.repeatDots[0]?.x ?? 0)).toBe(JIANPU_METRICS.repeatDotOffsetX);
  });

  it('断言 J：同一行谱内相邻两段歌词（verse 0/1）的基线 y 差恒等于 lyricLineGap', () => {
    const result = layout('C D|\nw: la li\nw: ta ti', 100000);
    const verse0 = result.lyrics.find((lyric) => lyric.verseIndex === 0);
    const verse1 = result.lyrics.find((lyric) => lyric.verseIndex === 1);
    expect(verse0).toBeDefined();
    expect(verse1).toBeDefined();
    if (verse0 === undefined || verse1 === undefined) return;
    expect(verse1.text.y - verse0.text.y).toBe(JIANPU_METRICS.lyricLineGap);
  });

  it('断言 K：compare-04 同款组合 fixture——歌词底边到下一行谱顶边的间距恒 ≥ 0（不倒灌进下一行谱）', () => {
    const body =
      "C2 D4 E3/2 F' G,|\n L:1/8\nA,|\n L:1/16\nB,,|C||D|:E:|F|]\nw: la li lo lu ta ti fa so re mi\nw: na ne ni no nu nv ja ji ju je";
    const result = layout(body, NARROW);
    expect(result.systems.length).toBeGreaterThanOrEqual(2);
    for (const lyric of result.lyrics) {
      const nextSystem = result.systems[lyric.systemIndex + 1];
      if (nextSystem === undefined) continue;
      expect(nextSystem.box.origin.y - lyric.text.y).toBeGreaterThanOrEqual(0);
    }
  });

  it.each([
    ['0 条减时线（L:1/4，四分音符 C,）', 'M:4/4\nL:1/4\nK:C\n'],
    ['3 条减时线（L:1/32，三十二分音符 C,）', 'M:4/4\nL:1/32\nK:C\n'],
  ] as const)('断言 L：1 个低八度点（C,）× %s × 有歌词行——歌词字形顶严格大于该行所有下方装饰的最深底边', (_label, fields) => {
    const result = layoutSource("C, D, E, F,|\nw: la li lo lu", fields);
    expect(result.lyrics.length).toBeGreaterThan(0);
    for (const lyric of result.lyrics) {
      const glyphTop = lyric.text.y - JIANPU_METRICS.lyricFontSize;
      const deepest = deepestDecorationY(result, lyric.systemIndex);
      expect(deepest).toBeDefined();
      if (deepest === undefined) continue;
      expect(glyphTop).toBeGreaterThan(deepest);
    }
  });
});
