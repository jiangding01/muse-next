/**
 * Open 事务适配层（M3 T1c-2，T1c Preflight r2 §6.2；用户裁决 Q1）。
 *
 * 把纯状态机 `openTransaction.ts` 的副作用落到 IPC、定时器与 store：
 * - `invoke-open` → `openDocument()`（**不设超时**，用户可以长时间停留在原生对话框中）；
 * - `invoke-activate` → `activateDocument(ticket)`，每次尝试单独计时；应答、invoke 抛错与超时都按「事务号 + 尝试号」回送，
 *   由状态机判断是否仍然有效（迟到的应答不会覆盖后续事务，重叠的未 settle 尝试不会重复提交）；
 * - `send-reject` → 经 R20 账本发出（M3 T4 B3a-1）：事务本身不等待、不依赖其应答；之后的文件操作开始前先重发并等待；
 * - `commit` → `commitSession(session, 'trusted')`；`downgrade-trust` → 降级授权状态。
 *
 * - 阶段性数据安全（M3 T3a，用户裁决 Q3 / S5，T3 Preflight r3 §8）：入口处文档 dirty 或输入法正在组字时拒绝 Open（不发起
 *   对话框）；`open-replied` / `activate-replied` 携带同步读取的 `dirty` 交给状态机；激活成功且即将提交时，先经编辑器
 *   结束组字（T3c：discard → blur），再读 dirty。`replacementPending` 在事务离开 idle 时置位，在终态的全部效果（含 commit）
 *   执行完之后才清除（r3 复核 L-5）。未注入编辑器门控时视为「从不 dirty、从不组字」（只用于既有协议测试）。
 * - 异常边界（r3a 复核 H-1）：IPC 应答、invoke 拒绝与超时定时器的回调都经 `guard` 执行，`open()` 的派发同样收束；任何抛错
 *   （编辑器门控、替换标志、状态机、效果、发布）都报告并以 `controller-failed` 按事务阶段 fail closed（见 `openTransaction.ts`），
 *   报告器自身抛错也不跳过收束；回调本身永不抛出，不产生未处理的 Promise 拒绝。`dispatch` 的替换标志清除与视图发布
 *   在 finally 中。
 *   提交分两步：`commit` 写入 store 失败且 store 仍是旧会话 → `commit-failed`（reject 已激活候选并降级）；写入已生效之后的
 *   异常（订阅者、`afterCommit` 的解析调度通知）只报告，不撤回新会话的能力。
 * 控制器是模块级对象，不在任何 React 组件生命周期里：组件卸载 / 重挂载不会中断或重复事务；组件只调用 `open()`。
 * - 准入（M3 T4 B3a-1）：经 `openEntry` 同步取共享租约、过送达门与最终核对才开始；租约持有到终态全部效果执行完再 CAS 释放。
 * - 替换守卫（M3 T4 B3b，r0 §4、r0.1 勘误 §4）：注入守卫时，dirty 的 Open 不再拒绝，而是在持有租约后询问（保存 / 不保存 /
 *   取消）；批准后才开始事务，中止则释放租约。两处检查以批准判据 `replacementBlocked` 代替 dirty；批准在事务中途失效
 *   （例如 discard 之后又编辑）被拒时，回到 idle 后重新询问。根卸载后（守卫没有宿主）Open 一律拒绝。组字中仍拒绝。
 */

