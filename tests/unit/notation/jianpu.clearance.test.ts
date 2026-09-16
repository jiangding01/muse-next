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
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuNode } from '../../../src/notation/jianpu/jianpuGlyphs';

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
