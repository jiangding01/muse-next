/**
 * notation/system —— 和弦图 overlay 的**水平规划**（M2.5 T6，方案 §Q5.1–Q5.4 / F-4；用户裁决 A–N，2026-10-05）。
 *
 * 产出阶段类型 `ChordOverlayPlan`（**不带 y**，裁决 A-a）：最终 `ChordDiagramOverlay` 的 y、层序与 band 高度归 T8。
 *
 * 流水线（顺序即契约）：
 * 1. **候选与 x**（B-a / C-b / D-a）：x 是 system box 内的时间锚点，图 / 名以它为中心。shared 只消费 T3 `OverlayOnset`
 *    （onset(k) → `G.x + xByOffsetIndex[k]`，measure-end → `G.x + endX`）；tier 3 → 与 T5 同源的 `placeExternalMeasure`
 *    slot x（spacing 按需计算）。不 clamp。缺公共几何、shared 缺 timeline → `RangeError`；degraded / not-compatible 走 tier 3。
 * 2. **来源选择 / 语义去重**：见 `chordOverlaySources.ts`。
 * 3. **查表**（只对保留下来的候选）：`chordSymbolDisplayText(raw) === chordShapes[i].name`，零归一化；>1 → 只画名 + ambiguous。
 * 4. **footprint 与碰撞**（G / F-4 / H-a / I）：带图 = 实际 `ChordLayout` 局部包围平移到 `x − width/2`，只画名 = `x ± 名宽/2`；
 *    带图框与已接受框严格重叠 → 降级只画名 + collision（info），以名字框继续参与；名字框之间不处理。
 *
 * 诊断只含 T6 三种码，不重新合并 `composed.diagnostics`（T8 顺序 = 其后接本函数诊断）。`layoutChord` 按需缓存、签名不变。
 */

import type { SourceRef } from '../../domain';
import { layoutChord } from '../chord/layoutChord';
import type { ChordLayout } from '../chord/layoutChord';
import { chordSymbolDisplayText } from '../layout/chordSymbolDisplay';
import { placeExternalMeasure } from '../layout/measurePlacement';
import { CHORD_METRICS, SYSTEM_METRICS } from '../layout/metrics';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic, RenderScore } from '../model/types';
import { candidateAnchor, candidateDraft, resolveChordSources } from './chordOverlaySources';
import type { ChordCandidate } from './chordOverlaySources';
import type { ComposedSystemGeometry } from './composeSystem';
import type { EventAnchor, SystemMeasureGeometry } from './contracts';
import { createVoiceSpacings } from './measureDemand';

export type ChordOverlayForm = 'diagram' | 'name';

/** system box 内的水平占位与纵向高度（T8 据此排 F-11 次序与 band 高度）。 */
export interface ChordOverlayFootprint {
  readonly left: number;
  readonly right: number;
  readonly height: number;
}

export interface ChordOverlayPlan {
  readonly anchor: EventAnchor;
  readonly sourceRef: SourceRef;
  readonly displayText: string;
  readonly form: ChordOverlayForm;
  /** 仅 `form === 'diagram'`；缺席 = 只画名（0 命中 / 同名歧义 / 碰撞降级）。 */
  readonly shapeIndex?: number;
  readonly groupIndex: number;
  readonly systemIndex: number;
  readonly measureOrdinal: number;
  /** system box 内的时间锚点，图 / 名以它为中心。 */
  readonly x: number;
  readonly footprint: ChordOverlayFootprint;
}

export interface ChordOverlayPlanning {
  readonly plans: readonly ChordOverlayPlan[];
  /** 只含 `chord.name-ambiguous` / `chord.symbol-conflict` / `chord.diagram-collision`。 */
  readonly diagnostics: readonly RenderDiagnostic[];
}

function fail(message: string): never {
  throw new RangeError(`chord overlay: ${message}`);
}

/** 一个 group 的全部 chordSymbol 候选（shared 走 T3 `OverlayOnset`，tier 3 走 T5 同源自排）。 */
function groupCandidates(
  composed: ComposedSystemGeometry,
  groupIndex: number,
  geometryOf: ReadonlyMap<string, SystemMeasureGeometry>,
  spacingsOf: ReturnType<typeof createVoiceSpacings>,
): ChordCandidate[] {
  const { grouping, alignment, timings } = composed.analysis;
  const voiceIds = grouping.groups[groupIndex]?.voiceIds ?? [];
  const measures = alignment.groups.find((group) => group.groupIndex === groupIndex)?.measures ?? [];
  const measureTimings = timings.groups.find((group) => group.groupIndex === groupIndex)?.measures ?? [];
  const out: ChordCandidate[] = [];
  measures.forEach((measure, k) => {
    const g = geometryOf.get(`${String(groupIndex)}/${String(measure.measureOrdinal)}`);
    if (g === undefined) fail(`group ${String(groupIndex)} 第 ${String(measure.measureOrdinal)} 个 measure 缺少公共几何`);
    const timing = measureTimings[k];
    const shared = timing?.status === 'shared' ? timing : undefined;
    if (shared !== undefined && g.timeline === undefined) fail('shared measure 缺少 timeline');
    measure.members.forEach((member, memberIndex) => {
      if (!('renderVoice' in member)) return;
      const voice = member.renderVoice;
      const overlays = shared?.voices.find((entry) => entry.memberIndex === memberIndex)?.overlays;
      let slots: ReturnType<typeof placeExternalMeasure> | undefined;
      member.slice.items.forEach((item, itemIndex) => {
        if (item.event.kind !== 'chordSymbol') return;
        const base = {
          item,
          voiceId: voice.voiceId,
          voiceOrder: voiceIds.indexOf(voice.voiceId),
          itemIndex,
          groupIndex,
          measureOrdinal: measure.measureOrdinal,
          systemIndex: g.systemIndex,
          text: chordSymbolDisplayText(item.event.symbol.raw),
        };
        if (shared !== undefined && g.timeline !== undefined) {
          const position = overlays?.find((entry) => entry.itemIndex === itemIndex)?.position
            ?? fail('shared chordSymbol 缺少 T3 OverlayOnset');
          const offset = position.kind === 'onset'
            ? g.timeline.xByOffsetIndex[position.offsetIndex] ?? fail('offsetIndex 越界')
            : g.timeline.endX;
          const key = position.kind === 'onset' ? `o${String(position.offsetIndex)}` : 'end';
          out.push({ ...base, x: g.x + offset, position: key });
          return;
        }
        const spacing = spacingsOf(voice)[member.slice.index] ?? fail('缺少 voice spacing');
        slots ??= placeExternalMeasure(member.slice, spacing, g);
        out.push({ ...base, x: g.x + (slots[itemIndex]?.slot.x ?? fail('缺少 tier 3 slot')) });
      });
    });
  });
  return out;
}

