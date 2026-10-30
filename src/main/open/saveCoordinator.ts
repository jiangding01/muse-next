/**
 * 保存的纯协议层（M3 T4 B2；r1 ERRATA §2.3 A7 / A8 / A9、§2.4，r1.2 ERRATA §2.1 R19，B2 r0 §3、r0.1 勘误 §2 / §3，
 * Gate B2 编码授权 F1 / F2）。
 *
 * 与 `openCoordinator.ts` 共用同一份 `OpenCoordinatorState`（DR1 Q2.6：不另建第二份可变状态）；所有函数同步、纯、不可变，
 * 不读时钟（`now` 由调用方注入）、不签发 token（由调用方传入）。
 *
 * - **保存逻辑锁**：`acquireSaveOperation` 分配进程内单调递增、从不复用的操作 id；`holdsSaveOperation` 要求 owner 仍登记、
 *   generation 未变且锁的 id 相同；`releaseSaveOperation` 只在持有时清锁（CAS），旧操作迟到的释放是空操作。
 *   A4 / A5（`resetOwner` / `rebuildOwner`）清锁，A6 随 owner 删除。Open 对话框或 Open 进行中 → `busy`；保存进行中 Open 也 `busy`。
 * - **R19 源文件身份核对**：Save As 两个阶段都独立执行 `anchorMatchesSource(committed, sourceCapabilityId)`，只做等值比较，
 *   不授予任何权限；`sourceCapabilityId` 不参与任何授权查询。
 * - **save-target 一次性**（F2）：对已鉴权、载荷合法的阶段 2 请求（及普通 Save 分支误用 save-target token），同 owner 的 G
 *   在任何业务判定之前被删除；跨 owner、未知、伪造 token 不删除任何其它 owner 的记录。
 * - **A9**：`settleSave` 在一次纯计算中完成锚点记录刷新、Save As 候选登记与不变量自检，调用方以一次赋值提交；
 *   计算中任何异常都不会留下半完成状态。
 */

import { isActiveOpen, putRecord, removeWhere } from '../document/capabilities';
import type { ActiveOpenRecord, AnchorRef, PendingOpenRecord, SaveTargetRecord, TombstoneRecord } from '../document/capabilities';
import type { SaveTargetGrant, WrittenFacts } from '../document/savePipeline';
import type { SaveErrorCode } from '../../shared/saveContracts';
import { anchorMatchesSource, anchorRecord, sameAnchor } from './anchorChain';
import { coordinatorInvariantViolations } from './coordinatorInvariants';
import { withOwner, withoutSaveTargets } from './openCoordinator';
import type { OpenCoordinatorState, OwnerMeta, SaveOperation } from './openCoordinator';

/** 写入编码（经能力表记录取得：`src/main/open` 只允许从 main/document 与 shared 导入类型）。 */
type JcxEncoding = SaveTargetRecord['encoding'];

/** save-target 的存活时长（DR1 Q6 建议值，Q-B2-13）。 */
export const SAVE_TARGET_TTL_MS = 120_000;

interface Step<R> {
  readonly state: OpenCoordinatorState;
  readonly result: R;
}

type Refusal<C extends SaveErrorCode> = { readonly ok: false; readonly code: C };

// ———————————————————————————————— 保存逻辑锁 ————————————————————————————————

export type AcquireOutcome = { readonly kind: 'acquired'; readonly operation: SaveOperation } | { readonly kind: 'busy' } | { readonly kind: 'unknown-owner' };

/** 获取保存逻辑锁：Open 对话框 / Open 进行中 / 已有保存操作 → `busy`（不分配 id）。 */
export function acquireSaveOperation(state: OpenCoordinatorState, ownerId: number, kind: SaveOperation['kind']): Step<AcquireOutcome> {
  const meta = state.owners.get(ownerId);
  if (meta === undefined) return { state, result: { kind: 'unknown-owner' } };
  if (meta.dialogOpen || meta.inFlightSeq !== null || meta.saveOperation !== null) return { state, result: { kind: 'busy' } };
  const operation: SaveOperation = Object.freeze({ id: state.nextOperationId, generation: meta.generation, kind });
  const next = withOwner({ ...state, nextOperationId: state.nextOperationId + 1 }, ownerId, { ...meta, saveOperation: operation });
  return { state: next, result: { kind: 'acquired', operation } };
}

