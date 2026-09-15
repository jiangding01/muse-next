/**
 * Parse 层 —— tuplet `(n` / `(p:q:r` 配对（M1.6 T7；spec §20）。
 *
 * **不派生任何时值缩放**（方案 §0-1 / §1.7）：`q === 0` 的含义 UNVERIFIED（Appendix A U25），
 * 只把三元组按事实存下来，`q === 0` 记为 `q: undefined` 并发一次 info。
 *
 * 计数口径：吸收其后 `r` 个「有时值事件」——note / rest / chord / tabNote / tabGroup；
 * barline / decoration / chordSymbol / unknown 跳过不计数，grace 不计数（spec §21 无时值）。
 */

import type { EventId } from '../../../../domain';
import type { PairState } from './pairShared';
import {
  consume,
  isTupletMember,
  markerEventIndex,
  nextRelationId,
  report,
  reportOnce,
} from './pairShared';
import type { ScanMarker } from './scanLeaf';

/** §20 的 `"(" digit [ ":" digit [ ":" digit ] ]`；lexer 已保证形态，此处只取数值。 */
const TUPLET_RE = /^\((\d+)(?::(\d+))?(?::(\d+))?$/;

interface TupletSpec {
  readonly p: number;
  readonly q?: number;
  readonly r: number;
}

/** 解析失败返回 undefined（lexer 形态保证下不可达，但不靠断言兜底）。 */
export function parseTupletSpec(raw: string): TupletSpec | undefined {
  const match = TUPLET_RE.exec(raw);
  if (match === null) {
    return undefined;
  }
  const p = Number(match[1]);
  const qRaw = match[2] === undefined ? undefined : Number(match[2]);
  const rRaw = match[3] === undefined ? undefined : Number(match[3]);
  // 简写 `(n`：n 既是 p 也是成员数（§20）。
  const r = rRaw ?? p;
  // `q === 0` 的语义 UNVERIFIED（U25）：按「未给出」记录，绝不据此算时值。
  return qRaw === undefined || qRaw === 0 ? { p, r } : { p, q: qRaw, r };
}

export function pairTuplet(state: PairState, marker: ScanMarker): void {
  consume(state, marker);
  const spec = parseTupletSpec(marker.raw);
  if (spec === undefined) {
    report(
      state,
      'jcx.parse.tuplet.unparsed',
      'warning',
      `tuplet 标记 ${JSON.stringify(marker.raw)} 不符合 spec §20 的形态，不建立关系`,
      marker,
    );
    return;
  }
  if (/^\(\d+:0(?::|$)/.test(marker.raw)) {
    reportOnce(
      state,
      'tuplet.q-zero',
      'jcx.parse.tuplet.q-zero',
      'info',
      "tuplet 的 q 为 0，其含义 UNVERIFIED（spec §20 / Appendix A U25）：按「未给出」记录为 q: undefined，不据此派生任何时值缩放",
      marker,
    );
  }

  const members: EventId[] = [];
  for (let i = markerEventIndex(marker); i < state.events.length && members.length < spec.r; i += 1) {
    const event = state.events[i];
    if (event !== undefined && isTupletMember(event)) {
      members.push(event.id);
    }
  }

  const complete = members.length === spec.r;
  if (!complete) {
    report(
      state,
      'jcx.parse.tuplet.incomplete',
      'warning',
      `tuplet 需要 ${String(spec.r)} 个有时值事件，声部内只找到 ${String(members.length)} 个`,
      marker,
    );
  }
  state.tuplets.push({
    kind: 'tuplet',
    status: complete ? 'complete' : 'incomplete',
    id: nextRelationId(state, 'tuplet'),
    origins: [marker.origin],
    p: spec.p,
    ...(spec.q === undefined ? {} : { q: spec.q }),
    r: spec.r,
    members,
  });
}
