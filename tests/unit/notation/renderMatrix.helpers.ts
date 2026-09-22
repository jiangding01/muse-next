/**
 * M2 T8 —— 渲染矩阵的共用夹具（**只放机械操作，断言全部留在 `render.matrix.test.ts`**）。
 *
 * 分派按 `voice.style` 自行做（与 `renderer/components/notation/voiceRender.ts` 同一
 * 口径）：**不 import renderer、不 import vexflow**——矩阵到 layout 层为止，staff 的
 * adapter 不在矩阵内。`JianpuNodeBase` / `TabNodeBase` / `StaffNodeBase` 三者都带同名
 * 同义的 `anchor: Anchor` 与 `fallback: boolean`，因此泛化访问器按 `MatrixLayout` 这个
 * **判别联合**分支即可，全程零 `as` 断言。
 *
 * 本文件头同时是**契约与矩阵覆盖表的唯一权威出处**（T9 同步 docs 时取这里，不取测试
 * 文件）。契约（方案 §T8 逐字）：
 * - **C1**：每个 `RenderItem` 在该声部的布局里**恰好**对应一个可见节点（含 unknown /
 *   outOfScope / grace / decoration / placeholder；chordSymbol 与 barline 也算节点）。
 * - **C2**：每个 `fallback: true` 的节点至少有一条诊断指向它（本层 `layout.diagnostics`
 *   或上游 `RenderScore.diagnostics` / `layoutScoreHeader`，anchor 为该 event）。
 * - **C3**：每条渲染诊断的 `anchor` 可经 `DomainIndex` 解析，且 `anchorKey()` 稳定。
 *
 * **各记谱的 C1 口径**（三种事件记谱同口径，chord 单列）：
 * - jianpu / tab / staff：`layout.nodes` 是「每个事件一个事件节点」的数组，C1 = 对
 *   `voice.items` 的每一项，`nodes` 里 `anchor.kind === 'event' && eventId === 该项` 的
 *   节点数**恰好 1**。
 * - **chord**：`Score.chordShapes` 是**文档级**对象，`ChordLayout.anchor` 恒为
 *   `{ kind: 'document' }`，与声部事件之间没有任何映射（D11：与 `ChordSymbolEvent` 按名
 *   关联只有 `INFERRED`，默认关闭）。所以 chord 的 C1 口径改写成「每个 `GuitarChord`
 *   恰好一个 `ChordLayout`、每个 `ChordLayout` 恰好 6 条弦标记、anchor 恒为 document」，
 *   并且**恒不消费任何 `RenderItem`**（对事件的可见节点数恒为 0，不是「漏画」）。
 *   chord 的 C2 同理恒为空集：`ChordLayout` 根本没有 `fallback` 字段，它没有降级路径。
 *
 * 矩阵覆盖表（用例 × 记谱 × 契约；`C` = 三条全跑，`C1′` = 按上面的 chord 口径跑）：
 *
 * | 用例组                                                               | chord | jianpu | tab   | staff |
 * | -------------------------------------------------------------------- | ----- | ------ | ----- | ----- |
 * | 102 个 fixture（按 `voice.style` 分派；无 style 的走 D12 用例）      | C1′   | C      | C     | C     |
 * | unknown 事件 / decoration / chordSymbol 在段末                       | C1′   | C      | C     | C     |
 * | tab 事件（落入 jianpu/staff）/ pitch 事件（落入 tab）                | C1′   | C      | C     | C     |
 * | grace（TabNote 成员 / Note 成员）/ 全 Rest chord `[zz]`              | C1′   | C      | C     | C     |
 * | duration undefined / 1/3 / 1/512 / 2/1                               | C1′   | C      | C     | C     |
 * | Z / @ 休止 / unresolved tie / tuplet q=0                             | C1′   | C      | C     | C     |
 * | clef 三态 / M: raw / K: 缺席 `Eb` `Dm`                               | C1′   | C      | C     | C     |
 * | 跨行 tie（窄宽度拆段）/ style 缺席 / style 未知                      | C1′   | C      | C     | C     |
 * | dangling relation 端点                                               | C1/C2 | C1/C2  | C1/C2 | C1/C2 |
 *
 * **唯一的非全跑格**是 dangling relation 端点：该用例靠**人为剪掉 `index.eventById`**
 * 里的一项来制造，于是「event anchor 解析不了」正是被造出来的那个故障本身，拿通用 C3
 * 去断它等于断言「我造的故障没生效」。该块改为定点断言 relation 分支的 C3，不静默跳过。
 *
 * 两档 `availableWidth`：`wide` 不换行，`narrow` 逼出多行谱（跨行 tie 的拆段路径）。
 */

