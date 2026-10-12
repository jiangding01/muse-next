/**
 * Open → Prepare → Activate → Commit 状态机（M3 T1c-2，T1c Preflight r2 §3.2 / §16.1 Q1「保守 R1」；纯逻辑）。
 *
 * `stepOpenFlow(state, event)` 返回新状态与要执行的副作用（调用 IPC、发 reject、提交会话、降级授权）；不调用 IPC、
 * 不读时钟、不建定时器，这些都在 `openController.ts`。
 *
 * 合同：
 * - **只有**当前事务收到明确的 `activateDocument → { ok: true }` 才产生 `commit`，且每个事务至多一次；提交之前当前会话、
 *   派生字段与文件关联都不变。候选只存在于本状态中，不进入 store。
 * - 吊销信号（保守 R1）：open 的 `superseded` 或抛错；activate 的首次 `capability-invalid`、`document-mismatch`；激活结果在
 *   预算内始终不确定——都产生 `downgrade-trust`（有文件的会话由 trusted 降为 unverified，demo 恒为 none）。`canceled`、
 *   `failed`、`busy` 不是吊销信号。`trusted` 只表示没有观察到吊销信号，不是 main 当前授权的证明（导航被拦截时 main 已
 *   静默吊销，T1c-1 已接受风险）。
 * - 激活不确定：单次应答期限 `ACTIVATION_TIMEOUT_MS`，最多 `MAX_ACTIVATION_ATTEMPTS` 次（含首次），重试使用同一张票。
 *   任何一次尝试（含已超时尝试的迟到应答）给出明确结果都终结事务；只有当前尝试的失败才推进重试。预算耗尽：保留当前会话、
 *   降级，并尽力发送 reject——reject 不保证送达，也不视为 main 已清理，之后的任何逻辑都不依赖它的应答。
 * - 迟到事件（事务号不是当前值，或事务已经终结）一律忽略，不能覆盖后续事务或当前会话。
 * - `openDocument` 不设超时：用户可以长时间停留在原生文件对话框里。
 * - 单飞：已有事务进行中时的 Open 请求不产生任何副作用。
 */

import type { ActivateDocumentReply, DocumentActivationTicket, OpenDocumentReply } from '../../../shared/activationContracts';
import type { OpenDocumentErrorCode } from '../../../shared/openContracts';
import type { DocumentSession } from '../../../editor/session/types';
import { prepareCandidate } from './sessionFactory';
import type { PreparedCandidate, PrepareResult } from './sessionFactory';

/** 单次 `activateDocument` 的应答期限（用户裁决 Q1）。 */
export const ACTIVATION_TIMEOUT_MS = 5_000;
/** `activateDocument` 的最大尝试次数，含首次（用户裁决 Q1）。 */
export const MAX_ACTIVATION_ATTEMPTS = 3;

export type CapabilityTrust = 'none' | 'trusted' | 'unverified';

export type OpenPhase = 'idle' | 'requesting' | 'activating' | 'uncertain';

export type OpenNotice =
  | { readonly kind: 'open-failed'; readonly code: OpenDocumentErrorCode }
  | { readonly kind: 'busy' }
  | { readonly kind: 'superseded' }
  | { readonly kind: 'request-rejected' }
  | { readonly kind: 'prepare-failed' }
  | { readonly kind: 'activation-invalid' }
  | { readonly kind: 'activation-mismatch' }
  | { readonly kind: 'activation-unresolved' };

export interface OpenFlowState {
  /** 最近一次被接受的事务号（单调递增，0 表示尚无事务）。 */
  readonly txn: number;
  readonly phase: OpenPhase;
  /** 当前事务已发出的激活尝试次数（未进入激活为 0）。 */
  readonly attempt: number;
  readonly candidate: PreparedCandidate | null;
  readonly notice: OpenNotice | null;
}

export type OpenFlowEvent =
  | { readonly type: 'open-requested' }
  | { readonly type: 'open-replied'; readonly txn: number; readonly reply: OpenDocumentReply }
  | { readonly type: 'open-threw'; readonly txn: number }
  | { readonly type: 'activate-replied'; readonly txn: number; readonly attempt: number; readonly reply: ActivateDocumentReply }
  | { readonly type: 'activate-failed'; readonly txn: number; readonly attempt: number }
  | { readonly type: 'notice-dismissed' };

