/**
 * Parse 层 —— 正文事件扫描与时值派生（M1.6 T6；spec §14–§26，方案 v1.1 §1.2 / §1.7 / §5 T6）。
 *
 * 职责边界（方案 §0-5，本任务专属的三条硬约束）：
 * - **events 中不含 marker**：`tie` / `slurOpen` / `slurClose` / `tupletStart` /
 *   `brokenRhythm` / `tabRelation` / 悬空 `strokePrefix` 全部落进与事件流并列的
 *   `markers`，记录它在事件流中的插入位置（`beforeEventIndex`），交 T7 配对；
 * - **不改写时值**：broken rhythm 的相邻时值改写是 T7 的事，本层只做
 *   `durationRaw × unitLength` 这一条 CONFIRMED 派生（§16.1 + §8.5）；
 * - **不附着**：decoration 与 chordSymbol 是独立事件，不挂到任何音符上（方案 §7 E2）。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.rest.uppercase-z` | info | 首个 `Z`（§15.2 语义 UNVERIFIED，不赋多小节语义） |
 * | `jcx.parse.rest.hidden` | info | 首个 `@`（§15.3 DOC-ONLY，不赋隐藏行为） |
 * | `jcx.parse.body.unknown-event` | warning | 每种 tokenKind 每文档一次（§29.3） |
 * | `jcx.parse.duration.unparsed` | warning | 时值原文不符合 §16.1 / §26.5 形态（见 `../duration.ts`） |
 */

import type {
  JcxBodyNode,
  JcxChordNode,
  JcxGraceNode,
  JcxTabGroupNode,
} from '../../ast';
import type {
  MusicEvent,
  Note,
  Rest,
  Rational,
  SourceRef,
  TabNote,
  VoiceId,
} from '../../../../domain';
import { eventId } from '../../../../domain';
import type { EventId } from '../../../../domain';
import type { ParseContext } from '../header';
import type { UnitLengthScope } from '../duration';
import type { VoiceSegment } from './segments';
import type { ScanValueContext } from './scanPitch';
import { buildNote, buildRest } from './scanPitch';
import type { PendingMemberMarker, ScanMarker } from './scanLeaf';
import { buildChordSymbol, buildDecoration, markerKindOf, reportRestVariant } from './scanLeaf';
import { buildTabNote, tabNoteRaw } from './scanTab';

export type { ScanMarker, ScanMarkerAnchor, ScanMarkerKind } from './scanLeaf';

/** 单个声部的扫描产出：事件流 + 与之并列的 marker 列表（marker 永不进 events）。 */
export interface ScanResult {
  readonly events: readonly MusicEvent[];
  readonly markers: readonly ScanMarker[];
}

export type ScanByVoice = ReadonlyMap<VoiceId, ScanResult>;

interface VoiceState {
  readonly events: MusicEvent[];
  readonly markers: ScanMarker[];
}

interface ScanState {
  readonly voice: VoiceState;
  readonly voiceId: VoiceId;
  readonly dur: ScanValueContext;
  readonly ctx: ParseContext;
}

/** 事件 id 只依赖「该声部事件流下标」，与文档位置无关（方案 §1.1）。 */
function pushEvent(state: ScanState, make: (id: EventId) => MusicEvent): void {
  state.voice.events.push(make(eventId(state.voiceId, state.voice.events.length)));
}

/** 组合节点不存 raw（AST 不变量），需要原文时由子叶子拼回。 */
function composedRaw(children: readonly { readonly raw: string }[]): string {
  return children.map((child) => child.raw).join('');
}

/** 叶子节点统一取 token kind；组合节点没有 token，退回节点 kind。 */
function tokenKindOf(node: JcxBodyNode): string {
  return 'token' in node ? node.token.kind : node.kind;
}

function pushUnknown(state: ScanState, raw: string, tokenKind: string, node: JcxBodyNode): void {
  state.ctx.once.reportOnce(
    `body.unknown-event.${tokenKind}`,
    'jcx.parse.body.unknown-event',
    'warning',
    `正文中的 ${tokenKind} token ${JSON.stringify(raw)} 无法归类为音乐事件，只保留原文（spec §29.3）`,
    node.span,
    node.path,
  );
  pushEvent(state, (id) => ({ kind: 'unknown', id, raw, tokenKind, origin: node.path }));
}

