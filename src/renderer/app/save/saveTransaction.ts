/**
 * Save / Save As 单次事务的纯状态机（M3 T4 B3a-2；B3 r0 §3.2–§3.6，r0.1 勘误 §1–§3；r1.1 §1.3 D1–D4 / F1–F4，H-5）。
 *
 * 与 `openTransaction.ts` 同一风格：`stepSaveFlow(state, event)` 只返回新状态与效果，副作用全部由保存控制器执行。
 *
 * 阶段（准入租约由控制器在 `save-requested` 之前同步获取，回到 idle 后释放）：
 * 1. `settling-ime`：R5 有界等待组字结束（先订阅再 blur，500 ms，超时拒绝且不 discard）。之后控制器 `flush('blur')` 并重读 store：
 *    普通 Save 在未命名文档上转为 Save As（Q-B3-3）；clean 的普通 Save 短路（R7，不过送达门、不发 IPC）。
 * 2. `gating`：R20 送达门——控制器 flush 账本后**同步**最终核对（租约、账本为空、文档号、源能力），普通 Save 另做预检。
 * 3. Save As：`choosing`（阶段 1 对话框）→ `settling-ime-after-dialog`（第二次 R5，Q-B3-4）→ `gating-after-dialog`
 *    （第二道送达门：阶段 2 发出之前**重新**核对租约、会话身份、源能力与未确认 reject，不复用阶段 1 之前的结果）。
 * 4. `writing`：控制器捕获 source、`beginFileOperation`、发出 `saveDocument`。
 * 5. `activating`（只有 Save As）：同一张票、每次 5 s、最多 3 次；事务仍在进行时，任何一次尝试（含已超时尝试的迟到应答）
 *    给出明确结果都终结事务；终结之后的迟到事件一律忽略（r0 §3.6，与 `openTransaction.ts:15-17` 同一规则）。
 *
 * Save As 激活与会话迁移（r1.1 §1.3；D = demo 源、F = 已打开文件源，区别只在 H-5 的授权降级）：
 * - D1 / F1：ok → `settle-save-as`（同次写文件事实、检查点与 trusted）；控制器 CAS 失败时回送 `settle-failed` → D2 / F2；
 * - D2 / F2：ok 但 CAS 失败 → 经账本 reject，不写会话；
 * - D3 / F3：明确失败 → 结束操作，授权按 `trustAfterSaveAsFailure`；
 * - D4 / F4：不确定（三次都无明确应答，或控制器异常）→ 经账本 reject，其余同 D3 / F3。
 *
 * `aborted`：控制器在某个 await 恢复后发现租约已不由本次持有、或文档身份已变（勘误 §1.3），或回调中出现异常时回送。
 * 尚未捕获时只释放；已 begin 时以 op 引用结束操作；已越过提交点时只给出诊断、不提交会话（候选经账本 reject）。
 */

import type { ActivateDocumentReply, DocumentActivationTicket } from '../../../shared/activationContracts';
import type { FileReference } from '../../../shared/documentContracts';
import type { JcxEncoding } from '../../../formats/jcxParse';
import type { RequestSaveTargetReply, SaveDocumentReply, SaveErrorCode } from '../../../shared/saveContracts';
import type { CapabilityTrust } from '../editor/openTransaction';
import type { SaveMessage } from './saveMessages';

/** Save As 单次激活的应答期限（与 T1c 的 `ACTIVATION_TIMEOUT_MS` 同值，Q-B3-6）。 */
export const SAVE_ACTIVATION_TIMEOUT_MS = 5_000;
/** Save As 激活的最大尝试次数，含首次（与 T1c 的 `MAX_ACTIVATION_ATTEMPTS` 同值）。 */
export const MAX_SAVE_ACTIVATION_ATTEMPTS = 3;
/** R5：组字结束的有界等待。 */
export const IME_SETTLE_TIMEOUT_MS = 500;

export type SaveKind = 'save' | 'saveAs';

