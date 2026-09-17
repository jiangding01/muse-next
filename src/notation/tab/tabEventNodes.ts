/**
 * notation/tab —— **单个事件 → 单个可见节点**的构造（M2 方案 §3.3，T6.1）。
 *
 * 十种 `MusicEvent.kind` 一个不少地穷尽 `switch`（`default` 分支的 `never` 赋值会在
 * Domain 新增事件类型时立刻编译报错）。契约与简谱侧完全一致，一条都没有放宽：
 *
 * - **C1**：`UnknownEvent` **恰好一个**可见占位节点，`summarizeEvent` 原样转述；
 * - **C2**：走了降级路径的节点 `fallback: true` 且**至少关联一条** `RenderDiagnostic`；
 * - **C3**：诊断的 `anchor` 指向该事件本身（`{ kind: 'event', voiceId, eventId }`）。
 *
 * pitch 模式事件（`note` / `chord`）落进 TAB 声部时走 `outOfScope` 文本占位 +
 * `tabEventOutOfScope`：音高与「哪根弦第几品」之间没有可逆映射（同一个音高在六线上
 * 有多个可弹位置），猜一个位置画出来就是在编造作者没写的指法。
 *
 * `-S-/-H-/-P-` 连线（`tabRelations.ts`）与 stroke 方向记号（`tabStrokes.ts`，spec
 * §26.4；`TabGroupEvent.stroke` 在 parse 层从不填充，M1.8 已知限制②）都是独立于单个
 * 事件节点构造的段落，T6.3 追加在 `layoutTab.ts` 里节点建好之后调用，不在本文件内。
 * 时值**来源**只透传不解释（`durationValue`）；时值**装饰**（符干 / 减时线 / 延音
 * 短横线 / 附点，T6.2）由 `tabDurationGlyphs.ts` 的 `buildTabDurationGlyphs` 构造，
 * 挂在节点的 `duration` 字段上。
 *
 * 依赖方向单向 `layoutTab.ts → tabEventNodes.ts → tabGlyphs.ts`，无环；尺寸一律取自
 * `layout/metrics.ts` 的 `TAB_METRICS`（唯一来源），单位是 abstract unit。
 */

import type { EventId, Note, TabNote, VoiceId } from '../../domain';
import { summarizeEvent, summarizePitch } from '../layout/fallbackSummary';
import { TAB_METRICS } from '../layout/metrics';
import type { SpacedSlot } from '../layout/spacing';
import type { TextMeasurer } from '../layout/textMeasurer';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { Anchor, RenderItem } from '../model/types';
import { durationGlyphsOf, isDurationFallback } from './tabDurationGlyphs';
import {
  buildFretGlyph,
  buildTabBarlineGlyphs,
  centeredGlyph,
  classifyTabBarline,
  draftOf,
  staffCenterY,
} from './tabGlyphs';
import type {
  DraftSink,
  TabFretGlyph,
  TabNode,
  TabNodeBase,
  TabTextGlyph,
  TabTextNode,
} from './tabGlyphs';

/** 一个已经定好位置的事件：`staffTop` 是所属 system 第 1 弦线的 y。 */
export interface Cursor {
  readonly item: RenderItem;
  readonly slot: SpacedSlot;
  readonly measureIndex: number;
  readonly systemIndex: number;
  readonly x: number;
  readonly staffTop: number;
}

/** 事件级 `Anchor`：节点与诊断共用同一个定义（§0d-1），不另设别名。 */
export function eventAnchor(voiceId: VoiceId, eventId: EventId): Anchor {
  return { kind: 'event', voiceId, eventId };
}

function baseOf(
  cursor: Cursor,
  voiceId: VoiceId,
  fallback: boolean,
  glyphWidth: number,
): TabNodeBase {
  return {
    anchor: eventAnchor(voiceId, cursor.item.eventId),
    sourceRef: cursor.item.sourceRef,
    slotIndex: cursor.slot.slot.index,
    measureIndex: cursor.measureIndex,
    systemIndex: cursor.systemIndex,
    x: cursor.x,
    y: cursor.staffTop,
    width: cursor.slot.slot.width,
    glyphWidth,
    fallback,
  };
}

/** 空数组的 `Math.max(...[])` 是 `-Infinity`：零成员组（`[]`）可达，字形宽退回 0。 */
function maxOrZero(values: readonly number[]): number {
  return values.length === 0 ? 0 : Math.max(...values);
}

