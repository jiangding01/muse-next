/**
 * M2 T8 / T8.1 —— 渲染矩阵的共用夹具（**只放机械操作，断言全部留在 `render.matrix.test.ts`**）。
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
 *   或上游 `RenderScore.diagnostics`，anchor 为该 event）。
 * - **C3**：每条渲染诊断的 `anchor` 可经 `DomainIndex` 解析，且 `anchorKey()` 稳定。
 *
 * **两张互不混用的矩阵**（T8.1 裁决①）：
 * - **voice matrix**（jianpu / tab / staff）：输入是 `RenderVoice`，跑 C1/C2/C3 三条。
 * - **document chord matrix**（`layoutChordShapes`）：输入是 `Score.chordShapes`，它是
 *   **document 级**的 T3 renderer，既不是 `RenderVoice` 也不消费 `RenderItem`
 *   （D11：与 `ChordSymbolEvent` 按名关联只有 `INFERRED`，默认关闭）。因此
 *   **C1(RenderItem) 与 C2(fallback node) 对它是 N/A**（`ChordLayout` 根本没有
 *   `fallback` 字段），只跑「每个 `GuitarChord` → 恰好一个 `ChordLayout`、anchor 恒为
 *   document 且可解析」。`MatrixLayout` 联合里**刻意没有 chord 分支**，也没有任何
 *   `layoutVoiceAs('chord', …)` 之类的 fake voice adapter。
 *
 * **C1 只数 primary event node**（T8.1 裁决⑤）：`visibleNodesByEvent` 只遍历
 * `layout.nodes`——那是「每个事件一个节点」的**主字形**数组。三种记谱的关系弧、
 * tuplet 括号、歌词、header 标签、`L:` 变化标记全部住在**各自独立的字段**
 * （jianpu 的 `arcs` / `tuplets` / `lyrics` / `labels` / `unitLengthMarks`、tab 的
 * `relations` / `strokes` / `staffLines`、staff 的 `ties` / `tuplets` / `staves`），
 * 它们**不在 `nodes` 里**。实测各 overlay 的 anchor 分布：`JianpuArc` / `JianpuTupletBracket`
 * 是 relation anchor，`JianpuLyricNode` 是 voice anchor，而 **`TabStrokeMark` 是货真价实的
 * event anchor**——一旦把 `layout.strokes` 并进来，同一个 `tabNote` 事件立刻被数成 2 个
 * 节点。所以过滤规则是「**只看 `nodes`，再按 `anchor.kind === 'event'` 收口**」，不是
 * 「扫遍整个 layout 找 event anchor」；`overlayEventAnchorCount` 就是给这条规则做正面
 * 证据的（测试断言它 > 0 而 C1 仍为 1）。
 *
 * 矩阵覆盖表（用例 × 记谱 × 契约；`C` = 三条全跑，`N/A` = 按上面的口径不适用）：
 *
 * | 用例组                                                          | jianpu | tab | staff | chord（document） |
 * | --------------------------------------------------------------- | ------ | --- | ----- | ----------------- |
 * | 全部 runtime `fixtureNames`（按 `voice.style` 分派）            | C      | C   | C     | 见下行            |
 * | 带 `%%gchord` 的 fixture + 合成 chord 源                        | —      | —   | —     | C3 + 计数；C1/C2 N/A |
 * | `style` 缺席 / 未知（D12 声部级 fallback summary）              | N/A    | N/A | N/A   | N/A               |
 * | unknown 事件 / decoration / chordSymbol 在段末                  | C      | C   | C     | —                 |
 * | tab 事件（落入 jianpu/staff）/ pitch 事件（落入 tab）           | C      | C   | C     | —                 |
 * | grace（TabNote 成员 / Note 成员）/ 全 Rest chord `[zz]`         | C      | C   | C     | —                 |
 * | duration undefined / 1/3 / 1/512 / 2/1                          | C      | C   | C     | —                 |
 * | Z / @ 休止 / unresolved tie / tuplet q=0                        | C      | C   | C     | —                 |
 * | clef 三态 / M: raw / K: 缺席 `Eb` `Dm`                          | C      | C   | C     | —                 |
 * | 歌词 overlay / TAB stroke overlay（不得被数成第二个 event node） | C      | C   | C     | —                 |
 * | 跨行 tie（窄宽度拆段）                                          | C      | C   | C     | —                 |
 * | dangling relation 端点                                          | C1/C2  | C1/C2 | C1/C2 | —               |
 *
 * 两处非全跑格，都有理由且都不静默跳过：
 * - **D12（`style` 缺席 / 未知）**：notation 层根本不产 layout，它是**声部级 fallback
 *   summary**（`layout/fallbackSummary.ts` 的 `summarizeEvents`），**没有任何
 *   `fallback: true` 的 event node**，所以 C1/C2 无对象可断。改为定点断言声部级诊断与
 *   summary 的确定性，**不伪造 C2 node**。
 * - **dangling relation 端点**：该用例靠**人为剪掉 `index.eventById`** 里的一项来制造，
 *   于是「event anchor 解析不了」正是被造出来的那个故障本身，拿通用 C3 去断它等于断言
 *   「我造的故障没生效」。改为定点断言 relation 分支的 C3。
 *
 * 两档 `availableWidth`：`wide` 不换行，`narrow` 逼出多行谱（跨行 tie 的拆段路径）。
 */

