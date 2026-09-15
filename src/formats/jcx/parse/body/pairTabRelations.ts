/**
 * Parse 层 —— TAB 同弦相邻音关系 `-S-` / `-H-` / `-P-`（M1.6 T7；spec §26.6）。
 *
 * 形态上恒有两端，所以 `TabRelation` 不带 `status`：缺任一侧就**不建关系**，
 * 只发 warning（方案 §1.3）。member 锚点（`{a1-S-a3}`、`[a1-S-a3]`）带 `memberIndex`。
 *
 * **同弦契约（M1.7 T0）**：§26.6 的标题与 help 2.1.4「同弦记法」把「同弦」写进了这三个
 * 标记的定义，等级 G-级 `CONFIRMED`，而 `TabRelation` 没有 recovery `status` 可以如实
 * 表达「非法但存在」。因此**证明不了同弦就不建关系**（与缺一端同一处置）：跨弦发
 * warning `jcx.parse.tab-relation.cross-string`；端点是整个组、组内定不到唯一同弦成员时
 * 发 `jcx.parse.tab-relation.unresolved`。落定规则见 `resolveSameString`。
 */

import type { MusicEvent, NoteRef, TabRelation } from '../../../../domain';
import type { PairMember, PairState } from './pairShared';
import {
  consume,
  eventAfter,
  eventBefore,
  groupMembersOf,
  isTabTarget,
  nextRelationId,
  noteRefAt,
  originsOfPair,
  report,
  skipBarline,
  skipNothing,
} from './pairShared';
import type { ScanMarker } from './scanLeaf';

const KINDS: ReadonlyMap<string, TabRelation['kind']> = new Map<string, TabRelation['kind']>([
  ['-S-', 'slide'],
  ['-H-', 'hammer'],
  ['-P-', 'pull'],
]);

function reportUnresolved(state: PairState, marker: ScanMarker, why: string): void {
  report(
    state,
    'jcx.parse.tab-relation.unresolved',
    'warning',
    `TAB 连接标记 ${JSON.stringify(marker.raw)} ${why}，不建立关系`,
    marker,
  );
}

/** 端点：一个 TAB 事件，`index` 指向组成员（缺省表示端点是事件本身）。 */
interface Endpoint {
  readonly event: MusicEvent;
  readonly index?: number;
}

/** TAB 成员的弦号；pitch 模式的成员（`{...}` 倚音里的音高音）没有弦号。 */
function memberString(member: PairMember | undefined): number | undefined {
  return member !== undefined && 'stringIndex' in member ? member.stringIndex : undefined;
}

/** 端点**已经确定**的弦号：单音事件取自身，带 `memberIndex` 的组端点取该成员。 */
function knownString(endpoint: Endpoint): number | undefined {
  if (endpoint.index === undefined) {
    return endpoint.event.kind === 'tabNote' ? endpoint.event.note.stringIndex : undefined;
  }
  return memberString(groupMembersOf(endpoint.event)?.[endpoint.index]);
}

/** 端点还没定到具体成员时（整个 `[...]` / `{...}`）的候选成员列表。 */
function candidatesOf(endpoint: Endpoint): readonly PairMember[] | undefined {
  return endpoint.index === undefined && endpoint.event.kind !== 'tabNote'
    ? groupMembersOf(endpoint.event)
    : undefined;
}

/** 组内弦号为 `target` 的成员下标；恰好一个才返回，0 个或多个返回 `undefined`。 */
function soleMemberOnString(members: readonly PairMember[], target: number): number | undefined {
  const hits: number[] = [];
  members.forEach((member, index) => {
    if (memberString(member) === target) {
      hits.push(index);
    }
  });
  return hits.length === 1 ? hits[0] : undefined;
}

/** 在两个组里**各自都唯一**的弦号；这样的弦号恰好一个时，同弦成员对才算能确定。 */
function soleSharedString(a: readonly PairMember[], b: readonly PairMember[]): number | undefined {
  const shared: number[] = [];
  for (const string of new Set(a.map(memberString))) {
    if (string === undefined) {
      continue;
    }
    if (soleMemberOnString(a, string) !== undefined && soleMemberOnString(b, string) !== undefined) {
      shared.push(string);
    }
  }
  return shared.length === 1 ? shared[0] : undefined;
}

/**
 * 把两个端点定到「同一根弦上的具体成员」；定不下来就不建关系。
 *
 * - 两端弦号都已知且不同 → `jcx.parse.tab-relation.cross-string`；
 * - 一端已知、另一端是整个组 → 组内同弦成员**恰好一个**才落定，0 个或多个 →
 *   `jcx.parse.tab-relation.unresolved`（不猜哪一根）；
 * - 两端都是整个组 → 只有「在两组中各自都唯一」的弦号恰好存在一个时才落定；
 * - 其余（组下标越界、成员不是 TAB 音）一律 unresolved。
 */