/** 一个品位字形的文本宽度——`glyphWidth`（主字形 bbox 跨度）只认它，不含白底外扩。 */
function fretTextWidth(fret: TabFretGlyph, measurer: TextMeasurer): number {
  return measurer.measure(fret.text.text, { fontSize: fret.text.fontSize }).width;
}

/**
 * 同一组里是否有多个成员落在**同一根弦**上（如 `[a0/a3/]`）。一根弦同一时刻只发得出
 * 一个音，这组写法演奏上无法实现；但哪一个「有效」没有依据，故调用方一律全部照画
 * （会重叠）+ 一条 warning，不挑、不丢。
 */
function hasDuplicateString(members: readonly TabNote[]): boolean {
  const seen = new Set<number>();
  for (const member of members) {
    if (seen.has(member.stringIndex)) return true;
    seen.add(member.stringIndex);
  }
  return false;
}

/** 重复弦号的诊断文案只有一处来源，`tabGroup` 与倚音共用。 */
function sinkDuplicateString(item: RenderItem, anchor: Anchor, sink: DraftSink): void {
  sink(draftOf(CODES.tabGroupDuplicateString, 'warning', '同一根弦上出现多个品位：一根弦同时只发得出一个音，无法同时呈现——全部照画（会视觉重叠），不猜哪一个有效', anchor, item.sourceRef));
}

/** 装饰 / 和弦符号 / 未知 / 范围外事件的文本内容。 */
function textNodeTextOf(item: RenderItem): string {
  const event = item.event;
  if (event.kind === 'decoration') {
    return event.decoration.form === 'simple' ? event.decoration.name : event.decoration.raw;
  }
  if (event.kind === 'chordSymbol') return event.symbol.raw;
  // `unknown` 与 pitch 模式越界事件都走 `summarizeEvent`：原样转述，不假装是任何一种记谱。
  return summarizeEvent(event);
}

function textNodeFontSize(kind: TabTextNode['kind']): number {
  return kind === 'chordSymbol' ? TAB_METRICS.chordSymbolFontSize : TAB_METRICS.unknownFontSize;
}

/**
 * 文本占位的纵向位置：和弦符号画在六线**上方**那条预留行里（`chordSymbolOffsetY`），
 * 其余占位画在六线纵向中心——它们不属于任何一根弦，挂到某根弦上会被误读成指法。
 */
function textNodeGlyph(
  kind: TabTextNode['kind'],
  text: string,
  x: number,
  staffTop: number,
): TabTextGlyph {
  const fontSize = textNodeFontSize(kind);
  if (kind === 'chordSymbol') {
    return { text, x, y: staffTop + TAB_METRICS.chordSymbolOffsetY, fontSize };
  }
  return centeredGlyph(text, x, staffCenterY(staffTop), fontSize);
}

function buildTextNode(
  cursor: Cursor,
  voiceId: VoiceId,
  kind: TabTextNode['kind'],
  measurer: TextMeasurer,
  sink: DraftSink,
): TabNode {
  const { item, x, staffTop } = cursor;
  const text = textNodeTextOf(item);
  const anchor = eventAnchor(voiceId, item.eventId);
  const glyph = textNodeGlyph(kind, text, x, staffTop);
  const textWidth = measurer.measure(text, { fontSize: glyph.fontSize }).width;

  if (kind === 'decoration') {
    sink(draftOf(CODES.decorationPlaceholder, 'info', '装饰记号只画统一文本占位：M2 不做符号字形映射（spec §23 U27–U30）', anchor, item.sourceRef));
  } else if (kind === 'unknown') {
    sink(draftOf(CODES.eventUnknown, 'warning', '未知事件画成可见占位，不静默跳过（契约 C1：恰好一个可见节点）', anchor, item.sourceRef));
  } else if (kind === 'outOfScope') {
    sink(draftOf(CODES.tabEventOutOfScope, 'warning', `事件类型 ${item.event.kind} 是 pitch 模式事件，不属于 TAB 渲染范围：画成可见占位，不把音高猜成某根弦的某个品位（spec §26.10 差异汇总：TAB 里小写字母是弦号、前置大写字母是拨弦方向，音高与弦品之间没有可逆映射）`, anchor, item.sourceRef));
  }

  return {
    ...baseOf(cursor, voiceId, kind !== 'chordSymbol', textWidth),
    kind,
    text: glyph,
    textWidth,
  };
}

