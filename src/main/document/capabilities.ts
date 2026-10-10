/**
 * main 能力表的纯数据模型（`docs/M3_EDITOR_CORE_PLAN.md` §13.1，M3 T1a）。
 *
 * - 纯函数 + 不可变数据：每个操作返回新表，从不修改传入的表；记录被冻结。不用 class。
 * - 能力 token 由调用方签发（不透明随机串）；本模块只管状态机，不生成 token、不读时钟。
 * - 状态：`pending`（main 已读取 / 解码成功、签发了候选能力，但 renderer 尚未确认接受）与 `active`（可用于读写授权）。
 *   `lookupActive` 只认 active：pending 能力与跨 owner（窗口）的能力一律视为无效。
 *
 * **本模块不固化撤销时机。** 激活协议（candidate → renderer accepted → activation ack → old revoked）、
 * 失败 / 超时清理、并发 Open 的时序由 T1b 冻结：`activate` 只把 pending 提升为 active，并把同 owner 其它 active
 * open 记录作为 `superseded` 交给调用方；何时吊销由调用方调用 `revoke` 决定。不得把「main 读取成功即撤销旧能力」
 * 写进这里。
 */

import type { ByteBom, EncodingRoundTrip } from '../../shared/documentContracts';
import type { JcxEncoding } from '../../formats/jcx/codec';
import type { FileIdentity } from './fileIdentity';

export type CapabilityState = 'pending' | 'active';

export interface OpenCapabilityRecord {
  readonly token: string;
  /** 绑定的窗口（webContents）标识；跨 owner 一律无效。 */
  readonly ownerId: number;
  readonly documentId: number;
  readonly purpose: 'open';
  readonly state: CapabilityState;
  readonly realpath: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly lastKnownDiskFingerprint: string;
  readonly identity: FileIdentity | null;
}

export type CapabilityTable = ReadonlyMap<string, OpenCapabilityRecord>;

export type AddPendingResult =
  | { readonly ok: true; readonly table: CapabilityTable }
  | { readonly ok: false; readonly reason: 'duplicate-token' | 'not-pending' };

export type ActivateResult =
  | { readonly ok: true; readonly table: CapabilityTable; readonly superseded: readonly string[] }
  | { readonly ok: false; readonly reason: 'not-found' | 'not-pending' };

export interface RemovalResult {
  readonly table: CapabilityTable;
  readonly removed: readonly string[];
}

export function createCapabilityTable(): CapabilityTable {
  return new Map();
}

/** 按 token 过滤出新表；返回被移除的 token（保持表内顺序）。 */
function removeWhere(table: CapabilityTable, predicate: (record: OpenCapabilityRecord) => boolean): RemovalResult {
  const next = new Map<string, OpenCapabilityRecord>();
  const removed: string[] = [];
  for (const [token, record] of table) {
    if (predicate(record)) removed.push(token);
    else next.set(token, record);
  }
  return { table: next, removed };
}

/** 登记一条 pending 候选能力。token 已存在（无论状态、owner）→ 拒绝；记录不是 pending → 拒绝。 */
export function addPending(table: CapabilityTable, record: OpenCapabilityRecord): AddPendingResult {
  if (record.state !== 'pending') return { ok: false, reason: 'not-pending' };
  if (table.has(record.token)) return { ok: false, reason: 'duplicate-token' };
  const next = new Map(table);
  next.set(record.token, Object.freeze({ ...record }));
  return { ok: true, table: next };
}

/**
 * 把同 owner 的 pending 能力提升为 active。跨 owner 与不存在同样报告 `not-found`（不向调用方区分）。
 * `superseded`：同 owner 其它 **active** open 记录的 token；本函数不吊销它们。
 */
export function activate(table: CapabilityTable, ownerId: number, token: string): ActivateResult {
  const record = table.get(token);
  if (record === undefined || record.ownerId !== ownerId) return { ok: false, reason: 'not-found' };
  if (record.state !== 'pending') return { ok: false, reason: 'not-pending' };
  const superseded: string[] = [];
  for (const [other, candidate] of table) {
    if (other !== token && candidate.ownerId === ownerId && candidate.state === 'active' && candidate.purpose === 'open') {
      superseded.push(other);
    }
  }
  const next = new Map(table);
  next.set(token, Object.freeze({ ...record, state: 'active' }));
  return { ok: true, table: next, superseded };
}

/** 吊销同 owner 的指定 token（任何状态）；其它 owner 的同名 token 不受影响。 */
export function revoke(table: CapabilityTable, ownerId: number, tokens: readonly string[]): RemovalResult {
  const targets = new Set(tokens);
  return removeWhere(table, (record) => record.ownerId === ownerId && targets.has(record.token));
}

/** 丢弃同 owner 的 pending 候选（renderer 拒绝 / 超时 / 失败清理）；active 记录不受影响。 */
export function discardPending(table: CapabilityTable, ownerId: number, token: string): RemovalResult {
  return removeWhere(table, (record) => record.token === token && record.ownerId === ownerId && record.state === 'pending');
}

/** 授权查询：只返回同 owner 的 active 记录；pending、跨 owner、不存在一律 null。 */
export function lookupActive(table: CapabilityTable, ownerId: number, token: string): OpenCapabilityRecord | null {
  const record = table.get(token);
  if (record === undefined || record.ownerId !== ownerId || record.state !== 'active') return null;
  return record;
}

/** 窗口销毁 / reload：清空该 owner 的全部能力（pending 与 active）。 */
export function revokeOwner(table: CapabilityTable, ownerId: number): RemovalResult {
  return removeWhere(table, (record) => record.ownerId === ownerId);
}