function resolveSameString(
  state: PairState,
  marker: ScanMarker,
  from: Endpoint,
  to: Endpoint,
): { readonly from: NoteRef; readonly to: NoteRef } | undefined {
  const fromString = knownString(from);
  const toString = knownString(to);
  if (fromString !== undefined && toString !== undefined) {
    if (fromString !== toString) {
      report(
        state,
        'jcx.parse.tab-relation.cross-string',
        'warning',
        `TAB 连接标记 ${JSON.stringify(marker.raw)} 的两端不在同一根弦（第 ${String(fromString)} 弦 → 第 ${String(toString)} 弦），spec §26.6 CONFIRMED 要求同弦，不建立关系`,
        marker,
      );
      return undefined;
    }
    return { from: noteRefAt(from.event, from.index), to: noteRefAt(to.event, to.index) };
  }

  const fromMembers = candidatesOf(from);
  const toMembers = candidatesOf(to);
  if (fromString !== undefined && toMembers !== undefined) {
    const index = soleMemberOnString(toMembers, fromString);
    if (index === undefined) {
      reportUnresolved(state, marker, `后一端的组里没有唯一一个第 ${String(fromString)} 弦的成员`);
      return undefined;
    }
    return { from: noteRefAt(from.event, from.index), to: noteRefAt(to.event, index) };
  }
  if (toString !== undefined && fromMembers !== undefined) {
    const index = soleMemberOnString(fromMembers, toString);
    if (index === undefined) {
      reportUnresolved(state, marker, `前一端的组里没有唯一一个第 ${String(toString)} 弦的成员`);
      return undefined;
    }
    return { from: noteRefAt(from.event, index), to: noteRefAt(to.event, to.index) };
  }
  if (fromMembers !== undefined && toMembers !== undefined) {
    const string = soleSharedString(fromMembers, toMembers);
    const fromIndex = string === undefined ? undefined : soleMemberOnString(fromMembers, string);
    const toIndex = string === undefined ? undefined : soleMemberOnString(toMembers, string);
    if (fromIndex === undefined || toIndex === undefined) {
      reportUnresolved(state, marker, '两端都是组，且无法唯一确定一对同弦成员');
      return undefined;
    }
    return { from: noteRefAt(from.event, fromIndex), to: noteRefAt(to.event, toIndex) };
  }
  reportUnresolved(state, marker, '至少一端的弦号无法确定（组下标越界或成员不是 TAB 音）');
  return undefined;
}

function push(
  state: PairState,
  marker: ScanMarker,
  kind: TabRelation['kind'],
  from: Endpoint,
  to: Endpoint,
): void {
  const refs = resolveSameString(state, marker, from, to);
  if (refs === undefined) {
    return;
  }
  state.tabRelations.push({
    kind,
    id: nextRelationId(state, kind),
    origins: originsOfPair(marker, from.event, to.event),
    from: refs.from,
    to: refs.to,
  });
}

function pairEventAnchored(
  state: PairState,
  marker: ScanMarker,
  kind: TabRelation['kind'],
  index: number,
): void {
  const from = eventBefore(state.events, index, isTabTarget, skipNothing);
  if (from === undefined) {
    reportUnresolved(state, marker, '之前没有 tabNote / tabGroup');
    return;
  }
  const to = eventAfter(state.events, index, isTabTarget, skipBarline);
  if (to === undefined) {
    reportUnresolved(state, marker, '之后没有 tabNote / tabGroup');
    return;
  }
  push(state, marker, kind, { event: from }, { event: to });
}

function pairMemberAnchored(
  state: PairState,
  marker: ScanMarker,
  kind: TabRelation['kind'],
  eventIndex: number,
  beforeMemberIndex: number,
): void {
  const group = state.events[eventIndex];
  const members = group === undefined ? undefined : groupMembersOf(group);
  if (group === undefined || members === undefined) {
    reportUnresolved(state, marker, '所在组合事件没有成员');
    return;
  }
  if (beforeMemberIndex === 0) {
    reportUnresolved(state, marker, '位于组首，之前没有成员');
    return;
  }
  if (beforeMemberIndex < members.length) {
    push(
      state,
      marker,
      kind,
      { event: group, index: beforeMemberIndex - 1 },
      { event: group, index: beforeMemberIndex },
    );
    return;
  }
  // 语料的主形态是 `{d8-S-}d10`：标记在组末尾，另一端是组**外**的下一个 TAB 事件。
  const to = eventAfter(state.events, eventIndex + 1, isTabTarget, skipBarline);
  if (to === undefined) {
    reportUnresolved(state, marker, '位于组末尾且之后没有 tabNote / tabGroup');
    return;
  }
  push(state, marker, kind, { event: group, index: beforeMemberIndex - 1 }, { event: to });
}

export function pairTabRelation(state: PairState, marker: ScanMarker): void {
  consume(state, marker);
  const kind = KINDS.get(marker.raw);
  if (kind === undefined) {
    reportUnresolved(state, marker, '不是已知的 -S- / -H- / -P- 形态');
    return;
  }
  if (marker.anchor === 'event') {
    pairEventAnchored(state, marker, kind, marker.beforeEventIndex);
    return;
  }
  pairMemberAnchored(state, marker, kind, marker.eventIndex, marker.beforeMemberIndex);
}
