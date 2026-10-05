/**
 * M2.5 T8 —— `system/composeLayout.ts` 的简谱歌词部分（裁决 C / D）。
 *
 * 覆盖：prepass 层高与最终 layout 的歌词行数 / TAB 补高 / Staff 高一致（全部 fixture × 两档宽）；歌词行数 prepass 的边界
 * （verse 乱序取 max、无目标兜底到本声部最小行谱）；external 歌词以目标字形中心居中、missing-target 不变、默认路径不变。
 */
import { describe, expect, it } from 'vitest';

import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import { lyricBandHeight } from '../../../src/notation/jianpu/jianpuVerticalDemand';
import { JIANPU_METRICS, STAFF_METRICS, TAB_METRICS } from '../../../src/notation/layout/metrics';
import type { RenderItem, RenderScore } from '../../../src/notation/model/types';
import { composeScoreLayout } from '../../../src/notation/system/composeLayout';
import type { VoiceLayoutEntry } from '../../../src/notation/system/composeLayout';
import { extraSystemHeight } from '../../../src/notation/tab/tabVerticalDemand';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';
import { compose, jianpuOf, layerHeight, main, systemAt } from './system.composeLayout.helpers';
import { externalMeasurer as measurer, screen } from './systemExternal.helpers';

/** 单个简谱声部：音节多于可唱事件（后两个无目标，走行尾顺排）。 */
const ORPHAN = ['X:1', 'M:4/4', 'L:1/4', 'V:1 style=jianpu', 'K:C', '[V:1]C D z2|', 'w: lang ki mo ra', ''].join('\n');

describe('T8 composeLayout —— prepass 层高与最终 layout 一致（全部 fixture × 两档宽）', () => {
  /** 由最终 TAB layout 反推每行的补高（节点 systemIndex + measure 原始 items），与 prepass 互相独立。 */
  function tabExtraBySystem(layout: VoiceLayoutEntry['layout']): Map<number, number> {
    const systemOf = new Map(layout.nodes.flatMap((n) => (n.anchor.kind === 'event' ? [[n.anchor.eventId, n.systemIndex] as const] : [])));
    const items = new Map<number, RenderItem[][]>();
    for (const measure of layout.measures) {
      const first = measure.items[0];
      const systemIndex = first === undefined ? undefined : systemOf.get(first.eventId);
      if (systemIndex !== undefined) items.set(systemIndex, [...(items.get(systemIndex) ?? []), [...measure.items]]);
    }
    return new Map([...items].map(([k, v]) => [k, extraSystemHeight(v)]));
  }

  it.each(fixtureNames.map((name) => [name] as const))('%s', (name) => {
    const source = matrixScoreFrom(fixtureBytes(name));
    for (const width of [960, 16]) {
      const out = compose(source, screen(width));
      for (const entry of out.voiceLayouts) {
        const heightOf = (index: number): number | undefined =>
          systemAt(out, index).layers.find((l) => l.voiceId === entry.voiceId)?.height;
        if (entry.notation === 'jianpu') {
          for (const system of entry.layout.systems) {
            const own = entry.layout.lyrics.filter((l) => l.systemIndex === system.index);
            const rows = Math.max(0, ...own.map((l) => l.verseIndex + 1));
            expect(heightOf(system.index)).toBe(JIANPU_METRICS.systemHeight + lyricBandHeight(rows));
            // 歌词在层高之内（裁决 C：沿用既有公式）。
            for (const lyric of own) expect(lyric.text.y).toBeLessThanOrEqual(system.box.origin.y + system.box.height);
          }
        } else if (entry.notation === 'tab') {
          const extra = tabExtraBySystem(entry.layout);
          for (const system of entry.layout.systems) {
            expect(heightOf(system.index)).toBe(TAB_METRICS.systemHeight + (extra.get(system.index) ?? 0));
          }
        } else {
          for (const system of entry.layout.systems) expect(heightOf(system.index)).toBe(STAFF_METRICS.systemHeight);
        }
      }
    }
  });
});