import type { MuseDesktopApi } from '../../../shared/ipc';
import type { ActivateDocumentReply, OpenDocumentReply } from '../../../shared/activationContracts';
import type { DocumentActivationTicket } from '../../../shared/activationContracts';
import type { DocumentSession } from '../../../editor/session/types';
import { reportEditorError } from '../fatalError';
import { commitSession, downgradeCapabilityTrust, publishEditorView, publishOpenView, useMuseAppStore } from '../store';
import type { OpenView } from '../store';
import { museEditorController } from './editorController';
import type { OpenGate } from './editorController';
import type { EditorNotice } from './editorTransitions';
import { activating, ACTIVATION_TIMEOUT_MS, initialOpenFlow, stepOpenFlow } from './openTransaction';
import { museParseController } from './parseController';
import { admissionNotice, museOpenAdmission } from './openEntry';
import type { OpenAdmission, OpenAdmissionRefusal } from './openEntry';
import type { FileIntentLease } from '../fileIntentGate';
import { museGuardController } from '../guard/guardController';
import type { GuardController } from '../guard/guardController';
import { replacementBlocked } from '../guard/replacementGuard';
import type { ReplacementApproval } from '../guard/replacementGuard';
import { createBridgeRejectLedger, museRejectLedger } from '../save/rejectLedger';
import type { RejectLedger } from '../save/rejectLedger';
import type { CapabilityTrust, OpenFlowEffect, OpenFlowEvent, OpenFlowState } from './openTransaction';

export interface OpenControllerDeps {
  /** 每次调用时取得桥（生产为 `window.museDesktop`，不在模块加载时访问 window）。 */
  readonly bridge: () => Pick<MuseDesktopApi, 'openDocument' | 'activateDocument' | 'rejectDocument'>;
  /** 一次性定时器；返回取消函数。 */
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  /** 写入 store。抛错时按「未提交」处理，除非 `committed` 表明 store 已经是该会话。 */
  readonly commit: (session: DocumentSession, trust: CapabilityTrust) => void;
  /** 提交成功之后的通知（产品：解析调度的 `documentReplaced`）；抛错只报告。 */
  readonly afterCommit?: () => void;
  /** `commit` 抛错时判断 store 是否已换成该会话（写入之后订阅者抛错）；缺省读产品 store。 */
  readonly committed?: (session: DocumentSession) => boolean;
  readonly downgradeTrust: () => void;
  readonly publish: (view: OpenView) => void;
  /** 编辑器门控（T3a）；缺省为「从不 dirty、从不组字」。 */
  readonly editor?: OpenEditorGate;
  /** 控制器自身异常的报告；缺省为产品的编辑器错误报告。 */
  readonly report?: (error: unknown, context: string) => void;
  /** 未确认 reject 账本（R20）；缺省为经 `bridge` 发送、不计超时的私有账本（既有协议测试）。 */
  readonly ledger?: Pick<RejectLedger, 'send'>;
  /** 共享准入（租约 + 送达门）；缺省为不经准入（既有协议测试）。 */
  readonly admission?: OpenAdmission;
  /** M3 T4 B3b：替换守卫；缺省时 dirty 即拒绝（既有协议测试）。 */
  readonly guard?: Pick<GuardController, 'ask' | 'hasHost'>;
  /** 当前文档号与源码版本（批准判据）；缺省时两处检查只看 dirty。 */
  readonly version?: () => { readonly documentId: number; readonly sourceVersion: number };
}

/** Open 控制器读取 / 通知编辑器的窄接口。 */
export interface OpenEditorGate {
  readonly gate: () => OpenGate;
  /** 激活成功、即将提交前调用：结束输入法组字（T3c）。 */
  readonly beforeCommit: () => void;
  readonly setReplacementPending: (pending: boolean) => void;
  readonly notify: (notice: EditorNotice) => void;
}

