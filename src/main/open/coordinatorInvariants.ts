/**
 * 协调器状态的一致性不变量（M3 T1b-1，用户要求「duplicated 状态必须通过不变量测试防止分叉」）。
 *
 * 能力事实只在 `CapabilityTable`，协调元数据只在 `owners`；这里检查两者没有分叉：
 *
 * 1. 每条能力记录的 owner 都已登记，且 purpose 为 `open`；
 * 2. 每个 owner 的 pending 记录集合与其 `candidates` 的 key 集合完全相同；
 * 3. 每个 owner 至多一条 active 能力；
 * 4. 每个 owner 至多一个 pending 候选，且它属于当前 generation 与最新请求（严格最新规则的直接推论）；
 * 5. owner 元数据的数值合法（generation ≥ 1、latestRequestSeq ≥ 0，均为安全整数）；
 * 6. 进行中的请求（`inFlightSeq`）只能是最新请求，且此时该窗口没有 pending 候选（候选只在请求完成时登记）。
 *
 * 返回违规描述列表；空列表表示一致。纯函数，供单元测试在每一步迁移之后调用。
 */

import type { OpenCoordinatorState } from './openCoordinator';

export function coordinatorInvariantViolations(state: OpenCoordinatorState): string[] {
  const violations: string[] = [];
  const pendingByOwner = new Map<number, Set<string>>();
  const activeByOwner = new Map<number, number>();

  for (const [token, record] of state.table) {
    if (record.token !== token) violations.push(`record keyed ${token} carries token ${record.token}`);
    if (record.purpose !== 'open') violations.push(`record ${token} has purpose ${String(record.purpose)}`);
    if (!state.owners.has(record.ownerId)) violations.push(`record ${token} belongs to unregistered owner ${String(record.ownerId)}`);
    if (record.state === 'pending') {
      const set = pendingByOwner.get(record.ownerId) ?? new Set<string>();
      set.add(token);
      pendingByOwner.set(record.ownerId, set);
    } else {
      activeByOwner.set(record.ownerId, (activeByOwner.get(record.ownerId) ?? 0) + 1);
    }
  }

  for (const [ownerId, meta] of state.owners) {
    if (!Number.isSafeInteger(meta.generation) || meta.generation < 1) violations.push(`owner ${String(ownerId)} has invalid generation`);
    if (!Number.isSafeInteger(meta.latestRequestSeq) || meta.latestRequestSeq < 0) violations.push(`owner ${String(ownerId)} has invalid requestSeq`);
    const pending = pendingByOwner.get(ownerId) ?? new Set<string>();
    for (const token of pending) {
      if (!meta.candidates.has(token)) violations.push(`pending ${token} has no candidate metadata`);
    }
    for (const [token, candidate] of meta.candidates) {
      if (!pending.has(token)) violations.push(`candidate ${token} has no pending record`);
      if (candidate.generation !== meta.generation) violations.push(`candidate ${token} belongs to an old generation`);
      if (candidate.requestSeq !== meta.latestRequestSeq) violations.push(`candidate ${token} is not the latest request`);
    }
    if (meta.inFlightSeq !== null && meta.inFlightSeq !== meta.latestRequestSeq) violations.push(`owner ${String(ownerId)} has a stale in-flight request`);
    if (meta.inFlightSeq !== null && meta.candidates.size > 0) violations.push(`owner ${String(ownerId)} has a candidate while a request is in flight`);
    if (meta.candidates.size > 1) violations.push(`owner ${String(ownerId)} has ${String(meta.candidates.size)} pending candidates`);
    if ((activeByOwner.get(ownerId) ?? 0) > 1) violations.push(`owner ${String(ownerId)} has more than one active capability`);
  }
  return violations;
}