function compareCandidates(a: ChordCandidate, b: ChordCandidate): number {
  return a.systemIndex - b.systemIndex
    || a.x - b.x
    || a.measureOrdinal - b.measureOrdinal
    || a.voiceOrder - b.voiceOrder
    || a.itemIndex - b.itemIndex;
}

/** 带图的实际局部包围（网格 0..width、居中名字、capo 标签），平移到以 x 为中心。 */
function diagramFootprint(layout: ChordLayout, x: number): ChordOverlayFootprint {
  const origin = x - layout.width / 2;
  const capo = layout.capoLabel;
  const left = Math.min(0, layout.name.x - layout.name.width / 2, ...(capo === undefined ? [] : [capo.x]));
  const right = Math.max(layout.width, layout.name.x + layout.name.width / 2, ...(capo === undefined ? [] : [capo.x + capo.width]));
  return { left: origin + left, right: origin + right, height: layout.height };
}

/** 整份文档的和弦图 overlay 水平规划（T6 阶段产物）。 */
export function planChordOverlays(
  renderScore: RenderScore,
  composed: ComposedSystemGeometry,
  measurer: TextMeasurer,
): ChordOverlayPlanning {
  const geometryOf = new Map(composed.lines.flatMap((line) =>
    line.measures.map((g) => [`${String(line.groupIndex)}/${String(g.measureOrdinal)}`, g] as const)));
  // spacing 按需：只有 tier 3 候选真正用到某个声部时才计算（createVoiceSpacings 内部按 RenderVoice 缓存）。
  const spacingsOf = createVoiceSpacings(renderScore.score, measurer);
  const sourceDrafts: RenderDiagnosticDraft[] = [];
  const retained = composed.analysis.grouping.groups.flatMap((group) =>
    resolveChordSources(groupCandidates(composed, group.index, geometryOf, spacingsOf), (draft) => { sourceDrafts.push(draft); }));

  const shapes = renderScore.score.chordShapes;
  const layouts = new Map<number, ChordLayout>();
  const layoutOf = (index: number): ChordLayout => {
    const cached = layouts.get(index);
    if (cached !== undefined) return cached;
    const chord = shapes[index] ?? fail('shapeIndex 越界');
    const layout = layoutChord(chord, { showFinger: renderScore.score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth });
    layouts.set(index, layout);
    return layout;
  };
  const nameFootprint = (c: ChordCandidate): ChordOverlayFootprint => {
    const size = measurer.measure(c.text, { fontSize: CHORD_METRICS.nameFontSize });
    return { left: c.x - size.width / 2, right: c.x + size.width / 2, height: size.height };
  };

  const lookupDrafts: RenderDiagnosticDraft[] = [];
  const collisionDrafts: RenderDiagnosticDraft[] = [];
  const accepted = new Map<number, ChordOverlayFootprint[]>();
  const plans = [...retained].sort(compareCandidates).map((c): ChordOverlayPlan => {
    // 查表在来源去重之后：ambiguous 只对保留下来的候选发（附加裁决）。
    const hits = shapes.flatMap((shape, index) => (shape.name === c.text ? [index] : []));
    if (hits.length > 1) {
      lookupDrafts.push(candidateDraft(CODES.chordNameAmbiguous, 'warning', `「${c.text}」对应 ${String(hits.length)} 条同名 %%gchord：只画和弦名，不猜用哪一条`, c));
    }
    const boxes = accepted.get(c.systemIndex) ?? [];
    accepted.set(c.systemIndex, boxes);
    const overlaps = (box: ChordOverlayFootprint): boolean => boxes.some((b) => box.left < b.right && b.left < box.right);
    const { groupIndex, systemIndex, measureOrdinal, x } = c;
    const base = { anchor: candidateAnchor(c), sourceRef: c.item.sourceRef, displayText: c.text, groupIndex, systemIndex, measureOrdinal, x };
    const [shapeIndex] = hits;
    if (hits.length === 1 && shapeIndex !== undefined) {
      const footprint = diagramFootprint(layoutOf(shapeIndex), c.x);
      if (!overlaps(footprint)) {
        boxes.push(footprint);
        return { ...base, form: 'diagram', shapeIndex, footprint };
      }
      collisionDrafts.push(candidateDraft(CODES.chordDiagramCollision, 'info', `和弦图「${c.text}」与同一行前面的和弦图 / 和弦名重叠：位置是时间事实不移动，本处只画和弦名`, c));
    }
    const footprint = nameFootprint(c);
    boxes.push(footprint);
    return { ...base, form: 'name', footprint };
  });

  return { plans, diagnostics: collectRenderDiagnostics([...sourceDrafts, ...lookupDrafts, ...collisionDrafts]) };
}
