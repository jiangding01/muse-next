/**
 * Domain —— 关系族（M1.6 方案 v1.1 §1.3）。
 *
 * 由 parse 层消费 syntax marker 产出，存于 `Voice`，不进入事件流。
 * 不设 `pitchMatched` 之类的推断字段：tie 两端音高不符只发 info diagnostic。
 */

import type { EventId, NoteRef, RelationId } from './ids';
import type { SourceRef } from './sourceRef';

export interface RelationBase {
  readonly id: RelationId;
  readonly origins: readonly SourceRef[];
}

/** 和弦逐 member 配对时 `NoteRef.memberIndex` 生效。无后继时 `unresolved`。 */
export interface Tie extends RelationBase {
  readonly kind: 'tie';
  readonly from: NoteRef;
  readonly to: NoteRef;
  readonly unresolved?: boolean;
}

/** 可跨小节跨行，不跨 voice；未闭合时 `to` 省略且 `unclosed` 为真。 */
export interface Slur extends RelationBase {
  readonly kind: 'slur';
  readonly from: EventId;
  readonly to?: EventId;
  readonly unclosed?: boolean;
}

/**
 * 只存 `(p:q:r` 的字面数值，**不派生时值缩放**（`q===0` 语义 UNVERIFIED，Appendix A U25）。
 * `q` 省略表示源文本未给出或给出了 `0`。
 */
export interface Tuplet extends RelationBase {
  readonly kind: 'tuplet';
  readonly p: number;
  readonly q?: number;
  readonly r: number;
  readonly members: readonly EventId[];
  readonly incomplete?: boolean;
}

/** spec §26.6 的同弦相邻音关系标记 `-S-` / `-H-` / `-P-`。 */
export interface TabRelation extends RelationBase {
  readonly kind: 'slide' | 'hammer' | 'pull';
  readonly from: NoteRef;
  readonly to: NoteRef;
}

export type Relation = Tie | Slur | Tuplet | TabRelation;
