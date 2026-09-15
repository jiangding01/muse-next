/**
 * Parse 层 —— marker 配对的共享状态与纯helper（M1.6 T7；方案 v1.1 §1.3 / §3）。
 *
 * 本文件只提供「配对各家共用的词汇」：可配对事件的判定、组成员取用、relation id
 * 分配、diagnostic 上报与 marker 消费登记。真正的算法在 `pairTies` / `pairSlurs` /
 * `pairTuplets` / `pairTabRelations` / `pairBrokenRhythm` 五个模块里。
 *
 * 硬约束（方案 §0）：
 * - 只消费 `ScanMarker`，**不重扫 AST**；
 * - `status` 只记录 parse-recovery fact，不设 `pitchMatched` 之类的推断字段；
 * - tuplet **不派生任何时值缩放**。
 */

import type {
  MusicEvent,
  Note,
  NoteRef,
  RelationId,
  Rest,
  Slur,
  SourceRef,
  TabNote,
  TabRelation,
  Tie,
  Tuplet,
  VoiceId,
} from '../../../../domain';
import { relationId } from '../../../../domain';
import type { JcxParseDiagnosticCode, JcxSeverity } from '../../lexer/diagnostics';
import { reportParse } from '../diagnostics';
import type { ParseContext } from '../header';
import type { ScanMarker } from './scanLeaf';

/** 组合事件的成员统一视图：`NoteRef.memberIndex` 指向的就是这些元素。 */
export type PairMember = Note | Rest | TabNote;

/** 配对过程的可变工作区；`events` 会被 broken rhythm 就地替换（id 不变）。 */
export interface PairState {
  readonly voiceId: VoiceId;
  readonly events: MusicEvent[];
  readonly ctx: ParseContext;
  readonly counters: Map<string, number>;
  /** 已被某个 handler 认领的 marker origin；用于「marker 全部被消费」的断言。 */
  readonly consumed: Set<SourceRef>;
  readonly ties: Tie[];
  readonly slurs: Slur[];
  readonly tuplets: Tuplet[];
  readonly tabRelations: TabRelation[];
}

/** 每种 kind 一条独立计数序列（`v1:tie0`、`v1:slur0`、`v1:slide0`…）。 */
export function nextRelationId(state: PairState, kind: string): RelationId {
  const n = state.counters.get(kind) ?? 0;
  state.counters.set(kind, n + 1);
  return relationId(state.voiceId, kind, n);
}

export function report(
  state: PairState,
  code: JcxParseDiagnosticCode,
  severity: JcxSeverity,
  message: string,
  marker: ScanMarker,
): void {
  reportParse(state.ctx.bag, code, severity, message, marker.span, marker.origin);
}

/** 每文档一次的 info（`<` 未观测、tuplet `q=0`、member 锚点 slur…）。 */
export function reportOnce(
  state: PairState,
  key: string,
  code: JcxParseDiagnosticCode,
  severity: JcxSeverity,
  message: string,
  marker: ScanMarker,
): void {
  state.ctx.once.reportOnce(key, code, severity, message, marker.span, marker.origin);
}

/** handler 入口处调用：登记「这枚 marker 已被处理」，与是否建成关系无关。 */
export function consume(state: PairState, marker: ScanMarker): void {
  state.consumed.add(marker.origin);
}

/** tie 的合法端点（pitch 与 TAB 两种模式共用一套 `Tie`）。 */
export function isTieTarget(event: MusicEvent): boolean {
  return (
    event.kind === 'note' ||
    event.kind === 'chord' ||
    event.kind === 'tabNote' ||
    event.kind === 'tabGroup'
  );
}

/**
 * tie 端点所属的「族」：pitch（note/chord）与 TAB（tabNote/tabGroup）。
 * **禁止跨族配对**——两种记谱的成员语义不同，跨族 `-` 只记录为 unresolved。
 */
export function tieFamilyOf(event: MusicEvent): 'pitch' | 'tab' | undefined {
  switch (event.kind) {
    case 'note':
    case 'chord':
      return 'pitch';
    case 'tabNote':
    case 'tabGroup':
      return 'tab';
    default:
      return undefined;
  }
}

/**
 * §22.2：slur 的合法端点——只认发声事件。
 * barline / decoration / chordSymbol / unknown / grace 一律跳过，不能当端点。
 */
export function isSlurEndpoint(event: MusicEvent): boolean {
  return (
    event.kind === 'note' ||
    event.kind === 'rest' ||
    event.kind === 'chord' ||
    event.kind === 'tabNote' ||
    event.kind === 'tabGroup'
  );
}

/** slur 找端点时可以跨过的「非发声」事件。 */
export function isSlurSkippable(event: MusicEvent): boolean {
  return !isSlurEndpoint(event);
}

/** §26.6：TAB 连接标记的合法端点。 */
export function isTabTarget(event: MusicEvent): boolean {
  return event.kind === 'tabNote' || event.kind === 'tabGroup';
}

