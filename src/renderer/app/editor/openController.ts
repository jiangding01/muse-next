/**
 * Open 事务适配层（M3 T1c-2，T1c Preflight r2 §6.2；用户裁决 Q1）。
 *
 * 把纯状态机 `openTransaction.ts` 的副作用落到 IPC、定时器与 store：
 * - `invoke-open` → `openDocument()`（**不设超时**，用户可以长时间停留在原生对话框中）；
 * - `invoke-activate` → `activateDocument(ticket)`，每次尝试单独计时；应答、invoke 抛错与超时都按「事务号 + 尝试号」回送，
 *   由状态机判断是否仍然有效（迟到的应答不会覆盖后续事务，重叠的未 settle 尝试不会重复提交）；
 * - `send-reject` → `rejectDocument(ticket)`，尽力发送：不等待、不依赖其应答（不视为 main 已清理）；
 * - `commit` → `commitSession(session, 'trusted')`；`downgrade-trust` → 降级授权状态。
 *
 * 控制器是模块级对象，不在任何 React 组件生命周期里：组件卸载 / 重挂载不会中断或重复事务；组件只调用 `open()`。
 * renderer 中只有本模块调用 `window.museDesktop`（架构守卫钉住）。
 */

import type { MuseDesktopApi } from '../../../shared/ipc';
import type { ActivateDocumentReply, OpenDocumentReply } from '../../../shared/activationContracts';
import type { DocumentSession } from '../../../editor/session/types';
import { commitSession, downgradeCapabilityTrust, publishOpenView } from '../store';
import type { OpenView } from '../store';
import { ACTIVATION_TIMEOUT_MS, initialOpenFlow, stepOpenFlow } from './openTransaction';
import type { CapabilityTrust, OpenFlowEffect, OpenFlowEvent, OpenFlowState } from './openTransaction';

export interface OpenControllerDeps {
  /** 每次调用时取得桥（生产为 `window.museDesktop`，不在模块加载时访问 window）。 */
  readonly bridge: () => Pick<MuseDesktopApi, 'openDocument' | 'activateDocument' | 'rejectDocument'>;
  /** 一次性定时器；返回取消函数。 */
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  readonly commit: (session: DocumentSession, trust: CapabilityTrust) => void;
  readonly downgradeTrust: () => void;
  readonly publish: (view: OpenView) => void;
}

export interface OpenController {
  /** 用户发起 Open；已有事务进行中时不产生任何效果。 */
  open(): void;
  dismissNotice(): void;
  /** 只读诊断快照（测试）。 */
  state(): OpenFlowState;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** 激活应答的形状校验：不是协议定义的明确结果时按「不确定」处理（fail closed，不提交）。 */
function isActivateReply(value: unknown): value is ActivateDocumentReply {
  if (!isRecord(value)) return false;
  if (value.ok === true) return true;
  return value.ok === false && (value.code === 'capability-invalid' || value.code === 'document-mismatch');
}

function isOpenReply(value: unknown): value is OpenDocumentReply {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'canceled':
      return true;
    case 'opened':
      return isRecord(value.document);
    case 'failed':
      return isRecord(value.error) && typeof value.error.code === 'string';
    case 'rejected':
      return value.reason === 'busy' || value.reason === 'superseded';
    default:
      return false;
  }
}

export function createOpenController(deps: OpenControllerDeps): OpenController {
  let state = initialOpenFlow();

  function dispatch(event: OpenFlowEvent): void {
    const step = stepOpenFlow(state, event);
    const changedView = step.state.phase !== state.phase || step.state.notice !== state.notice;
    state = step.state;
    for (const effect of step.effects) run(effect);
    if (changedView) deps.publish({ phase: state.phase, notice: state.notice });
  }

  function run(effect: OpenFlowEffect): void {
    switch (effect.type) {
      case 'invoke-open': {
        const { txn } = effect;
        invoke(() => deps.bridge().openDocument()).then(
          (reply) => {
            dispatch(isOpenReply(reply) ? { type: 'open-replied', txn, reply } : { type: 'open-threw', txn });
          },
          () => {
            dispatch({ type: 'open-threw', txn });
          },
        );
        return;
      }
      case 'invoke-activate': {
        const { txn, attempt, ticket } = effect;
        let settled = false;
        const cancel = deps.schedule(ACTIVATION_TIMEOUT_MS, () => {
          if (settled) return;
          settled = true;
          dispatch({ type: 'activate-failed', txn, attempt });
        });
        invoke(() => deps.bridge().activateDocument(ticket)).then(
          (reply) => {
            settled = true;
            cancel();
            // 已超时尝试的迟到应答同样回送：明确结果对仍在进行的事务有效，事务已终结时由状态机忽略。
            dispatch(isActivateReply(reply) ? { type: 'activate-replied', txn, attempt, reply } : { type: 'activate-failed', txn, attempt });
          },
          () => {
            const first = !settled;
            settled = true;
            cancel();
            if (first) dispatch({ type: 'activate-failed', txn, attempt });
          },
        );
        return;
      }
      case 'send-reject':
        invoke(() => deps.bridge().rejectDocument(effect.ticket)).catch(() => undefined);
        return;
      case 'commit':
        deps.commit(effect.session, 'trusted');
        return;
      case 'downgrade-trust':
        deps.downgradeTrust();
        return;
    }
  }

  return {
    open: () => dispatch({ type: 'open-requested' }),
    dismissNotice: () => dispatch({ type: 'notice-dismissed' }),
    state: () => state,
  };
}

/** 同步抛错（例如桥不存在）也转成被拒绝的 Promise，统一走失败分支。 */
function invoke<T>(call: () => Promise<T>): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** 产品使用的模块级控制器。 */
export const museOpenController: OpenController = createOpenController({
  bridge: () => window.museDesktop,
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
  commit: commitSession,
  downgradeTrust: downgradeCapabilityTrust,
  publish: publishOpenView,
});
