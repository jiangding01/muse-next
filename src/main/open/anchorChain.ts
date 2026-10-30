/**
 * 锚点链：纯函数（M3 T4 r1 ERRATA §2.3 A1 / A2 / A4 / A5；B2 r0.1 勘误 §1）。
 *
 * - `committed`（`OwnerMeta.committed`）是 main 推出的「renderer 当前会话对应的 open 记录」；active open 与墓碑的
 *   `prevCommitted` 记录激活时的旧锚点，供 reject 回退。三者都是 `AnchorRef`（`none` / `record` / `unresolved`）。
 * - **修剪**（每次迁移的最后一步）：只保留 `committed` 指向的记录及其直接 `prevCommitted` 指向的墓碑（每 owner ≤ 2 条），
 *   并把仍保留记录上指向已删除记录的 `prevCommitted` 改写为 `unresolved`——之后任何引用都不会指向已删除的记录，
 *   超出保留窗口的祖先永远不会被重新设为 `committed`。
 * - `unresolved` 与任何 `sourceCapabilityId`（含 null）都不相等（`anchorMatchesSource`）：回退无法安全完成时 fail closed。
 * - 本模块不处理 pending 候选元数据、save-target 与 generation；它们由 `openCoordinator.ts` / `saveCoordinator.ts` 负责。
 */

import { activate, isActiveOpen, isPendingOpen, putRecord, removeWhere, toTombstone } from '../document/capabilities';
import type { ActiveOpenRecord, AnchorRef, CapabilityRecord, CapabilityTable, TombstoneRecord } from '../document/capabilities';

export const NO_ANCHOR: AnchorRef = Object.freeze({ kind: 'none' });
export const UNRESOLVED_ANCHOR: AnchorRef = Object.freeze({ kind: 'unresolved' });

export function anchorTo(token: string): AnchorRef {
  return Object.freeze({ kind: 'record', token });
}

export function sameAnchor(a: AnchorRef, b: AnchorRef): boolean {
  if (a.kind === 'record' || b.kind === 'record') return a.kind === 'record' && b.kind === 'record' && a.token === b.token;
  return a.kind === b.kind;
}

/**
 * R19 源文件身份核对（r1.2 ERRATA §2.1）：只做等值比较，不授予任何权限。
 * 载荷 `null` 只与 `none` 相等；token 只与同 token 的 `record` 相等；`unresolved` 与任何载荷都不相等。
 */
export function anchorMatchesSource(committed: AnchorRef, sourceCapabilityId: string | null): boolean {
  if (committed.kind === 'none') return sourceCapabilityId === null;
  if (committed.kind === 'record') return sourceCapabilityId === committed.token;
  return false;
}

/** 锚点链上的记录：active open 或墓碑。 */
export function isAnchorRecord(record: CapabilityRecord): record is ActiveOpenRecord | TombstoneRecord {
  return isActiveOpen(record) || record.purpose === 'tombstone';
}

/** `committed` 指向的记录（同 owner 的 active open 或墓碑）；不存在时为 null。 */
export function anchorRecord(table: CapabilityTable, ownerId: number, committed: AnchorRef): ActiveOpenRecord | TombstoneRecord | null {
  if (committed.kind !== 'record') return null;
  const record = table.get(committed.token);
  return record !== undefined && record.ownerId === ownerId && isAnchorRecord(record) ? record : null;
}

export interface AnchorStep {
  readonly table: CapabilityTable;
  readonly committed: AnchorRef;
  /** 本次失去授权（或失去成为授权的资格）的 token（B2 G-16 定案 D-1）。 */
  readonly deauthorized: readonly string[];
}

