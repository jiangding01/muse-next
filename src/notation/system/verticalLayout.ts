/**
 * notation/system —— 最终 system 的**纵向堆叠与 box**（M2.5 T8，用户裁决 A / B / E / F / G / I，2026-10-05）。
 *
 * 纯数据：输入每个 system 的层高需求（由 `composeLayout.ts` 经记谱侧 vertical helper 预先算好，裁决 A）与 T6
 * footprint，输出 box / 层 top / 和弦带高。不 import 任何 voice layout、`chord/**` 或 `layoutChord`。
 *
 * - 和弦带（§Q5.3 / F-11）：无 plan → 0（不留 gap）；否则 = max(footprint.height) + `chordBandGap`。带在全部层之上。
 * - 层（裁决 B / I）：按 group `voiceIds` 顺序自上而下，`top` 相对 box；已知记谱层恒有基础高度（即使本行没有 measure），
 *   fallback 层高 0、不参与 `layerGap`（gap 只出现在相邻两个已知记谱层之间）。
 * - overlay y（裁决 E）= 块顶，块底对齐带底：`bandHeight − chordBandGap − footprint.height`。
 * - 横向（裁决 F + T8 post-freeze amendment）：box = T4 system geometry + T6 chord ink extents（**不含**歌词等其它
 *   墨迹）。`left = min(0, footprint.left…)` **向下**、`right = max(行宽, footprint.right…)` **向上**量化到
 *   `geometryQuantum`（2⁻¹⁰）网格，各多出 < 1 tick 的不可见留白、不裁墨迹；`box.origin.x = left`、
 *   `box.width = right − left`、`dx = −left`，下游把 T4 / T6 的行坐标统一 `+dx`。
 *   精度契约：T4 measure / shared timeline 的 x 都在网格上，rebase 后 `origin.x + x` **逐位**还原；tier 3 的
 *   voice-local x 是任意 double，只保证语义坐标不变、浮点重组误差在 ulp 量级（语料实测逐位相等是观察，不是契约）。
 * - 纵向（裁决 G）：按 `systemIndex` 升序自 y = 0 堆叠，`systemGap` 只在相邻 system 之间、不计入 box，跨 group 不重置。
 */

import type { VoiceId } from '../../domain';
import { SYSTEM_METRICS } from '../layout/metrics';
import type { Box } from '../layout/primitives';
import type { ChordOverlayFootprint } from './chordOverlay';
import type { VoiceLayerLayout, VoiceLayerNotation } from './contracts';

export interface LayerDemand {
  readonly voiceId: VoiceId;
  readonly notation: VoiceLayerNotation;
  /** 层高（已知记谱 = 基础高 + 歌词带 / TAB 深时值补高 / Staff 纵向墨迹上下补高；fallback 恒 0）。 */
  readonly height: number;
}

export interface SystemDemand {
  readonly systemIndex: number;
  /** T4 行宽（T4 行坐标下音乐内容的右界）。 */
  readonly width: number;
  /** 顺序 = group `voiceIds` 顺序。 */
  readonly layers: readonly LayerDemand[];
  /** 本 system 的 T6 footprint（T4 行坐标）。 */
  readonly chords: readonly ChordOverlayFootprint[];
}

export interface SystemFrame {
  readonly systemIndex: number;
  readonly box: Box;
  /** T4 / T6 行坐标 → 最终 box 内坐标的平移量（`= −box.origin.x ≥ 0`）。 */
  readonly dx: number;
  readonly bandHeight: number;
  readonly layers: readonly VoiceLayerLayout[];
}

export function chordBandHeight(chords: readonly ChordOverlayFootprint[]): number {
  return chords.length === 0 ? 0 : Math.max(...chords.map((chord) => chord.height)) + SYSTEM_METRICS.chordBandGap;
}

/** 和弦图 / 名的块顶 y（box 内），块底对齐带底。 */
export function overlayTop(bandHeight: number, footprintHeight: number): number {
  return bandHeight - SYSTEM_METRICS.chordBandGap - footprintHeight;
}

const QUANTUM = SYSTEM_METRICS.geometryQuantum;

/**
 * 有符号的网格吸附（不复用 `geometryTicks` 的 floor / ceil：那两个带「负数 → 0」的 demand 语义）。
 * 除以 2 的幂与乘回都是二进制精确的，结果恰在网格上。
 */
function snapDown(units: number): number {
  return Math.floor(units / QUANTUM) * QUANTUM;
}

function snapUp(units: number): number {
  return Math.ceil(units / QUANTUM) * QUANTUM;
}

/** 墨迹左界向下吸附；没有向左溢出时恰为 0（不产生 `-0`）。 */
function inkLeft(chords: readonly ChordOverlayFootprint[]): number {
  const raw = Math.min(0, ...chords.map((chord) => chord.left));
  return raw < 0 ? snapDown(raw) : 0;
}

/** 墨迹右界向上吸附；行宽本身在网格上，没有向右溢出时恰为行宽。 */
function inkRight(width: number, chords: readonly ChordOverlayFootprint[]): number {
  return snapUp(Math.max(width, ...chords.map((chord) => chord.right)));
}

/** 层的 top（相对 box）与层栈底；`layerIndex` = group 内层序（含 fallback，连续）。 */
function stackLayers(layers: readonly LayerDemand[], bandHeight: number): { readonly layers: VoiceLayerLayout[]; readonly bottom: number } {
  const out: VoiceLayerLayout[] = [];
  let cursor = bandHeight;
  let knownPlaced = false;
  for (const [layerIndex, layer] of layers.entries()) {
    if (layer.notation === 'fallback') {
      out.push({ voiceId: layer.voiceId, notation: layer.notation, layerIndex, top: cursor, height: 0 });
      continue;
    }
    if (knownPlaced) cursor += SYSTEM_METRICS.layerGap;
    out.push({ voiceId: layer.voiceId, notation: layer.notation, layerIndex, top: cursor, height: layer.height });
    cursor += layer.height;
    knownPlaced = true;
  }
  return { layers: out, bottom: cursor };
}

/** 全部 system 的最终 box 与层（按 `systemIndex` 升序；不改输入）。 */
export function stackSystems(demands: readonly SystemDemand[]): readonly SystemFrame[] {
  let y = 0;
  return [...demands].sort((a, b) => a.systemIndex - b.systemIndex).map((demand): SystemFrame => {
    const bandHeight = chordBandHeight(demand.chords);
    const stacked = stackLayers(demand.layers, bandHeight);
    const left = inkLeft(demand.chords);
    const right = inkRight(demand.width, demand.chords);
    const box = { origin: { x: left, y }, width: right - left, height: stacked.bottom };
    y += stacked.bottom + SYSTEM_METRICS.systemGap;
    return { systemIndex: demand.systemIndex, box, dx: 0 - left, bandHeight, layers: stacked.layers };
  });
}
