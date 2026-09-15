/**
 * Parse 层 —— tie `-` 配对（M1.6 T7；spec §22.1、§26.6 的普通 `-`）。
 *
 * 语义（2026-09-15 按语料证据裁决，与 ABC 2.1 §4.11 一致）：
 * **`-` 永远属于它前面那个音，并把这个音向后连到下一个事件里的同音高音**。
 *
 * - **event 锚点**：`C2-D2`、`[CEG]-[CEG]`，source 是前一个 note/chord（TAB 下是
 *   tabNote/tabGroup），target 是其后第一个同族事件（允许跨 barline，§22.1 的 `abc-|cba`）；
 * - **member 锚点**：`[c/2-A/2-=F/2-]` 这类组内标记，source 是**标记前面那个成员**
 *   （`members[beforeMemberIndex - 1]`），target 在**宿主组之后**找，而不是组内的下一个成员。
 *
 * 组两端一律**按音高匹配**（不按下标）：`[CE]-[EC]` 交叉配对。找不到同音高的 target →
 * `Tie{status:'unresolved'}` + warning，不任意造关系。只有「单音 → 单音」保留 legacy 容错：
 * 音高不同照建 tie，另发 info（方案 §1.3：不设 `pitchMatched` 之类的推断字段）。
 */

import type { MusicEvent, NoteRef } from '../../../../domain';
import type { PairMember, PairState } from './pairShared';
import {
  consume,
  eventAfter,
  eventBefore,
  groupMembersOf,
  isTieTarget,
  nextRelationId,
  noteRefAt,
  originsOfPair,
  report,
  sameSound,
  skipBarline,
  skipNothing,
  soleMemberOf,
  tieFamilyOf,
} from './pairShared';
import type { ScanMarker } from './scanLeaf';

interface Endpoint {
  readonly event: MusicEvent;
  readonly index?: number;
}

function memberAt(endpoint: Endpoint): PairMember | undefined {
  return endpoint.index === undefined
    ? soleMemberOf(endpoint.event)
    : groupMembersOf(endpoint.event)?.[endpoint.index];
}

function reportUnresolved(state: PairState, marker: ScanMarker, why: string): void {
  report(state, 'jcx.parse.tie.unresolved', 'warning', `tie '-' ${why}`, marker);
}

function pushUnresolved(state: PairState, marker: ScanMarker, from: Endpoint): void {
  const ref: NoteRef = noteRefAt(from.event, from.index);
  state.ties.push({
    kind: 'tie',
    status: 'unresolved',
    id: nextRelationId(state, 'tie'),
    origins: originsOfPair(marker, from.event, undefined),
    from: ref,
  });
}

function pushResolved(state: PairState, marker: ScanMarker, from: Endpoint, to: Endpoint): void {
  state.ties.push({
    kind: 'tie',
    status: 'resolved',
    id: nextRelationId(state, 'tie'),
    origins: originsOfPair(marker, from.event, to.event),
    from: noteRefAt(from.event, from.index),
    to: noteRefAt(to.event, to.index),
  });
}

/** 组内找第一个未被占用且**同音高**的成员（TAB 下是同弦同品）。 */
function matchMember(
  members: readonly PairMember[],
  source: PairMember,
  used: ReadonlySet<number>,
): number | undefined {
  for (let index = 0; index < members.length; index += 1) {
    const member = members[index];
    if (member !== undefined && !used.has(index) && sameSound(source, member)) {
      return index;
    }
  }
  return undefined;
}

/** 单个 source 音 → target 事件里的同音高音；target 是单音时直接比对它本身。 */
function resolveAgainst(
  state: PairState,
  marker: ScanMarker,
  from: Endpoint,
  target: MusicEvent,
  used: Set<number>,
): boolean {
  const source = memberAt(from);
  if (source === undefined) {
    return false;
  }
  const members = groupMembersOf(target);
  if (members === undefined) {
    const sole = soleMemberOf(target);
    if (sole === undefined || !sameSound(source, sole)) {
      return false;
    }
    pushResolved(state, marker, from, { event: target });
    return true;
  }
  const index = matchMember(members, source, used);
  if (index === undefined) {
    return false;
  }
  used.add(index);
  pushResolved(state, marker, from, { event: target, index });
  return true;
}

