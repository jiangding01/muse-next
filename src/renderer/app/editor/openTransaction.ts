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
 * - 阶段性数据安全（M3 T3a，用户裁决 Q3 / S5，T3 Preflight r3 §8）：`open-replied` 与 `activate-replied` 携带控制器同步读取的
 *   `dirty`。收到 `opened` 时若文档已 dirty → 只丢弃 pending 候选（`send-reject`，main 的旧 active 不受影响），不进入激活；
 *   激活成功时若文档已 dirty（编辑在 Open 进行中被禁止，只可能来自缺陷）→ 不提交、对已激活的候选 `send-reject`，
 *   并 `downgrade-trust`（main 已在激活时吊销旧能力），提示沿用 `activation-invalid`。两处都产生 `replacement-refused`，
 *   由控制器转成编辑器提示。入口处的 dirty / 组字拒绝在控制器中完成，不进入本状态机。
 * - 控制器自身异常的 fail-closed 终结（r3a 复核 H-1）：`controller-failed` 按事务所处阶段收束——requesting 时 main 至多持有
 *   pending 候选：已知票据则只 reject 它（旧 active 未受影响，不降级），应答含义未知则按 open 抛错处理（降级）；
 *   activating / uncertain 时 main 可能已经激活候选、吊销了旧能力：reject 候选并降级，提示 `activation-unresolved`；
 *   事务已终结（含已提交）时不产生任何效果，因此不会撤回已成功提交会话的能力。`commit-failed` 只用于刚终结的事务在
 *   store 写入时失败（main 已激活、renderer 仍是旧会话）：reject 已激活候选并降级，提示 `activation-invalid`。
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
  | { readonly type: 'open-replied'; readonly txn: number; readonly reply: OpenDocumentReply; readonly dirty: boolean }
  | { readonly type: 'open-threw'; readonly txn: number }
  | { readonly type: 'activate-replied'; readonly txn: number; readonly attempt: number; readonly reply: ActivateDocumentReply; readonly dirty: boolean }
  | { readonly type: 'activate-failed'; readonly txn: number; readonly attempt: number }
  /** 控制器在处理本事务时抛错；`ticket` 是 requesting 阶段已从 open 应答中识别出的票据。 */
  | { readonly type: 'controller-failed'; readonly txn: number; readonly ticket: DocumentActivationTicket | null }
  /** 本事务的 commit 效果写入 store 失败；`ticket` 是刚被激活的候选的票据。 */
  | { readonly type: 'commit-failed'; readonly txn: number; readonly ticket: DocumentActivationTicket }
  | { readonly type: 'notice-dismissed' };

export type OpenFlowEffect =
  | { readonly type: 'invoke-open'; readonly txn: number }
  | { readonly type: 'invoke-activate'; readonly txn: number; readonly attempt: number; readonly ticket: DocumentActivationTicket }
  | { readonly type: 'send-reject'; readonly ticket: DocumentActivationTicket }
  /** `ticket` 是被提交候选的票据：store 写入失败时据此撤回已激活的候选（r3a 复核 H-1）。 */
  | { readonly type: 'commit'; readonly session: DocumentSession; readonly ticket: DocumentActivationTicket }
  | { readonly type: 'downgrade-trust' }
  /** 因文档已 dirty 而放弃替换：激活之前（只丢候选）或激活之后的提交时（最后防线）。 */
  | { readonly type: 'replacement-refused'; readonly stage: 'before-activation' | 'at-commit' };

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

function onOpenReplied(state: OpenFlowState, reply: OpenDocumentReply, dirty: boolean, prepare: PrepareCandidate): OpenFlowStep {
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
      if (dirty) return finish(state, null, [{ type: 'send-reject', ticket: candidate.ticket }, { type: 'replacement-refused', stage: 'before-activation' }]);
      return {
        state: { ...state, phase: 'activating', attempt: 1, candidate, notice: null },
        effects: [{ type: 'invoke-activate', txn: state.txn, attempt: 1, ticket: candidate.ticket }],
      };
    }
  }
}

/** 事务是否正处于激活阶段（含不确定后的重试）；控制器据此决定提交前是否需要结束组字。 */
export const activating = (state: OpenFlowState, txn: number): boolean =>
  txn === state.txn && (state.phase === 'activating' || state.phase === 'uncertain') && state.candidate !== null;

function onControllerFailed(state: OpenFlowState, ticket: DocumentActivationTicket | null): OpenFlowStep {
  if (state.phase === 'requesting') {
    return ticket === null ? finish(state, { kind: 'request-rejected' }, [DOWNGRADE]) : finish(state, { kind: 'prepare-failed' }, [{ type: 'send-reject', ticket }]);
  }
  if (state.phase === 'idle' || state.candidate === null) return unchanged(state);
  return finish(state, { kind: 'activation-unresolved' }, [{ type: 'send-reject', ticket: state.candidate.ticket }, DOWNGRADE]);
}

export function stepOpenFlow(state: OpenFlowState, event: OpenFlowEvent, prepare: PrepareCandidate = prepareCandidate): OpenFlowStep {
  switch (event.type) {
    case 'open-requested': {
      if (state.phase !== 'idle') return unchanged(state);
      const txn = state.txn + 1;
      return { state: { txn, phase: 'requesting', attempt: 0, candidate: null, notice: null }, effects: [{ type: 'invoke-open', txn }] };
    }
    case 'open-replied':
      if (event.txn !== state.txn || state.phase !== 'requesting') return unchanged(state);
      return onOpenReplied(state, event.reply, event.dirty, prepare);
    case 'open-threw':
      if (event.txn !== state.txn || state.phase !== 'requesting') return unchanged(state);
      return finish(state, { kind: 'request-rejected' }, [DOWNGRADE]);
    case 'activate-replied': {
      if (!activating(state, event.txn) || state.candidate === null) return unchanged(state);
      const { reply } = event;
      if (reply.ok && event.dirty) {
        return finish(state, { kind: 'activation-invalid' }, [
          { type: 'send-reject', ticket: state.candidate.ticket },
          DOWNGRADE,
          { type: 'replacement-refused', stage: 'at-commit' },
        ]);
      }
      if (reply.ok) return finish(state, null, [{ type: 'commit', session: state.candidate.session, ticket: state.candidate.ticket }]);
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
    case 'controller-failed':
      return event.txn === state.txn ? onControllerFailed(state, event.ticket) : unchanged(state);
    case 'commit-failed':
      if (event.txn !== state.txn || state.phase !== 'idle') return unchanged(state);
      return { state: { ...state, notice: { kind: 'activation-invalid' } }, effects: [{ type: 'send-reject', ticket: event.ticket }, DOWNGRADE] };
    case 'notice-dismissed':
      return state.notice === null ? unchanged(state) : { state: { ...state, notice: null }, effects: [] };
  }
}