/** 该操作是否仍持有锁：owner 仍登记、generation 未变、锁的 id 与 generation 都相同。 */
export function holdsSaveOperation(state: OpenCoordinatorState, ownerId: number, operation: SaveOperation): boolean {
  const meta = state.owners.get(ownerId);
  const held = meta?.saveOperation;
  return meta !== undefined && held !== null && held !== undefined && meta.generation === operation.generation && held.id === operation.id && held.generation === operation.generation;
}

/** CAS 释放：只有持有者能清锁；否则原样返回（迟到的旧操作不会释放新操作的锁）。 */
export function releaseSaveOperation(state: OpenCoordinatorState, ownerId: number, operation: SaveOperation): OpenCoordinatorState {
  if (!holdsSaveOperation(state, ownerId, operation)) return state;
  const meta = state.owners.get(ownerId);
  if (meta === undefined) return state;
  return withOwner(state, ownerId, { ...meta, saveOperation: null });
}

/** 删除同 owner 的 save-target token（F2：一次性消费在任何业务判定之前）；不是同 owner 的 save-target 时不动表。 */
export function discardSaveTarget(state: OpenCoordinatorState, ownerId: number, token: string): OpenCoordinatorState {
  return consumeIfSaveTarget(state, ownerId, token).state;
}

function consumeIfSaveTarget(state: OpenCoordinatorState, ownerId: number, token: string): { readonly state: OpenCoordinatorState; readonly target: SaveTargetRecord | null } {
  const record = state.table.get(token);
  if (record === undefined || record.ownerId !== ownerId || record.purpose !== 'save-target') return { state, target: null };
  const table = removeWhere(state.table, (other) => other.token === token && other.ownerId === ownerId).table;
  return { state: { ...state, table }, target: record };
}

/** 失败时释放本次获取的锁。 */
function refuse<C extends SaveErrorCode>(state: OpenCoordinatorState, ownerId: number, operation: SaveOperation, code: C): Step<Refusal<C>> {
  return { state: releaseSaveOperation(state, ownerId, operation), result: { ok: false, code } };
}

// ———————————————————————————————— 普通 Save ————————————————————————————————

export interface SaveTicket {
  readonly capabilityId: string;
  readonly documentId: number;
  readonly encoding: JcxEncoding;
}

export type BeginSaveResult =
  | { readonly ok: true; readonly record: ActiveOpenRecord; readonly operation: SaveOperation }
  | Refusal<'busy' | 'capability-invalid' | 'document-mismatch' | 'encoding-mismatch'>;

/**
 * 普通 Save 的授权（r1 ERRATA §2.4）：save-target token 误用于普通 Save → 先消费再 `capability-invalid`（Q-B2-11 / F2）；
 * 然后 busy → `lookupActive`（墓碑、pending、跨窗口、旧 generation 都不存在）→ documentId → 编码等于 writeEncoding。
 */
export function beginSave(state: OpenCoordinatorState, ownerId: number, ticket: SaveTicket): Step<BeginSaveResult> {
  const consumed = consumeIfSaveTarget(state, ownerId, ticket.capabilityId);
  const acquired = acquireSaveOperation(consumed.state, ownerId, 'save');
  if (acquired.result.kind !== 'acquired') return { state: acquired.state, result: { ok: false, code: acquired.result.kind === 'busy' ? 'busy' : 'capability-invalid' } };
  const operation = acquired.result.operation;
  if (consumed.target !== null) return refuse(acquired.state, ownerId, operation, 'capability-invalid');
  const record = acquired.state.table.get(ticket.capabilityId);
  if (record === undefined || record.ownerId !== ownerId || !isActiveOpen(record)) return refuse(acquired.state, ownerId, operation, 'capability-invalid');
  if (record.documentId !== ticket.documentId) return refuse(acquired.state, ownerId, operation, 'document-mismatch');
  if (record.writeEncoding !== ticket.encoding) return refuse(acquired.state, ownerId, operation, 'encoding-mismatch');
  return { state: acquired.state, result: { ok: true, record, operation } };
}