/** 倚音成员：`TabNote` 画小字号品位；pitch 模式的 `Note` 走 out-of-scope 文本占位。 */
function buildGraceNode(
  cursor: Cursor,
  voiceId: VoiceId,
  members: readonly (Note | TabNote)[],
  after: boolean,
  measurer: TextMeasurer,
  sink: DraftSink,
): TabNode {
  const { item, x, staffTop } = cursor;
  const anchor = eventAnchor(voiceId, item.eventId);
  const offset = after ? TAB_METRICS.graceOffsetX : -TAB_METRICS.graceOffsetX;
  const size = TAB_METRICS.graceFontSize;
  const frets: TabFretGlyph[] = [];
  const outOfScopeTexts: TabTextGlyph[] = [];

  // 整组只做**一次**水平偏移，组内与 `tabGroup` 同构：同一列纵向按弦分行。逐成员再错开
  // 1u 只会让字形几乎重叠却又对不齐任何一根弦，既看不出是几个音，也读不出在第几弦。
  const memberX = x + offset;
  // `memberIndex` 必须是 `members`（Domain 原始、pitch 与 TAB 混排）里的下标，不是
  // 「仅 TAB 成员」子序列的下标——`resolveVoiceRelations` 给出的 `NoteRef.memberIndex`
  // 恒按 Domain 原始数组解释（T6.3 关系连线的端点查找依赖这一点，见 `tabRelations.ts`）。
  const tabMembers: { readonly member: TabNote; readonly memberIndex: number }[] = [];
  members.forEach((member, memberIndex) => {
    if ('pitch' in member) {
      sink(draftOf(CODES.tabEventOutOfScope, 'warning', '倚音成员是 pitch 模式音符，不属于 TAB 渲染范围：画成可见文本占位，不猜弦品（spec §26.10 差异汇总）', anchor, item.sourceRef));
      outOfScopeTexts.push(centeredGlyph(summarizePitch(member.pitch), memberX, staffCenterY(staffTop), size));
      return;
    }
    tabMembers.push({ member, memberIndex });
  });
  for (const { member, memberIndex } of [...tabMembers].sort((a, b) => a.member.stringIndex - b.member.stringIndex)) {
    frets.push(buildFretGlyph(member.stringIndex, member.fret, memberX, staffTop, size, measurer, memberIndex));
  }

  const duplicateString = hasDuplicateString(tabMembers.map(({ member }) => member));
  if (duplicateString) sinkDuplicateString(item, anchor, sink);

  // bbox span：所有成员同一 x，跨度就是最宽的那个字形。
  const glyphWidth = maxOrZero([
    ...frets.map((fret) => fretTextWidth(fret, measurer)),
    ...outOfScopeTexts.map((text) => measurer.measure(text.text, { fontSize: size }).width),
  ]);

  return {
    ...baseOf(cursor, voiceId, outOfScopeTexts.length > 0 || duplicateString, glyphWidth),
    kind: 'grace',
    after,
    frets,
    outOfScopeTexts,
  };
}

