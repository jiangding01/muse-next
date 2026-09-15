/**
 * Domain —— 关系族（M1.6 方案 v1.1 §1.3）。
 *
 * 由 parse 层消费 syntax marker 产出，存于 `Voice`，不进入事件流。
 * 不设 `pitchMatched` 之类的推断字段：tie 两端音高不符只发 info diagnostic。
 *
 * **`status` 是 parse-recovery fact，不是语义推断**：`'unresolved'` / `'unclosed'` /
 * `'incomplete'` 记录的是「解析恢复时客观发生了什么」——源文本里这个 marker 没有
 * 配到对端、括号没闭合、三连音成员数不够 `r`。它描述的是文本事实，不是对作者
 * 意图或音乐语义的猜测，因此不受方案 §0-1「UNVERIFIED 不得进 Domain」约束。
 *
 * 三个关系都用 `status` 做**判别联合**，而不是「字段可选 + 布尔旗标」：后者允许
 * `{ to: undefined, unresolved: false }` 这类自相矛盾的值存在，前者在类型层就排除了。
 */

import type { EventId, NoteRef, RelationId } from './ids';
import type { SourceRef } from './sourceRef';

export interface RelationBase {
  readonly id: RelationId;
  readonly origins: readonly SourceRef[];
}

/** 配到对端的连音线；和弦逐 member 配对时 `NoteRef.memberIndex` 生效。 */
export interface ResolvedTie extends RelationBase {
  readonly kind: 'tie';
  readonly status: 'resolved';
  readonly from: NoteRef;
  readonly to: NoteRef;
}

/** `-` 之后没有可配对的 note / chord（行尾、文件尾或后继不可唱）。 */
export interface UnresolvedTie extends RelationBase {
  readonly kind: 'tie';
  readonly status: 'unresolved';
  readonly from: NoteRef;
}

export type Tie = ResolvedTie | UnresolvedTie;

/** 可跨小节跨行，不跨 voice。 */
export interface ClosedSlur extends RelationBase {
  readonly kind: 'slur';
  readonly status: 'closed';
  readonly from: EventId;
  readonly to: EventId;
}

/** `(` 之后直到 voice 结束都没有 `)`。 */
export interface UnclosedSlur extends RelationBase {
  readonly kind: 'slur';
  readonly status: 'unclosed';
  readonly from: EventId;
}

export type Slur = ClosedSlur | UnclosedSlur;

/**
 * 只存 `(p:q:r` 的字面数值，**不派生时值缩放**（`q===0` 语义 UNVERIFIED，Appendix A U25）。
 * `q` 省略表示源文本未给出或给出了 `0`。
 *
 * `status` 必填：`'incomplete'` 表示吸收到的成员数少于 `r`（源文本事实），
 * 与 `members.length < r` 一致，但显式化后调用方无须自己重算。
 */
export interface Tuplet extends RelationBase {
  readonly kind: 'tuplet';
  readonly status: 'complete' | 'incomplete';
  /** `(3` / `(3:0:3` 的原拼写；序列化直接写回它，不由 `p`/`q`/`r` 反拼。 */
  readonly raw: string;
  readonly p: number;
  readonly q?: number;
  readonly r: number;
  readonly members: readonly EventId[];
}

/**
 * spec §26.6 的同弦相邻音关系标记 `-S-` / `-H-` / `-P-`。
 * 形态上恒有两端（marker 夹在两音之间），无未解析态，故不带 `status`。
 */
export interface TabRelation extends RelationBase {
  readonly kind: 'slide' | 'hammer' | 'pull';
  readonly from: NoteRef;
  readonly to: NoteRef;
}

/** spec §16.2 的六种 marker 形态；lexer 只产出这六种。 */
export type BrokenRhythmRaw = '>' | '>>' | '>>>' | '<' | '<<' | '<<<';

/**
 * spec §16.2 的 `>` / `<` 时值改写标记。
 *
 * **是 parse-recovery fact，不是语义推断**：parse 层消费 marker 时把相邻两事件的
 * `duration` 改写成了倍率后的值，而 `durationRaw` 仍是原文——若不记录 marker 本身，
 * 「这里写过一个 `>`」这条文本事实就彻底丢失。本关系只存原拼写与两端事件引用，
 * 不重复存倍率（倍率由 `raw` 唯一决定）。
 *
 * 只在**改写确实发生**时登记：任一侧缺失、缺时值或越界而未改写时不建关系，
 * 只留 warning（见 `pairBrokenRhythm.ts`）。形态上恒有两端，故不带 `status`。
 */
export interface BrokenRhythm extends RelationBase {
  readonly kind: 'brokenRhythm';
  readonly raw: BrokenRhythmRaw;
  readonly from: EventId;
  readonly to: EventId;
}

export type Relation = Tie | Slur | Tuplet | TabRelation | BrokenRhythm;