/** 普通 Save 的 `stillCurrent`（E1 §5.2 C1）：仍持有锁（含 generation 未变）且 token 仍是 active。 */
export function saveStillCurrent(state: OpenCoordinatorState, ownerId: number, operation: SaveOperation, token: string): boolean {
  const record = state.table.get(token);
  return holdsSaveOperation(state, ownerId, operation) && record !== undefined && record.ownerId === ownerId && isActiveOpen(record);
}

// ———————————————————————————————— Save As 阶段 1 ————————————————————————————————

export type BeginSaveTargetResult =
  | { readonly ok: true; readonly operation: SaveOperation; readonly anchor: AnchorRef; readonly anchorFacts: ActiveOpenRecord | TombstoneRecord | null }
  | Refusal<'busy' | 'capability-invalid' | 'source-mismatch'>;

/** 阶段 1 开始（对话框之前）：busy → R19。通过时持有 `save-as-dialog` 锁，并给出锚点与其文件事实（供 sameFile 判定）。 */
export function beginSaveTarget(state: OpenCoordinatorState, ownerId: number, sourceCapabilityId: string | null): Step<BeginSaveTargetResult> {
  const acquired = acquireSaveOperation(state, ownerId, 'save-as-dialog');
  if (acquired.result.kind !== 'acquired') return { state: acquired.state, result: { ok: false, code: acquired.result.kind === 'busy' ? 'busy' : 'capability-invalid' } };
  const operation = acquired.result.operation;
  const meta = ownerOf(acquired.state, ownerId);
  if (!anchorMatchesSource(meta.committed, sourceCapabilityId)) return refuse(acquired.state, ownerId, operation, 'source-mismatch');
  return { state: acquired.state, result: { ok: true, operation, anchor: meta.committed, anchorFacts: anchorRecord(acquired.state.table, ownerId, meta.committed) } };
}

export interface SaveTargetGrantRequest {
  readonly token: string;
  readonly sourceCapabilityId: string | null;
  /** 阶段 1 开始时的锚点：对话框期间锚点变化（reject 回退等）即不登记。 */
  readonly anchorAtBegin: AnchorRef;
  readonly encoding: JcxEncoding;
  readonly target: SaveTargetGrant;
  readonly requestedPath: string;
  readonly displayName: string;
  readonly displayPath: string;
}

/**
 * 对话框返回之后、登记 G 之前重新验证（F2）：仍持有本次操作的锁（owner 仍登记、generation 未变、锁未被新操作取代）
 * → R19 → 锚点未变。全部通过才执行 A7：删除旧 save-target，登记新的（`anchor = committed`，`boundDocumentId = 锚点
 * documentId ?? 0`，`generation = 当前`，`expiresAt = now + TTL`）。不释放锁（由调用方在 finally 中释放）。
 */
export function grantSaveTarget(
  state: OpenCoordinatorState,
  ownerId: number,
  operation: SaveOperation,
  request: SaveTargetGrantRequest,
  now: number,
): Step<{ readonly ok: true; readonly token: string } | Refusal<'capability-invalid' | 'source-mismatch'>> {
  if (!Number.isFinite(now)) throw new RangeError('grantSaveTarget: now must be finite');
  if (!holdsSaveOperation(state, ownerId, operation) || operation.kind !== 'save-as-dialog') return { state, result: { ok: false, code: 'capability-invalid' } };
  const meta = ownerOf(state, ownerId);
  if (!anchorMatchesSource(meta.committed, request.sourceCapabilityId)) return { state, result: { ok: false, code: 'source-mismatch' } };
  if (!sameAnchor(meta.committed, request.anchorAtBegin)) return { state, result: { ok: false, code: 'capability-invalid' } };
  if (state.table.has(request.token)) throw new Error('grantSaveTarget: duplicate token');
  const anchor = anchorRecord(state.table, ownerId, meta.committed);
  const record: SaveTargetRecord = {
    token: request.token,
    ownerId,
    purpose: 'save-target',
    operationId: operation.id,
    generation: meta.generation,
    anchor: meta.committed,
    boundDocumentId: anchor?.documentId ?? 0,
    encoding: request.encoding,
    target: request.target,
    requestedPath: request.requestedPath,
    displayName: request.displayName,
    displayPath: request.displayPath,
    expiresAt: now + SAVE_TARGET_TTL_MS,
  };
  const table = putRecord(withoutSaveTargets(state.table, ownerId), record);
  return { state: { ...state, table }, result: { ok: true, token: request.token } };
}

