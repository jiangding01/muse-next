/**
 * notation/staff —— tie 跨行拆段 + 自有 tuplet bracket（M2 T7.3）。
 *
 * 只回答两个问题：**一条关系被换行切成几段**、**每段指向哪几个事件**。与
 * `jianpuArcs.ts` / `tabRelations.ts` 的切段手法同构但**不 import 它们**（§2.7 /
 * `staff/**` 不 import `jianpu/**`、`tab/**`、`chord/**`）——那两处切的是**几何线段**，
 * 本文件切的是**纯语义引用**：本层一个坐标都不产（T7.2 `StaffStaveSpec` 裁决的延续，
 * stave 内音符 x 由渲染器 formatter 决定）。`STAFF_METRICS.tieContinuationMinSpan`
 * 由 adapter（T7.4）消费，这里不造几何去凑它的用法（见 `StaffTie` 的 JSDoc）。
 *
 * **零 VexFlow 概念**：tuplet 不输出任何时值缩放字段，只有 `label` + 成员范围
 * （M2 不按 `p`/`q` 推算 effective duration，`q === 0` 的语义 UNVERIFIED，U25）。
 *
 * **诊断只发本层新发的、每条关系至多一次**（§4.2）：`relationEndpointMissing`
 * （B 类悬空）已由 `model/relations.ts` 在 `buildRenderScore` 里发过——本文件端点
 * 查不到就**只是不画**，不重发；`tieUnresolved` / `tupletRatioUnverified` /
 * `tupletIncomplete` 是 A 类恢复状态的**呈现决定**，各记谱各自表达（jianpu 侧在
 * `jianpuSections.ts`，与本文件互不共享代码也互不重复：一个声部只会被一种记谱布局
 * 消费），由本文件发出，**跨行拆出的多段共用同一 `anchor`，诊断仍只发一次**。
 */

import type { DomainIndex, EventId, Tie, Tuplet } from '../../domain';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import { resolveVoiceRelations } from '../model/relations';
import type { ResolvedRelationEndpoint } from '../model/relations';
import type { Anchor, RenderVoice } from '../model/types';
import type { StaffDraftSink } from './staffEventNodes';
import type {
  StaffRelationEndpoint,
  StaffTie,
  StaffTupletBracket,
} from './staffRelationTypes';
import type { StaffEventNode } from './staffTypes';

/** 事件 → 本次布局的节点：索引的是**布局产物**而不是 Domain 事实（§2.4.1，P2-G）。 */
export type StaffNodeByEvent = ReadonlyMap<EventId, StaffEventNode>;

/** 三条 A 类恢复状态诊断都是 info；`sourceRef` 取关系自己的首个 origin。 */
function draftOf(
  code: RenderDiagnosticDraft['code'],
  message: string,
  anchor: Anchor,
  origins: readonly RenderDiagnosticDraft['sourceRef'][],
): RenderDiagnosticDraft {
  const sourceRef = origins[0];
  return sourceRef === undefined
    ? { code, level: 'info', message, anchor }
    : { code, level: 'info', message, anchor, sourceRef };
}

/** `memberIndex` **原样透传**（Domain 原始下标，不换算成 `pitches` 下标）；理由见 `StaffRelationEndpoint`。 */
function endpointOf(endpoint: ResolvedRelationEndpoint): StaffRelationEndpoint {
  const memberIndex = endpoint.ref.memberIndex;
  return memberIndex === undefined
    ? { eventId: endpoint.event.id }
    : { eventId: endpoint.event.id, memberIndex };
}

/**
 * tie 端点必须落在一个**画得出符头**的音符节点上。端点已降级成占位（时值无法分解、
 * 倚音、和弦块成员全是休止……）或本就不是音符（休止 / 小节线）时**不画、不报告**：
 * 「这个事件画不出来」已由该事件自己的诊断表达过（C2），关系层再发一条只是重复。
 */
function noteNodeFor(
  nodes: StaffNodeByEvent,
  endpoint: ResolvedRelationEndpoint | undefined,
): StaffEventNode | undefined {
  if (endpoint === undefined) return undefined;
  const node = nodes.get(endpoint.event.id);
  return node !== undefined && node.kind === 'note' ? node : undefined;
}

function tieAt(
  anchor: Anchor,
  relation: Tie,
  systemIndex: number,
  segment: StaffTie['segment'],
  ends: { readonly from?: StaffRelationEndpoint; readonly to?: StaffRelationEndpoint },
): StaffTie {
  return {
    anchor,
    relationId: relation.id,
    systemIndex,
    segment,
    status: relation.status,
    ...(ends.from === undefined ? {} : { from: ends.from }),
    ...(ends.to === undefined ? {} : { to: ends.to }),
  };
}

