/**
 * notation/tab —— TAB 层的**纵向需求**（M2.5 T8，用户裁决 A / J，2026-10-05）。
 *
 * 一行谱需要的额外高度只取决于该行谱内出现过的最深时值装饰（`requiredSystemDepth`，只看 `duration`、与绝对 y
 * 无关），所以能在任何 y 确定之前算出。默认路径（`layoutTab.ts` 的 `restackSystems` 回填）与 T8 的 vertical
 * prepass 共用本文件的 `extraSystemHeight`，同一份规则只有一个实现。纯函数，不认识 `system/**` 的编排。
 */

import { TAB_METRICS } from '../layout/metrics';
import { splitMeasures } from '../layout/systems';
import type { RenderItem, RenderVoice } from '../model/types';
import { requiredSystemDepth } from './tabDurationGlyphs';
import { durationOf } from './tabSlotWidths';

/**
 * 一行谱内出现过的最深时值装饰，转换成该行谱需要的**额外**高度
 * （`TAB_METRICS.systemHeight` 之外还差多少）；不够深（含没有任何计时事件）时为 0
 * ——`restackSystems` 对 `extra === 0` 不产生任何效果，行高原样等于 `systemHeight`。
 */
export function extraSystemHeight(measureItems: readonly (readonly RenderItem[])[]): number {
  let deepest = 0;
  for (const items of measureItems) {
    for (const item of items) {
      deepest = Math.max(deepest, requiredSystemDepth(durationOf(item)));
    }
  }
  return Math.max(0, deepest - TAB_METRICS.systemHeight);
}

/**
 * 一个 TAB 声部在给定各行谱上的层高 = `systemHeight` + 该行谱内**本声部自己的** measure 的额外高度。
 * `systemOfMeasure`：本地 measure 下标 → 全局 systemIndex（absent 的行谱没有条目，层高取基础值）。
 */
export function tabLayerHeights(
  voice: RenderVoice,
  systemOfMeasure: ReadonlyMap<number, number>,
  systemIndices: readonly number[],
): ReadonlyMap<number, number> {
  const itemsBySystem = new Map<number, (readonly RenderItem[])[]>();
  for (const measure of splitMeasures(voice.items)) {
    const systemIndex = systemOfMeasure.get(measure.index);
    if (systemIndex === undefined) continue;
    itemsBySystem.set(systemIndex, [...(itemsBySystem.get(systemIndex) ?? []), measure.items]);
  }
  return new Map(systemIndices.map((systemIndex) => [
    systemIndex,
    TAB_METRICS.systemHeight + extraSystemHeight(itemsBySystem.get(systemIndex) ?? []),
  ]));
}