/** 修剪（勘误 §1.2）：保留集合 K = {committed 记录, 其直接 prevCommitted 记录}；删除 K 之外的墓碑；改写悬空引用。 */
export function pruneAnchors(table: CapabilityTable, ownerId: number, committed: AnchorRef): { readonly table: CapabilityTable; readonly committed: AnchorRef } {
  const keep = new Set<string>();
  const head = anchorRecord(table, ownerId, committed);
  // 防御：committed 指向不存在的记录时不得悬空，按回退失败处理。
  const resolved = committed.kind === 'record' && head === null ? UNRESOLVED_ANCHOR : committed;
  if (head !== null) {
    keep.add(head.token);
    const prev = anchorRecord(table, ownerId, head.prevCommitted);
    if (prev !== null) keep.add(prev.token);
  }
  const kept = removeWhere(table, (record) => record.ownerId === ownerId && record.purpose === 'tombstone' && !keep.has(record.token)).table;
  let next = kept;
  for (const record of kept.values()) {
    if (record.ownerId !== ownerId || !isAnchorRecord(record)) continue;
    if (record.prevCommitted.kind === 'record' && anchorRecord(kept, ownerId, record.prevCommitted) === null) {
      next = putRecord(next, { ...record, prevCommitted: UNRESOLVED_ANCHOR });
    }
  }
  return { table: next, committed: resolved };
}

/**
 * A1：激活 pending X。X → active（`prevCommitted = committed`）；同 owner 其它 active open → 墓碑（不删除）；
 * `committed = X`；修剪。调用方已确认 X 是同 owner、属于最新请求与当前 generation、未过期的 pending。
 */
export function commitActivation(table: CapabilityTable, ownerId: number, token: string, committed: AnchorRef): AnchorStep {
  const activated = activate(table, ownerId, token, committed);
  if (!activated.ok) throw new Error(`commitActivation: pending capability could not be activated (${activated.reason})`);
  let next = activated.table;
  for (const superseded of activated.superseded) {
    const record = next.get(superseded);
    if (record !== undefined && isActiveOpen(record)) next = putRecord(next, toTombstone(record));
  }
  const pruned = pruneAnchors(next, ownerId, anchorTo(token));
  return { ...pruned, deauthorized: activated.superseded };
}

/**
 * A2 / A2'：reject(t) 且 `committed = record(t)`。t 是 active → 转墓碑；t 是墓碑 → 保留到修剪。`committed = t.prevCommitted`；
 * 修剪。其它情形（committed 不是 t、t 不在锚点链上、跨 owner）返回 null——调用方不得改变任何状态。
 */
export function rollbackAnchor(table: CapabilityTable, ownerId: number, token: string, committed: AnchorRef): AnchorStep | null {
  if (committed.kind !== 'record' || committed.token !== token) return null;
  const record = anchorRecord(table, ownerId, committed);
  if (record === null) return null;
  const wasActive = isActiveOpen(record);
  const next = wasActive ? putRecord(table, toTombstone(record)) : table;
  const pruned = pruneAnchors(next, ownerId, record.prevCommitted);
  return { ...pruned, deauthorized: wasActive ? [token] : [] };
}

/**
 * A4（主 frame 跨文档导航开始、渲染进程退出——页面可能仍存活）：active open → 墓碑；pending 与 save-target 丢弃；
 * `committed` 不变；修剪。
 */
export function tombstoneOwner(table: CapabilityTable, ownerId: number, committed: AnchorRef): AnchorStep {
  const dropped = removeWhere(table, (record) => record.ownerId === ownerId && (isPendingOpen(record) || record.purpose === 'save-target'));
  const deauthorized = [...dropped.removed];
  let next = dropped.table;
  for (const record of dropped.table.values()) {
    if (record.ownerId === ownerId && isActiveOpen(record)) {
      next = putRecord(next, toTombstone(record));
      deauthorized.push(record.token);
    }
  }
  return { ...pruneAnchors(next, ownerId, committed), deauthorized };
}

/** A5（`did-navigate`：页面已重建）：先 A4，再删除该 owner 全部墓碑，`committed = none`。 */
export function clearAnchors(table: CapabilityTable, ownerId: number, committed: AnchorRef): AnchorStep {
  const reset = tombstoneOwner(table, ownerId, committed);
  const cleared = removeWhere(reset.table, (record) => record.ownerId === ownerId && record.purpose === 'tombstone').table;
  return { table: cleared, committed: NO_ANCHOR, deauthorized: reset.deauthorized };
}