const NO_EDITOR: OpenEditorGate = {
  gate: () => ({ dirty: false, composing: false }),
  beforeCommit: () => undefined,
  setReplacementPending: () => undefined,
  notify: () => undefined,
};

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
  const editor = deps.editor ?? NO_EDITOR;
  const reporter = deps.report ?? reportEditorError;
  // 报告器自身抛错不能跳过随后的 fail-closed 收束（独立审查 L2）。
  const report = (error: unknown, context: string): void => {
    try {
      reporter(error, context);
    } catch {
      // 报告失败已无处可报；收束照常进行。
    }
  };
  // 按文档号判断：写入之后订阅者即使换了会话对象（同一文档的新快照），也仍算已提交（独立审查 L3）。
  const committed = deps.committed ?? ((session: DocumentSession) => useMuseAppStore.getState().session.documentId === session.documentId);
  const ledger = deps.ledger ?? createBridgeRejectLedger(deps.bridge);
  let lease: FileIntentLease | null = null; // 经准入开始的事务期间持有的租约
  let intent: number | null = null; // 本次 Open 的替换意图（守卫询问时取得）
  let approval: ReplacementApproval | null = null;
  let reask = false;
  let asking = false; // 守卫询问期间：事务处于 idle 但租约仍由本次 Open 持有，idle 派发不得释放

  /** 两处检查的批准判据（r0.1 勘误 §4）：未经守卫或批准不属于本次 Open / 当前文档时等同 proceed（dirty 即 blocked）。 */
  const blocked = (): boolean => {
    const { dirty } = editor.gate();
    const current = deps.version?.();
    return current === undefined ? dirty : replacementBlocked(approval, { intentId: intent, ...current, dirty });
  };

  function dispatch(event: OpenFlowEvent): void {
    const step = stepOpenFlow(state, event);
    const changedView = step.state.phase !== state.phase || step.state.notice !== state.notice;
    state = step.state;
    if (state.phase !== 'idle') editor.setReplacementPending(true);
    try {
      for (const effect of step.effects) run(effect);
    } finally {
      // 终态的全部效果（含 commit）执行完之后才清除；效果抛错也不会让标志停在 true（r3a 审查 L-2）。
      // 视图同样在 finally 中发布：终态效果抛错时 controller-failed 不再改变状态，视图不能停在旧阶段（r3a 复核 H-1）。
      if (state.phase === 'idle') {
        try {
          editor.setReplacementPending(false);
        } finally {
          // 终态的全部效果执行完之后才释放准入租约（CAS）；清理替换标志抛错也不能泄漏模块级租约。
          // 守卫询问期间（关闭提示、旧事务的迟到回调等 idle 派发）不释放：租约属于正在询问的这次 Open。
          if (!asking) {
            if (lease !== null) deps.admission?.release(lease);
            lease = null;
            intent = null;
            approval = null;
          }
        }
      }
      if (changedView) deps.publish({ phase: state.phase, notice: state.notice });
    }
    // 批准失效而被拒：回到 idle、租约释放之后重新询问（N-4）。
    if (reask && state.phase === 'idle' && lease === null) {
      reask = false;
      open();
    }
  }

  /**
   * 询问守卫期间持有租约（Open / Save 都被拒，idle 派发不释放）；中止则释放。批准是一次 await（用户选择与可能的保存）：
   * 恢复后在同一同步段内释放并立即重新经准入（租约、R20 送达门与最终核对、文档号、fileOp、组字）才开始事务。
   */
  function askGuard(granted: FileIntentLease, guard: Pick<GuardController, 'ask' | 'hasHost'>, admission: OpenAdmission): void {
    lease = granted;
    asking = true;
    const abandon = (): void => {
      if (lease === null || lease !== granted || state.phase !== 'idle') return;
      asking = false;
      deps.admission?.release(lease);
      lease = null;
      intent = null;
      approval = null;
    };
    let asked: ReturnType<GuardController['ask']>;
    try {
      asked = guard.ask(granted);
    } catch (error) {
      report(error, 'open-guard');
      abandon();
      return;
    }
    intent = asked.intentId;
    asked.outcome.then(
      (outcome) => {
        if (lease !== granted || state.phase !== 'idle') {
          // 防御（分析不可达：询问期间租约不会被释放、事务不会开始）。fail closed：不开始 Open；本次租约已不在任何人
          // 手里时结束询问标志，避免之后 idle 派发永远不释放后续租约。
          if (lease === null) asking = false;
          return;
        }
        if (!('approval' in outcome)) {
          abandon();
          return;
        }
        const approved = outcome.approval;
        const current = intent;
        abandon();
        // 批准留在闭包中，重新准入真正开始事务时才写回：flush 等待期间的 idle 派发不会把它清掉。
        admission.admit({
          begin: (regranted) => {
            approval = approved;
            intent = current;
            start(regranted);
          },
          refuse: (reason) => {
            editor.notify({ kind: admissionNotice(reason, { ...editor.gate(), dirty: false }) });
          },
          // 重新检查守卫宿主（收口 L1）：批准之后、R20 flush 期间根卸载 → 不开始 Open（准入拒绝并释放重新取得的租约）。
          stillAllowed: () => state.phase === 'idle' && lease === null && !editor.gate().composing && guard.hasHost(),
        });
      },
      (error: unknown) => {
        report(error, 'open-guard');
        abandon();
      },
    );
  }

  /** 开始事务；`granted` 为准入租约（经准入时）。同步入口同样 fail closed（独立审查 L1）。 */
  function start(granted: FileIntentLease | null): void {
    if (granted !== null) lease = granted;
    try {
      dispatch({ type: 'open-requested' });
    } catch (error) {
      failClosed(state.txn, null, error);
    }
  }

  /** 回调的统一异常边界（先复核准入租约与文档号，勘误 §1.3）：异常报告后按阶段 fail closed；收束再抛错只报告。 */
  function guard(txn: number, task: () => void, ticket: DocumentActivationTicket | null = null): void {
    try {
      if (lease !== null && deps.admission?.holds(lease) === false) throw new Error('file intent lease lost');
      task();
    } catch (error) {
      failClosed(txn, ticket, error);
    }
  }

  function failClosed(txn: number, ticket: DocumentActivationTicket | null, error: unknown): void {
    report(error, 'open');
    try {
      dispatch({ type: 'controller-failed', txn, ticket });
    } catch (again) {
      report(again, 'open-fail-closed');
    }
  }

  /** 写入 store 失败且 store 仍是旧会话：main 已激活候选 → `commit-failed`。写入已生效之后的异常只报告。 */
  function commitCandidate(session: DocumentSession, ticket: DocumentActivationTicket): void {
    try {
      deps.commit(session, 'trusted');
    } catch (error) {
      report(error, 'open-commit');
      if (!committed(session)) {
        dispatch({ type: 'commit-failed', txn: state.txn, ticket });
        return;
      }
    }
    try {
      deps.afterCommit?.();
    } catch (error) {
      report(error, 'open-after-commit');
    }
  }

  function run(effect: OpenFlowEffect): void {
    switch (effect.type) {
      case 'invoke-open': {
        const { txn } = effect;
        invoke(() => deps.bridge().openDocument()).then(
          (reply) => {
            guard(
              txn,
              () => {
                // 只有 opened 需要 dirty：其余应答不读取门控（独立审查 L4）。
                if (!isOpenReply(reply)) dispatch({ type: 'open-threw', txn });
                else dispatch({ type: 'open-replied', txn, reply, replacementBlocked: reply.kind === 'opened' && blocked() });
              },
              openedTicket(reply),
            );
          },
          () => {
            guard(txn, () => {
              dispatch({ type: 'open-threw', txn });
            });
          },
        );
        return;
      }
      case 'invoke-activate': {
        const { txn, attempt, ticket } = effect;
        let settled = false;
        const cancel = deps.schedule(ACTIVATION_TIMEOUT_MS, () => {
          guard(txn, () => {
            if (settled) return;
            settled = true;
            dispatch({ type: 'activate-failed', txn, attempt });
          });
        });
        invoke(() => deps.bridge().activateDocument(ticket)).then(
          (reply) => {
            guard(txn, () => {
              settled = true;
              cancel();
              // 已超时尝试的迟到应答同样回送：明确结果对仍在进行的事务有效，事务已终结时由状态机忽略。
              if (!isActivateReply(reply)) {
                dispatch({ type: 'activate-failed', txn, attempt });
                return;
              }
              // 即将提交：先结束组字（discard → blur），再读 dirty（r3 §8 提交前顺序）。
              if (reply.ok && activating(state, txn)) editor.beforeCommit();
              dispatch({ type: 'activate-replied', txn, attempt, reply, replacementBlocked: blocked() });
            });
          },
          () => {
            guard(txn, () => {
              const first = !settled;
              settled = true;
              cancel();
              if (first) dispatch({ type: 'activate-failed', txn, attempt });
            });
          },
        );
        return;
      }
      case 'send-reject':
        ledger.send(effect.ticket);
        return;
      case 'commit':
        commitCandidate(effect.session, effect.ticket);
        return;
      case 'downgrade-trust':
        deps.downgradeTrust();
        return;
      case 'replacement-refused':
        editor.notify({ kind: effect.stage === 'before-activation' ? 'open-candidate-dropped-dirty' : 'open-commit-refused-dirty' });
        if (approval !== null) reask = true;
        return;
    }
  }

  function open(): void {
    const { guard } = deps;
    if (state.phase === 'idle') {
      const gate = editor.gate();
      if (gate.composing || (gate.dirty && guard === undefined)) {
        editor.notify({ kind: gate.dirty && guard === undefined ? 'open-refused-dirty' : 'open-refused-composing' });
        return;
      }
      // 根卸载后守卫没有宿主：没有界面可以询问或呈现结果，Open 一律拒绝。
      if (guard !== undefined && !guard.hasHost()) return;
      if (deps.admission !== undefined) {
        const allowed = (again: OpenGate): boolean => state.phase === 'idle' && lease === null && !again.composing && (guard !== undefined || !again.dirty);
        // 有守卫时 dirty 不是拒绝理由（改为询问）：提示只按组字 / 另一项文件操作 / 未送达给出。
        const refuse = (reason: OpenAdmissionRefusal): void =>
          editor.notify({ kind: admissionNotice(reason, guard === undefined ? editor.gate() : { ...editor.gate(), dirty: false }) });
        const begin = (granted: FileIntentLease): void => {
          if (guard !== undefined && editor.gate().dirty && deps.admission !== undefined) askGuard(granted, guard, deps.admission);
          else start(granted);
        };
        deps.admission.admit({ begin, refuse, stillAllowed: () => allowed(editor.gate()) });
        return;
      }
    }
    start(null);
  }

  return {
    open,
    dismissNotice: () => dispatch({ type: 'notice-dismissed' }),
    state: () => state,
  };
}

