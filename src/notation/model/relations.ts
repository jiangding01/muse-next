/**
 * notation/model —— 关系反查封装（M2 方案 v1.1.1 §2.2 / §2.4.1 / §2.6.1）。
 *
 * 职责只有一件：**把 `Relation` 的端点解析成 render 可用的引用**，解析手段一律是
 * 查 `RenderInput.index`（`loadJcx` 产出的 `DomainIndex`）。
 *
 * 三条边界：
 * - **零自建 lookup**（§2.4.1，P1-1/P2-G）：本文件不声明任何 `EventId → MusicEvent` /
 *   `RelationId → Relation` 的映射，只做成员访问 `index.eventById.get(...)` /
 *   `index.relationById.get(...)`。index 必须与 `score` 同源（同一次 `loadJcx`）。
 * - **不产生时值语义**（§2.6.1，P1-C）：tuplet 只发一条「实际时值关系未建模」的
 *   relation 级诊断，**不按 `p`/`q` 推算 effective duration**（`q === 0` 的语义是
 *   UNVERIFIED，U25），也**不因 tuplet 给任何成员追加 duration 诊断**。
 * - **不解释 `SourceRef`**：只透传，不回 AST（§2.1 禁止边）。
 */

import type {
  DomainIndex,
  EventId,
  MusicEvent,
  NoteRef,
  Relation,
  RelationId,
  Voice,
  VoiceId,
} from '../../domain';
import type { RenderDiagnosticDraft } from './diagnostics';
import { RENDER_DIAGNOSTIC_CODES } from './diagnostics';

/** 端点在关系里扮演的角色；`member` 只出现在 tuplet（成员序列）。 */
export type RelationEndpointRole = 'from' | 'to' | 'member';

export interface RelationEndpoint {
  readonly role: RelationEndpointRole;
  /** 端点的位置引用；`memberIndex` 省略表示整个事件（非和弦块，或整块）。 */
  readonly ref: NoteRef;
}

/** B 类悬空的两种成因，共用一个 code，由本字段区分。 */
export type DanglingReason = 'event-missing' | 'member-index-invalid';

export interface DanglingRelationEndpoint extends RelationEndpoint {
  readonly reason: DanglingReason;
}

/** 端点在 index 中查到了对应事件。`event` 是 Domain 节点的同一引用，永不原地修改。 */
export interface ResolvedRelationEndpoint extends RelationEndpoint {
  readonly voiceId: VoiceId;
  readonly event: MusicEvent;
}

/**
 * 一条关系的解析结果。
 *
 * **两类「配不上对」必须分开，不得合并成同一个 code**：
 *
 * - **A. Domain 记录的恢复状态**——`tie.status === 'unresolved'`、
 *   `slur.status === 'unclosed'`、`tuplet.status === 'incomplete'`。它们是 parse
 *   层如实记录的**源文本事实**（`relation.ts` 文件头已论证），关系正常可渲染，
 *   `relationEndpoints` 只枚举确实存在的那一端，**不进 `dangling`、不发诊断**；
 *   具体的保守呈现（半条连线 / 不闭合的括号）由各记谱的 layout 任务负责。
 * - **B. 端点指不到有效目标**——关系声称指向某个 `EventId`（可能还带 `memberIndex`），
 *   但传入的 `DomainIndex` 里没有该事件，或该事件没有这个成员。这是 index 与 score
 *   不同源（或上游不变量被破坏）的征兆，进 `dangling` 并发一条
 *   `muse.render.relation.endpoint-missing`（warning），成因由 `reason` 区分。
 */
export interface RenderRelation {
  readonly relationId: RelationId;
  readonly relation: Relation;
  readonly resolved: readonly ResolvedRelationEndpoint[];
  readonly dangling: readonly DanglingRelationEndpoint[];
}

/**
 * 成员型事件的成员数；非成员型事件返回 `undefined`。
 *
 * 判据取自 Domain 的事件定义，不做推断：只有 `chord`（`Note | Rest`）、
 * `tabGroup`（`TabNote`）、`grace`（`Note | TabNote`）带 `members`。
 */
function memberCount(event: MusicEvent): number | undefined {
  switch (event.kind) {
    case 'chord':
    case 'tabGroup':
    case 'grace':
      return event.members.length;
    default:
      return undefined;
  }
}

/**
 * `NoteRef.memberIndex` 对该事件是否有效。
 *
 * - 省略 `memberIndex` → 指整个事件，恒有效；
 * - 事件没有 `members`（note / rest / tabNote / barline / …）却带了 `memberIndex`
 *   → **无效**：这是「指向一个不存在的位置」，不是「指向整块」，不能悄悄当整块处理；
 * - 越界或非自然数下标 → 无效。
 */
function isMemberIndexValid(event: MusicEvent, memberIndex: number | undefined): boolean {
  if (memberIndex === undefined) {
    return true;
  }
  const count = memberCount(event);
  if (count === undefined) {
    return false;
  }
  return Number.isInteger(memberIndex) && memberIndex >= 0 && memberIndex < count;
}