/** chord / grace / tabGroup 的成员收集结果：marker 与未归类叶子都等组事件推入后再落账。 */
interface Members {
  readonly notes: (Note | Rest)[];
  readonly tabNotes: TabNote[];
  readonly markers: PendingMemberMarker[];
  readonly leftovers: { readonly raw: string; readonly tokenKind: string; readonly node: JcxBodyNode }[];
}

function collectMembers(items: readonly JcxBodyNode[], state: ScanState): Members {
  const members: Members = { notes: [], tabNotes: [], markers: [], leftovers: [] };
  for (const item of items) {
    switch (item.kind) {
      case 'note': {
        const note = buildNote(item, state.dur);
        if (note === undefined) {
          members.leftovers.push({ raw: composedRaw(item.children), tokenKind: 'note', node: item });
        } else {
          members.notes.push(note);
        }
        break;
      }
      case 'rest': {
        const rest = buildRest(item, state.dur);
        reportRestVariant(state.ctx, rest, item);
        members.notes.push(rest);
        break;
      }
      case 'tabNote': {
        const tabNote = buildTabNote(item, state.dur);
        if (tabNote === undefined) {
          members.leftovers.push({ raw: tabNoteRaw(item), tokenKind: 'tabNote', node: item });
        } else {
          members.tabNotes.push(tabNote);
        }
        break;
      }
      case 'whitespace':
        break;
      case 'chord':
      case 'grace':
      case 'tabGroup':
        // 组内嵌组（语料 0 次）：直接按独立事件扫描，保证不丢事件；顺序上嵌套组排在外层组之前。
        scanNode(item, state);
        break;
      default: {
        const marker = markerKindOf(item.kind);
        if (marker !== undefined && 'raw' in item) {
          // 组内部的 marker（`[C-C]` 的 tie、`{a1-S-a3}` 的 tabRelation）锚到 member 之间。
          members.markers.push({
            kind: marker,
            raw: item.raw,
            origin: item.path,
            span: item.span,
            beforeMemberIndex: members.notes.length + members.tabNotes.length,
          });
          break;
        }
        if ('raw' in item) {
          members.leftovers.push({ raw: item.raw, tokenKind: tokenKindOf(item), node: item });
        }
        break;
      }
    }
  }
  return members;
}

/**
 * 组事件推入后统一落账：先把组内 marker 锚到该事件（`eventIndex`），再补发未归类叶子，
 * 保证「组事件在前、残片在后」的稳定顺序。
 */
function flushGroup(members: Members, state: ScanState, eventIndex: number): void {
  for (const marker of members.markers) {
    state.voice.markers.push({ ...marker, anchor: 'member', eventIndex });
  }
  for (const leftover of members.leftovers) {
    pushUnknown(state, leftover.raw, leftover.tokenKind, leftover.node);
  }
}

function scanChord(node: JcxChordNode, state: ScanState): void {
  const members = collectMembers(node.items, state);
  const eventIndex = state.voice.events.length;
  // §14.4 CONFIRMED BY DOCUMENTATION：pitch 模式组时值**严格**取第一个成员的时值；
  // 首音无时值时整个和弦就没有时值，不去后面的成员里找替补。
  const first = members.notes[0];
  const duration: Rational | undefined = first?.duration;
  pushEvent(state, (id) => ({
    kind: 'chord',
    id,
    members: members.notes,
    ...(duration === undefined ? {} : { duration }),
    origin: node.path,
  }));
  flushGroup(members, state, eventIndex);
}

function scanGrace(node: JcxGraceNode, state: ScanState): void {
  const members = collectMembers(node.items, state);
  const eventIndex = state.voice.events.length;
  // §21：倚音事件本身无时长；成员各自的 durationRaw / duration 照常保留（`{C2}`）。
  const notes: (Note | TabNote)[] = [
    ...members.notes.filter((member): member is Note => 'pitch' in member),
    ...members.tabNotes,
  ];
  pushEvent(state, (id) => ({
    kind: 'grace',
    id,
    members: notes,
    after: node.open.raw === '{@',
    origin: node.path,
  }));
  flushGroup(members, state, eventIndex);
}

function scanTabGroup(node: JcxTabGroupNode, state: ScanState): void {
  const members = collectMembers(node.items, state);
  const eventIndex = state.voice.events.length;
  // §26.8 CONFIRMED BY DOCUMENTATION：TAB 组时值**严格**取最后一个成员（与 pitch 相反）。
  const last = members.tabNotes[members.tabNotes.length - 1];
  const duration: Rational | undefined = last?.duration;
  pushEvent(state, (id) => ({
    kind: 'tabGroup',
    id,
    members: members.tabNotes,
    ...(duration === undefined ? {} : { duration }),
    origin: node.path,
  }));
  flushGroup(members, state, eventIndex);
}

