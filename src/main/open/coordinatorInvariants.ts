/**
 * 协调器状态的一致性不变量（M3 T1b-1，用户要求「duplicated 状态必须通过不变量测试防止分叉」；M3 T4 r1 ERRATA §2.5、
 * B2 r0.1 勘误 §1.6 / §2）。
 *
 * 能力事实只在 `CapabilityTable`，协调元数据只在 `owners`；这里检查两者没有分叉：
 *
 * 1. 每条能力记录的 owner 都已登记，且 purpose ∈ {open, tombstone, save-target}（I1）；
 * 2. 每个 owner 的 pending 记录集合与其 `candidates` 的 key 集合完全相同；
 * 3. 每个 owner 至多一条 active 能力、至多一条 save-target（属于当前 generation）、至多两条墓碑（I2）；
 * 4. 每个 owner 至多一个 pending 候选，且它属于当前 generation 与最新请求（严格最新规则的直接推论）；
 * 5. owner 元数据的数值合法（generation ≥ 1、latestRequestSeq ≥ 0，均为安全整数）；
 * 6. 进行中的请求（`inFlightSeq`）只能是最新请求，且此时该窗口没有 pending 候选（候选只在请求完成时登记）；
 * 7. 存在 active A ⇒ `committed = record(A)`（I3）；`committed` 为 none / unresolved ⇒ 没有 active（I8）；
 * 8. `committed` 与每条 active / 墓碑的 `prevCommitted` 若为 record，必须指向同 owner 仍存在的 active 或墓碑（I4'）；
 * 9. 每条墓碑都等于 `committed` 指向的记录或其直接 `prevCommitted`（I5'）；
 * 10. 保存逻辑锁属于当前 generation，且其 id 小于 `nextOperationId`（id 不可复用）。
 *
 * 返回违规描述列表；空列表表示一致。纯函数，供单元测试在每一步迁移之后调用。
 */

import type { AnchorRef, CapabilityRecord } from '../document/capabilities';
import { anchorRecord, isAnchorRecord } from './anchorChain';
import type { OpenCoordinatorState } from './openCoordinator';

const PURPOSES: ReadonlySet<string> = new Set(['open', 'tombstone', 'save-target']);

const anchorText = (anchor: AnchorRef): string => (anchor.kind === 'record' ? `record ${anchor.token}` : anchor.kind);

export function coordinatorInvariantViolations(state: OpenCoordinatorState): string[] {
  const violations: string[] = [];
  const pendingByOwner = new Map<number, Set<string>>();
  const activeByOwner = new Map<number, string[]>();
  const byOwner = (ownerId: number, purpose: CapabilityRecord['purpose']): CapabilityRecord[] =>
    [...state.table.values()].filter((record) => record.ownerId === ownerId && record.purpose === purpose);

  for (const [token, record] of state.table) {
    if (record.token !== token) violations.push(`record keyed ${token} carries token ${record.token}`);
    if (!PURPOSES.has(record.purpose)) violations.push(`record ${token} has purpose ${String(record.purpose)}`);
    if (!state.owners.has(record.ownerId)) violations.push(`record ${token} belongs to unregistered owner ${String(record.ownerId)}`);
    if (record.purpose !== 'open') continue;
    if (record.state === 'pending') {
      const set = pendingByOwner.get(record.ownerId) ?? new Set<string>();
      set.add(token);
      pendingByOwner.set(record.ownerId, set);
    } else {
      activeByOwner.set(record.ownerId, [...(activeByOwner.get(record.ownerId) ?? []), token]);
    }
  }

  if (!Number.isSafeInteger(state.nextOperationId) || state.nextOperationId < 1) violations.push('nextOperationId is invalid');

  for (const [ownerId, meta] of state.owners) {
    const owner = String(ownerId);
    if (!Number.isSafeInteger(meta.generation) || meta.generation < 1) violations.push(`owner ${owner} has invalid generation`);
    if (!Number.isSafeInteger(meta.latestRequestSeq) || meta.latestRequestSeq < 0) violations.push(`owner ${owner} has invalid requestSeq`);
    const pending = pendingByOwner.get(ownerId) ?? new Set<string>();
    for (const token of pending) {
      if (!meta.candidates.has(token)) violations.push(`pending ${token} has no candidate metadata`);
    }
    for (const [token, candidate] of meta.candidates) {
      if (!pending.has(token)) violations.push(`candidate ${token} has no pending record`);
      if (candidate.generation !== meta.generation) violations.push(`candidate ${token} belongs to an old generation`);
      if (candidate.requestSeq !== meta.latestRequestSeq) violations.push(`candidate ${token} is not the latest request`);
    }
    if (meta.inFlightSeq !== null && meta.inFlightSeq !== meta.latestRequestSeq) violations.push(`owner ${owner} has a stale in-flight request`);
    if (meta.inFlightSeq !== null && meta.candidates.size > 0) violations.push(`owner ${owner} has a candidate while a request is in flight`);
    if (meta.candidates.size > 1) violations.push(`owner ${owner} has ${String(meta.candidates.size)} pending candidates`);
    const actives = activeByOwner.get(ownerId) ?? [];
    if (actives.length > 1) violations.push(`owner ${owner} has more than one active capability`);

    // I2：save-target 与墓碑的数量上限。
    const targets = byOwner(ownerId, 'save-target');
    if (targets.length > 1) violations.push(`owner ${owner} has ${String(targets.length)} save-targets`);
    for (const target of targets) {
      if (target.purpose === 'save-target' && target.generation !== meta.generation) violations.push(`save-target ${target.token} belongs to an old generation`);
    }
    const tombstones = byOwner(ownerId, 'tombstone');
    if (tombstones.length > 2) violations.push(`owner ${owner} has ${String(tombstones.length)} tombstones`);

    // I3 / I8：active 与 committed 的关系。
    const committed = meta.committed;
    for (const token of actives) {
      if (committed.kind !== 'record' || committed.token !== token) violations.push(`owner ${owner} has active ${token} but committed is ${anchorText(committed)}`);
    }
    if (committed.kind !== 'record' && actives.length > 0) violations.push(`owner ${owner} has an active capability while committed is ${committed.kind}`);

    // I4'：任何 record 引用都指向同 owner 仍存在的锚点链记录。
    const head = anchorRecord(state.table, ownerId, committed);
    if (committed.kind === 'record' && head === null) violations.push(`owner ${owner} committed ${committed.token} is not a live anchor`);
    for (const record of state.table.values()) {
      if (record.ownerId !== ownerId || !isAnchorRecord(record)) continue;
      const prev = record.prevCommitted;
      if (prev.kind === 'record' && anchorRecord(state.table, ownerId, prev) === null) violations.push(`record ${record.token} prevCommitted ${prev.token} is dangling`);
    }

    // I5'：墓碑只能是 committed 记录或其直接 prevCommitted。
    const keep = new Set<string>();
    if (head !== null) {
      keep.add(head.token);
      if (head.prevCommitted.kind === 'record') keep.add(head.prevCommitted.token);
    }
    for (const tombstone of tombstones) {
      if (!keep.has(tombstone.token)) violations.push(`tombstone ${tombstone.token} is outside the anchor chain`);
    }

    // 保存逻辑锁。
    const operation = meta.saveOperation;
    if (operation !== null) {
      if (operation.generation !== meta.generation) violations.push(`owner ${owner} holds a save operation from an old generation`);
      if (!Number.isSafeInteger(operation.id) || operation.id < 1 || operation.id >= state.nextOperationId) violations.push(`owner ${owner} holds a save operation with an unissued id`);
    }
  }
  return violations;
}