/** 一条 tie → 0 / 1 / 2 段。诊断至多一条，跨行的两段不重复发。 */
function tieSegments(
  anchor: Anchor,
  relation: Tie,
  endpoints: readonly ResolvedRelationEndpoint[],
  nodes: StaffNodeByEvent,
  sink: StaffDraftSink,
): readonly StaffTie[] {
  const from = endpoints.find((endpoint) => endpoint.role === 'from');
  const fromNode = noteNodeFor(nodes, from);
  if (from === undefined || fromNode === undefined) return [];

  if (relation.status !== 'resolved') {
    // A 类恢复状态：只画首端的半开弧（`to` 省略 = 延到行末），不为缺失的对端造端点。
    sink(draftOf(
      CODES.tieUnresolved,
      'tie 在源文本里未闭合（parse 层如实记录的恢复状态）：只画从首端延出去的半开弧，不为缺失的对端造端点',
      anchor,
      relation.origins,
    ));
    return [tieAt(anchor, relation, fromNode.systemIndex, 'start', { from: endpointOf(from) })];
  }

  const to = endpoints.find((endpoint) => endpoint.role === 'to');
  const toNode = noteNodeFor(nodes, to);
  if (to === undefined || toNode === undefined) return [];

  // parse 层配对保证 from 不晚于 to；写成 `<=` 是让「不可能的反向关系」也落到单段
  // 而不是切出一对首尾颠倒的续行段（同 `jianpuArcs.ts` 的处理，思路照抄不 import）。
  if (toNode.systemIndex <= fromNode.systemIndex) {
    return [tieAt(anchor, relation, fromNode.systemIndex, 'whole', {
      from: endpointOf(from),
      to: endpointOf(to),
    })];
  }
  return [
    tieAt(anchor, relation, fromNode.systemIndex, 'start', { from: endpointOf(from) }),
    tieAt(anchor, relation, toNode.systemIndex, 'end', { to: endpointOf(to) }),
  ];
}

/** 一个声部的全部 tie → tie 段。顺序跟随 `resolveVoiceRelations`（确定性）。 */
export function buildStaffTies(
  voice: RenderVoice,
  index: DomainIndex,
  nodes: StaffNodeByEvent,
  sink: StaffDraftSink,
): readonly StaffTie[] {
  const ties: StaffTie[] = [];
  for (const resolved of resolveVoiceRelations(voice.voice, index)) {
    const relation = resolved.relation;
    if (relation.kind !== 'tie') continue;
    const anchor: Anchor = {
      kind: 'relation',
      voiceId: voice.voiceId,
      relationId: relation.id,
    };
    ties.push(...tieSegments(anchor, relation, resolved.resolved, nodes, sink));
  }
  return ties;
}

/** 落在同一行谱上的一串连续成员。 */
interface MemberRun {
  readonly systemIndex: number;
  readonly eventIds: EventId[];
}

/**
 * 按行谱把成员切成若干段：**保持 Domain 成员次序**，相邻同 system 的合并成一段。
 * 端点查不到节点（B 类悬空已被 `resolveVoiceRelations` 滤掉，或该事件不在本次布局里）
 * 就跳过该成员，不重发诊断，也不为它留空段。
 *
 * 与 tie 不同，**降级成占位的成员照样算进括号**：括号是「这几列属于一个连音组」的
 * 横向标注，占位同样是一列可见内容，漏掉它括号就会短一截、指向错误的范围；tie 则
 * 必须落在真的符头上（没有符头就没有可连的两点），故那边只收 `note` 节点。
 */
function memberRuns(
  endpoints: readonly ResolvedRelationEndpoint[],
  nodes: StaffNodeByEvent,
): readonly MemberRun[] {
  const runs: MemberRun[] = [];
  for (const endpoint of endpoints) {
    if (endpoint.role !== 'member') continue;
    const node = nodes.get(endpoint.event.id);
    if (node === undefined) continue;
    const current = runs[runs.length - 1];
    if (current !== undefined && current.systemIndex === node.systemIndex) {
      current.eventIds.push(endpoint.event.id);
    } else {
      runs.push({ systemIndex: node.systemIndex, eventIds: [endpoint.event.id] });
    }
  }
  return runs;
}

/** `${p}`（`q` 缺失或为 0，U25）或 `${p}:${q}`；**只是一个标签**，不含时值语义。 */
function tupletLabel(relation: Tuplet): string {
  return relation.q === undefined || relation.q === 0
    ? String(relation.p)
    : `${String(relation.p)}:${String(relation.q)}`;
}

/** 一个声部的全部 tuplet → 括号段。跨行拆段，`label` 只在首段。 */
export function buildStaffTuplets(
  voice: RenderVoice,
  index: DomainIndex,
  nodes: StaffNodeByEvent,
  sink: StaffDraftSink,
): readonly StaffTupletBracket[] {
  const brackets: StaffTupletBracket[] = [];
  for (const resolved of resolveVoiceRelations(voice.voice, index)) {
    const relation = resolved.relation;
    if (relation.kind !== 'tuplet') continue;

    const runs = memberRuns(resolved.resolved, nodes);
    // 一个成员都画不出来时整条关系不画；既然没画，A 类恢复状态的「呈现决定」也无从
    // 谈起，不发诊断（成员自身画不出来的原因已各自发过诊断，C2）。
    if (runs.length === 0) continue;

    const anchor: Anchor = {
      kind: 'relation',
      voiceId: voice.voiceId,
      relationId: relation.id,
    };
    const label = tupletLabel(relation);
    for (const [order, run] of runs.entries()) {
      brackets.push({
        anchor,
        relationId: relation.id,
        systemIndex: run.systemIndex,
        eventIds: run.eventIds,
        // 续行段没有对端可标注，重复画一个数字是编造（同 `tabRelations.ts` 的口径）。
        ...(order === 0 ? { label } : {}),
        status: relation.status,
      });
    }

    if (relation.q === undefined || relation.q === 0) {
      sink(draftOf(
        CODES.tupletRatioUnverified,
        `连音记号 ${relation.raw} 的 q 缺失或为 0（spec Appendix A U25）：只画括号 + p 数字，成员按字面 duration 排布，不做任何时值缩放`,
        anchor,
        relation.origins,
      ));
    }
    if (relation.status === 'incomplete') {
      sink(draftOf(
        CODES.tupletIncomplete,
        `连音记号 ${relation.raw} 的成员不完整：括号按已有成员范围画，缺失端不补`,
        anchor,
        relation.origins,
      ));
    }
  }
  return brackets;
}
