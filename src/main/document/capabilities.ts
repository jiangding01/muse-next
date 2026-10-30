/**
 * main 能力表的纯数据模型（`docs/M3_EDITOR_CORE_PLAN.md` §13.1，M3 T1a；T4 r1 ERRATA §2、B2 r0.1 勘误 §1）。
 *
 * - 纯函数 + 不可变数据：每个操作返回新表，从不修改传入的表；记录被冻结。不用 class。
 * - 能力 token 由调用方签发（不透明随机串）；本模块只管状态机，不生成 token、不读时钟。
 * - 记录是判别联合（`purpose`）：
 *   - `open`：`pending`（main 已读取 / 解码成功、签发了候选能力，但 renderer 尚未确认接受）与 `active`（授权普通 Save）；
 *   - `tombstone`：被取代 / 放弃 / reset 的 open 记录留下的原文件事实，**永不授权**，只供 sameFile、unsafe、改编码、
 *     指纹判定与 R19 等值核对使用；
 *   - `save-target`：Save As 阶段 1 授予的一次性写入目标。
 *   `lookupActive` 只返回 active open：pending、墓碑、save-target 与跨 owner（窗口）的记录一律视为无效。
 *
 * **本模块不固化撤销时机。** 激活协议、锚点链（`prevCommitted` / 墓碑 / 修剪）与失效时机由 `src/main/open/` 的协调器决定：
 * `activate` 只把 pending 提升为 active，并把同 owner 其它 active open 记录作为 `superseded` 交给调用方。
 */

import type { ByteBom, EncodingRoundTrip } from '../../shared/documentContracts';
import type { JcxEncoding } from '../../formats/jcx/codec';
import type { FileIdentity } from './fileIdentity';
import type { SaveTargetGrant } from './savePipeline';

/**
 * 锚点引用（B2 r0.1 勘误 §1.1）：`committed` 与 active / 墓碑记录的 `prevCommitted` 共用。
 * - `none`：没有文件（demo 页面，或页面重建之后）；
 * - `record`：指向同 owner 仍存在的 active open 或墓碑；
 * - `unresolved`：回退目标已超出保留窗口而被修剪——与任何 `sourceCapabilityId`（含 null）都不相等，fail closed。
 */
export type AnchorRef = { readonly kind: 'none' } | { readonly kind: 'record'; readonly token: string } | { readonly kind: 'unresolved' };

export type CapabilityState = 'pending' | 'active';

/** open 记录与墓碑共有的原文件事实。 */
export interface OpenFileFacts {
  readonly token: string;
  /** 绑定的窗口（webContents）标识；跨 owner 一律无效。 */
  readonly ownerId: number;
  readonly documentId: number;
  readonly realpath: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly lastKnownDiskFingerprint: string;
  readonly identity: FileIdentity | null;
}

/** pending 候选不携带 `prevCommitted`：锚点链只在激活时写入（B2 G-16 定案 D-2）。 */
export interface PendingOpenRecord extends OpenFileFacts {
  readonly purpose: 'open';
  readonly state: 'pending';
}

export interface ActiveOpenRecord extends OpenFileFacts {
  readonly purpose: 'open';
  readonly state: 'active';
  /** 激活时的旧锚点，供 reject 回退（A2）。 */
  readonly prevCommitted: AnchorRef;
}

export type OpenCapabilityRecord = PendingOpenRecord | ActiveOpenRecord;

/** 墓碑：没有 `state` 字段，任何授权查询都不匹配。 */
export interface TombstoneRecord extends OpenFileFacts {
  readonly purpose: 'tombstone';
  readonly prevCommitted: AnchorRef;
}

/** Save As 阶段 1 授予的一次性目标（r1 ERRATA §2.2；B2 r0 §3.2）。 */
export interface SaveTargetRecord {
  readonly token: string;
  readonly ownerId: number;
  readonly purpose: 'save-target';
  /** 授予它的保存操作 id（不可复用）。 */
  readonly operationId: number;
  readonly generation: number;
  /** 授予时的锚点；消费时必须仍等于 `committed`。 */
  readonly anchor: AnchorRef;
  /** 锚点记录的 documentId；没有锚点时为 0。 */
  readonly boundDocumentId: number;
  readonly encoding: JcxEncoding;
  readonly target: SaveTargetGrant;
  /** 用户在 main 对话框中选择的绝对路径。 */
  readonly requestedPath: string;
  readonly displayName: string;
  readonly displayPath: string;
  readonly expiresAt: number;
}

export type CapabilityRecord = OpenCapabilityRecord | TombstoneRecord | SaveTargetRecord;

export type CapabilityTable = ReadonlyMap<string, CapabilityRecord>;

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

