/**
 * notation/layout —— beam 组落到 layout 节点上的**记谱无关骨架**（M2.5 T3.5）。
 *
 * TAB / 简谱各自决定一组怎么画（`tab/tabBeams.ts` / `jianpu/jianpuBeams.ts` 传入 `engrave`），本文件
 * 只负责共同的那一半：按成员自带的 `EventId` 找到组成员节点（只索引 event anchor 节点）、调用
 * `engrave`、把返回的替换节点写回**同一位置**（节点数组同长同序、anchor 不变——组本身永远不进
 * `nodes`，契约 C1）。`engrave` 返回 `undefined`
 * 表示该组不画（防御性：成员节点缺失），对应节点保持原样。没有任何组时原样返回同一个数组。
 */

import type { EventId } from '../../domain';
import type { Anchor } from '../model/types';
import type { BeamGroupPlan, MeasureBeamPlan } from './beamGroups';

export type GroupEngraver<N, B> = (
  group: BeamGroupPlan,
  measureIndex: number,
  members: readonly (N | undefined)[],
) => { readonly beam: B; readonly nodes: readonly N[] } | undefined;

export function engraveBeamGroups<N extends { readonly anchor: Anchor }, B>(
  nodes: readonly N[],
  plans: readonly MeasureBeamPlan[],
  engrave: GroupEngraver<N, B>,
): { readonly nodes: readonly N[]; readonly beams: readonly B[] } {
  if (plans.every((plan) => plan.groups.length === 0)) return { nodes, beams: [] };
  const indexByEvent = new Map<EventId, number>();
  nodes.forEach((node, i) => {
    if (node.anchor.kind === 'event') indexByEvent.set(node.anchor.eventId, i);
  });
  const out = [...nodes];
  const beams: B[] = [];
  for (const [measureIndex, plan] of plans.entries()) {
    for (const group of plan.groups) {
      const positions = group.members.map((member) => indexByEvent.get(member.eventId));
      const engraved = engrave(group, measureIndex, positions.map((i) => (i === undefined ? undefined : out[i])));
      if (engraved === undefined || engraved.nodes.length !== positions.length) continue;
      engraved.nodes.forEach((node, k) => {
        const i = positions[k];
        if (i !== undefined) out[i] = node;
      });
      beams.push(engraved.beam);
    }
  }
  return { nodes: out, beams };
}