import type { DomainIndex, EventId, Score } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import type { ChordLayout } from '../../../src/notation/chord/layoutChord';
import { layoutChord } from '../../../src/notation/chord/layoutChord';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import { layoutScoreHeader } from '../../../src/notation/layout/scoreHeader';
import type { TextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import type { StaffLayout } from '../../../src/notation/staff/staffTypes';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { TabLayout } from '../../../src/notation/tab/layoutTab';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { Anchor, RenderDiagnostic, RenderScore, RenderVoice } from '../../../src/notation/model/types';

/** 四种记谱。`chord` 是**文档级**和弦图，C1 口径见 `visibleNodesByEvent`。 */
export const NOTATIONS = ['chord', 'jianpu', 'tab', 'staff'] as const;
export type MatrixNotation = (typeof NOTATIONS)[number];

/** 两档可用宽度：`wide` 不触发换行，`narrow` 逼出多行谱（跨行 tie / tuplet 的拆段路径）。 */
export const MATRIX_WIDTHS = { wide: 100_000, narrow: 16 } as const;
export type MatrixWidthKey = keyof typeof MATRIX_WIDTHS;
export const WIDTH_KEYS = ['wide', 'narrow'] as const;

/** 零 DOM 的确定性度量（§2.8）：矩阵全程只用它，三平台 CI 不漂移。 */
export const matrixMeasurer: TextMeasurer = createDeterministicTextMeasurer();

/** 一份乐谱在矩阵里的全部素材。 */
export interface MatrixScore {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly renderScore: RenderScore;
  /** `layoutScoreHeader` 的文档级诊断（`textBlock.unclosed` / key 四态 / `meter.raw`）。 */
  readonly headerDiagnostics: readonly RenderDiagnostic[];
}

/** `bytes | text → loadJcx → buildRenderScore → layoutScoreHeader` 一次备齐。 */
export function matrixScoreFrom(input: string | Uint8Array): MatrixScore {
  const loaded = typeof input === 'string' ? loadJcx(input) : loadJcx(input);
  const renderScore = buildRenderScore({ score: loaded.score, index: loaded.index });
  return {
    score: loaded.score,
    index: loaded.index,
    renderScore,
    headerDiagnostics: layoutScoreHeader(loaded.score, matrixMeasurer).diagnostics,
  };
}

/** 上游（非本记谱层）诊断：C2 允许由它满足，C3 对它同样适用。 */
export function upstreamDiagnostics(source: MatrixScore): readonly RenderDiagnostic[] {
  return [...source.renderScore.diagnostics, ...source.headerDiagnostics];
}

export interface MatrixContext {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  readonly availableWidth: number;
}

export function matrixContext(source: MatrixScore, width: MatrixWidthKey): MatrixContext {
  return {
    score: source.score,
    index: source.index,
    measurer: matrixMeasurer,
    availableWidth: MATRIX_WIDTHS[width],
  };
}

/** 四种记谱的布局产物，判别联合——泛化访问器靠它分支，不用 `as`。 */
export type MatrixLayout =
  | { readonly notation: 'chord'; readonly chords: readonly ChordLayout[] }
  | { readonly notation: 'jianpu'; readonly layout: JianpuLayout }
  | { readonly notation: 'tab'; readonly layout: TabLayout }
  | { readonly notation: 'staff'; readonly layout: StaffLayout };

/**
 * 强制按指定记谱布局一个声部：**不看 `voice.style`**。「tab 事件落入 jianpu/staff」
 * 「pitch 事件落入 tab」只能这样造——parse 层按 `style` 决定 body 的解释方式，不可能
 * 解析出「jianpu 声部里的 tabNote」。`chord` 分支不消费声部（`chordShapes` 是文档级
 * 对象，与 `ChordSymbolEvent` 的关联只有 `INFERRED`，D11 默认关闭）。
 */
export function layoutVoiceAs(
  notation: MatrixNotation,
  voice: RenderVoice,
  ctx: MatrixContext,
): MatrixLayout {
  const { score, index, measurer, availableWidth } = ctx;
  switch (notation) {
    case 'chord': {
      const options = { showFinger: score.showFinger, measurer };
      return { notation, chords: score.chordShapes.map((chord) => layoutChord(chord, options)) };
    }
    case 'jianpu': {
      const head = {
        ...(score.key === undefined ? {} : { key: score.key }),
        ...(score.meter === undefined ? {} : { meter: score.meter }),
      };
      return { notation, layout: layoutJianpu(voice, { score: head, index, measurer, availableWidth }) };
    }
    case 'tab':
      return { notation, layout: layoutTab(voice, { index, measurer, availableWidth }) };
    case 'staff':
      return { notation, layout: layoutStaff(voice, { score, index, measurer, availableWidth }) };
    default: {
      const exhaustive: never = notation;
      return exhaustive;
    }
  }
}

/**
 * 按 `voice.style` 分派（同 `voiceRender.buildVoiceRender`，但不 import renderer）。
 * `style` 缺席 / 未知 → `undefined`：D12 方案 B 下这类声部走 renderer 侧占位展示，
 * **notation 层不产生 layout**，故 C1 不适用，C2/C3 靠 `RenderScore.diagnostics` 的
 * `voice.style-absent` / `style-unknown` 覆盖。
 */
export function layoutVoiceForMatrix(voice: RenderVoice, ctx: MatrixContext): MatrixLayout | undefined {
  const style = voice.voice.style;
  if (style === 'jianpu' || style === 'tab' || style === 'staff') {
    return layoutVoiceAs(style, voice, ctx);
  }
  return undefined;
}

function nodeAnchors(model: MatrixLayout, onlyFallback: boolean): readonly Anchor[] {
  switch (model.notation) {
    case 'chord':
      return onlyFallback ? [] : model.chords.map((chord) => chord.anchor);
    case 'jianpu':
      return model.layout.nodes.filter((n) => !onlyFallback || n.fallback).map((n) => n.anchor);
    case 'tab':
      return model.layout.nodes.filter((n) => !onlyFallback || n.fallback).map((n) => n.anchor);
    case 'staff':
      return model.layout.nodes.filter((n) => !onlyFallback || n.fallback).map((n) => n.anchor);
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
}

/**
 * C1 的泛化访问器：`EventId → 可见节点数`。jianpu / tab / staff 的 `nodes` 是「每个事件
 * 一个节点」的数组（含 unknown / outOfScope / grace / decoration / placeholder /
 * chordSymbol / barline），只数 `anchor.kind === 'event'`。**chord 恒为空 map**：
 * `ChordLayout.anchor` 恒为 `{ kind: 'document' }`，与声部事件无映射——chord 侧 C1 改成
 * 「每个 `GuitarChord` 恰好一个 `ChordLayout`、恰好 6 条弦标记」，由测试单独断言。
 */
export function visibleNodesByEvent(model: MatrixLayout): ReadonlyMap<EventId, number> {
  const counts = new Map<EventId, number>();
  for (const anchor of nodeAnchors(model, false)) {
    if (anchor.kind !== 'event') continue;
    counts.set(anchor.eventId, (counts.get(anchor.eventId) ?? 0) + 1);
  }
  return counts;
}

/** C2 的泛化访问器：所有 `fallback: true` 节点的 anchor。chord 侧恒为空（无降级路径）。 */
export function fallbackAnchors(model: MatrixLayout): readonly Anchor[] {
  return nodeAnchors(model, true);
}

/** 本记谱层自己发的诊断。chord 层不产诊断（`layoutChord` 没有 sink）。 */
export function layoutDiagnostics(model: MatrixLayout): readonly RenderDiagnostic[] {
  return model.notation === 'chord' ? [] : model.layout.diagnostics;
}

/** C3：逐分支真的查一次，没有恒成立的分支。 */
export function anchorResolves(anchor: Anchor, source: MatrixScore): boolean {
  switch (anchor.kind) {
    case 'document':
      return source.renderScore.score === source.score;
    case 'voice':
      return source.index.voiceById.has(anchor.voiceId);
    case 'event': {
      const found = source.index.eventById.get(anchor.eventId);
      return found !== undefined && found.voiceId === anchor.voiceId;
    }
    case 'relation':
      return source.index.relationById.has(anchor.relationId);
    default: {
      const exhaustive: never = anchor;
      return exhaustive;
    }
  }
}
