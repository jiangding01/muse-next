/**
 * notation/tab —— 单音 stroke（拨弦 / 扫弦方向）记号的几何（M2 方案 §3.3，T6.3；
 * spec §26.4，`CONFIRMED BY DOCUMENTATION`，值域开放）。
 *
 * **渲染做法是如实呈现，不是二次解释**：`TabNote.stroke` 原样保留的是原字符
 * （`V`/`U`/`A`/`B`/`P`/`H`/`'`/`S`/`T`），画的也是原字符本身——不把 `V`/`U` 画成箭头，
 * 那是把 help 符号表的字面含义换成了我们自己的图形约定，读者对不上原文。字符统一画在
 * 该音所在列、第 1 弦上方（产品决定，`TAB_METRICS.strokeOffsetY`）。
 *
 * **组级 vs 单音级**（M1.8 已知限制②）：`TabGroupEvent.stroke` 在 parse 层从不填充
 * （`src/formats/jcx/parse/body/scan.ts` 的 `scanTabGroup` 从不读取组级前缀；组级前缀如
 * `V[...]` 是悬空 `strokePrefix` marker，被消费掉后不落进事件流，谱面上不显示）——
 * 这不是「扫弦方向不可用」，而是「作用范围不同的两件事，M2 只实现了其中单音的一件」。
 * 下面仍然写了 `TabGroupEvent.stroke` 有值时的画法（按单音规则、拼进同一个记号槽），
 * 但**当前不可达**，只是不让接口形状锁死这条未来会打开的路径。
 */

import type { EventId, TabGroupEvent, TabNote } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { Anchor, RenderVoice } from '../model/types';
import { draftOf, glyph } from './tabGlyphs';
import type { DraftSink, TabNode, TabTextGlyph } from './tabGlyphs';

export interface TabStrokeMark {
  readonly anchor: Anchor;
  readonly eventId: EventId;
  readonly text: TabTextGlyph;
  readonly systemIndex: number;
}

export interface TabStrokesResult {
  readonly strokes: readonly TabStrokeMark[];
}

/** help 2.1.4 符号表（spec §26.4）：`V`/`U`/`A`/`B`/`P`/`H`/`'`/`S`/`T` 九种。 */
const STROKE_SYMBOL_TABLE = new Set(['V', 'U', 'A', 'B', 'P', "'", 'S', 'T', 'H']);

function strokeGlyph(text: string, x: number, staffTop: number): TabTextGlyph {
  return glyph(text, x, staffTop + TAB_METRICS.strokeOffsetY, TAB_METRICS.strokeFontSize);
}

/**
 * 逐字符发诊断：`H` 按「延长」解释是 spec §26.4 的 `INFERRED`（I15）位置消歧，非
 * 符号表内的字符如实画出但不猜语义。两条判据互斥（`H` 恒在符号表内），不会同一个
 * 字符触发两条诊断。
 */
function sinkStrokeDiagnostics(
  chars: readonly string[],
  anchor: Anchor,
  sourceRef: Parameters<typeof draftOf>[4],
  sink: DraftSink,
): void {
  for (const ch of chars) {
    if (ch === 'H') {
      sink(draftOf(
        CODES.tabStrokeHoldInferred,
        'info',
        'stroke 记号 H 作为独立前缀时，按「延长」解释（spec §26.4 的 INFERRED 位置消歧 I15），不是「敲击」——两种含义在 help 符号表里都用同一个字符，无法从字符本身区分',
        anchor,
        sourceRef,
      ));
    } else if (!STROKE_SYMBOL_TABLE.has(ch)) {
      sink(draftOf(
        CODES.tabStrokeUnrecognized,
        'warning',
        `stroke 记号 ${JSON.stringify(ch)} 不在 help 2.1.4 符号表内（spec §26.4）：仍画原字符，不猜语义`,
        anchor,
        sourceRef,
      ));
    }
  }
}

/** 组合事件（`tabGroup`）成员级 stroke：非空的按成员原始顺序收集，忽略空串。 */
function memberStrokesOf(members: readonly TabNote[]): readonly string[] {
  const strokes: string[] = [];
  for (const member of members) {
    if (member.stroke !== undefined && member.stroke !== '') strokes.push(member.stroke);
  }
  return strokes;
}

/**
 * `tabGroup` 事件应画的 stroke 字符集合：成员级（可达）+ 组级（`TabGroupEvent.stroke`，
 * 当前不可达，parse 层从不填充）。**同一事件多成员有 stroke 时只画一次、字符拼接**——
 * 都画在第 1 弦上方同一个位置，逐个单独画只会互相重叠，拼接成一个记号才看得出有几个。
 */
function tabGroupStrokesOf(event: TabGroupEvent): readonly string[] {
  const strokes = memberStrokesOf(event.members);
  if (event.stroke === undefined || event.stroke === '') return strokes;
  return [...strokes, event.stroke];
}

/** TAB 单音 / 组 stroke 记号入口：一个声部的全部 stroke → 一批文本记号 + 诊断。 */
export function buildTabStrokes(
  voice: RenderVoice,
  nodeByEvent: ReadonlyMap<string, TabNode>,
  sink: DraftSink,
): TabStrokesResult {
  const strokes: TabStrokeMark[] = [];
  const voiceAnchor: Anchor = { kind: 'voice', voiceId: voice.voiceId };
  // 每个 TAB 声部恰好一条：措辞见文件头——精确区分「单音支持 / 组不支持」，不写成
  //「扫弦方向不可用」（组级前缀在谱面上确实不显示，但单音级的完全按 stroke 画出）。
  sink(draftOf(
    CODES.tabGroupStrokeNotModeled,
    'info',
    'M2 的 TAB 渲染支持单音级的扫弦/拨弦方向记号（TabNote.stroke，parse 层已填充），不支持组级的方向记号（TabGroupEvent.stroke，parse 层从不填充，M1.8 已知限制②）；组级前缀（如 V[...]）在谱面上不显示',
    voiceAnchor,
  ));

  for (const item of voice.items) {
    const event = item.event;
    const node = nodeByEvent.get(item.eventId);
    if (node === undefined) continue;
    const anchor: Anchor = { kind: 'event', voiceId: voice.voiceId, eventId: item.eventId };

    const chars =
      event.kind === 'tabNote'
        ? event.note.stroke === undefined || event.note.stroke === '' ? [] : [event.note.stroke]
        : event.kind === 'tabGroup'
          ? tabGroupStrokesOf(event)
          : [];
    if (chars.length === 0) continue;

    sinkStrokeDiagnostics(chars, anchor, item.sourceRef, sink);
    strokes.push({
      anchor,
      eventId: item.eventId,
      systemIndex: node.systemIndex,
      text: strokeGlyph(chars.join(''), node.x, node.y),
    });
  }

  return { strokes };
}
