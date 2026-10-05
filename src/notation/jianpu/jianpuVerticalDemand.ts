/**
 * notation/jianpu —— 简谱层的**纵向需求**（M2.5 T8，用户裁决 A / C / J，2026-10-05）。
 *
 * 一行谱的层高 = `systemHeight` + 歌词带（沿用默认路径的 `lyricBandHeight`，裁决 C：不趁 T8 收紧余量）。
 * 歌词带只取决于「哪些音节落在哪一行谱」：`assignLyricSyllables` 归属行谱只读列的 `systemIndex`，不读 x，
 * 所以在任何 x / y 确定之前、只凭 measure → system 的归属就能数出每行谱用掉几行歌词。默认路径
 * （`layoutJianpu.ts`）与 T8 的 vertical prepass 共用本文件的 `lyricBandHeight`。纯函数。
 */

import { JIANPU_METRICS } from '../layout/metrics';
import { splitMeasures } from '../layout/systems';
import type { RenderVoice } from '../model/types';
import { assignLyricSyllables } from './jianpuSections';
import type { LyricColumn } from './jianpuSections';

/**
 * 一行谱为 `rows` 行歌词预留的额外高度。`rows === 0` 时不留任何余量——「这一行没有
 * 歌词」和「有歌词但空着」是两件事。
 */
export function lyricBandHeight(rows: number): number {
  return rows === 0 ? 0 : JIANPU_METRICS.lyricFirstOffset + rows * JIANPU_METRICS.lyricLineGap;
}

/**
 * 每个给定行谱上的歌词行数（= 该行谱内出现过的最大 `verseIndex + 1`，没有歌词为 0）。
 *
 * 与 external 路径的 `layoutJianpu` 同口径：列只带 `systemIndex`（来自 `systemOfMeasure`：本地 measure 下标 →
 * 全局 systemIndex），无从得知行谱时退到 `systemIndices` 中最小的那个（= external 路径按 index 升序后的首个行谱）。
 */
export function jianpuLyricRows(
  voice: RenderVoice,
  systemOfMeasure: ReadonlyMap<number, number>,
  systemIndices: readonly number[],
): ReadonlyMap<number, number> {
  const columnByEvent = new Map<string, LyricColumn>();
  for (const measure of splitMeasures(voice.items)) {
    const systemIndex = systemOfMeasure.get(measure.index);
    if (systemIndex === undefined) continue;
    for (const item of measure.items) columnByEvent.set(item.eventId, { x: 0, systemIndex });
  }
  const fallbackSystemIndex = systemIndices.length === 0 ? 0 : Math.min(...systemIndices);
  const rows = new Map(systemIndices.map((systemIndex) => [systemIndex, 0]));
  for (const line of assignLyricSyllables(voice, (id) => columnByEvent.get(id), fallbackSystemIndex)) {
    for (const { systemIndex, verseIndex } of line) {
      const current = rows.get(systemIndex);
      if (current !== undefined) rows.set(systemIndex, Math.max(current, verseIndex + 1));
    }
  }
  return rows;
}

/** 一个简谱声部在给定各行谱上的层高 = `systemHeight + lyricBandHeight(rows)`（含歌词，裁决 C）。 */
export function jianpuLayerHeights(
  voice: RenderVoice,
  systemOfMeasure: ReadonlyMap<number, number>,
  systemIndices: readonly number[],
): ReadonlyMap<number, number> {
  // `jianpuLyricRows` 对 `systemIndices` 的每一项都有条目（初值 0），直接逐项换算，不需要兜底。
  const rows = jianpuLyricRows(voice, systemOfMeasure, systemIndices);
  return new Map([...rows].map(([systemIndex, count]) => [systemIndex, JIANPU_METRICS.systemHeight + lyricBandHeight(count)]));
}
