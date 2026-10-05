/**
 * renderer/components/notation —— screen 版式的 system 渲染模型（M2.5 T9b，用户裁决 A / B / J4 / K1 / M / O / 8）。
 *
 * 纯组装，不含 React / DOM / VexFlow：输入 T8 `composeScoreLayout(…, { kind: 'screen' })` 的 `ScoreLayout` 与
 * `RenderScore`，输出 React 只需逐字段映射的 `ScoreRender`。允许调用既有的 `summarizeEvents` / `layoutChord`；
 * **不重新 layout**、不重做 T6 / T8 的任何决策、不解释 `MusicEvent.kind`。切片与 overlay 见 `systemSlices.ts`。
 *
 * - 横向（裁决 J4 + T9c.P D4）：`leftGutter = max(0, −system.box.origin.x…, −简谱歌词左 extent…)`，每个 system
 *   `leftOffset = leftGutter + origin.x ≥ 0`。于是所有 system 的音乐 x = 0 都落在 `leftGutter`，和弦左墨迹与行首长歌词
 *   都不进入负滚动坐标（任何 zoom 都可横向滚动看全）。歌词不进 system box：这里只做纯 extent 测量，不反馈 compose / layout。
 * - 纵向：system 自上而下排列，相邻 system 之间由容器的 row-gap 恰好放一个 `systemGap`（不读 `box.origin.y`）；
 *   system 内的层用 `VoiceLayerLayout.top / height` 绝对定位。
 * - fallback（裁决 K1 + 修复轮 M4）：system 内保留高 0 的层身份（`kind: 'empty'`）；fallback 提示**不从 system / 层反推**
 *   （没有任何 measure 的单独 group 不产出 system，反推会让该声部整条消失），而是取 `renderScore.voices` 中
 *   `!isKnownVoiceStyle(style)` 的声部：文档顺序、每个声部恰好一项，摘要调用既有 `summarizeEvents`，不参与 system 高度与 gap。
 * - 诊断（裁决 M）：`scoreLayout.diagnostics`（已含 renderScore / T1–T3 / T6 / 各声部）→ 页眉诊断；按 id 去重只是兜底。
 * - CSS 像素（zoom 语义一字不改）：`px(u) = u × cssPixelsPerUnitAtZoom1 × zoom`；`availableWidth = cssWidth ÷ 同一因子`。
 */

import { isKnownVoiceStyle } from '../../../domain';
import type { Score, VoiceId } from '../../../domain';
import { summarizeEvents } from '../../../notation/layout/fallbackSummary';
import { SCORE_VIEW_METRICS } from '../../../notation/layout/metrics';
import type { Box } from '../../../notation/layout/primitives';
import type { TextMeasurer } from '../../../notation/layout/textMeasurer';
import type { RenderDiagnostic, RenderScore } from '../../../notation/model/types';
import type { SvgNode } from '../../../notation/svg/node';
import type { ScoreLayout, VoiceLayoutEntry } from '../../../notation/system/composeLayout';
import type { ScoreSystemLayout, VoiceLayerLayout, VoiceLayerNotation } from '../../../notation/system/contracts';
import type { StaffSystemSlice } from '../../integrations/vexflow/staffSystemSlice';
import { jianpuSystemSvg, staffSystemSlice, systemOverlaySvg, tabSystemSvg } from './systemSlices';

interface LayerBase {
  readonly voiceId: VoiceId;
  readonly notation: VoiceLayerNotation;
  readonly layerIndex: number;
  /** system box 内的纵向偏移（abstract unit）。 */
  readonly top: number;
  readonly height: number;
}

/** 一个层：简谱 / TAB 是已切好的 SVG；Staff 是交给 VexFlow 的切片；fallback 只保留高 0 的身份。 */
export type LayerRender =
  | (LayerBase & { readonly kind: 'svg'; readonly node: SvgNode })
  | (LayerBase & { readonly kind: 'staff'; readonly slice: StaffSystemSlice })
  | (LayerBase & { readonly kind: 'empty' });

export interface SystemRender {
  readonly index: number;
  readonly box: Box;
  /** 相对 `.score-systems` 内容左缘的偏移（abstract unit，≥ 0）。 */
  readonly leftOffset: number;
  readonly layers: readonly LayerRender[];
  readonly overlay?: SvgNode;
}

export interface FallbackNotice {
  readonly voiceId: VoiceId;
  readonly label: string;
  readonly summary: string;
}

export interface ScoreRender {
  /** 所有 system 共用的音乐 x = 0 位置（abstract unit）。 */
  readonly leftGutter: number;
  readonly systems: readonly SystemRender[];
  readonly fallbackNotices: readonly FallbackNotice[];
}

function fail(message: string): never {
  throw new RangeError(`system render: ${message}`);
}

/** abstract unit → CSS 像素字符串（zoom 只改像素换算，不改 layout 数值）。 */
export function cssPx(units: number, zoom: number): string {
  return `${String(units * SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1 * zoom)}px`;
}

