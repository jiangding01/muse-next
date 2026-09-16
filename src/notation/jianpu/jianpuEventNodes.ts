/**
 * notation/jianpu —— **单个事件 → 单个可见节点**的构造（M2 方案 v1.1.1 §3.2，T5.2-A 拆出）。
 *
 * 拆分理由与 `jianpuGlyphs.ts` 同源：`layoutJianpu.ts` 在 T5.2-A 引入「先横向打包、再按各
 * 行谱实际的歌词行数补高度」的两趟布局后必然超过 350 行的工程上限。切口选在**编排与构造**
 * 之间：本文件只回答「给定一个已经定好位置的事件，画成什么」，完全不碰 measure 切分、换行、
 * 歌词归属与行高——那些仍留在 `layoutJianpu.ts`。
 *
 * 契约照旧，一条都没有放宽：`UnknownEvent` **恰好一个**可见占位节点（C1）；走了降级路径的
 * 节点 `fallback: true` 且**至少关联一条** `RenderDiagnostic`（C2）；UNVERIFIED 一律保守
 * 呈现 + 诊断，从不静默（`Z` 按普通休止画 `0`、`@` 照常画并占位、tuplet 不做任何时值缩放、
 * 混合方向八度只按 `register` 画）。
 *
 * 依赖方向单向 `layoutJianpu.ts → jianpuEventNodes.ts → jianpuGlyphs.ts`，无环；尺寸一律
 * 取自 `layout/metrics.ts` 的 `JIANPU_METRICS`（尺寸常量唯一来源），单位是 abstract unit。
 */

import type { EventId, MusicEvent, Note, Rational, Rest, VoiceId } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { SpacedSlot } from '../layout/spacing';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import { decomposeDuration } from '../model/duration';
import type { Anchor, RenderItem } from '../model/types';
import {
  buildBarlineGlyphs,
  buildDurationGlyphs,
  buildPitchGlyphs,
  classifyBarline,
  draftOf,
  glyph,
} from './jianpuGlyphs';
import type {
  DraftSink,
  JianpuChordMemberGlyph,
  JianpuDurationGlyphs,
  JianpuNode,
  JianpuNodeBase,
  JianpuTextNode,
} from './jianpuGlyphs';
import { pitchToNumber } from './pitchToNumber';

/** 横向已定、纵向未定的一项：y 要等各行谱补完歌词高度之后才算得出来。 */
export interface Placed {
  readonly item: RenderItem;
  readonly slot: SpacedSlot;
  readonly measureIndex: number;
  readonly systemIndex: number;
  readonly x: number;
}

export interface Cursor extends Placed {
  readonly y: number;
}

/** 事件级 `Anchor`：节点与诊断共用同一个定义（§0d-1），不另设别名。 */
export function eventAnchor(voiceId: VoiceId, eventId: EventId): Anchor {
  return { kind: 'event', voiceId, eventId };
}