/** 未解析 / 未闭合的关系只枚举它确实存在的那一端，不为缺失的对端造引用。 */
export function relationEndpoints(relation: Relation): readonly RelationEndpoint[] {
  switch (relation.kind) {
    case 'tie':
      return relation.status === 'resolved'
        ? [
            { role: 'from', ref: relation.from },
            { role: 'to', ref: relation.to },
          ]
        : [{ role: 'from', ref: relation.from }];
    case 'slur':
      return relation.status === 'closed'
        ? [
            { role: 'from', ref: { eventId: relation.from } },
            { role: 'to', ref: { eventId: relation.to } },
          ]
        : [{ role: 'from', ref: { eventId: relation.from } }];
    case 'tuplet':
      return relation.members.map((member) => ({
        role: 'member' as const,
        ref: { eventId: member },
      }));
    case 'slide':
    case 'hammer':
    case 'pull':
      return [
        { role: 'from', ref: relation.from },
        { role: 'to', ref: relation.to },
      ];
    case 'brokenRhythm':
      return [
        { role: 'from', ref: { eventId: relation.from } },
        { role: 'to', ref: { eventId: relation.to } },
      ];
    default: {
      const exhaustive: never = relation;
      return exhaustive;
    }
  }
}

/** 查一个事件；**只读 index，不自建映射**。查不到返回 `undefined`（调用方决定降级）。 */
export function lookupEvent(
  index: DomainIndex,
  id: EventId,
): { readonly voiceId: VoiceId; readonly event: MusicEvent } | undefined {
  return index.eventById.get(id);
}

/** 查一条关系；同上，只读 index。 */
export function lookupRelation(index: DomainIndex, id: RelationId): Relation | undefined {
  return index.relationById.get(id);
}

/** 解析一条关系的全部端点。纯函数：同一 `(index, relation)` 必然得到同一结果。 */
export function resolveRelation(index: DomainIndex, relation: Relation): RenderRelation {
  const resolved: ResolvedRelationEndpoint[] = [];
  const dangling: DanglingRelationEndpoint[] = [];

  for (const endpoint of relationEndpoints(relation)) {
    const found = lookupEvent(index, endpoint.ref.eventId);
    if (found === undefined) {
      dangling.push({ ...endpoint, reason: 'event-missing' });
      continue;
    }
    if (!isMemberIndexValid(found.event, endpoint.ref.memberIndex)) {
      dangling.push({ ...endpoint, reason: 'member-index-invalid' });
      continue;
    }
    resolved.push({ ...endpoint, voiceId: found.voiceId, event: found.event });
  }

  return { relationId: relation.id, relation, resolved, dangling };
}

/**
 * 一个声部的全部关系，顺序固定（tie → slur → tuplet → tab → brokenRhythm）。
 * 与 parse 层 `buildDomainIndex` 的遍历顺序一致，保证诊断次序确定。
 */
export function voiceRelations(voice: Voice): readonly Relation[] {
  return [
    ...voice.ties,
    ...voice.slurs,
    ...voice.tuplets,
    ...voice.tabRelations,
    ...voice.brokenRhythms,
  ];
}

export function resolveVoiceRelations(
  voice: Voice,
  index: DomainIndex,
): readonly RenderRelation[] {
  return voiceRelations(voice).map((relation) => resolveRelation(index, relation));
}

function withOrigin(
  draft: RenderDiagnosticDraft,
  relation: Relation,
): RenderDiagnosticDraft {
  const origin = relation.origins[0];
  return origin === undefined ? draft : { ...draft, sourceRef: origin };
}

/**
 * 关系层诊断，两条，互不混用：
 *
 * 1. **每个 `Tuplet` 恰好一条** `muse.render.tuplet.timing-not-modeled`（info），挂在
 *    关系上（`Anchor` 的 `relation` 分支），**不挂在任何成员上**（§2.6.1，P1-C）——
 *    成员的 `duration` 该怎么分解就怎么分解，tuplet 只额外画一个括号 + 数字。
 *    `q === 0` 同样只保留事实，**不推算 effective duration**（U25）。
 * 2. **每个 B 类悬空端点一条** `muse.render.relation.endpoint-missing`（warning）。
 *    A 类恢复状态不在此列。
 */
export function collectRelationDiagnostics(
  voice: Voice,
  index: DomainIndex,
): readonly RenderDiagnosticDraft[] {
  const drafts: RenderDiagnosticDraft[] = [];

  for (const resolvedRelation of resolveVoiceRelations(voice, index)) {
    const { relation, relationId: id, dangling } = resolvedRelation;
    const anchor = { kind: 'relation', voiceId: voice.id, relationId: id } as const;

    if (relation.kind === 'tuplet') {
      drafts.push(
        withOrigin(
          {
            code: RENDER_DIAGNOSTIC_CODES.tupletTimingNotModeled,
            level: 'info',
            message: `连音记号 ${relation.raw} 的实际时值关系未建模，成员按字面 duration 排布（spec Appendix A U25）`,
            anchor,
          },
          relation,
        ),
      );
    }

    for (const endpoint of dangling) {
      const target =
        endpoint.ref.memberIndex === undefined
          ? endpoint.ref.eventId
          : `${endpoint.ref.eventId} 的成员 #${String(endpoint.ref.memberIndex)}`;
      const cause =
        endpoint.reason === 'event-missing'
          ? '传入的 index 里没有该事件'
          : '该事件没有这个成员（memberIndex 越界或事件本就没有 members）';
      drafts.push(
        withOrigin(
          {
            code: RENDER_DIAGNOSTIC_CODES.relationEndpointMissing,
            level: 'warning',
            message: `关系 ${id}（${relation.kind}）的 ${endpoint.role} 端指向 ${target}，但${cause}；该端不参与渲染`,
            anchor,
          },
          relation,
        ),
      );
    }
  }

  return drafts;
}
