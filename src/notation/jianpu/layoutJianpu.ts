/**
 * notation/jianpu —— `RenderVoice` → `JianpuLayout`（M2 方案 v1.1.1 §3.2 / §2.6 / §6 T4）。
 *
 * 本文件负责**判定与编排**（measure 切分、换行、关系、歌词、标签、诊断）；几何与节点
 * 类型在 `jianpuGlyphs.ts`，列宽与换行在 `layout/spacing.ts` / `layout/systems.ts`。
 * `JianpuLayout` 是简谱**自己的** layout model，不继承任何万能基类（§2.7）。
 *
 * UNVERIFIED 一律**保守呈现 + 诊断**，从不静默：`Z` 按普通休止画 `0`（不画多小节休止、
 * 不占多小节宽度）、`@` 照常画并占位（绝不隐藏）、tuplet 不做任何时值缩放、混合方向
 * 八度只按 `register` 画、`UnknownEvent` **恰好一个**可见占位节点（契约 C1）。
 *
 * 调号一律以 `K: <值>` 转述事实：**全文件没有生成 `1=<tonic>` 的代码路径**（P1-2）——
 * 那个标签在简谱惯例里表示「X 是 do」，与固定 C 映射直接冲突，画出来会误导读谱；
 * `KeySignature.alter` 也**从不被读取**（据它反推主音在大小调间二义，属臆造）。
 */

