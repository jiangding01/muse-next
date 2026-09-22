/**
 * notation/staff —— Staff 关系（tie / tuplet bracket）的 renderer-neutral 类型（M2 T7.3）。
 *
 * 自 `staffTypes.ts` 机械拆出（该文件已逼近 350 行上限），内容逐字未改：这里只放
 * 「一条关系在 Staff 布局里长什么样」的类型，构造逻辑在 `staffRelations.ts`。
 * 同样**零 VexFlow 编码**、同样只 type-only import Domain 与 `../model` 的既有类型。
 */

import type { EventId, RelationId } from '../../domain';
import type { Anchor } from '../model/types';

// 关系（T7.3 落地，构造逻辑在 `staffRelations.ts`）。**两者都不带 x / y**。
/**
 * 关系端点。`memberIndex` 是 **Domain 原始成员下标**（`NoteRef.memberIndex` 原样透传），
 * **不是** `StaffNoteNode.pitches` 的数组下标。两者靠 `StaffNotePitch.memberIndex`
 * 对上：adapter（T7.4）写
 * `pitches.findIndex((entry) => entry.memberIndex === endpoint.memberIndex)`，
 * **不得**自己重放「跳过休止成员」的规则，也**不得**把它直接当下标用。
 * 省略表示指整个事件（非和弦块，或指整块）。
 */
export interface StaffRelationEndpoint {
  readonly eventId: EventId;
  readonly memberIndex?: number;
}

/**
 * tie（连音线）。**不带 x / y**：stave 内音符的 x 由渲染器 formatter 决定（同
 * `StaffStaveSpec` 的裁决），adapter 用 `eventId` 找到音符再画。
 *
 * `segment` + 两端的在场与否就是 adapter 需要的全部信息：
 * - `whole`：两端同在 `systemIndex` 这一行，`from` / `to` 都在；
 * - `start`：`to` 省略 = 弧从 `from` 延到**本行末**（跨行时下一行有 `end` 段接上；
 *   `status === 'unresolved'` 时本就没有对端）；
 * - `end`：`from` 省略 = 弧从**本行首**起、落到 `to`。
 *
 * 跨行拆出的两段共用**同一个** `anchor`：段数是视觉事实，relation 仍只有一条，
 * 诊断也只发一次。`STAFF_METRICS.tieContinuationMinSpan`（续行段最小可见跨度）
 * **由 adapter 消费**——notation 层没有 x，对它做不了任何计算，这里也不造假几何。
 */
export interface StaffTie {
  readonly anchor: Anchor;
  readonly relationId: RelationId;
  readonly systemIndex: number;
  readonly segment: 'whole' | 'start' | 'end';
  /** 原样透传 Domain `Tie.status`；`unresolved` 只产一个 `start` 段。 */
  readonly status: 'resolved' | 'unresolved';
  readonly from?: StaffRelationEndpoint;
  readonly to?: StaffRelationEndpoint;
}

/**
 * tuplet 括号——**Muse Next 自有概念，不是渲染器的 Tuplet 对象**：只有标签与成员范围，
 * **不带任何时值缩放字段**（M2 不按 `p`/`q` 推算 effective duration，`q === 0`
 * UNVERIFIED）。同样不带 x / y：adapter 用 `eventIds` 找到音符再算括号范围。
 * 跨行按 system 拆段（同一个 `anchor`），`label` **只在首段**；`status` 原样透传
 * Domain `Tuplet.status`，`incomplete` 时缺失端不补。
 */
export interface StaffTupletBracket {
  readonly anchor: Anchor;
  readonly relationId: RelationId;
  readonly systemIndex: number;
  /** 落在本段（本行谱）上的成员事件，按 Domain 成员次序。 */
  readonly eventIds: readonly EventId[];
  /** `${p}` 或 `${p}:${q}`；续行段没有对端可标注，省略。 */
  readonly label?: string;
  readonly status: 'complete' | 'incomplete';
}