// ———————————————————————————————— Save As 阶段 2 ————————————————————————————————

export interface SaveAsTicket extends SaveTicket {
  readonly sourceCapabilityId: string | null;
}

export type ConsumeSaveTargetResult =
  | {
      readonly ok: true;
      readonly target: SaveTargetRecord;
      readonly operation: SaveOperation;
      /** 消费时的锚点；`stillCurrent` 要求它保持不变（Q-B2-7）。 */
      readonly anchor: AnchorRef;
      readonly anchorFacts: ActiveOpenRecord | TombstoneRecord | null;
      /** 本次占用的 Open 请求序号（DR1 Q2.6）：候选只能以它登记。 */
      readonly requestSeq: number;
    }
  | Refusal<'busy' | 'capability-invalid' | 'source-mismatch' | 'document-mismatch' | 'encoding-mismatch'>;

/**
 * 阶段 2（A8 + Q-B2-5 + F2）：先删除同 owner 的 G（若 token 正是它）；再依次判定 busy → capability-invalid（不存在 / 墓碑 /
 * 其它用途 / 跨窗口 / 旧 generation / 过期 / `anchor ≠ committed`）→ source-mismatch（R19）→ document-mismatch（与
 * `boundDocumentId` 比较）→ encoding-mismatch。全部通过：持有 `save-as-write` 锁，占用新的 Open 请求序号并丢弃旧 pending 候选。
 */
export function consumeSaveTarget(state: OpenCoordinatorState, ownerId: number, ticket: SaveAsTicket, now: number): Step<ConsumeSaveTargetResult> {
  // F2：先消费，再做任何判定（含时钟异常——异常时钟下 G 同样不可重用，按 capability-invalid 拒绝）。
  const consumed = consumeIfSaveTarget(state, ownerId, ticket.capabilityId);
  if (!Number.isFinite(now)) return { state: consumed.state, result: { ok: false, code: 'capability-invalid' } };
  const acquired = acquireSaveOperation(consumed.state, ownerId, 'save-as-write');
  if (acquired.result.kind !== 'acquired') return { state: acquired.state, result: { ok: false, code: acquired.result.kind === 'busy' ? 'busy' : 'capability-invalid' } };
  const operation = acquired.result.operation;
  const meta = ownerOf(acquired.state, ownerId);
  const target = consumed.target;
  if (target === null || target.generation !== meta.generation || now >= target.expiresAt || !sameAnchor(target.anchor, meta.committed)) {
    return refuse(acquired.state, ownerId, operation, 'capability-invalid');
  }
  if (!anchorMatchesSource(meta.committed, ticket.sourceCapabilityId)) return refuse(acquired.state, ownerId, operation, 'source-mismatch');
  if (ticket.documentId !== target.boundDocumentId) return refuse(acquired.state, ownerId, operation, 'document-mismatch');
  if (ticket.encoding !== target.encoding) return refuse(acquired.state, ownerId, operation, 'encoding-mismatch');

  const requestSeq = meta.latestRequestSeq + 1;
  const table = removeWhere(acquired.state.table, (record) => record.ownerId === ownerId && record.purpose === 'open' && record.state === 'pending').table;
  const next = withOwner(acquired.state, ownerId, { ...meta, latestRequestSeq: requestSeq, candidates: new Map() }, table);
  return {
    state: next,
    result: { ok: true, target, operation, anchor: meta.committed, anchorFacts: anchorRecord(next.table, ownerId, meta.committed), requestSeq },
  };
}