export function buildTabNode(
  cursor: Cursor,
  voiceId: VoiceId,
  measurer: TextMeasurer,
  sink: DraftSink,
): TabNode {
  const { item, x, staffTop } = cursor;
  const event = item.event;
  const anchor = eventAnchor(voiceId, item.eventId);
  const size = TAB_METRICS.fretFontSize;

  switch (event.kind) {
    case 'tabNote': {
      const note = event.note;
      // `tabNote` 不是组合事件，没有「成员数组」：`memberIndex` 固定记 0（`TabFretGlyph`
      // 文档已注明这一约定），与 `NoteRef` 省略 `memberIndex` 时指「整个事件」同构。
      const fret = buildFretGlyph(note.stringIndex, note.fret, x, staffTop, size, measurer, 0);
      // `duration === undefined`（`L:` 不可知）是时值上的降级路径：固定宽占位已由
      // `spacing.ts` 给出（§2.6.1 R4），对应的 `muse.render.duration.unresolved` /
      // `muse.render.duration.unrepresentable` 诊断**已由 T1 的 `buildRenderScore` 在
      // event 级发出**，本层不重复报（§4.2：同一件事只由一层报告一次）——契约 C2
      // 「fallback 节点至少关联一条诊断」因此仍然成立。
      const duration = durationGlyphsOf(note.duration, x, staffTop);
      return {
        ...baseOf(cursor, voiceId, isDurationFallback(note.duration, duration), fretTextWidth(fret, measurer)),
        kind: 'tabNote',
        fret,
        durationValue: note.duration,
        duration,
      };
    }
    case 'tabGroup': {
      // 同一列纵向排开，按弦号升序（第 1 弦最上）；组时值取末音已由 Domain 解算（§26.8），
      // 时值装饰按这同一份末音时值推导，不逐成员各画一套。`memberIndex` 记 `event.members`
      // 的原始下标（排序前），不是排序后的显示位置——T6.3 关系连线端点查找依赖这一点。
      const ordered = event.members
        .map((member, memberIndex) => ({ member, memberIndex }))
        .sort((a, b) => a.member.stringIndex - b.member.stringIndex);
      const frets = ordered.map(({ member, memberIndex }) =>
        buildFretGlyph(member.stringIndex, member.fret, x, staffTop, size, measurer, memberIndex),
      );
      const glyphWidth = maxOrZero(frets.map((fret) => fretTextWidth(fret, measurer)));
      const duplicateString = hasDuplicateString(event.members);
      if (duplicateString) sinkDuplicateString(item, anchor, sink);
      // `duration === undefined` / `unrepresentable` 的说明同 `tabNote` 分支（诊断由
      // `buildRenderScore` 发出）。
      const duration = durationGlyphsOf(event.duration, x, staffTop);
      return {
        ...baseOf(cursor, voiceId, isDurationFallback(event.duration, duration) || duplicateString, glyphWidth),
        kind: 'tabGroup',
        frets,
        durationValue: event.duration,
        duration,
      };
    }
    case 'rest': {
      const variant = event.rest.variant;
      // `Z` 与 `@` 各有各的 code：语义不同，合并会让后续拿到新语料时无法区分。
      const code = variant === 'Z' ? CODES.restMultiMeasureNotModeled
        : variant === '@' ? CODES.restInvisibleNotModeled : undefined;
      if (code !== undefined) {
        sink(draftOf(code, 'info', `休止 ${variant} 的语义 UNVERIFIED：按普通休止画并照常占位，既不画多小节休止也不隐藏`, anchor, item.sourceRef));
      }
      const restSize = TAB_METRICS.restFontSize;
      const text = centeredGlyph(variant, x, staffCenterY(staffTop), restSize);
      const glyphWidth = measurer.measure(text.text, { fontSize: restSize }).width;
      // 休止符与音符共用同一套时值装饰规则（T6.2 方案明文：「rest 同规则」）。
      const duration = durationGlyphsOf(event.rest.duration, x, staffTop);
      return {
        ...baseOf(cursor, voiceId, code !== undefined || isDurationFallback(event.rest.duration, duration), glyphWidth),
        kind: 'rest',
        variant,
        text,
        durationValue: event.rest.duration,
        duration,
      };
    }
    case 'grace':
      return buildGraceNode(cursor, voiceId, event.members, event.after, measurer, sink);
    case 'barline': {
      const form = classifyTabBarline(event.raw);
      if (form === 'unrecognized') {
        sink(draftOf(CODES.barlineUnrecognized, 'info', `小节线 ${JSON.stringify(event.raw)} 不在 spec §18 已知形态表内：画普通单线，不推断反复语义`, anchor, item.sourceRef));
      }
      const glyphs = buildTabBarlineGlyphs(form, x, staffTop);
      // bbox span：如实取线组 x 极差，单线时为 0——小节线没有「最小宽度」一说。
      const lineXs = glyphs.lines.map((line) => line.x1);
      return {
        ...baseOf(cursor, voiceId, form === 'unrecognized', Math.max(...lineXs) - Math.min(...lineXs)),
        kind: 'barline',
        raw: event.raw,
        form,
        ...glyphs,
      };
    }
    case 'decoration':
      return buildTextNode(cursor, voiceId, 'decoration', measurer, sink);
    case 'chordSymbol':
      return buildTextNode(cursor, voiceId, 'chordSymbol', measurer, sink);
    case 'unknown':
      return buildTextNode(cursor, voiceId, 'unknown', measurer, sink);
    case 'note':
    case 'chord':
      return buildTextNode(cursor, voiceId, 'outOfScope', measurer, sink);
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