export type SavePhase =
  | 'idle'
  | 'settling-ime'
  | 'gating'
  | 'choosing'
  | 'settling-ime-after-dialog'
  | 'gating-after-dialog'
  | 'writing'
  | 'activating';

/** 阶段 1 授予的一次性 save-target。 */
export interface SaveTarget {
  readonly capabilityId: string;
  readonly displayName: string;
}

/** 阶段 2 `saved` 应答中、激活成功后要写入会话的事实。 */
export interface SaveAsActivation {
  readonly ticket: DocumentActivationTicket;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: 'utf8' | 'none';
  readonly encodingRoundTrip: 'exact' | 'unsafe';
  readonly displayName: string;
  readonly displayPath: string;
}

export interface SaveFlowState {
  readonly txn: number;
  readonly phase: SavePhase;
  readonly kind: SaveKind;
  readonly target: SaveTarget | null;
  readonly activation: SaveAsActivation | null;
  readonly attempt: number;
}

/** R5 等待之后、`flush('blur')` 重读 store 得到的事实。 */
export interface SaveEntryFacts {
  readonly hasFile: boolean;
  readonly dirty: boolean;
}

/** 预检发现的第一个不可编码字符（行从 1、列从 0 起）。 */
export interface UnencodableAt {
  readonly line: number;
  readonly column: number;
  readonly encoding: JcxEncoding;
}

export type SaveFlowEvent =
  /** `saveEnabled`：本平台是否开放普通 Save（R10：Windows / Linux 上普通 Save 为无操作，Save As 不受影响）。 */
  | { readonly type: 'save-requested'; readonly kind: SaveKind; readonly saveEnabled: boolean }
  | { readonly type: 'ime-settled'; readonly txn: number; readonly outcome: 'ready' | 'timeout'; readonly facts: SaveEntryFacts }
  /** 送达门：`delivered` 为 flush 送达且同步最终核对通过；`unencodable` 为预检结果（只在写入之前的送达门给出）。 */
  | { readonly type: 'gate-checked'; readonly txn: number; readonly delivered: boolean; readonly unencodable: UnencodableAt | null }
  /** `reply` 为 null：invoke 抛错或应答畸形。 */
  | { readonly type: 'target-replied'; readonly txn: number; readonly reply: RequestSaveTargetReply | null }
  | { readonly type: 'save-replied'; readonly txn: number; readonly reply: SaveDocumentReply | null }
  | { readonly type: 'activate-replied'; readonly txn: number; readonly attempt: number; readonly reply: ActivateDocumentReply }
  | { readonly type: 'activate-failed'; readonly txn: number; readonly attempt: number }
  /** D1 的会话写入被 store CAS 拒绝（D2 / F2）。 */
  | { readonly type: 'settle-failed'; readonly txn: number; readonly ticket: DocumentActivationTicket; readonly displayName: string }
  /** await 恢复后租约或文档身份核对失败，或回调异常；`committed` 为写入应答是否已越过提交点（未知为 null）。 */
  | { readonly type: 'aborted'; readonly txn: number; readonly committed: boolean | null; readonly ticket: DocumentActivationTicket | null };

/** 结束文件操作的原因：`save-as-activation` 时授权按 H-5 降级，`plain` 不改授权。 */
export type FinishReason = 'plain' | 'save-as-activation';

export type SaveFlowEffect =
  | { readonly type: 'settle-ime'; readonly txn: number }
  | { readonly type: 'check-gate'; readonly txn: number; readonly beforeWrite: boolean }
  | { readonly type: 'request-target'; readonly txn: number }
  | { readonly type: 'write'; readonly txn: number; readonly kind: SaveKind; readonly target: SaveTarget | null }
  | { readonly type: 'activate'; readonly txn: number; readonly attempt: number; readonly ticket: DocumentActivationTicket }
  /** 普通 Save 越过提交点：检查点前移到捕获值；`downgrade` 为 committed-unconfirmed。 */
  | { readonly type: 'settle-save'; readonly downgrade: boolean }
  | { readonly type: 'settle-save-as'; readonly txn: number; readonly activation: SaveAsActivation }
  | { readonly type: 'finish'; readonly reason: FinishReason }
  | { readonly type: 'send-reject'; readonly ticket: DocumentActivationTicket }
  /** Q-B3-2：source-mismatch 之后在后台 flush 账本，由用户手动重试。 */
  | { readonly type: 'flush-ledger' }
  | { readonly type: 'report'; readonly message: SaveMessage };

