/**
 * 替换守卫控制器（M3 T4 B3b；B3 r0 §2.3 b2、§4，r0.1 勘误 §4）。
 *
 * 执行 `stepGuard` 的效果；模块级对象，询问状态不随 React 组件卸载而丢失。
 * - `ask(lease)`：持有准入租约的 Open 在文档 dirty 时调用；同步返回本次 `intentId`，结果为批准或中止。
 * - 「保存」分支调用 `saveWithin(lease)`：复用 Open 已持有的那一张租约，不另取第二张；等待 `SaveResult`。
 * - 宿主：询问对话框挂载时登记、卸载时注销。宿主计数归零（根 React 卸载）时，尚未完成的询问一律取消；
 *   之后的 Open 由 Open 控制器经 `hasHost()` 拒绝（没有界面可以询问）。
 * - 询问视图经本模块的订阅接口提供给对话框（`useSyncExternalStore`），不写 store。
 * - 本模块不接触 `museDesktop`、不实现 T5 的 close / quit / will-prevent-unload / main intent。
 */

import { reportEditorError } from '../fatalError';
import type { FileIntentLease } from '../fileIntentGate';
import { museSaveController } from '../save/saveController';
import { useMuseAppStore } from '../store';
import { IDLE_GUARD, stepGuard } from './replacementGuard';
import type { GuardChoice, GuardEffect, GuardEvent, GuardState, ReplacementApproval, SaveResult } from './replacementGuard';

export type GuardOutcome = { readonly approval: ReplacementApproval } | { readonly aborted: 'canceled' | 'save-failed' | 'host-gone' | 'busy' };

export interface GuardAsk {
  readonly intentId: number;
  readonly outcome: Promise<GuardOutcome>;
}

export interface GuardView {
  readonly phase: GuardState['phase'];
  readonly intentId: number | null;
}

export interface GuardControllerDeps {
  readonly saveWithin: (lease: FileIntentLease) => Promise<SaveResult>;
  /** 选择「不保存」时的当前版本（discard 的基线）。 */
  readonly sourceVersion: () => number;
  readonly report: (error: unknown, context: string) => void;
}

export interface GuardController {
  ask(lease: FileIntentLease): GuardAsk;
  choose(choice: GuardChoice): void;
  view(): GuardView;
  subscribe(listener: () => void): () => void;
  /** 询问对话框挂载时调用；返回注销函数（卸载时调用）。 */
  attachHost(): () => void;
  hasHost(): boolean;
}

const IDLE_VIEW: GuardView = { phase: 'idle', intentId: null };

export function createGuardController(deps: GuardControllerDeps): GuardController {
  let state: GuardState = IDLE_GUARD;
  let view: GuardView = IDLE_VIEW;
  let lastIntent = 0;
  let hosts = 0;
  let pending: { readonly intentId: number; readonly lease: FileIntentLease; readonly resolve: (outcome: GuardOutcome) => void } | null = null;
  const listeners = new Set<() => void>();

  function publish(): void {
    const next: GuardView = state.phase === 'idle' ? IDLE_VIEW : { phase: state.phase, intentId: state.intentId };
    if (next.phase === view.phase && next.intentId === view.intentId) return;
    view = next;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        deps.report(error, 'guard-listener');
      }
    }
  }

  function settle(intentId: number, outcome: GuardOutcome): void {
    if (pending === null || pending.intentId !== intentId) return;
    const { resolve } = pending;
    pending = null;
    resolve(outcome);
  }

  function run(effect: GuardEffect): void {
    switch (effect.type) {
      case 'start-save': {
        const current = pending;
        if (current === null || current.intentId !== effect.intentId) return;
        const { intentId } = effect;
        let saving: Promise<SaveResult>;
        try {
          saving = deps.saveWithin(current.lease);
        } catch (error) {
          saving = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        saving.then(
          (result) => {
            dispatch({ type: 'saved', intentId, result });
          },
          (error: unknown) => {
            deps.report(error, 'guard-save');
            dispatch({ type: 'saved', intentId, result: { ok: false, clean: false } });
          },
        );
        return;
      }
      case 'approve':
        settle(effect.approval.intentId, { approval: effect.approval });
        return;
      case 'abort':
        settle(effect.intentId, { aborted: effect.reason });
        return;
    }
  }

  function dispatch(event: GuardEvent): void {
    const step = stepGuard(state, event);
    state = step.state;
    try {
      for (const effect of step.effects) run(effect);
    } finally {
      publish();
    }
  }

  return {
    ask(lease) {
      lastIntent += 1;
      const intentId = lastIntent;
      if (hosts === 0 || state.phase !== 'idle' || pending !== null) {
        return { intentId, outcome: Promise.resolve({ aborted: hosts === 0 ? 'host-gone' : 'busy' }) };
      }
      const outcome = new Promise<GuardOutcome>((resolve) => {
        pending = { intentId, lease, resolve };
      });
      dispatch({ type: 'ask', intentId, documentId: lease.documentId });
      return { intentId, outcome };
    },
    choose(choice) {
      if (state.phase !== 'asking') return;
      dispatch({ type: 'chose', intentId: state.intentId, choice, sourceVersion: deps.sourceVersion() });
    },
    view: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    attachHost() {
      hosts += 1;
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        hosts -= 1;
        if (hosts === 0) dispatch({ type: 'host-gone' });
      };
    },
    hasHost: () => hosts > 0,
  };
}

/** 产品使用的模块级守卫控制器。 */
export const museGuardController: GuardController = createGuardController({
  saveWithin: (lease) => museSaveController.saveWithin(lease),
  sourceVersion: () => useMuseAppStore.getState().session.sourceVersion,
  report: reportEditorError,
});