describe('T8 composeLayout —— 歌词行数 prepass 的边界（与 external 路径同口径）', () => {
  it('同一行谱内 verse 1 先于 verse 0 出现（两段正文各带 w:）：行数取 max 而不是最后一条', () => {
    const body = ['[V:1]C D E F|', 'w: a b c d', 'w: e f g h', '[V:1]G A B c|', 'w: i j k l'];
    const source = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', 'V:1 style=jianpu', 'K:C', ...body, ''].join('\n'));
    const layout = compose(source);
    const lyrics = jianpuOf(layout).lyrics;
    expect(new Set(lyrics.map((l) => l.systemIndex))).toEqual(new Set([0]));
    expect(lyrics[lyrics.length - 1]?.verseIndex).toBe(0);
    expect(layerHeight(layout, 0, source, 0)).toBe(JIANPU_METRICS.systemHeight + lyricBandHeight(2));
  });

  it('整行无目标且 bodyRange 为 null：兜底到本声部 index 最小的行谱（group 不从 0 起），层高计入该行歌词', () => {
    const header = ['X:1', 'M:4/4', 'L:1/4', 'V:1 style=staff', 'V:2 style=jianpu', 'K:C'];
    const source = matrixScoreFrom([...header, '[V:1]C D E F|', '[V:2]C D E F|G A B c|', 'w: la li lo lu', ''].join('\n'));
    const [first, second] = source.renderScore.voices;
    if (first === undefined || second === undefined) throw new Error('voices');
    const lyricLines = second.voice.lyricLines.map((line) => ({
      ...line,
      bodyRange: null,
      syllables: line.syllables.map(({ target: _target, ...rest }) => rest),
    }));
    const render: RenderScore = { ...source.renderScore, voices: [first, { ...second, voice: { ...second.voice, lyricLines } }] };
    const layout = composeScoreLayout(render, source.index, measurer, screen(16));
    const jianpuSystems = layout.composed.systems.filter((sy) => sy.layers.some((l) => l.notation === 'jianpu'));
    const firstIndex = Math.min(...jianpuSystems.map((sy) => sy.index));
    expect(firstIndex).toBeGreaterThan(0);
    const lyrics = jianpuOf(layout).lyrics;
    expect(lyrics.length).toBeGreaterThan(0);
    expect(new Set(lyrics.map((l) => l.systemIndex))).toEqual(new Set([firstIndex]));
    expect(layerHeight(layout, firstIndex, source, 1)).toBe(JIANPU_METRICS.systemHeight + lyricBandHeight(1));
  });
});

describe('T8 composeLayout —— 歌词居中只改 external 路径（裁决 D）', () => {
  function visibleSyllables(render: RenderScore): { readonly target?: string; readonly text: string }[] {
    return (render.voices[0]?.voice.lyricLines ?? []).flatMap((line) => line.syllables
      .filter((s) => s.kind !== 'skip')
      .map((s) => (s.target === undefined ? { text: s.text } : { target: s.target.eventId, text: s.text })));
  }
  const widthOf = (text: string): number => measurer.measure(text, { fontSize: JIANPU_METRICS.lyricFontSize }).width;

  it('有目标音节：left = 目标字形中心 − 音节宽 / 2（不是列 x、不是 slot 中心）', () => {
    const jianpu = jianpuOf(compose(main));
    const nodeOf = new Map(jianpu.nodes.map((n) => [n.anchor.kind === 'event' ? n.anchor.eventId : '', n]));
    const syllables = visibleSyllables(main.renderScore);
    expect(jianpu.lyrics).toHaveLength(syllables.length);
    let differsFromColumn = 0;
    let differsFromSlot = 0;
    jianpu.lyrics.forEach((lyric, i) => {
      const node = nodeOf.get(syllables[i]?.target ?? '');
      if (node === undefined || !lyric.aligned) return;
      const width = widthOf(lyric.text.text);
      expect(lyric.text.x).toBe(node.x + node.glyphWidth / 2 - width / 2);
      if (lyric.text.x !== node.x) differsFromColumn += 1;
      if (lyric.text.x !== node.x + node.width / 2 - width / 2) differsFromSlot += 1;
    });
    expect(differsFromColumn).toBeGreaterThan(0);
    expect(differsFromSlot).toBeGreaterThan(0);
  });

  it('missing-target 音节不居中：仍从同一 (行谱, verse) 上一音节右侧 + lyricSyllableGap 顺排', () => {
    const lyrics = jianpuOf(compose(matrixScoreFrom(ORPHAN))).lyrics;
    expect(lyrics.map((l) => l.aligned)).toEqual([true, true, false, false]);
    for (const i of [2, 3]) {
      const prev = lyrics[i - 1];
      const expected = (prev?.text.x ?? Number.NaN) + widthOf(prev?.text.text ?? '') + JIANPU_METRICS.lyricSyllableGap;
      expect(lyrics[i]?.text.x).toBe(expected);
    }
  });

  it('默认路径（不传 external）逐字段不变：有目标音节仍左对齐列 x', () => {
    const voice = main.renderScore.voices[0];
    if (voice === undefined) throw new Error('no voice');
    const legacy = layoutJianpu(voice, { score: {}, index: main.index, measurer, availableWidth: 960 });
    const nodeOf = new Map(legacy.nodes.map((n) => [n.anchor.kind === 'event' ? n.anchor.eventId : '', n]));
    const syllables = visibleSyllables(main.renderScore);
    let checked = 0;
    legacy.lyrics.forEach((lyric, i) => {
      const node = nodeOf.get(syllables[i]?.target ?? '');
      if (node === undefined || !lyric.aligned) return;
      expect(lyric.text.x).toBe(node.x);
      checked += 1;
    });
    expect(checked).toBeGreaterThan(4);
  });
});