export interface SaveFlowStep {
  readonly state: SaveFlowState;
  readonly effects: readonly SaveFlowEffect[];
}

export function initialSaveFlow(): SaveFlowState {
  return { txn: 0, phase: 'idle', kind: 'save', target: null, activation: null, attempt: 0 };
}

/**
 * H-5：Save As 激活失败（D3 / D4、F3 / F4）之后的授权。main 可能已经吊销旧能力，因此已打开的文件降为 `unverified`；
 * demo（没有文件）保持 `none`；已降级的保持不变。
 */
export function trustAfterSaveAsFailure(file: FileReference | null, trust: CapabilityTrust): CapabilityTrust {
  if (file === null) return trust;
  return trust === 'trusted' ? 'unverified' : trust;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;
const isTicket = (value: unknown): value is DocumentActivationTicket =>
  isRecord(value) && typeof value.capabilityId === 'string' && typeof value.documentId === 'number';

/** 阶段 1 应答的结构校验；畸形为 null（按 invoke 失败处理）。 */
export function targetReply(value: unknown): RequestSaveTargetReply | null {
  if (!isRecord(value)) return null;
  if (value.kind === 'canceled') return { kind: 'canceled' };
  if (value.kind === 'refused' && isRecord(value.error) && typeof value.error.code === 'string') return value as RequestSaveTargetReply;
  if (value.kind === 'granted' && typeof value.capabilityId === 'string' && typeof value.displayName === 'string') return value as RequestSaveTargetReply;
  return null;
}

/** `save-document` 应答的结构校验；畸形为 null（结果未知）。 */
export function saveReply(value: unknown): SaveDocumentReply | null {
  if (!isRecord(value)) return null;
  if (value.outcome === 'not-committed') return isRecord(value.error) && typeof value.error.code === 'string' ? (value as SaveDocumentReply) : null;
  if (value.outcome !== 'saved' && value.outcome !== 'committed-unconfirmed') return null;
  if (typeof value.displayName !== 'string' || typeof value.displayPath !== 'string' || typeof value.writeEncoding !== 'string') return null;
  return value.ticket === null || isTicket(value.ticket) ? (value as SaveDocumentReply) : null;
}

export const isActivateReply = (value: unknown): value is ActivateDocumentReply =>
  isRecord(value) && (value.ok === true || (value.ok === false && typeof value.code === 'string'));

/** 越过提交点了吗（null：结果未知）。 */
export const committedOf = (reply: SaveDocumentReply | null): boolean | null => (reply === null ? null : reply.outcome !== 'not-committed');

const unchanged = (state: SaveFlowState): SaveFlowStep => ({ state, effects: [] });

const report = (message: SaveMessage): SaveFlowEffect => ({ type: 'report', message });

/** 事务终结：回到 idle（控制器随后释放租约）。 */
function done(state: SaveFlowState, effects: readonly SaveFlowEffect[]): SaveFlowStep {
  return { state: { ...state, phase: 'idle', target: null, activation: null, attempt: 0 }, effects };
}

const failedWith = (code: SaveErrorCode): readonly SaveFlowEffect[] => [report({ kind: 'failed', code }), ...(code === 'source-mismatch' ? [{ type: 'flush-ledger' } as const] : [])];

const PRE_WRITE: ReadonlySet<SavePhase> = new Set(['settling-ime', 'gating', 'choosing', 'settling-ime-after-dialog', 'gating-after-dialog']);

function onImeSettled(state: SaveFlowState, outcome: 'ready' | 'timeout', facts: SaveEntryFacts): SaveFlowStep {
  if (outcome === 'timeout') return done(state, [report({ kind: 'ime-timeout' })]);
  if (state.phase === 'settling-ime-after-dialog') {
    return { state: { ...state, phase: 'gating-after-dialog' }, effects: [{ type: 'check-gate', txn: state.txn, beforeWrite: true }] };
  }
  const kind: SaveKind = state.kind === 'save' && !facts.hasFile ? 'saveAs' : state.kind;
  if (kind === 'save' && !facts.dirty) return done(state, [report({ kind: 'nothing-to-save' })]);
  return { state: { ...state, kind, phase: 'gating' }, effects: [{ type: 'check-gate', txn: state.txn, beforeWrite: kind === 'save' }] };
}

function onGateChecked(state: SaveFlowState, delivered: boolean, unencodable: UnencodableAt | null): SaveFlowStep {
  if (!delivered) return done(state, [report({ kind: 'reject-pending' })]);
  if (state.phase === 'gating' && state.kind === 'saveAs') {
    return { state: { ...state, phase: 'choosing' }, effects: [{ type: 'request-target', txn: state.txn }] };
  }
  if (unencodable !== null) return done(state, [report({ kind: 'unencodable', ...unencodable })]);
  return { state: { ...state, phase: 'writing' }, effects: [{ type: 'write', txn: state.txn, kind: state.kind, target: state.target }] };
}

function onTargetReplied(state: SaveFlowState, reply: RequestSaveTargetReply | null): SaveFlowStep {
  if (reply === null) return done(state, [report({ kind: 'dialog-failed' })]);
  switch (reply.kind) {
    case 'canceled':
      return done(state, []);
    case 'refused':
      return done(state, failedWith(reply.error.code));
    case 'granted':
      return {
        state: { ...state, phase: 'settling-ime-after-dialog', target: { capabilityId: reply.capabilityId, displayName: reply.displayName } },
        effects: [{ type: 'settle-ime', txn: state.txn }],
      };
  }
}

function onSaveReplied(state: SaveFlowState, reply: SaveDocumentReply | null): SaveFlowStep {
  if (reply === null) return done(state, [{ type: 'finish', reason: 'plain' }, report({ kind: 'result-unknown' })]);
  if (reply.outcome === 'not-committed') return done(state, [{ type: 'finish', reason: 'plain' }, ...failedWith(reply.error.code)]);
  const { displayName } = reply;
  if (state.kind === 'save') {
    return reply.outcome === 'saved'
      ? done(state, [report({ kind: 'saved', displayName }), { type: 'settle-save', downgrade: false }])
      : done(state, [report({ kind: 'save-unconfirmed', displayName }), { type: 'settle-save', downgrade: true }]);
  }
  if (reply.outcome !== 'saved' || reply.ticket === null) {
    return done(state, [{ type: 'finish', reason: 'plain' }, report({ kind: 'save-as-unconfirmed', displayName })]);
  }
  const activation: SaveAsActivation = {
    ticket: reply.ticket,
    writeEncoding: reply.writeEncoding,
    byteBom: reply.byteBom,
    encodingRoundTrip: reply.encodingRoundTrip,
    displayName,
    displayPath: reply.displayPath,
  };
  return { state: { ...state, phase: 'activating', attempt: 1, activation }, effects: [{ type: 'activate', txn: state.txn, attempt: 1, ticket: reply.ticket }] };
}

/** D4 / F4（以及激活期间的异常收束）：经账本 reject，结束操作并按 H-5 处理授权。 */
function unresolved(state: SaveFlowState, activation: SaveAsActivation): SaveFlowStep {
  return done(state, [
    { type: 'send-reject', ticket: activation.ticket },
    { type: 'finish', reason: 'save-as-activation' },
    report({ kind: 'save-as-not-switched', displayName: activation.displayName }),
  ]);
}

function onAborted(state: SaveFlowState, committed: boolean | null, ticket: DocumentActivationTicket | null): SaveFlowStep {
  if (PRE_WRITE.has(state.phase)) return done(state, [report({ kind: 'changed' })]);
  if (state.phase === 'activating' && state.activation !== null) return unresolved(state, state.activation);
  if (state.phase !== 'writing') return unchanged(state);
  const message: SaveMessage = committed === null ? { kind: 'result-unknown' } : committed ? { kind: 'result-not-applied' } : { kind: 'changed' };
  return done(state, [{ type: 'finish', reason: 'plain' }, ...(ticket === null ? [] : [{ type: 'send-reject', ticket } as const]), report(message)]);
}

const live = (state: SaveFlowState, txn: number): boolean => txn === state.txn && state.phase !== 'idle';

export function stepSaveFlow(state: SaveFlowState, event: SaveFlowEvent): SaveFlowStep {
  switch (event.type) {
    case 'save-requested': {
      if (state.phase !== 'idle') return unchanged(state);
      const txn = state.txn + 1;
      const next: SaveFlowState = { txn, phase: 'settling-ime', kind: event.kind, target: null, activation: null, attempt: 0 };
      // R10：本平台未开放普通 Save → 无操作（不等待、不提示、不发 IPC）；Save As 不受影响。
      if (event.kind === 'save' && !event.saveEnabled) return done(next, []);
      return { state: next, effects: [{ type: 'settle-ime', txn }] };
    }
    case 'ime-settled':
      if (!live(state, event.txn) || (state.phase !== 'settling-ime' && state.phase !== 'settling-ime-after-dialog')) return unchanged(state);
      return onImeSettled(state, event.outcome, event.facts);
    case 'gate-checked':
      if (!live(state, event.txn) || (state.phase !== 'gating' && state.phase !== 'gating-after-dialog')) return unchanged(state);
      return onGateChecked(state, event.delivered, event.unencodable);
    case 'target-replied':
      if (!live(state, event.txn) || state.phase !== 'choosing') return unchanged(state);
      return onTargetReplied(state, event.reply);
    case 'save-replied':
      if (!live(state, event.txn) || state.phase !== 'writing') return unchanged(state);
      return onSaveReplied(state, event.reply);
    case 'activate-replied': {
      if (!live(state, event.txn) || state.phase !== 'activating' || state.activation === null) return unchanged(state);
      const { activation } = state;
      // 提示先于会话写入：写入被 CAS 拒绝时控制器回送 settle-failed，其提示会取代这里的成功提示。
      if (event.reply.ok) return done(state, [report({ kind: 'saved-as', displayName: activation.displayName }), { type: 'settle-save-as', txn: state.txn, activation }]);
      return done(state, [{ type: 'finish', reason: 'save-as-activation' }, report({ kind: 'save-as-not-switched', displayName: activation.displayName })]);
    }
    case 'activate-failed': {
      if (!live(state, event.txn) || state.phase !== 'activating' || state.activation === null || event.attempt !== state.attempt) return unchanged(state);
      if (state.attempt >= MAX_SAVE_ACTIVATION_ATTEMPTS) return unresolved(state, state.activation);
      const attempt = state.attempt + 1;
      return { state: { ...state, attempt }, effects: [{ type: 'activate', txn: state.txn, attempt, ticket: state.activation.ticket }] };
    }
    case 'settle-failed':
      // D2 / F2：只在刚终结的这一次事务上处理（会话写入发生在终结效果中）。
      if (event.txn !== state.txn || state.phase !== 'idle') return unchanged(state);
      return { state, effects: [{ type: 'send-reject', ticket: event.ticket }, report({ kind: 'save-as-not-switched', displayName: event.displayName })] };
    case 'aborted':
      if (!live(state, event.txn)) return unchanged(state);
      return onAborted(state, event.committed, event.ticket);
  }
}
