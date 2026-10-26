/**
 * 模块级输入法会话（M3 T3c；Preflight r1 §7、r1.1 §1）。
 *
 * - 持有 `imeMachine` 的当前状态与两个单调计数（组字会话号、提交授权号，永不复用），供编辑控制器（`imeView` / Open 提交前 discard）、
 *   写回层（核对与消费授权、非法变化时 discard）与绑定层（事件驱动）共用，切断三者之间的循环依赖。
 * - 不碰 DOM、不读 store；DOM 回滚由调用方完成。绑定代际（attachmentGen）由绑定层持有并校验迟到回调。
 * - `discard` 只允许三种调用者 × 理由组合（`architecture.m3t3` 钉住）：Open 提交前（`open-commit`）、组字中 store 出现非法变化
 *   （`store-changed-while-composing`）、textarea detach（`detach`，直接回到 idle）。
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
  /** 诊断窗口退出；传入会话号时只在匹配时退出。 */
  exitSettled(id?: number): void;
  noteStoreChange(documentId: number, version: number): void;
  diagnose(facts: DiagnosisFacts): TrailingSuspect | null;
}

export function createImeSession(): ImeSession {
  let state: ImeState = IDLE;
  let lastSessionId = 0;
  let lastToken = 0;

  return {
    state: () => state,
    view: () => imeViewOf(state),
    start: (facts) => {
      const next = startComposition(state, { ...facts, id: lastSessionId + 1 });
      if (next !== state) lastSessionId += 1;
      state = next;
      return state;
    },
    beginCommit: (authorization) => {
      if (state.kind !== 'composing') return null;
      lastToken += 1;
      state = beginCommit(state, { ...authorization, token: lastToken });
      return lastToken;
    },
    authorization: () => authorizationOf(state),
    consumeCommit: (token, facts) => {
      const step = consumeCommit(state, token, facts);
      state = step.state;
      return step.ok;
    },
    abortCommit: (token, facts) => {
      const step = abortCommit(state, token, facts);
      state = step.state;
      return step.ok;
    },
    endCommitUnverified: (token, facts) => {
      const step = endCommitUnverified(state, token, facts);
      state = step.state;
      return step.ok;
    },
    endWithoutCommit: (kind, documentId, facts) => {
      state = endWithoutCommit(state, kind, documentId, facts);
    },
    discard: (reason) => {
      state = reason === 'detach' ? IDLE : discardComposition(state);
    },
    stuckExit: () => {
      state = stuckExit(state);
    },
    exitSettled: (id) => {
      state = exitSettled(state, id);
    },
    noteStoreChange: (documentId, version) => {
      state = noteStoreChange(state, documentId, version);
    },
    diagnose: (facts) => {
      const step = diagnose(state, facts);
      state = step.state;
      return step.record;
    },
  };
}

/** 产品使用的模块级输入法会话。 */
export const museImeSession: ImeSession = createImeSession();