export const isActiveOpen = (record: CapabilityRecord): record is ActiveOpenRecord => record.purpose === 'open' && record.state === 'active';
export const isPendingOpen = (record: CapabilityRecord): record is PendingOpenRecord => record.purpose === 'open' && record.state === 'pending';

/** 按 token 过滤出新表；返回被移除的 token（保持表内顺序）。 */
export function removeWhere(table: CapabilityTable, predicate: (record: CapabilityRecord) => boolean): RemovalResult {
  const next = new Map<string, CapabilityRecord>();
  const removed: string[] = [];
  for (const [token, record] of table) {
    if (predicate(record)) removed.push(token);
    else next.set(token, record);
  }
  return { table: next, removed };
}

/** 写入（或替换）一条记录；记录被冻结。 */
export function putRecord(table: CapabilityTable, record: CapabilityRecord): CapabilityTable {
  const next = new Map(table);
  next.set(record.token, Object.freeze({ ...record }));
  return next;
}

/** 登记一条 pending 候选能力。token 已存在（无论用途、状态、owner）→ 拒绝；记录不是 pending → 拒绝。 */
export function addPending(table: CapabilityTable, record: OpenCapabilityRecord): AddPendingResult {
  if (record.state !== 'pending') return { ok: false, reason: 'not-pending' };
  if (table.has(record.token)) return { ok: false, reason: 'duplicate-token' };
  return { ok: true, table: putRecord(table, record) };
}

/**
 * 把同 owner 的 pending 能力提升为 active，并写入 `prevCommitted`（默认 `none`）。跨 owner 与不存在同样报告 `not-found`（不向调用方区分）。
 * `superseded`：同 owner 其它 **active** open 记录的 token；本函数不处理它们。
 */
export function activate(table: CapabilityTable, ownerId: number, token: string, prevCommitted: AnchorRef = { kind: 'none' }): ActivateResult {
  const record = table.get(token);
  if (record === undefined || record.ownerId !== ownerId || record.purpose !== 'open') return { ok: false, reason: 'not-found' };
  if (record.state !== 'pending') return { ok: false, reason: 'not-pending' };
  const superseded: string[] = [];
  for (const [other, candidate] of table) {
    if (other !== token && candidate.ownerId === ownerId && isActiveOpen(candidate)) superseded.push(other);
  }
  const active: ActiveOpenRecord = { ...record, state: 'active', prevCommitted };
  return { ok: true, table: putRecord(table, active), superseded };
}

/** open 记录或墓碑上的原文件事实（逐字段拷贝）。 */
export function fileFactsOf(record: OpenFileFacts): OpenFileFacts {
  return {
    token: record.token,
    ownerId: record.ownerId,
    documentId: record.documentId,
    realpath: record.realpath,
    displayName: record.displayName,
    displayPath: record.displayPath,
    writeEncoding: record.writeEncoding,
    byteBom: record.byteBom,
    encodingRoundTrip: record.encodingRoundTrip,
    lastKnownDiskFingerprint: record.lastKnownDiskFingerprint,
    identity: record.identity,
  };
}

/** active open → 墓碑（保留原文件事实与 `prevCommitted`）。 */
export function toTombstone(record: ActiveOpenRecord): TombstoneRecord {
  return { ...fileFactsOf(record), purpose: 'tombstone', prevCommitted: record.prevCommitted };
}

/** 吊销同 owner 的指定 token（任何用途与状态）；其它 owner 的同名 token 不受影响。 */
export function revoke(table: CapabilityTable, ownerId: number, tokens: readonly string[]): RemovalResult {
  const targets = new Set(tokens);
  return removeWhere(table, (record) => record.ownerId === ownerId && targets.has(record.token));
}

/** 丢弃同 owner 的 pending 候选（renderer 拒绝 / 超时 / 失败清理）；其它记录不受影响。 */
export function discardPending(table: CapabilityTable, ownerId: number, token: string): RemovalResult {
  return removeWhere(table, (record) => record.token === token && record.ownerId === ownerId && isPendingOpen(record));
}

/** 授权查询：只返回同 owner 的 active open 记录；pending、墓碑、save-target、跨 owner、不存在一律 null（I6）。 */
export function lookupActive(table: CapabilityTable, ownerId: number, token: string): ActiveOpenRecord | null {
  const record = table.get(token);
  if (record === undefined || record.ownerId !== ownerId || !isActiveOpen(record)) return null;
  return record;
}

/** 窗口销毁：清空该 owner 的全部记录。 */
export function revokeOwner(table: CapabilityTable, ownerId: number): RemovalResult {
  return removeWhere(table, (record) => record.ownerId === ownerId);
}