function baseOf(
  cursor: Cursor, voiceId: VoiceId, fallback: boolean, glyphWidth: number,
): JianpuNodeBase {
  return {
    anchor: eventAnchor(voiceId, cursor.item.eventId), sourceRef: cursor.item.sourceRef,
    slotIndex: cursor.slot.slot.index,
    measureIndex: cursor.measureIndex, systemIndex: cursor.systemIndex,
    x: cursor.x, y: cursor.y, width: cursor.slot.slot.width, glyphWidth, fallback,
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

/**
 * 空数组的 `Math.max(...[])` 是 `-Infinity`：`[]` / `{}` 这种零成员括号语法可达
 * （parse 不设成员数下限），字形宽必须退回 0 而不是把 `-Infinity` 带进弧线几何。
 */
function maxOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
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
  const textWidth = measurer.measure(text, { fontSize: size }).width;
  if (kind === 'decoration') {
    sink(draftOf(CODES.decorationPlaceholder, 'info', '装饰记号只画统一文本占位：M2 不做符号字形映射（spec §23 U27–U30）', anchor, item.sourceRef));
  } else if (kind === 'unknown') {
    sink(draftOf(CODES.eventUnknown, 'warning', '未知事件画成可见占位，不静默跳过（契约 C1：恰好一个可见节点）', anchor, item.sourceRef));
  } else if (kind === 'outOfScope') {
    sink(draftOf(CODES.jianpuEventOutOfScope, 'info', `事件类型 ${item.event.kind} 不属于简谱渲染范围，画成可见占位，不静默丢弃`, anchor, item.sourceRef));
  }
  return {
    ...baseOf(cursor, voiceId, kind !== 'chordSymbol', textWidth),
    kind, text: glyph(text, x, y, size),
    textWidth,
  };
}

export function buildNode(
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
      const text = glyph(String(pitch.number), x, y, size);
      const glyphWidth = measurer.measure(text.text, { fontSize: size }).width;
      if (pitch.mixedOctave) {
        sink(draftOf(CODES.jianpuOctaveMixed, 'info', "八度修饰同时含 ' 与 ,（spec §14.2 UNVERIFIED）：只按 register 画基准八度，不实现抵消", anchor, item.sourceRef));
      }
      return {
        ...baseOf(cursor, voiceId, pitch.mixedOctave || isDurationFallback(event.note.duration, duration), glyphWidth),
        kind: 'note',
        pitch,
        text,
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
      const text = glyph('0', x, y, size);
      const glyphWidth = measurer.measure(text.text, { fontSize: size }).width;
      return {
        ...baseOf(cursor, voiceId, code !== undefined || isDurationFallback(event.rest.duration, duration), glyphWidth),
        kind: 'rest',
        variant,
        text,
        duration,
      };
    }
    case 'chord': {
      const duration = durationGlyphsOf(event.duration, x, y);
      const members = event.members.map((member, index) => memberGlyph(member, index, x, y));
      // 组内各成员各画各的数字：弧线等需要对准的是「最宽那个数字」，不是整组的纵向堆叠范围。
      const glyphWidth = maxOrZero(
        members.map((member) => measurer.measure(member.text.text, { fontSize: JIANPU_METRICS.digitFontSize }).width),
      );
      return {
        ...baseOf(cursor, voiceId, isDurationFallback(event.duration, duration), glyphWidth),
        kind: 'chord',
        members,
        duration,
      };
    }
    case 'grace': {
      // 倚音**不占时值**（spec §21）：只做水平偏移，列宽仍是 untimed 的固定窄列。
      const offset = event.after ? JIANPU_METRICS.graceOffsetX : -JIANPU_METRICS.graceOffsetX;
      const texts = event.members.map((member, index) => glyph(
        'pitch' in member ? String(pitchToNumber(member.pitch).number) : String(member.fret),
        x + offset + index, y, JIANPU_METRICS.graceFontSize,
      ));
      // bbox span：各 text 的 x 因 `offset + index` 各不相同，宽度必须按「最右字形右边界
      // − 最左字形左边界」算，不能拿各字形宽度直接相加（那会把位移也重复计入一次）。
      const textRights = texts.map(
        (t) => t.x + measurer.measure(t.text, { fontSize: JIANPU_METRICS.graceFontSize }).width,
      );
      const textLefts = texts.map((t) => t.x);
      const glyphWidth = texts.length === 0 ? 0 : Math.max(...textRights) - Math.min(...textLefts);
      return {
        ...baseOf(cursor, voiceId, false, glyphWidth),
        kind: 'grace',
        after: event.after,
        texts,
      };
    }
    case 'barline': {
      const form = classifyBarline(event.raw);
      if (form === 'unrecognized') {
        sink(draftOf(CODES.barlineUnrecognized, 'info', `小节线 ${JSON.stringify(event.raw)} 不在 spec §18 已知形态表内：画普通单线，不推断反复语义`, anchor, item.sourceRef));
      }
      const glyphs = buildBarlineGlyphs(form, x, y);
      // bbox span：如实取线组 x 极差，单线时为 0——小节线不是 tie/slur 端点，没有「最小宽度」
      // 一说；仓库 metrics 里也没有任何线宽常量可用，不为此新增或挪用 `barlineCompositeGap`
      // （那是复合线的间距，不是宽度）。
      const lineXs = glyphs.lines.map((line) => line.x1);
      const glyphWidth = Math.max(...lineXs) - Math.min(...lineXs);
      return {
        ...baseOf(cursor, voiceId, form === 'unrecognized', glyphWidth),
        kind: 'barline',
        raw: event.raw,
        form,
        glyphs,
      };
    }
    default:
      return buildTextNode(cursor, voiceId, measurer, sink);
  }
}