import type { DomainIndex, EventId, RelationId, Score, VoiceId } from '../../../src/domain';
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

/** voice matrix 的三种记谱。**chord 不在其中**（它是 document 级，见文件头裁决①）。 */
export const VOICE_NOTATIONS = ['jianpu', 'tab', 'staff'] as const;
export type VoiceNotation = (typeof VOICE_NOTATIONS)[number];

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

/**
 * **C2 的上游诊断**（T8.1 裁决④）：只并 `RenderScore.diagnostics`。
 * 头部诊断全是 document anchor，对「event anchor 指向某个 fallback 节点」没有贡献，
 * 混进来只会让 C2 变松。
 */
export function upstreamDiagnosticsForC2(source: MatrixScore): readonly RenderDiagnostic[] {
  return source.renderScore.diagnostics;
}

/**
 * **C3 的全量诊断**（T8.1 裁决④）：`RenderScore` + score 级 `layoutScoreHeader`，
 * 后者正是 document anchor 的来源，加进来 C3 的 `document` 分支才真的被覆盖到。
 */
export function allDiagnosticsForC3(source: MatrixScore): readonly RenderDiagnostic[] {
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

/** voice matrix 的布局产物，判别联合——泛化访问器靠它分支，不用 `as`。**无 chord 分支**。 */
export type MatrixLayout =
  | { readonly notation: 'jianpu'; readonly layout: JianpuLayout }
  | { readonly notation: 'tab'; readonly layout: TabLayout }
  | { readonly notation: 'staff'; readonly layout: StaffLayout };

/**
 * 强制按指定记谱布局一个声部：**不看 `voice.style`**。「tab 事件落入 jianpu/staff」
 * 「pitch 事件落入 tab」只能这样造——parse 层按 `style` 决定 body 的解释方式，不可能
 * 解析出「jianpu 声部里的 tabNote」。
 */
export function layoutVoiceAs(
  notation: VoiceNotation,
  voice: RenderVoice,
  ctx: MatrixContext,
): MatrixLayout {
  const { score, index, measurer, availableWidth } = ctx;
  switch (notation) {
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
 * `style` 缺席 / 未知 → `undefined`：走 D12 的声部级 fallback summary，见文件头。
 */
export function layoutVoiceForMatrix(voice: RenderVoice, ctx: MatrixContext): MatrixLayout | undefined {
  const style = voice.voice.style;
  if (style === 'jianpu' || style === 'tab' || style === 'staff') {
    return layoutVoiceAs(style, voice, ctx);
  }
  return undefined;
}

/**
 * **document chord matrix 的唯一入口**（裁决①）：输入是 `Score.chordShapes`，
 * **不接受也不需要任何 `RenderVoice`**。
 */
export function layoutChordShapes(source: MatrixScore): readonly ChordLayout[] {
  const options = { showFinger: source.score.showFinger, measurer: matrixMeasurer };
  return source.score.chordShapes.map((chord) => layoutChord(chord, options));
}

/** 只遍历 `layout.nodes`（primary event node），不碰 overlay 数组——理由见文件头裁决⑤。 */
function primaryNodeAnchors(model: MatrixLayout, onlyFallback: boolean): readonly Anchor[] {
  switch (model.notation) {
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

/** C1 的泛化访问器：`EventId → 该事件的 primary 可见节点数`（期望恒为 1）。 */
export function visibleNodesByEvent(model: MatrixLayout): ReadonlyMap<EventId, number> {
  const counts = new Map<EventId, number>();
  for (const anchor of primaryNodeAnchors(model, false)) {
    if (anchor.kind !== 'event') continue;
    counts.set(anchor.eventId, (counts.get(anchor.eventId) ?? 0) + 1);
  }
  return counts;
}

/** C2 的泛化访问器：所有 `fallback: true` 的 primary 节点的 anchor。 */
export function fallbackAnchors(model: MatrixLayout): readonly Anchor[] {
  return primaryNodeAnchors(model, true);
}

/** overlay 计数：`nodes` 之外、同样带 event anchor 的产物，用来证明 C1 的过滤规则有意义。 */
export function overlayEventAnchorCount(model: MatrixLayout): number {
  switch (model.notation) {
    case 'jianpu':
      return [...model.layout.lyrics, ...model.layout.arcs, ...model.layout.tuplets].filter(
        (entry) => entry.anchor.kind === 'event',
      ).length;
    case 'tab':
      return [...model.layout.strokes, ...model.layout.relations].filter(
        (entry) => entry.anchor.kind === 'event',
      ).length;
    case 'staff':
      return [...model.layout.ties, ...model.layout.tuplets].filter(
        (entry) => entry.anchor.kind === 'event',
      ).length;
    default: {
      const exhaustive: never = model;
      return exhaustive;
    }
  }
}

/** 本记谱层自己发的诊断。 */
export function layoutDiagnostics(model: MatrixLayout): readonly RenderDiagnostic[] {
  return model.layout.diagnostics;
}

/**
 * relation 的**归属**校验（T8.1 裁决③）：光有 `relationById.has(id)` 不够——那只证明
 * 这个 id 在文档里存在，证明不了它属于 anchor 所声称的那个声部。`Voice` 的
 * `ties` / `slurs` / `tuplets` / `tabRelations` / `brokenRhythms` 五类数组是关系的
 * 实际归属处（与 `notation/model/relations.ts` 的 `voiceRelations()` 同一全集），逐一比对 `id`。
 */
function relationBelongsToVoice(source: MatrixScore, voiceId: VoiceId, relationId: RelationId): boolean {
  if (!source.index.relationById.has(relationId)) return false;
  const voice = source.index.voiceById.get(voiceId);
  if (voice === undefined) return false;
  return [
    ...voice.ties,
    ...voice.slurs,
    ...voice.tuplets,
    ...voice.tabRelations,
    ...voice.brokenRhythms,
  ].some(
    (relation) => relation.id === relationId,
  );
}

/**
 * C3：逐分支真的查一次，**且 event / relation 两支都校验 ownership**（裁决③）。
 * 没有恒成立的分支：`document` 也要求 `RenderScore` 的根确实是同一份 `Score`。
 */
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
      return relationBelongsToVoice(source, anchor.voiceId, anchor.relationId);
    default: {
      const exhaustive: never = anchor;
      return exhaustive;
    }
  }
}
