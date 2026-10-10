/**
 * Open 激活协调器：纯状态机（`docs/M3_EDITOR_CORE_PLAN.md` §13.1、§20，M3 T1b-1，用户裁决 4 / 5）。
 *
 * - **单一事实来源**：能力的 pending / active 状态只存在 T1a 的 `CapabilityTable` 中；本模块额外只保存每个
 *   owner（窗口）的协调元数据——`generation`、`latestRequestSeq`、`dialogOpen`，以及 pending 候选的
 *   `requestSeq` / `generation` / `expiresAt`。两者的一致性由 `coordinatorInvariantViolations` 钉死。
 * - 所有迁移同步、确定性、不可变：返回新状态，不修改入参；不读时钟、不建定时器——`now` 由调用方注入的单调时钟给出。
 * - **严格最新**：`beginOpen` 接受新请求时 `requestSeq + 1`，并立即作废同窗口所有 pending 候选；`busy` 拒绝不占代次。
 *   只有 `requestSeq === latestRequestSeq` 且 generation 未变的候选能完成登记与激活，因此任何过期请求都不能
 *   恢复旧 active，也不能吊销较新的 active。
 * - **TTL**：从 pending 登记成功时计时（不含对话框与读取时间）；`now >= expiresAt` 即过期；任何调用都不会续期。
 * - 激活成功只表示 main 已把能力设为 active，不表示 renderer 已提交切换（见 `src/shared/activationContracts.ts`）。
 * - **一张票只能完成一次**：`beginOpen` 记下 `inFlightSeq`，`completeOpen` 消费它；同一张票的重复完成一律 `superseded`。
 * - 本模块不 import electron；sender 校验在 `ipcValidation.ts`，Electron 接线属 T1b-2。
 *
 * **T1b-2 接线约束**（不可变状态 + 异步 handler）：
 * - 每次迁移都必须基于**当前最新**状态；不得在 `await` 之后复用 `await` 之前取得的状态对象。
 * - 对话框与 T1a 管线的任何异常路径（包括 `completeOpen` 因编程错误抛出）都必须在 `finally` 中对最新状态调用
 *   `endDialog(ticket)`，否则该窗口的 `dialogOpen` 会一直为 true（之后的请求都是 `busy`，只有 `disposeOwner` 能解除）。
 * - `resetOwner` 只挂在主 frame 的跨文档 `did-start-navigation`（`isMainFrame && !isSameDocument`）与
 *   `render-process-gone` 上，不挂页内导航；`disposeOwner` 挂在 `closed` / `destroyed` 上（二者都可能触发，均幂等）。
 * - `beginOpen` 的 `unknown-owner` 如何映射为 IPC 回复由 T1b-2 preflight 决定（窗口未登记即非法 sender）。
 */

import { activate, addPending, discardPending, lookupActive, revoke, revokeOwner } from '../document/capabilities';
import type { CapabilityTable, OpenCapabilityRecord } from '../document/capabilities';
import type { OpenAtPathResult } from '../document/openDocument';
import type { ActivateDocumentReply, DocumentActivationTicket, OpenDocumentReply, RejectDocumentReply } from '../../shared/activationContracts';

/** pending 候选的存活时长（用户裁决 4）。 */
export const PENDING_TTL_MS = 120_000;

export interface CandidateMeta {
  readonly requestSeq: number;
  readonly generation: number;
  readonly expiresAt: number;
}

export interface OwnerMeta {
  /** 页面代次：reload / 渲染进程退出时 + 1。 */
  readonly generation: number;
  /** 最近一次被接受的 Open 请求序号（从 1 开始；0 表示尚无请求）。 */
  readonly latestRequestSeq: number;
  /** 该窗口是否正在显示打开对话框（期间新请求一律 `busy`）。 */
  readonly dialogOpen: boolean;
  /** 已被接受、尚未完成的请求序号；`completeOpen` 消费后为 null（防止同一张票被完成两次）。 */
  readonly inFlightSeq: number | null;
  /** pending 候选的协调元数据，key 为 token；能力事实本身在 `CapabilityTable` 中。 */
  readonly candidates: ReadonlyMap<string, CandidateMeta>;
}

export interface OpenCoordinatorState {
  readonly table: CapabilityTable;
  readonly owners: ReadonlyMap<number, OwnerMeta>;
  readonly ttlMs: number;
}

/** 一次被接受的 Open 请求的身份；`completeOpen` / `endDialog` 凭它判断请求是否仍然是最新的。 */
export interface OpenTicket {
  readonly ownerId: number;
  readonly requestSeq: number;
  readonly generation: number;
}

export type BeginOpenOutcome =
  | { readonly kind: 'accepted'; readonly ticket: OpenTicket; readonly discarded: readonly string[] }
  | { readonly kind: 'busy' }
  | { readonly kind: 'unknown-owner' };

export type OpenCompletion = OpenAtPathResult | { readonly kind: 'canceled' };

interface Step<R> {
  readonly state: OpenCoordinatorState;
  readonly result: R;
}

