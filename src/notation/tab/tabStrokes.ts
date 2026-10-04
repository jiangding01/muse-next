/**
 * notation/tab —— 单音 stroke（拨弦 / 扫弦方向）记号的几何（M2 方案 §3.3，T6.3；
 * spec §26.4，`CONFIRMED BY DOCUMENTATION`，值域开放）。
 *
 * **M2.5 T3.5 起的产品决定反转（§Q8.4，用户裁决 Q12-a）**：T6.3 原先一律画原字符，论证是「把 `V`/`U`
 * 画成箭头等于用我们自己的图形约定替换 help 符号表的字面含义」。现在只对**方向明确**的两个符号做替换：
 * `V`（下拨）→ `↓`、`U`（上拨）→ `↑`（help 符号表等级 `CONFIRMED BY DOCUMENTATION`）；`A`/`B`/`P`/`H`/
 * `'`/`S`/`T` 不是方向记号，**仍画原字符**（画箭头即臆造）。多字符逐字符映射；记号仍是文本字形，
 * 仍是 overlay、不进 `layout.nodes`，`TabStrokeMark` 的类型与 anchor 归属不变；诊断（含 `H` 的
 * `tabStrokeHoldInferred`）照旧按**原字符**判定。列宽仍按原字符量（`tabSlotWidths.ts`），确定性量宽器下
 * `↓`/`↑` 与 `V`/`U` 等宽。字符画在该音所在列、第 1 弦上方（`TAB_METRICS.strokeOffsetY`）；与和弦名 /
 * 和弦图的纵向次序（F-11）是 T6 的集成约定，本步只保证箭头在第 1 弦之上。
 *
 * **组级 vs 单音级**：单音级与组级方向记号按同一规则显示（`V`/`U` 箭头，其余原字符）。`TabGroupEvent.stroke`
 * 自 2026-09-22（M2.5 formats preflight）起由 `src/formats/jcx/parse/body/scanTab.ts`
 * 的 `scanTopLevelItems` 回填（`V[...]` 的 `V` 绑进事件本身），下面
 * `tabGroupStrokesOf` 的组级画法随之可达，与成员级 stroke 拼进同一个记号槽。
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

/** §Q8.4：只有方向明确的 `V` / `U` 画成箭头，其余字符原样。 */
const STROKE_ARROWS: Readonly<Record<string, string>> = { V: '↓', U: '↑' };

export function strokeDisplayText(chars: readonly string[]): string {
  return [...chars.join('')].map((ch) => STROKE_ARROWS[ch] ?? ch).join('');
}

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
 * `tabGroup` 事件应画的 stroke 字符集合：成员级 + 组级（`TabGroupEvent.stroke`，
 * parse 层已回填，见文件头）。**同一事件多成员有 stroke 时只画一次、字符拼接**——
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
      text: strokeGlyph(strokeDisplayText(chars), node.x, node.y),
    });
  }

  return { strokes };
}