/** Save As 的 `stillCurrent`（Q-B2-7 + 勘误 §2.3）：仍持有锁（含 generation 未变）且锚点仍等于消费时的值。 */
export function saveAsStillCurrent(state: OpenCoordinatorState, ownerId: number, operation: SaveOperation, anchor: AnchorRef): boolean {
  const meta = state.owners.get(ownerId);
  return holdsSaveOperation(state, ownerId, operation) && meta !== undefined && sameAnchor(meta.committed, anchor);
}

// ———————————————————————————————— A9 ————————————————————————————————

export interface SettleSaveInput {
  readonly operation: SaveOperation;
  readonly written: WrittenFacts;
  /** 写入的是锚点文件时，按 token 刷新的那条记录（active 或墓碑）；否则 null。 */
  readonly refreshToken: string | null;
  /** Save As 且 `saved`、仍持有锁时登记的新 pending 候选；其它情形为 null。 */
  readonly candidate: {
    readonly token: string;
    readonly documentId: number;
    readonly requestSeq: number;
    readonly displayName: string;
    readonly displayPath: string;
  } | null;
  readonly now: number;
}

/**
 * A9（r1 ERRATA §2.3；勘误 §3.3）：纯计算，返回新状态，**不**修改入参；调用方以一次赋值提交。
 * - 刷新：按 token 找到的锚点记录（active 或墓碑）更新 realpath、identity 与指纹；找不到（已被 A5 / A6 清除）则跳过；
 * - 候选（只在 `saved` 且仍持有锁时由调用方传入）：登记 pending open 候选（`documentId = boundDocumentId`，事实取自
 *   WrittenFacts），requestSeq 必须仍是消费时占用的序号；
 * - 最后做不变量自检；任何一步失败都抛出（调用方据此保持原状态）。
 */
export function settleSave(state: OpenCoordinatorState, ownerId: number, input: SettleSaveInput): OpenCoordinatorState {
  if (!Number.isFinite(input.now)) throw new RangeError('settleSave: now must be finite');
  let table = state.table;
  if (input.refreshToken !== null) {
    const record = table.get(input.refreshToken);
    if (record !== undefined && record.ownerId === ownerId && (isActiveOpen(record) || record.purpose === 'tombstone')) {
      table = putRecord(table, {
        ...record,
        realpath: input.written.realpath,
        identity: input.written.identity,
        lastKnownDiskFingerprint: input.written.lastKnownDiskFingerprint,
      });
    }
  }
  let next: OpenCoordinatorState = table === state.table ? state : { ...state, table };
  const candidate = input.candidate;
  if (candidate !== null) {
    const meta: OwnerMeta = ownerOf(next, ownerId);
    if (!holdsSaveOperation(next, ownerId, input.operation)) throw new Error('settleSave: save operation no longer held');
    if (meta.latestRequestSeq !== candidate.requestSeq || meta.inFlightSeq !== null) throw new Error('settleSave: request sequence is no longer current');
    if (next.table.has(candidate.token)) throw new Error('settleSave: duplicate token');
    const pending: PendingOpenRecord = {
      token: candidate.token,
      ownerId,
      documentId: candidate.documentId,
      purpose: 'open',
      state: 'pending',
      realpath: input.written.realpath,
      displayName: candidate.displayName,
      displayPath: candidate.displayPath,
      writeEncoding: input.written.writeEncoding,
      byteBom: input.written.byteBom,
      encodingRoundTrip: input.written.encodingRoundTrip,
      lastKnownDiskFingerprint: input.written.lastKnownDiskFingerprint,
      identity: input.written.identity,
    };
    const candidates = new Map([[candidate.token, { requestSeq: candidate.requestSeq, generation: meta.generation, expiresAt: input.now + next.ttlMs }]]);
    next = withOwner(next, ownerId, { ...meta, candidates }, putRecord(next.table, pending));
  }
  const violations = coordinatorInvariantViolations(next);
  if (violations.length > 0) throw new Error(`settleSave: invariant violated (${violations.join('; ')})`);
  return next;
}

function ownerOf(state: OpenCoordinatorState, ownerId: number): OwnerMeta {
  const meta = state.owners.get(ownerId);
  if (meta === undefined) throw new Error('save coordinator: owner is not registered');
  return meta;
}