export type OpenFlowEffect =
  | { readonly type: 'invoke-open'; readonly txn: number }
  | { readonly type: 'invoke-activate'; readonly txn: number; readonly attempt: number; readonly ticket: DocumentActivationTicket }
  | { readonly type: 'send-reject'; readonly ticket: DocumentActivationTicket }
  | { readonly type: 'commit'; readonly session: DocumentSession }
  | { readonly type: 'downgrade-trust' };

export interface OpenFlowStep {
  readonly state: OpenFlowState;
  readonly effects: readonly OpenFlowEffect[];
}

export type PrepareCandidate = (value: unknown) => PrepareResult;

export function initialOpenFlow(): OpenFlowState {
  return { txn: 0, phase: 'idle', attempt: 0, candidate: null, notice: null };
}

const DOWNGRADE: OpenFlowEffect = { type: 'downgrade-trust' };

/** 事务终结：回到 idle、丢弃候选，给出提示。 */
function finish(state: OpenFlowState, notice: OpenNotice | null, effects: readonly OpenFlowEffect[] = []): OpenFlowStep {
  return { state: { ...state, phase: 'idle', attempt: 0, candidate: null, notice }, effects };
}

const unchanged = (state: OpenFlowState): OpenFlowStep => ({ state, effects: [] });

function onOpenReplied(state: OpenFlowState, reply: OpenDocumentReply, prepare: PrepareCandidate): OpenFlowStep {
  switch (reply.kind) {
    case 'canceled':
      return finish(state, null);
    case 'failed':
      return finish(state, { kind: 'open-failed', code: reply.error.code });
    case 'rejected':
      // busy 不归因（物理对话框或逻辑锁），也不是吊销信号；superseded 可能意味着页面代次已被重置。
      return reply.reason === 'busy' ? finish(state, { kind: 'busy' }) : finish(state, { kind: 'superseded' }, [DOWNGRADE]);
    case 'opened': {
      const prepared = prepare(reply.document);
      if (!prepared.ok) {
        return finish(state, { kind: 'prepare-failed' }, prepared.ticket === null ? [] : [{ type: 'send-reject', ticket: prepared.ticket }]);
      }
      const { candidate } = prepared;
      return {
        state: { ...state, phase: 'activating', attempt: 1, candidate, notice: null },
        effects: [{ type: 'invoke-activate', txn: state.txn, attempt: 1, ticket: candidate.ticket }],
      };
    }
  }
}

/** 事务是否正处于激活阶段（含不确定后的重试）。 */
const activating = (state: OpenFlowState, txn: number): boolean =>
  txn === state.txn && (state.phase === 'activating' || state.phase === 'uncertain') && state.candidate !== null;

export function stepOpenFlow(state: OpenFlowState, event: OpenFlowEvent, prepare: PrepareCandidate = prepareCandidate): OpenFlowStep {
  switch (event.type) {
    case 'open-requested': {
      if (state.phase !== 'idle') return unchanged(state);
      const txn = state.txn + 1;
      return { state: { txn, phase: 'requesting', attempt: 0, candidate: null, notice: null }, effects: [{ type: 'invoke-open', txn }] };
    }
    case 'open-replied':
      if (event.txn !== state.txn || state.phase !== 'requesting') return unchanged(state);
      return onOpenReplied(state, event.reply, prepare);
    case 'open-threw':
      if (event.txn !== state.txn || state.phase !== 'requesting') return unchanged(state);
      return finish(state, { kind: 'request-rejected' }, [DOWNGRADE]);
    case 'activate-replied': {
      if (!activating(state, event.txn) || state.candidate === null) return unchanged(state);
      const { reply } = event;
      if (reply.ok) return finish(state, null, [{ type: 'commit', session: state.candidate.session }]);
      return finish(state, { kind: reply.code === 'document-mismatch' ? 'activation-mismatch' : 'activation-invalid' }, [DOWNGRADE]);
    }
    case 'activate-failed': {
      if (!activating(state, event.txn) || state.candidate === null || event.attempt !== state.attempt) return unchanged(state);
      const { ticket } = state.candidate;
      if (state.attempt < MAX_ACTIVATION_ATTEMPTS) {
        const attempt = state.attempt + 1;
        return { state: { ...state, phase: 'uncertain', attempt }, effects: [{ type: 'invoke-activate', txn: state.txn, attempt, ticket }] };
      }
      return finish(state, { kind: 'activation-unresolved' }, [{ type: 'send-reject', ticket }, DOWNGRADE]);
    }
    case 'notice-dismissed':
      return state.notice === null ? unchanged(state) : { state: { ...state, notice: null }, effects: [] };
  }
}
