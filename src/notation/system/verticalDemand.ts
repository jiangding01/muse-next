/**
 * notation/system —— 最终 system 的 **vertical prepass**（M2.5 T8，用户裁决 A / B / C / I，2026-10-05）。
 *
 * 每个 (声部, system) 的层高只凭 T4 的 measure → system 归属算出，不依赖任何 y（所以「行高 ↔ layout y」不成环）：
 * - 简谱 = `systemHeight + lyricBandHeight(歌词行数)`（`jianpu/jianpuVerticalDemand.ts`，沿用默认公式，裁决 C）；
 * - TAB = `systemHeight +` 本声部在该行最深时值的补高（`tab/tabVerticalDemand.ts`）；
 * - Staff = `STAFF_METRICS.systemHeight`；fallback = 0（裁决 I）。
 * 已知记谱声部在其 group 的**每一行**都有层（本行没有 measure 也保留基础高度，裁决 B）。
 * 只调用记谱侧的纯 helper，不 import 任何 voice layout 入口；输出交给 `verticalLayout.ts` 堆叠。
 */

import type { VoiceId } from '../../domain';
import { jianpuLayerHeights } from '../jianpu/jianpuVerticalDemand';
import { STAFF_METRICS } from '../layout/metrics';
import type { RenderScore, RenderVoice } from '../model/types';
import { tabLayerHeights } from '../tab/tabVerticalDemand';
import type { ChordOverlayPlan } from './chordOverlay';
import type { ComposedSystemGeometry, SystemLineGeometry } from './composeSystem';
import type { VoiceLayerNotation } from './contracts';
import { voiceNotation } from './measureDemand';
import type { SystemDemand } from './verticalLayout';

/** 一个声部在整份文档里的层计划（group 顺序、组内 `voiceIds` 顺序）。 */
export interface VoicePlan {
  readonly voice: RenderVoice;
  readonly notation: VoiceLayerNotation;
  readonly groupIndex: number;
  /** 所在 group 的全部行。 */
  readonly lines: readonly SystemLineGeometry[];
  /** systemIndex → 层高（`lines` 的每一行都有条目）。 */
  readonly heights: ReadonlyMap<number, number>;
}

/** 本地 measure 下标 → 全局 systemIndex（absent 不出条目）。 */
function systemOfMeasure(voiceId: VoiceId, lines: readonly SystemLineGeometry[]): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  for (const line of lines) {
    for (const g of line.measures) {
      for (const p of g.participation) {
        if (p.voiceId === voiceId && p.kind !== 'absent') out.set(p.localMeasureIndex, g.systemIndex);
      }
    }
  }
  return out;
}

function layerHeights(
  voice: RenderVoice,
  notation: VoiceLayerNotation,
  lines: readonly SystemLineGeometry[],
): ReadonlyMap<number, number> {
  const indices = lines.map((line) => line.systemIndex);
  if (notation === 'fallback') return new Map(indices.map((index) => [index, 0]));
  if (notation === 'staff') return new Map(indices.map((index) => [index, STAFF_METRICS.systemHeight]));
  const owned = systemOfMeasure(voice.voiceId, lines);
  return notation === 'jianpu' ? jianpuLayerHeights(voice, owned, indices) : tabLayerHeights(voice, owned, indices);
}

/** 全部声部的层计划；group 里的声部缺少 `RenderVoice` 是上游不变量被破坏 → `RangeError`。 */
export function planVoiceLayers(renderScore: RenderScore, geometry: ComposedSystemGeometry): readonly VoicePlan[] {
  const renderVoiceOf = new Map(renderScore.voices.map((voice) => [voice.voiceId, voice]));
  return geometry.analysis.grouping.groups.flatMap((group) => {
    const lines = geometry.lines.filter((line) => line.groupIndex === group.index);
    return group.voiceIds.map((voiceId): VoicePlan => {
      const voice = renderVoiceOf.get(voiceId);
      if (voice === undefined) throw new RangeError(`score layout: 声部 ${voiceId} 缺少 RenderVoice`);
      const notation = voiceNotation(voice);
      return { voice, notation, groupIndex: group.index, lines, heights: layerHeights(voice, notation, lines) };
    });
  });
}

/** 声部计划在某行上的层高；缺失 = 上游结构不变量被破坏（不能静默给 0，否则违反裁决 B）。 */
function heightAt(voicePlan: VoicePlan, systemIndex: number): number {
  const height = voicePlan.heights.get(systemIndex);
  if (height === undefined) throw new RangeError(`score layout: 声部 ${voicePlan.voice.voiceId} 缺少 system ${String(systemIndex)} 的纵向需求`);
  return height;
}

/** 每个 system 的纵向需求：层按 `voiceIds` 顺序，和弦取该 system 的 T6 footprint（没有和弦的 system 为空）。 */
export function systemDemands(
  geometry: ComposedSystemGeometry,
  voicePlans: readonly VoicePlan[],
  chordPlansOf: ReadonlyMap<number, readonly ChordOverlayPlan[]>,
): readonly SystemDemand[] {
  return geometry.lines.map((line) => ({
    systemIndex: line.systemIndex,
    width: line.width,
    layers: voicePlans
      .filter((voicePlan) => voicePlan.groupIndex === line.groupIndex)
      .map((voicePlan) => ({
        voiceId: voicePlan.voice.voiceId,
        notation: voicePlan.notation,
        height: heightAt(voicePlan, line.systemIndex),
      })),
    chords: (chordPlansOf.get(line.systemIndex) ?? []).map((chordPlan) => chordPlan.footprint),
  }));
}