/** open 应答中可识别的候选票据：requesting 阶段异常时据此撤回 main 中 pending 的候选；识别不了为 null（与 sessionFactory 的票据规则一致）。 */
function openedTicket(reply: unknown): DocumentActivationTicket | null {
  if (!isOpenReply(reply) || reply.kind !== 'opened') return null;
  const document: unknown = reply.document;
  if (!isRecord(document) || !isRecord(document.file) || !isRecord(document.file.capability)) return null;
  const { documentId } = document;
  const capabilityId = document.file.capability.id;
  if (typeof documentId !== 'number' || !Number.isSafeInteger(documentId) || documentId < 1) return null;
  if (typeof capabilityId !== 'string' || capabilityId === '') return null;
  return { capabilityId, documentId };
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
  commit: (session, trust) => {
    commitSession(session, trust);
  },
  afterCommit: () => {
    museParseController.documentReplaced();
  },
  downgradeTrust: downgradeCapabilityTrust,
  publish: publishOpenView,
  report: reportEditorError,
  ledger: museRejectLedger,
  admission: museOpenAdmission,
  guard: museGuardController,
  version: () => {
    const { documentId, sourceVersion } = useMuseAppStore.getState().session;
    return { documentId, sourceVersion };
  },
  editor: {
    gate: () => museEditorController.openGate(),
    beforeCommit: () => {
      museEditorController.prepareReplacement();
    },
    setReplacementPending: (pending) => {
      museEditorController.setReplacementPending(pending);
    },
    notify: (notice) => {
      publishEditorView({ notice });
    },
  },
});
