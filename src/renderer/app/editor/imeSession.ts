/**
 * 模块级输入法会话（M3 T3c；Preflight r1 §7、r1.1 §1）。
 *
 * - 持有 `imeMachine` 的当前状态与两个单调计数（组字会话号、提交授权号，永不复用），供编辑控制器（`imeView` / Open 提交前 discard）、
 *   写回层（核对与消费授权、非法变化时 discard）与绑定层（事件驱动）共用，切断三者之间的循环依赖。
 * - 不碰 DOM、不读 store；DOM 回滚由调用方完成。绑定代际（attachmentGen）由绑定层持有并校验迟到回调。
 * - `discard` 只允许三种调用者 × 理由组合（`architecture.m3t3` 钉住）：Open 提交前（`open-commit`）、组字中 store 出现非法变化
 *   （`store-changed-while-composing`）、textarea detach（`detach`，直接回到 idle）。
 * - `subscribe`（M3 T4 B3a-1，B3 r0.1 勘误 §3）：每次状态迁移之后，若对外视图（`imeViewOf`）变化，同步通知订阅者；
 *   单个订阅者抛错被隔离，不影响状态机与其它订阅者。保存的有界等待「先订阅、再 blur、再核验」，不会漏掉 blur 中同步发生的
 *   compositionend。订阅不改变任何状态，也不调用 `discard`。
 */

import {
  IDLE,
  abortCommit,
  authorizationOf,
  beginCommit,
  consumeCommit,
  diagnose,
  discardComposition,
  endCommitUnverified,
  endWithoutCommit,
  exitSettled,
  imeViewOf,
  noteStoreChange,
  startComposition,
  stuckExit,
} from './imeMachine';
import type { CommitAuthorization, DiagnosisFacts, EndKind, ImeState, ImeView, SettledFacts, StartFacts, TrailingSuspect } from './imeMachine';

export type DiscardReason = 'open-commit' | 'store-changed-while-composing' | 'detach';

export interface ImeSession {
  state(): ImeState;
  view(): ImeView;
  start(facts: Omit<StartFacts, 'id'>): ImeState;
  /** composing → committing；返回授权号，状态不是 composing 时返回 null。 */
  beginCommit(authorization: Omit<CommitAuthorization, 'token'>): number | null;
  authorization(): CommitAuthorization | null;
  consumeCommit(token: number, facts: SettledFacts): boolean;
  abortCommit(token: number, facts: SettledFacts): boolean;
  endCommitUnverified(token: number, facts: SettledFacts): boolean;
  endWithoutCommit(kind: EndKind, documentId: number, facts: SettledFacts): void;
  discard(reason: DiscardReason): void;
  stuckExit(): void;
  /** 订阅对外视图的变化（只在视图改变时通知）；返回退订函数（幂等）。 */
  subscribe(listener: (view: ImeView) => void): () => void;
  /** 诊断窗口退出；传入会话号时只在匹配时退出。 */
  exitSettled(id?: number): void;
  noteStoreChange(documentId: number, version: number): void;
  diagnose(facts: DiagnosisFacts): TrailingSuspect | null;
}

export function createImeSession(): ImeSession {
  let state: ImeState = IDLE;
  let lastSessionId = 0;
  let lastToken = 0;
  const listeners = new Set<(view: ImeView) => void>();

  /** 唯一的状态写入点：迁移之后对外视图变化时通知订阅者。 */
  function transition(next: ImeState): void {
    const before = imeViewOf(state);
    state = next;
    const after = imeViewOf(state);
    if (after === before) return;
    for (const listener of [...listeners]) {
      // 订阅者在回调中引发了新的迁移：更新的视图已由内层迁移通知全部订阅者，不再派发过时的 after。
      if (imeViewOf(state) !== after) return;
      try {
        listener(after);
      } catch {
        // 订阅者自身的错误不影响状态机与其它订阅者。
      }
    }
  }

  return {
    state: () => state,
    view: () => imeViewOf(state),
    start: (facts) => {
      const next = startComposition(state, { ...facts, id: lastSessionId + 1 });
      if (next !== state) lastSessionId += 1;
      transition(next);
      return state;
    },
    beginCommit: (authorization) => {
      if (state.kind !== 'composing') return null;
      lastToken += 1;
      transition(beginCommit(state, { ...authorization, token: lastToken }));
      return lastToken;
    },
    authorization: () => authorizationOf(state),
    consumeCommit: (token, facts) => {
      const step = consumeCommit(state, token, facts);
      transition(step.state);
      return step.ok;
    },
    abortCommit: (token, facts) => {
      const step = abortCommit(state, token, facts);
      transition(step.state);
      return step.ok;
    },
    endCommitUnverified: (token, facts) => {
      const step = endCommitUnverified(state, token, facts);
      transition(step.state);
      return step.ok;
    },
    endWithoutCommit: (kind, documentId, facts) => {
      transition(endWithoutCommit(state, kind, documentId, facts));
    },
    discard: (reason) => {
      transition(reason === 'detach' ? IDLE : discardComposition(state));
    },
    stuckExit: () => {
      transition(stuckExit(state));
    },
    exitSettled: (id) => {
      transition(exitSettled(state, id));
    },
    noteStoreChange: (documentId, version) => {
      transition(noteStoreChange(state, documentId, version));
    },
    diagnose: (facts) => {
      const step = diagnose(state, facts);
      transition(step.state);
      return step.record;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** 产品使用的模块级输入法会话。 */
export const museImeSession: ImeSession = createImeSession();