/**
 * 容器 CSS 像素宽 → `availableWidth`（abstract unit）：`cssWidth / (cssPixelsPerUnitAtZoom1 × zoom)`。zoom 越大可用
 * 宽度越小、换行越早；layout 层只看到 abstract unit，不知道外面套了 zoom（D6 + T6.4，公式自 M2 起不变）。
 */
export function computeAvailableWidthUnits(cssWidthPx: number, cssPixelsPerUnitAtZoom1: number, zoom: number): number {
  return cssWidthPx / (cssPixelsPerUnitAtZoom1 * zoom);
}

function layerRender(layer: VoiceLayerLayout, systemIndex: number, entryOf: ReadonlyMap<VoiceId, VoiceLayoutEntry>): LayerRender {
  const base = { voiceId: layer.voiceId, notation: layer.notation, layerIndex: layer.layerIndex, top: layer.top, height: layer.height };
  if (layer.notation === 'fallback') return { ...base, kind: 'empty' };
  const entry = entryOf.get(layer.voiceId) ?? fail(`声部 ${layer.voiceId} 缺少 voice layout`);
  if (entry.notation !== layer.notation) fail(`声部 ${layer.voiceId} 的层记谱（${layer.notation}）与 voice layout（${entry.notation}）不一致`);
  switch (entry.notation) {
    case 'jianpu':
      return { ...base, kind: 'svg', node: jianpuSystemSvg(entry.layout, systemIndex) };
    case 'tab':
      return { ...base, kind: 'svg', node: tabSystemSvg(entry.layout, systemIndex) };
    case 'staff':
      return { ...base, kind: 'staff', slice: staffSystemSlice(entry.layout, systemIndex) };
  }
}

function systemRender(
  system: ScoreSystemLayout,
  leftGutter: number,
  entryOf: ReadonlyMap<VoiceId, VoiceLayoutEntry>,
  score: Score,
  measurer: TextMeasurer,
): SystemRender {
  const base = {
    index: system.index,
    box: system.box,
    leftOffset: leftGutter + system.box.origin.x,
    layers: system.layers.map((layer) => layerRender(layer, system.index, entryOf)),
  };
  const overlay = systemOverlaySvg(system, score, measurer);
  return overlay === undefined ? base : { ...base, overlay };
}

/** fallback 声部的可见提示：以 `renderScore.voices` 为全集（与 T8 同口径：style 不是已知记谱即 fallback），文档顺序、每声部一项。 */
function fallbackNotices(renderScore: RenderScore): FallbackNotice[] {
  return renderScore.voices.flatMap((voice): FallbackNotice[] => {
    const style = voice.voice.style;
    if (isKnownVoiceStyle(style)) return [];
    // 措辞沿用旧 renderer：未声明 / 未知。
    const label = style === undefined ? '风格未声明' : `未知风格 style=${style}`;
    return [{ voiceId: voice.voiceId, label, summary: summarizeEvents(voice.items.map((item) => item.event)) }];
  });
}

/**
 * 全部简谱歌词的左 extent（T9c.P D4，与 `toSvg.ts` 的 anchor 同口径）：有目标以 `middle` 绘制 → `x − 宽/2`；
 * 无目标以 `start` 绘制 → `x`。只量墨迹、不改任何坐标。
 */
function lyricLeftExtents(voiceLayouts: readonly VoiceLayoutEntry[], measurer: TextMeasurer): number[] {
  return voiceLayouts.flatMap((entry) =>
    entry.notation !== 'jianpu'
      ? []
      : entry.layout.lyrics.map(({ text, aligned }) =>
          aligned ? text.x - measurer.measure(text.text, { fontSize: text.fontSize }).width / 2 : text.x,
        ),
  );
}

/** 整份文档的 screen system 渲染模型。 */
export function buildScoreRender(scoreLayout: ScoreLayout, renderScore: RenderScore, measurer: TextMeasurer): ScoreRender {
  const systems = scoreLayout.composed.systems;
  // reduce 而非展开：歌词可能很多，避免 `Math.max(...)` 的参数个数上限。
  const lefts = [...systems.map((system) => system.box.origin.x), ...lyricLeftExtents(scoreLayout.voiceLayouts, measurer)];
  const leftGutter = lefts.reduce((gutter, left) => Math.max(gutter, 0 - left), 0);
  const entryOf = new Map(scoreLayout.voiceLayouts.map((entry) => [entry.voiceId, entry]));
  return {
    leftGutter,
    systems: systems.map((system) => systemRender(system, leftGutter, entryOf, renderScore.score, measurer)),
    fallbackNotices: fallbackNotices(renderScore),
  };
}

/** 诊断合并（裁决 M）：T8 诊断 → 页眉诊断；按 id 去重、保留首次出现顺序——只是兜底，不掩盖 producer 重复。 */
export function mergeScoreDiagnostics(
  layoutDiagnostics: readonly RenderDiagnostic[],
  headerDiagnostics: readonly RenderDiagnostic[],
): readonly RenderDiagnostic[] {
  const seen = new Set<string>();
  return [...layoutDiagnostics, ...headerDiagnostics].filter((diagnostic) => {
    if (seen.has(diagnostic.id)) return false;
    seen.add(diagnostic.id);
    return true;
  });
}