function scanNode(node: JcxBodyNode, state: ScanState): void {
  switch (node.kind) {
    case 'note': {
      const note = buildNote(node, state.dur);
      if (note === undefined) {
        pushUnknown(state, composedRaw(node.children), 'note', node);
        break;
      }
      pushEvent(state, (id) => ({ kind: 'note', id, note, origin: node.path }));
      break;
    }
    case 'rest': {
      const rest = buildRest(node, state.dur);
      reportRestVariant(state.ctx, rest, node);
      pushEvent(state, (id) => ({ kind: 'rest', id, rest, origin: node.path }));
      break;
    }
    case 'chord':
      scanChord(node, state);
      break;
    case 'grace':
      scanGrace(node, state);
      break;
    case 'tabGroup':
      scanTabGroup(node, state);
      break;
    case 'tabNote': {
      const tabNote = buildTabNote(node, state.dur);
      if (tabNote === undefined) {
        pushUnknown(state, tabNoteRaw(node), 'tabNote', node);
        break;
      }
      pushEvent(state, (id) => ({ kind: 'tabNote', id, note: tabNote, origin: node.path }));
      break;
    }
    // §18 / §19.2：小节线与跳房子都只存 raw，语义留 M2/M4。
    case 'barline':
    case 'repeatEnding':
      pushEvent(state, (id) => ({ kind: 'barline', id, raw: node.raw, origin: node.path }));
      break;
    case 'decoration': {
      const parts = node.token.kind === 'decorationComplex' ? node.token.parts : undefined;
      pushEvent(state, (id) => ({
        kind: 'decoration',
        id,
        decoration: buildDecoration(node.raw, parts),
        origin: node.path,
      }));
      break;
    }
    case 'chordSymbol':
      pushEvent(state, (id) => ({
        kind: 'chordSymbol',
        id,
        symbol: buildChordSymbol(node.raw),
        origin: node.path,
      }));
      break;
    case 'whitespace':
      break;
    default: {
      const marker = markerKindOf(node.kind);
      if (marker !== undefined) {
        state.voice.markers.push({
          kind: marker,
          raw: node.raw,
          origin: node.path,
          span: node.span,
          anchor: 'event',
          // 定义：marker 之后下一个事件的下标；marker 在末尾时等于 events.length。
          beforeEventIndex: state.voice.events.length,
        });
        break;
      }
      pushUnknown(state, node.raw, tokenKindOf(node), node);
      break;
    }
  }
}

/**
 * 扫描 T5 给出的有序段落，产出每个声部的事件流与并列的 marker 列表。
 *
 * `unitLengths` 的查询按**事件自身的 AstPath 行号 + 所在声部**做（body 区 `L:`
 * 按声部作用域从该行起生效，spec §8.5 / U06 已裁决），因此同一行内的事件共享
 * 同一个单位音长，且不同声部各自只看自己的条目与 global 条目。
 */
export function scanSegments(
  segments: readonly VoiceSegment[],
  unitLengths: UnitLengthScope,
  ctx: ParseContext,
): ScanByVoice {
  const byVoice = new Map<VoiceId, VoiceState>();

  const stateOf = (id: VoiceId, origin: SourceRef): ScanState => {
    const existing = byVoice.get(id) ?? { events: [], markers: [] };
    byVoice.set(id, existing);
    return {
      voice: existing,
      voiceId: id,
      dur: { ctx, unitLength: unitLengths.unitLengthAt(origin, id) },
      ctx,
    };
  };

  for (const segment of segments) {
    const { unit } = segment;
    if (unit.kind === 'lyric') {
      // 歌词是 T8 的事，本层不产出事件。
      continue;
    }
    const items = unit.kind === 'bodyLine' ? unit.node.items : unit.node.trailing;
    const state = stateOf(segment.voiceId, unit.node.path);
    for (const item of items) {
      scanNode(item, state);
    }
  }

  const result = new Map<VoiceId, ScanResult>();
  for (const [id, state] of byVoice) {
    result.set(id, { events: state.events, markers: state.markers });
  }
  return result;
}
