/**
 * Parse 层 —— slur `(` / `)` 配对（M1.6 T7；spec §22.2）。
 *
 * 栈式匹配，可跨小节跨行，**不跨 voice**（本模块只看单个声部的事件流）。
 * 端点谓词 `isSlurEndpoint`：只认 note / rest / chord / tabNote / tabGroup，
 * barline / decoration / chordSymbol / unknown / grace 一律跳过——否则 `(C |"G" D)`
 * 的 slur 会错挂到小节线或和弦符号上。
 */

import type { MusicEvent } from '../../../../domain';
import type { PairState } from './pairShared';
import {
  consume,
  eventAfter,
  eventBefore,
  isSlurEndpoint,
  isSlurSkippable,
  markerEventIndex,
  nextRelationId,
  originsOfPair,
  report,
  reportOnce,
} from './pairShared';
import type { ScanMarker } from './scanLeaf';

/** 栈元素：`(` 本身与它已经锁定的起点事件。 */
export interface OpenSlur {
  readonly marker: ScanMarker;
  readonly from: MusicEvent;
}

function noteMemberAnchor(state: PairState, marker: ScanMarker): void {
  if (marker.anchor === 'member') {
    // 语料 0 次：组内部的 `(` / `)`。按事件锚点处理（折算到组前 / 组后），只留观测。
    reportOnce(
      state,
      'slur.member-anchor',
      'jcx.parse.slur.member-anchor',
      'info',
      'slur 标记出现在组合事件内部（语料 0 次）：按整个组合事件的前 / 后处理，不引入成员级 slur 语义',
      marker,
    );
  }
}

export function openSlur(state: PairState, marker: ScanMarker, stack: OpenSlur[]): void {
  consume(state, marker);
  noteMemberAnchor(state, marker);
  const from = eventAfter(state.events, markerEventIndex(marker), isSlurEndpoint, isSlurSkippable);
  if (from === undefined) {
    report(
      state,
      'jcx.parse.slur.unclosed',
      'warning',
      "slur '(' 之后没有可作为起点的发声事件，不建立关系",
      marker,
    );
    return;
  }
  stack.push({ marker, from });
}

export function closeSlur(state: PairState, marker: ScanMarker, stack: OpenSlur[]): void {
  consume(state, marker);
  noteMemberAnchor(state, marker);
  const open = stack.pop();
  if (open === undefined) {
    report(
      state,
      'jcx.parse.slur.unopened',
      'warning',
      "孤立的 slur ')'：之前没有未闭合的 '('，不建立关系",
      marker,
    );
    return;
  }
  const to = eventBefore(state.events, markerEventIndex(marker), isSlurEndpoint, isSlurSkippable);
  if (to === undefined) {
    report(
      state,
      'jcx.parse.slur.unclosed',
      'warning',
      "slur ')' 之前没有可作为终点的发声事件，起始 '(' 记为 unclosed",
      marker,
    );
    state.slurs.push({
      kind: 'slur',
      status: 'unclosed',
      id: nextRelationId(state, 'slur'),
      origins: originsOfPair(open.marker, open.from, undefined),
      from: open.from.id,
    });
    return;
  }
  state.slurs.push({
    kind: 'slur',
    status: 'closed',
    id: nextRelationId(state, 'slur'),
    origins: [open.marker.origin, marker.origin, open.from.origin, to.origin],
    from: open.from.id,
    to: to.id,
  });
}

/** 声部扫完后栈里剩下的 `(`：每个都记为 unclosed 并告警（parse-recovery fact）。 */
export function flushOpenSlurs(state: PairState, stack: readonly OpenSlur[]): void {
  for (const open of stack) {
    report(
      state,
      'jcx.parse.slur.unclosed',
      'warning',
      "slur '(' 直到声部结束都没有匹配的 ')'",
      open.marker,
    );
    state.slurs.push({
      kind: 'slur',
      status: 'unclosed',
      id: nextRelationId(state, 'slur'),
      origins: originsOfPair(open.marker, open.from, undefined),
      from: open.from.id,
    });
  }
}
