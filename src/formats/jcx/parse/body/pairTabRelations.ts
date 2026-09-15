/**
 * Parse 层 —— TAB 同弦相邻音关系 `-S-` / `-H-` / `-P-`（M1.6 T7；spec §26.6）。
 *
 * 形态上恒有两端，所以 `TabRelation` 不带 `status`：缺任一侧就**不建关系**，
 * 只发 warning（方案 §1.3）。member 锚点（`{a1-S-a3}`、`[a1-S-a3]`）带 `memberIndex`。
 */

import type { MusicEvent, TabRelation } from '../../../../domain';
import type { PairState } from './pairShared';
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

function push(
  state: PairState,
  marker: ScanMarker,
  kind: TabRelation['kind'],
  from: { readonly event: MusicEvent; readonly index?: number },
  to: { readonly event: MusicEvent; readonly index?: number },
): void {
  state.tabRelations.push({
    kind,
    id: nextRelationId(state, kind),
    origins: originsOfPair(marker, from.event, to.event),
    from: noteRefAt(from.event, from.index),
    to: noteRefAt(to.event, to.index),
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