export function createOpenCoordinator(ttlMs: number = PENDING_TTL_MS): OpenCoordinatorState {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new RangeError('createOpenCoordinator: ttlMs must be a positive safe integer');
  return { table: new Map(), owners: new Map(), ttlMs };
}

function assertNow(now: number): void {
  if (!Number.isFinite(now)) throw new RangeError('open coordinator: now must be a finite monotonic timestamp');
}

function withOwner(state: OpenCoordinatorState, ownerId: number, meta: OwnerMeta, table: CapabilityTable = state.table): OpenCoordinatorState {
  const owners = new Map(state.owners);
  owners.set(ownerId, meta);
  return { ...state, table, owners };
}

function withoutCandidate(meta: OwnerMeta, token: string): OwnerMeta {
  const candidates = new Map(meta.candidates);
  candidates.delete(token);
  return { ...meta, candidates };
}

/** 丢弃一个 pending 候选：能力表与元数据同步移除。 */
function dropCandidate(state: OpenCoordinatorState, ownerId: number, meta: OwnerMeta, token: string): OpenCoordinatorState {
  const { table } = discardPending(state.table, ownerId, token);
  return withOwner(state, ownerId, withoutCandidate(meta, token), table);
}

/** 窗口创建时登记 owner；已登记则不变。 */
export function registerOwner(state: OpenCoordinatorState, ownerId: number): OpenCoordinatorState {
  if (state.owners.has(ownerId)) return state;
  return withOwner(state, ownerId, { generation: 1, latestRequestSeq: 0, dialogOpen: false, inFlightSeq: null, candidates: new Map() });
}

/** 接受一次新的 Open 请求：占用新代次、标记对话框打开，并作废该窗口所有 pending 候选。 */
export function beginOpen(state: OpenCoordinatorState, ownerId: number): Step<BeginOpenOutcome> {
  const meta = state.owners.get(ownerId);
  if (meta === undefined) return { state, result: { kind: 'unknown-owner' } };
  if (meta.dialogOpen) return { state, result: { kind: 'busy' } };
  const discarded = [...meta.candidates.keys()];
  let table = state.table;
  for (const token of discarded) table = discardPending(table, ownerId, token).table;
  const requestSeq = meta.latestRequestSeq + 1;
  const next: OwnerMeta = { ...meta, latestRequestSeq: requestSeq, dialogOpen: true, inFlightSeq: requestSeq, candidates: new Map() };
  return {
    state: withOwner(state, ownerId, next, table),
    result: { kind: 'accepted', ticket: { ownerId, requestSeq, generation: meta.generation }, discarded },
  };
}

/** 对话框关闭（选中、取消或出错）：只有这次请求仍是该窗口最新请求时才清除 `dialogOpen`。 */
export function endDialog(state: OpenCoordinatorState, ticket: OpenTicket): OpenCoordinatorState {
  const meta = state.owners.get(ticket.ownerId);
  if (meta === undefined || !meta.dialogOpen || meta.latestRequestSeq !== ticket.requestSeq) return state;
  return withOwner(state, ticket.ownerId, { ...meta, dialogOpen: false });
}

/**
 * 请求完成：T1a 管线的结果或对话框取消。
 *
 * - owner 已销毁 → `reply: null`（没有可回复的页面），状态不变；
 * - 票据已被完成过、请求已被取代（更新的请求或页面重载）→ `rejected: superseded`，**不登记**任何能力；
 * - 取消 / 失败 → 原样回复，不改变能力表（旧 active 保持）；
 * - 成功 → 登记 pending 候选，`expiresAt = now + ttl`，回复 `opened`。
 */
export function completeOpen(state: OpenCoordinatorState, ticket: OpenTicket, completion: OpenCompletion, now: number): Step<OpenDocumentReply | null> {
  assertNow(now);
  const dialogClosed = endDialog(state, ticket);
  const before = dialogClosed.owners.get(ticket.ownerId);
  if (before === undefined) return { state, result: null };
  // 先消费票据（无论结果如何），再判断是否仍是当前请求：重复完成时 inFlightSeq 已为 null。
  const inFlight = before.inFlightSeq === ticket.requestSeq;
  const meta: OwnerMeta = inFlight ? { ...before, inFlightSeq: null } : before;
  const settled = withOwner(dialogClosed, ticket.ownerId, meta);
  if (!inFlight || meta.generation !== ticket.generation || meta.latestRequestSeq !== ticket.requestSeq) {
    return { state: settled, result: { kind: 'rejected', reason: 'superseded' } };
  }
  if (completion.kind !== 'opened') return { state: settled, result: completion };

  const record: OpenCapabilityRecord = completion.capability;
  if (record.ownerId !== ticket.ownerId || record.state !== 'pending') {
    throw new Error('completeOpen: capability record does not belong to this pending request');
  }
  const added = addPending(settled.table, record);
  if (!added.ok) throw new Error(`completeOpen: cannot register capability (${added.reason})`);
  const candidates = new Map(meta.candidates);
  candidates.set(record.token, { requestSeq: ticket.requestSeq, generation: ticket.generation, expiresAt: now + settled.ttlMs });
  return {
    state: withOwner(settled, ticket.ownerId, { ...meta, candidates }, added.table),
    result: { kind: 'opened', document: completion.document },
  };
}