import type {
  DomainIndex, EventId, KeySignature, Meter, MusicEvent, Note, Rational, Rest, VoiceId,
} from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import { spaceItems } from '../layout/spacing';
import type { SpacedSlot } from '../layout/spacing';
import { layoutSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { decomposeDuration } from '../model/duration';
import type { Anchor, RenderDiagnostic, RenderItem, RenderVoice } from '../model/types';
import {
  buildBarlineGlyphs,
  buildDurationGlyphs,
  buildPitchGlyphs,
  buildUnitLengthMark,
  classifyBarline,
  draftOf,
  glyph,
} from './jianpuGlyphs';
import type {
  DraftSink,
  JianpuArc,
  JianpuChordMemberGlyph,
  JianpuDurationGlyphs,
  JianpuLabel,
  JianpuLyricNode,
  JianpuNode,
  JianpuNodeBase,
  JianpuTextNode,
  JianpuTupletBracket,
  JianpuUnitLengthMark,
} from './jianpuGlyphs';
import { buildHeaderLabels, buildLyricNodes, relationLayout } from './jianpuSections';
import { pitchToNumber } from './pitchToNumber';

/** 布局输入。`measurer` **显式注入**：无模块级单例、无全局兜底（§2.8）。 */
export interface JianpuContext {
  /** 只取头部标签需要的两项；`Score` 本体不被本层修改。 */
  readonly score: { readonly key?: KeySignature; readonly meter?: Meter };
  /** 与 `score` 同源的 `DomainIndex`（§2.4.1）：关系反查只查它，本层零自建 Domain lookup。 */
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  /** 容器可用宽度（abstract unit）：贪心换行的唯一阈值（D7）。 */
  readonly availableWidth: number;
}

export interface JianpuLayout {
  readonly voiceId: VoiceId;
  readonly systems: readonly System[];
  readonly measures: readonly MeasureSlice[];
  readonly slots: readonly SpacedSlot[];
  readonly nodes: readonly JianpuNode[];
  readonly tuplets: readonly JianpuTupletBracket[];
  readonly arcs: readonly JianpuArc[];
  readonly lyrics: readonly JianpuLyricNode[];
  readonly labels: readonly JianpuLabel[];
  readonly unitLengthMarks: readonly JianpuUnitLengthMark[];
  readonly width: number;
  readonly height: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}

interface Cursor {
  readonly item: RenderItem;
  readonly slot: SpacedSlot;
  readonly measureIndex: number;
  readonly systemIndex: number;
  readonly x: number;
  readonly y: number;
}

function eventAnchor(voiceId: VoiceId, eventId: EventId): Anchor {
  return { kind: 'event', voiceId, eventId };
}

function baseOf(cursor: Cursor, voiceId: VoiceId, fallback: boolean): JianpuNodeBase {
  return {
    anchor: eventAnchor(voiceId, cursor.item.eventId), sourceRef: cursor.item.sourceRef,
    slotIndex: cursor.slot.slot.index,
    measureIndex: cursor.measureIndex, systemIndex: cursor.systemIndex,
    x: cursor.x, y: cursor.y, width: cursor.slot.slot.width, fallback,
  };
}

/**
 * 该事件是否走了时值上的降级路径（契约 C2：这类节点至少关联一条 `RenderDiagnostic`）。
 *
 * 两种情形**都算**，且诊断都已由 T1 的 `buildRenderScore` 在 event 级发出：
 * - `duration` 缺失（`L:` 不可知）→ `muse.render.duration.unresolved`；
 * - `duration` 存在但不可表示为 `base × {1, 3/2, 7/4}`（`1/12`、`5/16`）→
 *   `muse.render.duration.unrepresentable`。后者虽然列宽按字面 `duration` 正常排布，
 *   但**一个时值装饰都画不出来**，谱面与作者所写并不完全对应，属于降级。
 */
function isDurationFallback(
  duration: Rational | undefined,
  glyphs: JianpuDurationGlyphs,
): boolean {
  return duration === undefined || glyphs.unrepresentable;
}

/** `duration` 缺失 → 不画任何时值装饰（固定宽占位已由 `spacing.ts` 给出，§2.6.1 R4）。 */
function durationGlyphsOf(
  duration: Rational | undefined, x: number, y: number,
): JianpuDurationGlyphs {
  return duration === undefined
    ? { beams: [], dashes: [], augmentationDots: [], unrepresentable: false }
    : buildDurationGlyphs(decomposeDuration(duration), x, y);
}

/** 和弦块纵向堆叠（§14.4：组时值取首音，Domain 已放在 `ChordEvent.duration`）。 */
function memberGlyph(
  member: Note | Rest, index: number, x: number, y: number,
): JianpuChordMemberGlyph {
  const memberY = y - index * JIANPU_METRICS.chordMemberGap;
  const size = JIANPU_METRICS.digitFontSize;
  if (!('pitch' in member)) return { memberIndex: index, text: glyph('0', x, memberY, size) };
  const pitch = pitchToNumber(member.pitch, member.accidental);
  return {
    memberIndex: index, text: glyph(String(pitch.number), x, memberY, size),
    pitchGlyphs: buildPitchGlyphs(pitch, x, memberY),
  };
}

function textNodeKindOf(event: MusicEvent): JianpuTextNode['kind'] {
  if (event.kind === 'decoration') return 'decoration';
  if (event.kind === 'chordSymbol') return 'chordSymbol';
  return event.kind === 'unknown' ? 'unknown' : 'outOfScope';
}

function textNodeTextOf(event: MusicEvent): string {
  if (event.kind === 'decoration') {
    return event.decoration.form === 'simple' ? event.decoration.name : event.decoration.raw;
  }
  if (event.kind === 'chordSymbol') return event.symbol.raw;
  if (event.kind === 'unknown') return event.raw;
  return event.kind;
}

/** 装饰 / 和弦符号 / 未知 / 范围外事件的文本占位。**不做符号字形映射**（U27–U30）。 */
function buildTextNode(
  cursor: Cursor, voiceId: VoiceId, measurer: TextMeasurer, sink: DraftSink,
): JianpuNode {
  const { item, x, y } = cursor;
  const kind = textNodeKindOf(item.event);
  const text = textNodeTextOf(item.event);
  const anchor = eventAnchor(voiceId, item.eventId);
  const size = JIANPU_METRICS.annotationFontSize;
  if (kind === 'decoration') {
    sink(draftOf(CODES.decorationPlaceholder, 'info', '装饰记号只画统一文本占位：M2 不做符号字形映射（spec §23 U27–U30）', anchor, item.sourceRef));
  } else if (kind === 'unknown') {
    sink(draftOf(CODES.eventUnknown, 'warning', '未知事件画成可见占位，不静默跳过（契约 C1：恰好一个可见节点）', anchor, item.sourceRef));
  } else if (kind === 'outOfScope') {
    sink(draftOf(CODES.jianpuEventOutOfScope, 'info', `事件类型 ${item.event.kind} 不属于简谱渲染范围，画成可见占位，不静默丢弃`, anchor, item.sourceRef));
  }
  return {
    ...baseOf(cursor, voiceId, kind !== 'chordSymbol'),
    kind, text: glyph(text, x, y, size),
    textWidth: measurer.measure(text, { fontSize: size }).width,
  };
}

function buildNode(
  cursor: Cursor, voiceId: VoiceId, measurer: TextMeasurer, sink: DraftSink,
): JianpuNode {
  const { item, x, y } = cursor;
  const event = item.event;
  const anchor = eventAnchor(voiceId, item.eventId);
  const size = JIANPU_METRICS.digitFontSize;

  switch (event.kind) {
    case 'note': {
      const pitch = pitchToNumber(event.note.pitch, event.note.accidental);
      const duration = durationGlyphsOf(event.note.duration, x, y);
      if (pitch.mixedOctave) {
        sink(draftOf(CODES.jianpuOctaveMixed, 'info', "八度修饰同时含 ' 与 ,（spec §14.2 UNVERIFIED）：只按 register 画基准八度，不实现抵消", anchor, item.sourceRef));
      }
      return {
        ...baseOf(cursor, voiceId, pitch.mixedOctave || isDurationFallback(event.note.duration, duration)),
        kind: 'note',
        pitch,
        text: glyph(String(pitch.number), x, y, size),
        pitchGlyphs: buildPitchGlyphs(pitch, x, y),
        duration,
      };
    }
    case 'rest': {
      const variant = event.rest.variant;
      // `Z` 与 `@` 各有各的 code：语义不同，合并会让后续拿到新语料时无法区分。
      const code = variant === 'Z' ? CODES.restMultiMeasureNotModeled
        : variant === '@' ? CODES.restInvisibleNotModeled : undefined;
      if (code !== undefined) {
        sink(draftOf(code, 'info', `休止 ${variant} 的语义 UNVERIFIED：按普通休止画 0 并照常占位，既不画多小节休止也不隐藏`, anchor, item.sourceRef));
      }
      const duration = durationGlyphsOf(event.rest.duration, x, y);
      return {
        ...baseOf(cursor, voiceId, code !== undefined || isDurationFallback(event.rest.duration, duration)),
        kind: 'rest',
        variant,
        text: glyph('0', x, y, size),
        duration,
      };
    }
    case 'chord': {
      const duration = durationGlyphsOf(event.duration, x, y);
      return {
        ...baseOf(cursor, voiceId, isDurationFallback(event.duration, duration)),
        kind: 'chord',
        members: event.members.map((member, index) => memberGlyph(member, index, x, y)),
        duration,
      };
    }
    case 'grace': {
      // 倚音**不占时值**（spec §21）：只做水平偏移，列宽仍是 untimed 的固定窄列。
      const offset = event.after ? JIANPU_METRICS.graceOffsetX : -JIANPU_METRICS.graceOffsetX;
      return {
        ...baseOf(cursor, voiceId, false),
        kind: 'grace',
        after: event.after,
        texts: event.members.map((member, index) => glyph(
          'pitch' in member ? String(pitchToNumber(member.pitch).number) : String(member.fret),
          x + offset + index, y, JIANPU_METRICS.graceFontSize,
        )),
      };
    }
    case 'barline': {
      const form = classifyBarline(event.raw);
      if (form === 'unrecognized') {
        sink(draftOf(CODES.barlineUnrecognized, 'info', `小节线 ${JSON.stringify(event.raw)} 不在 spec §18 已知形态表内：画普通单线，不推断反复语义`, anchor, item.sourceRef));
      }
      return {
        ...baseOf(cursor, voiceId, form === 'unrecognized'),
        kind: 'barline',
        raw: event.raw,
        form,
        glyphs: buildBarlineGlyphs(form, x, y),
      };
    }
    default:
      return buildTextNode(cursor, voiceId, measurer, sink);
  }
}

/**
 * 简谱布局入口。纯函数：同一 `(voice, ctx)` 必然得到逐字段相等的输出
 * （`ctx.measurer` 按 §2.8 的契约也必须是纯函数）。
 */
export function layoutJianpu(voice: RenderVoice, ctx: JianpuContext): JianpuLayout {
  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) => spaceItems(measure.items, measure.startIndex));
  const { systems, placements } = layoutSystems(spacings.map((spacing) => spacing.width), {
    availableWidth: ctx.availableWidth,
    systemHeight: JIANPU_METRICS.systemHeight,
    systemGap: JIANPU_METRICS.systemGap,
    originY: JIANPU_METRICS.headerHeight,
  });

  const nodes: JianpuNode[] = [];
  const slots: SpacedSlot[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: DraftSink = (item) => { drafts.push(item); };
  // 布局用途的位置索引（`EventId → node`）：§2.4.1 明确允许，它不是 Domain lookup。
  const nodeByEvent = new Map<string, JianpuNode>();

  for (const [measureIndex, measure] of measures.entries()) {
    const spacing = spacings[measureIndex];
    const placement = placements[measureIndex];
    const system = placement === undefined ? undefined : systems[placement.systemIndex];
    if (spacing === undefined || placement === undefined || system === undefined) continue;
    const baselineY = system.box.origin.y + JIANPU_METRICS.baselineOffset;

    for (const [offset, item] of measure.items.entries()) {
      const slot = spacing.slots[offset];
      if (slot === undefined) continue;
      slots.push(slot);
      const cursor: Cursor = {
        item, slot, measureIndex, systemIndex: placement.systemIndex,
        x: placement.x + slot.slot.x, y: baselineY,
      };
      const node = buildNode(cursor, voice.voiceId, ctx.measurer, sink);
      nodes.push(node);
      nodeByEvent.set(item.eventId, node);
    }
  }

  const lastSystem = systems[systems.length - 1];
  const lyricRows = voice.voice.lyricLines.length;
  const lyricTop = lastSystem === undefined
    ? JIANPU_METRICS.headerHeight
    : lastSystem.box.origin.y + JIANPU_METRICS.baselineOffset;
  const lyricSpan = lyricRows === 0
    ? 0
    : JIANPU_METRICS.lyricFirstOffset + lyricRows * JIANPU_METRICS.lyricLineGap;

  const relations = relationLayout(voice, ctx.index, nodeByEvent, sink);
  const lyrics = buildLyricNodes(
    voice,
    (id) => nodeByEvent.get(id)?.x,
    (row) => lyricTop + JIANPU_METRICS.lyricFirstOffset + row * JIANPU_METRICS.lyricLineGap,
    ctx.measurer,
    sink,
  );
  const labels = buildHeaderLabels(ctx.score.key, ctx.score.meter, ctx.measurer, sink);

  const unitLengthMarks: JianpuUnitLengthMark[] = [];
  for (const change of voice.voice.unitLengthChanges) {
    const node = nodeByEvent.get(change.beforeEventId);
    if (node === undefined) continue;
    const anchor = eventAnchor(voice.voiceId, change.beforeEventId);
    unitLengthMarks.push({ anchor, raw: change.raw, segment: buildUnitLengthMark(node.x, node.y) });
    sink(draftOf(CODES.unitLengthChanged, 'info', `此处 L: 变为 ${change.raw}：渲染直接用已解算好的 duration，不重新解释作用域（spec §8.5，U06 已由 Domain 选定）`, anchor, change.origin));
  }

  return {
    voiceId: voice.voiceId, systems, measures, slots, nodes,
    tuplets: relations.tuplets, arcs: relations.arcs, lyrics, labels, unitLengthMarks,
    width: systems.reduce((max, system) => Math.max(max, system.box.width), 0),
    height: lastSystem === undefined
      ? JIANPU_METRICS.headerHeight
      : lastSystem.box.origin.y + lastSystem.box.height + lyricSpan,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