/** §16.2：broken rhythm 只作用在有时值的 pitch 模式事件上。 */
export function isBrokenTarget(event: MusicEvent): boolean {
  return event.kind === 'note' || event.kind === 'rest' || event.kind === 'chord';
}

/** §20：被 tuplet 计数的事件；barline / decoration / chordSymbol / unknown 跳过，grace 不计数。 */
export function isTupletMember(event: MusicEvent): boolean {
  return (
    event.kind === 'note' ||
    event.kind === 'rest' ||
    event.kind === 'chord' ||
    event.kind === 'tabNote' ||
    event.kind === 'tabGroup'
  );
}

/** chord / tabGroup / grace 的成员列表；非组合事件返回 undefined。 */
export function groupMembersOf(event: MusicEvent): readonly PairMember[] | undefined {
  switch (event.kind) {
    case 'chord':
      return event.members;
    case 'tabGroup':
      return event.members;
    case 'grace':
      return event.members;
    default:
      return undefined;
  }
}

/** 组合事件用 `memberIndex` 精确到成员；单音事件省略它（方案 §1.1）。 */
export function noteRefAt(event: MusicEvent, memberIndex: number | undefined): NoteRef {
  return memberIndex === undefined
    ? { eventId: event.id }
    : { eventId: event.id, memberIndex };
}

/**
 * 两端是否「同一个音」。
 *
 * 只用于决定是否发 `pitch-mismatch` info——**结果不写进 Domain**（方案 §1.3：
 * 不设 `pitchMatched` 之类的推断字段）。比较的全是事实字段。
 */
export function sameSound(a: PairMember, b: PairMember): boolean {
  if ('pitch' in a && 'pitch' in b) {
    return (
      a.pitch.letter === b.pitch.letter &&
      a.pitch.register === b.pitch.register &&
      (a.pitch.octaveRaw ?? '') === (b.pitch.octaveRaw ?? '') &&
      a.accidental === b.accidental
    );
  }
  if ('stringIndex' in a && 'stringIndex' in b) {
    return a.stringIndex === b.stringIndex && a.fret === b.fret;
  }
  if ('variant' in a && 'variant' in b) {
    return a.variant === b.variant;
  }
  return false;
}

/** 单音事件的「唯一成员」视图，使单音 ↔ 和弦的比较能共用 `sameSound`。 */
export function soleMemberOf(event: MusicEvent): PairMember | undefined {
  switch (event.kind) {
    case 'note':
      return event.note;
    case 'rest':
      return event.rest;
    case 'tabNote':
      return event.note;
    default:
      return undefined;
  }
}

/**
 * marker 在事件流中的「插入位置」：member 锚点折算成它所属组合事件的前 / 后。
 *
 * 组内首位（`beforeMemberIndex === 0`）视为整个组之前，其余视为整个组之后。
 */
export function markerEventIndex(marker: ScanMarker): number {
  if (marker.anchor === 'event') {
    return marker.beforeEventIndex;
  }
  return marker.beforeMemberIndex === 0 ? marker.eventIndex : marker.eventIndex + 1;
}

/** 从 `index - 1` 往回找第一个满足 `accept` 的事件；中途遇到不满足的立即停。 */
export function eventBefore(
  events: readonly MusicEvent[],
  index: number,
  accept: (event: MusicEvent) => boolean,
  skip: (event: MusicEvent) => boolean,
): MusicEvent | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event === undefined) {
      return undefined;
    }
    if (accept(event)) {
      return event;
    }
    if (!skip(event)) {
      return undefined;
    }
  }
  return undefined;
}

/** 从 `index` 往后找第一个满足 `accept` 的事件；中途遇到不满足的立即停。 */
export function eventAfter(
  events: readonly MusicEvent[],
  index: number,
  accept: (event: MusicEvent) => boolean,
  skip: (event: MusicEvent) => boolean,
): MusicEvent | undefined {
  for (let i = index; i < events.length; i += 1) {
    const event = events[i];
    if (event === undefined) {
      return undefined;
    }
    if (accept(event)) {
      return event;
    }
    if (!skip(event)) {
      return undefined;
    }
  }
  return undefined;
}

/** 永不跳过：用于「必须紧邻」的场景。 */
export const skipNothing = (): boolean => false;

/**
 * §22.1：`abc-|cba` 合法——tie / TAB 连接标记向后找对端时允许跨过小节线，
 * 但**不允许**跨过任何别的事件。
 */
export function skipBarline(event: MusicEvent): boolean {
  return event.kind === 'barline';
}

export function originsOfPair(
  marker: ScanMarker,
  from: MusicEvent | undefined,
  to: MusicEvent | undefined,
): readonly SourceRef[] {
  const origins: SourceRef[] = [marker.origin];
  if (from !== undefined) {
    origins.push(from.origin);
  }
  if (to !== undefined) {
    origins.push(to.origin);
  }
  return origins;
}