const INVALID: ActivateDocumentReply = { ok: false, code: 'capability-invalid' };

/**
 * renderer 确认接受候选：校验通过则 pending → active，并吊销同窗口被取代的旧 active。
 *
 * 判定顺序：未知 owner / 未知 token / 跨窗口 → `capability-invalid`；documentId 不符 → `document-mismatch`（不改状态）；
 * 已是 active → 幂等 `{ ok: true }`（不确定结果的重试据此得到确定答案）；候选已过期、generation 已变或不再是最新请求
 * → 丢弃候选并 `capability-invalid`。只有最后一步成功才吊销旧 active。
 */
export function activateDocument(
  state: OpenCoordinatorState,
  ownerId: number,
  ticket: DocumentActivationTicket,
  now: number,
): Step<{ readonly reply: ActivateDocumentReply; readonly revoked: readonly string[] }> {
  assertNow(now);
  const meta = state.owners.get(ownerId);
  const record = state.table.get(ticket.capabilityId);
  if (meta === undefined || record === undefined || record.ownerId !== ownerId) return { state, result: { reply: INVALID, revoked: [] } };
  if (record.documentId !== ticket.documentId) return { state, result: { reply: { ok: false, code: 'document-mismatch' }, revoked: [] } };
  if (record.state === 'active') return { state, result: { reply: { ok: true }, revoked: [] } };

  const candidate = meta.candidates.get(record.token);
  const live =
    candidate !== undefined &&
    candidate.generation === meta.generation &&
    candidate.requestSeq === meta.latestRequestSeq &&
    now < candidate.expiresAt;
  if (!live) return { state: dropCandidate(state, ownerId, meta, record.token), result: { reply: INVALID, revoked: [] } };

  const activated = activate(state.table, ownerId, record.token);
  if (!activated.ok) throw new Error(`activateDocument: pending capability could not be activated (${activated.reason})`);
  const { table, removed } = revoke(activated.table, ownerId, activated.superseded);
  return {
    state: withOwner(state, ownerId, withoutCandidate(meta, record.token), table),
    result: { reply: { ok: true }, revoked: removed },
  };
}

/**
 * renderer 放弃候选（准备失败，或已激活后放弃新会话）：pending → 丢弃；active → 吊销（不恢复任何被取代的旧能力）。
 * 未知 / 跨窗口 / documentId 不符 → 不改状态。恒回复 `{ ok: true }`。
 */
export function rejectDocument(
  state: OpenCoordinatorState,
  ownerId: number,
  ticket: DocumentActivationTicket,
): Step<{ readonly reply: RejectDocumentReply; readonly removed: readonly string[] }> {
  const reply: RejectDocumentReply = { ok: true };
  const meta = state.owners.get(ownerId);
  const record = state.table.get(ticket.capabilityId);
  if (meta === undefined || record === undefined || record.ownerId !== ownerId || record.documentId !== ticket.documentId) {
    return { state, result: { reply, removed: [] } };
  }
  if (record.state === 'pending') return { state: dropCandidate(state, ownerId, meta, record.token), result: { reply, removed: [record.token] } };
  const { table, removed } = revoke(state.table, ownerId, [record.token]);
  return { state: { ...state, table }, result: { reply, removed } };
}

/** 丢弃所有已过期（`now >= expiresAt`）的 pending 候选。 */
export function expireCandidates(state: OpenCoordinatorState, now: number): Step<readonly string[]> {
  assertNow(now);
  let next = state;
  const expired: string[] = [];
  for (const [ownerId, meta] of state.owners) {
    let current = meta;
    for (const [token, candidate] of meta.candidates) {
      if (now < candidate.expiresAt) continue;
      next = dropCandidate(next, ownerId, current, token);
      current = withoutCandidate(current, token);
      expired.push(token);
    }
  }
  return { state: next, result: expired };
}

/** 页面重载 / 渲染进程退出：generation + 1，清空该窗口全部能力（pending 与 active）与候选。`dialogOpen` 保持，避免并发对话框。 */
export function resetOwner(state: OpenCoordinatorState, ownerId: number): Step<readonly string[]> {
  const meta = state.owners.get(ownerId);
  if (meta === undefined) return { state, result: [] };
  const { table, removed } = revokeOwner(state.table, ownerId);
  return { state: withOwner(state, ownerId, { ...meta, generation: meta.generation + 1, candidates: new Map() }, table), result: removed };
}

/** 窗口销毁：清空该窗口全部能力并移除 owner 元数据（幂等）。 */
export function disposeOwner(state: OpenCoordinatorState, ownerId: number): Step<readonly string[]> {
  const { table, removed } = revokeOwner(state.table, ownerId);
  const owners = new Map(state.owners);
  owners.delete(ownerId);
  return { state: { ...state, table, owners }, result: removed };
}

/** 授权查询（供 T4 的 Save 使用）：只认同窗口的 active 能力；pending、跨窗口、未知一律 null。 */
export function authorizeCapability(state: OpenCoordinatorState, ownerId: number, token: string): OpenCapabilityRecord | null {
  return lookupActive(state.table, ownerId, token);
}
