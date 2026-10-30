/**
 * DocumentReplacementGuard 的纯状态机与批准判据（M3 T4 B3b；B3 r0 §4，r0.1 勘误 §4 M-B3-2；DR1 Q9 / Q12）。
 *
 * - 一次替换意图（intent）只属于一次持有准入租约的 Open：`intentId` 由守卫控制器单调生成、从不复用。
 * - 询问 → 「保存」：等待保存结果 `SaveResult { ok, clean }`——`ok && clean` 批准 `proceed`；`ok && !clean` 重新询问；
 *   `!ok` 中止。「不保存」：批准 `discard`，基线为当时的 `documentId` 与 `sourceVersion`。「取消」：中止。
 * - 根 React 卸载（宿主不再存在）时，尚未完成的询问一律取消；保存进行中卸载的，保存结果到达后也只中止、不批准。
 * - 迟到事件（intentId 不是当前 intent）一律忽略。
 *
 * 批准判据 `replacementBlocked`（Open 事务两处检查的输入，`openTransaction` 的 `replacementBlocked` 字段）：
 * 1. 没有批准，或批准的 `intentId` / `documentId` 与本次 Open 和当前会话不符 → 视为未批准，等同入口 clean 的 Open（proceed）；
 * 2. `proceed` 要求当前 clean（Q9）；
 * 3. `discard` 要求 `sourceVersion` 未变（Q9）：批准之后的任何编辑（含 undo / redo，版本单调递增）都使批准失效。
 * 纯模块：只依赖类型。
 */

export type GuardDecision = 'proceed' | 'discard';

export interface ReplacementApproval {
  readonly decision: GuardDecision;
  readonly intentId: number;
  /** 被替换的原文档。 */
  readonly documentId: number;
  /** 只在 `discard` 时有值。 */
  readonly sourceVersion: number | null;
}

export interface SaveResult {
  readonly ok: boolean;
  /** 保存收束之后当前文档是否 clean（同一文档）。 */
  readonly clean: boolean;
}

/** Open 两处检查时的当前事实。 */
export interface ReplacementFacts {
  readonly intentId: number | null;
  readonly documentId: number;
  readonly sourceVersion: number;
  readonly dirty: boolean;
}

export function replacementBlocked(approval: ReplacementApproval | null, facts: ReplacementFacts): boolean {
  if (approval === null || approval.intentId !== facts.intentId || approval.documentId !== facts.documentId) return facts.dirty;
  if (approval.decision === 'proceed') return facts.dirty;
  return approval.sourceVersion !== facts.sourceVersion;
}

export type GuardChoice = 'save' | 'discard' | 'cancel';

export type GuardState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'asking'; readonly intentId: number; readonly documentId: number }
  | { readonly phase: 'saving'; readonly intentId: number; readonly documentId: number; readonly hostGone: boolean };

export type GuardEvent =
  | { readonly type: 'ask'; readonly intentId: number; readonly documentId: number }
  /** 用户的选择；`sourceVersion` 为选择时的当前版本（discard 的基线）。 */
  | { readonly type: 'chose'; readonly intentId: number; readonly choice: GuardChoice; readonly sourceVersion: number }
  | { readonly type: 'saved'; readonly intentId: number; readonly result: SaveResult }
  | { readonly type: 'host-gone' };

export type GuardEffect =
  | { readonly type: 'start-save'; readonly intentId: number }
  | { readonly type: 'approve'; readonly approval: ReplacementApproval }
  | { readonly type: 'abort'; readonly intentId: number; readonly reason: 'canceled' | 'save-failed' | 'host-gone' };

export interface GuardStep {
  readonly state: GuardState;
  readonly effects: readonly GuardEffect[];
}

export const IDLE_GUARD: GuardState = { phase: 'idle' };

const unchanged = (state: GuardState): GuardStep => ({ state, effects: [] });

export function stepGuard(state: GuardState, event: GuardEvent): GuardStep {
  switch (event.type) {
    case 'ask':
      if (state.phase !== 'idle') return unchanged(state);
      return { state: { phase: 'asking', intentId: event.intentId, documentId: event.documentId }, effects: [] };
    case 'chose': {
      if (state.phase !== 'asking' || state.intentId !== event.intentId) return unchanged(state);
      const { intentId, documentId } = state;
      if (event.choice === 'cancel') return { state: IDLE_GUARD, effects: [{ type: 'abort', intentId, reason: 'canceled' }] };
      if (event.choice === 'discard') {
        return { state: IDLE_GUARD, effects: [{ type: 'approve', approval: { decision: 'discard', intentId, documentId, sourceVersion: event.sourceVersion } }] };
      }
      return { state: { phase: 'saving', intentId, documentId, hostGone: false }, effects: [{ type: 'start-save', intentId }] };
    }
    case 'saved': {
      if (state.phase !== 'saving' || state.intentId !== event.intentId) return unchanged(state);
      const { intentId, documentId } = state;
      if (state.hostGone) return { state: IDLE_GUARD, effects: [{ type: 'abort', intentId, reason: 'host-gone' }] };
      if (!event.result.ok) return { state: IDLE_GUARD, effects: [{ type: 'abort', intentId, reason: 'save-failed' }] };
      if (!event.result.clean) return { state: { phase: 'asking', intentId, documentId }, effects: [] };
      return { state: IDLE_GUARD, effects: [{ type: 'approve', approval: { decision: 'proceed', intentId, documentId, sourceVersion: null } }] };
    }
    case 'host-gone':
      if (state.phase === 'asking') return { state: IDLE_GUARD, effects: [{ type: 'abort', intentId: state.intentId, reason: 'host-gone' }] };
      if (state.phase === 'saving') return { state: { ...state, hostGone: true }, effects: [] };
      return unchanged(state);
  }
}
