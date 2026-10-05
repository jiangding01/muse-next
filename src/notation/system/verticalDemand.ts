/**
 * notation/system —— 最终 system 的 **vertical prepass**（M2.5 T8，用户裁决 A / B / C / I，2026-10-05；T9b.S 补 Staff）。
 *
 * 每个 (声部, system) 的层高只凭 T4 的 measure → system 归属算出，不依赖任何 y（所以「行高 ↔ layout y」不成环）：
 * - 简谱 = `systemHeight + lyricBandHeight(歌词行数)`（`jianpu/jianpuVerticalDemand.ts`，沿用默认公式，裁决 C）；
 * - TAB = `systemHeight +` 本声部在该行最深时值的补高（`tab/tabVerticalDemand.ts`）；
 * - Staff = `systemHeight + topExtra + bottomExtra`（`staff/staffVerticalDemand.ts`，T9b.S）：由 `composeLayout.ts` 以
 *   `StaffDemandSource` 注入（T8 冻结守卫要求本文件只 import 简谱 / TAB helper）；`topExtra` 同时作为该行 Staff 内容的
 *   上内缩，经 `VoicePlan.staffTopInsets` 唯一地交给 `layoutStaff`（不由它重算）；
 * - fallback = 0（裁决 I）。
 * 已知记谱声部在其 group 的**每一行**都有层（本行没有 measure 也保留基础高度，裁决 B）。
 * 只调用记谱侧的纯 helper，不 import 任何 voice layout 入口；输出交给 `verticalLayout.ts` 堆叠。
 */

import type { VoiceId } from '../../domain';
import { jianpuLayerHeights } from '../jianpu/jianpuVerticalDemand';
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
  /** systemIndex → 层高（`lines` 的每一行都有条目）——最终层高的唯一真源。 */
  readonly heights: ReadonlyMap<number, number>;
  /** Staff 声部：systemIndex → 内容上内缩（= 该行 `topExtra`，`lines` 的每一行都有条目）；其它记谱为空表。 */
  readonly staffTopInsets: ReadonlyMap<number, number>;
}

type LayerVertical = Pick<VoicePlan, 'heights' | 'staffTopInsets'>;

/**
 * Staff 纵向需求的来源（T9b.S）：`composeLayout.ts` 传入绑定了 `DomainIndex` 的 `staffLayerDemands`。
 * `systemIndices` 的每一项都必须有条目（缺失在 `heightAt` / `layoutStaff` 处 `RangeError`）。
 */
export type StaffDemandSource = (
  voice: RenderVoice,
  systemOfMeasure: ReadonlyMap<number, number>,
  systemIndices: readonly number[],
) => ReadonlyMap<number, { readonly topExtra: number; readonly height: number }>;

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

function layerVertical(
  voice: RenderVoice,
  notation: VoiceLayerNotation,
  lines: readonly SystemLineGeometry[],
  staffDemand: StaffDemandSource,
): LayerVertical {
  const indices = lines.map((line) => line.systemIndex);
  const none = new Map<number, number>();
  if (notation === 'fallback') return { heights: new Map(indices.map((systemIndex) => [systemIndex, 0])), staffTopInsets: none };
  const owned = systemOfMeasure(voice.voiceId, lines);
  if (notation === 'staff') {
    const demands = [...staffDemand(voice, owned, indices)];
    return {
      heights: new Map(demands.map(([systemIndex, demand]) => [systemIndex, demand.height])),
      staffTopInsets: new Map(demands.map(([systemIndex, demand]) => [systemIndex, demand.topExtra])),
    };
  }
  const heights = notation === 'jianpu' ? jianpuLayerHeights(voice, owned, indices) : tabLayerHeights(voice, owned, indices);
  return { heights, staffTopInsets: none };
}

/**
 * 全部声部的层计划；group 里的声部缺少 `RenderVoice` 是上游不变量被破坏 → `RangeError`。
 * `staffDemand`：Staff 声部的纵向需求来源（见 `StaffDemandSource`）。
 */
export function planVoiceLayers(renderScore: RenderScore, geometry: ComposedSystemGeometry, staffDemand: StaffDemandSource): readonly VoicePlan[] {
  const renderVoiceOf = new Map(renderScore.voices.map((voice) => [voice.voiceId, voice]));
  return geometry.analysis.grouping.groups.flatMap((group) => {
    const lines = geometry.lines.filter((line) => line.groupIndex === group.index);
    return group.voiceIds.map((voiceId): VoicePlan => {
      const voice = renderVoiceOf.get(voiceId);
      if (voice === undefined) throw new RangeError(`score layout: 声部 ${voiceId} 缺少 RenderVoice`);
      const notation = voiceNotation(voice);
      return { voice, notation, groupIndex: group.index, lines, ...layerVertical(voice, notation, lines, staffDemand) };
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