/** `-` 之后的 target：同族（pitch / TAB）的下一个事件，允许跨小节线。 */
function targetAfter(state: PairState, index: number, family: 'pitch' | 'tab'): MusicEvent | undefined {
  return eventAfter(
    state.events,
    index,
    (event) => isTieTarget(event) && tieFamilyOf(event) === family,
    skipBarline,
  );
}

/** 单音 → 单音：legacy 容错，音高不同照建 tie，只发 info。 */
function pairSoleToSole(
  state: PairState,
  marker: ScanMarker,
  from: MusicEvent,
  to: MusicEvent,
): void {
  const source = soleMemberOf(from);
  const target = soleMemberOf(to);
  if (source !== undefined && target !== undefined && !sameSound(source, target)) {
    report(
      state,
      'jcx.parse.tie.pitch-mismatch',
      'info',
      'tie 两端音高 / 品位不同（spec §22.1 要求同音）；仍按源文本建立 tie，不做任何推断',
      marker,
    );
  }
  pushResolved(state, marker, { event: from }, { event: to });
}

function pairEventAnchored(state: PairState, marker: ScanMarker, index: number): void {
  const from = eventBefore(state.events, index, isTieTarget, skipNothing);
  const family = from === undefined ? undefined : tieFamilyOf(from);
  if (from === undefined || family === undefined) {
    reportUnresolved(state, marker, '之前没有可连接的 note / chord / tabNote / tabGroup');
    return;
  }
  const to = targetAfter(state, index, family);
  if (to === undefined) {
    reportUnresolved(state, marker, '之后没有同族的可连接事件（行尾 / 声部尾 / 后继不可唱 / 跨族）');
    pushUnresolved(state, marker, { event: from });
    return;
  }
  const members = groupMembersOf(from);
  if (members === undefined) {
    if (groupMembersOf(to) === undefined) {
      pairSoleToSole(state, marker, from, to);
      return;
    }
    // 单音 → 组：按音高在组内找对应音，找不到不硬配。
    if (!resolveAgainst(state, marker, { event: from }, to, new Set())) {
      reportUnresolved(state, marker, '在后继组里找不到同音高的音');
      pushUnresolved(state, marker, { event: from });
    }
    return;
  }
  // 组 → 任意：组内每个成员各自去 target 里找同音高的音（不按下标）。
  // 逐成员结算——匹配不上的成员各记一条 unresolved + warning，不因为「别的成员配上了」而沉默。
  const used = new Set<number>();
  for (let i = 0; i < members.length; i += 1) {
    const source: Endpoint = { event: from, index: i };
    if (resolveAgainst(state, marker, source, to, used)) {
      continue;
    }
    reportUnresolved(state, marker, `组内第 ${String(i)} 个成员在后继事件里找不到同音高的音`);
    pushUnresolved(state, marker, source);
  }
}

function pairMemberAnchored(
  state: PairState,
  marker: ScanMarker,
  eventIndex: number,
  beforeMemberIndex: number,
): void {
  const host = state.events[eventIndex];
  const members = host === undefined ? undefined : groupMembersOf(host);
  const family = host === undefined ? undefined : tieFamilyOf(host);
  if (host === undefined || members === undefined || family === undefined) {
    reportUnresolved(state, marker, '所在组合事件不能作为 tie 的起点');
    return;
  }
  if (beforeMemberIndex === 0) {
    // 组首的 `-` 前面没有音可属：源文本事实，不猜它指向谁。
    reportUnresolved(state, marker, '位于组首，前面没有可作为起点的成员');
    return;
  }
  const from: Endpoint = { event: host, index: beforeMemberIndex - 1 };
  const to = targetAfter(state, eventIndex + 1, family);
  if (to === undefined) {
    reportUnresolved(state, marker, '宿主组之后没有同族的可连接事件');
    pushUnresolved(state, marker, from);
    return;
  }
  if (!resolveAgainst(state, marker, from, to, new Set())) {
    reportUnresolved(state, marker, '在后继事件里找不到同音高的音');
    pushUnresolved(state, marker, from);
  }
}

export function pairTie(state: PairState, marker: ScanMarker): void {
  consume(state, marker);
  if (marker.anchor === 'event') {
    pairEventAnchored(state, marker, marker.beforeEventIndex);
    return;
  }
  pairMemberAnchored(state, marker, marker.eventIndex, marker.beforeMemberIndex);
}
