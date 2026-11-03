/**
 * 保存控制器（M3 T4 B3a-2；B3 r0 §2.1 a2、§3.2–§3.7，r0.1 勘误 §1–§3，Gate B3a-2 授权的安全约束）。
 *
 * 执行 `stepSaveFlow` 的效果；模块级对象，不在任何 React 组件生命周期里（根卸载后菜单 Save / Save As 仍可用，结果经
 * store 的保存视图与 `fatalError` 的非 React 出口提示）。
 *
 * - **准入**：`save()` / `saveAs()` 第一行同步 `tryAcquire`（与 Open 共用 `fileIntentGate`），在首个 `await` 之前建立独占
 *   身份；拿不到即同步提示 busy，不等待、不弹对话框、不发 IPC。租约持有到事务终态的全部效果执行完（含 reject 入账、
 *   结束操作、提示），由最外层派发以 CAS 释放。
 * - **每个 await 恢复之后**先复核：租约仍由本次持有、store 文档号仍是获取时的文档号；不成立 → `aborted`（勘误 §1.3）。
 * - **R5**：先订阅输入法视图、再 blur、再核验，通知或 500 ms 超时二者取先；所有结束路径都解除订阅与定时器；不 discard。
 * - **R20 送达门**：账本非空时 flush 并等待，之后**同步**最终核对：租约、账本为空、文档号、源能力仍是入口时的能力
 *   （Save As 阶段 2 之前再做一次，不复用阶段 1 之前的结果）。账本 `{ ok: true }` 只表示 main 已处理；R19 由 main 独立强制。
 * - **捕获与 CAS**：写入之前捕获 source 并 `beginFileOperation`；结果只经 store 的 CAS 写入函数（documentId + op 引用）回写，
 *   检查点只取捕获值（保存期间继续输入仍 dirty，M18）。
 * - 回调异常一律报告后按阶段 fail closed（`aborted`），不向事件循环抛出。
 */

import { findUnencodableCharacters } from '../../../editor/save/precheck';
import { isSourceDirty } from '../../../editor/session/derive';
import type { FileOperation } from '../../../editor/session/types';
import type { JcxEncoding } from '../../../formats/jcxParse';
import type { DocumentActivationTicket } from '../../../shared/activationContracts';
import type { MuseDesktopApi } from '../../../shared/ipc';
import { museImeSession } from '../editor/imeSession';
import type { ImeSession } from '../editor/imeSession';
import { museParseController } from '../editor/parseController';
import { sourceEditingEnabled } from '../editor/sourceEditorBinding';
import { reportEditorError } from '../fatalError';
import { museFileIntentGate } from '../fileIntentGate';
import type { FileIntentGate, FileIntentLease } from '../fileIntentGate';
import type { SaveResult } from '../guard/replacementGuard';
import { beginFileOperation, downgradeCapabilityTrust, finishFileOperation, publishSaveView, settleSave, settleSaveAs, useMuseAppStore } from '../store';
import { museRejectLedger } from './rejectLedger';
import type { FlushOutcome, RejectLedger } from './rejectLedger';
import type { SaveMessage } from './saveMessages';
import {
  committedOf,
  IME_SETTLE_TIMEOUT_MS,
  initialSaveFlow,
  isActivateReply,
  SAVE_ACTIVATION_TIMEOUT_MS,
  saveReply,
  stepSaveFlow,
  targetReply,
  trustAfterSaveAsFailure,
} from './saveTransaction';
import type { SaveFlowEffect, SaveFlowEvent, SaveFlowState, SaveKind, UnencodableAt } from './saveTransaction';

export interface SaveControllerDeps {
  readonly gate: FileIntentGate;
  readonly ledger: Pick<RejectLedger, 'send' | 'flush' | 'pending'>;
  readonly bridge: () => Pick<MuseDesktopApi, 'requestSaveTarget' | 'saveDocument' | 'activateDocument'>;
  readonly ime: Pick<ImeSession, 'view' | 'subscribe'>;
  /** 让源码面板失焦（R5：输入法可能因此同步结束组字）。 */
  readonly blur: () => void;
  /** R5 之后 `flush('blur')`：立即解析挂起的修改，再重读 store。 */
  readonly flushParse: () => void;
  /** Q4：Save As 切换成功后对同一版本静默强制解析（编码标注跟上新的 writeEncoding）。 */
  readonly refreshParse: () => void;
  /** 本平台是否开放普通 Save（R10）。 */
  readonly saveEnabled: () => boolean;
  readonly schedule: (delayMs: number, task: () => void) => () => void;
  readonly report: (error: unknown, context: string) => void;
  readonly publish: (message: SaveMessage) => void;
}

export interface SaveController {
  save(): void;
  /** `utf8`：Q-B3-9 的「另存为 UTF-8」入口（SaveEntry）；缺省保持会话编码（unsafe 文档仍自动改为 UTF-8）。 */
  saveAs(options?: { readonly utf8?: boolean }): void;
  /**
   * M3 T4 B3b：替换守卫的「保存」分支。复用 Open 已持有的共享租约（要求 `holds(lease) && lease.kind === 'open'`），
   * 不另取租约、结束时不释放它；R5、R20、CAS 与 main R19 照旧。`SaveResult` 只在保存事务的全部终态效果（含结束
   * fileOp）执行完之后给出：`ok` 只认确定的成功，未确认 / 结果未知 / 失败都不是 ok。
   */
  saveWithin(lease: FileIntentLease): Promise<SaveResult>;
  state(): SaveFlowState;
}

interface Entry {
  /** 入口时会话的文件能力（demo 为 null）：R19 的 `sourceCapabilityId`，也是两道送达门复核的源能力。 */
  readonly sourceCapabilityId: string | null;
  /** Save As 的写入编码（Q-B3-9：保持会话编码；unsafe 文档改为 UTF-8），阶段 1 与阶段 2 必须相同。 */
  readonly encoding: JcxEncoding;
  /** unsafe 文档的 Save As 改用 UTF-8（Q-B3-9：切换成功的提示中说明）。 */
  readonly toUtf8: boolean;
}

/** 借用 Open 租约的这一次保存（守卫）：结果的接收者与发起时的文档号。 */
interface Borrowed {
  readonly documentId: number;
  readonly resolve: (result: SaveResult) => void;
}

/** 视为「保存成功」的提示：已保存、已另存为、没有需要保存的修改。 */
const OK_MESSAGES: ReadonlySet<SaveMessage['kind']> = new Set(['saved', 'saved-as', 'saved-as-utf8', 'nothing-to-save']);

interface Captured {
  readonly documentId: number;
  readonly op: FileOperation;
  readonly source: string;
}

export function createSaveController(deps: SaveControllerDeps): SaveController {
  let state = initialSaveFlow();
  let lease: FileIntentLease | null = null;
  let entry: Entry | null = null;
  let captured: Captured | null = null;
  let borrowed: Borrowed | null = null;
  let last: SaveMessage | null = null;
  let depth = 0;

  const report = (error: unknown, context: string): void => {
    try {
      deps.report(error, context);
    } catch {
      // 报告失败已无处可报；收束照常进行。
    }
  };

  /** 本次事务的租约仍由本次持有，且 store 文档号未变（勘误 §1.3）。 */
  const held = (): boolean => lease !== null && deps.gate.holds(lease) && useMuseAppStore.getState().session.documentId === lease.documentId;

  function dispatch(event: SaveFlowEvent): void {
    const step = stepSaveFlow(state, event);
    state = step.state;
    depth += 1;
    try {
      // 效果逐个隔离：一个效果抛错（报告）不跳过后面的 reject 入账、结束操作与提示，fileOp 不会残留。
      for (const effect of step.effects) {
        try {
          run(effect);
        } catch (error) {
          report(error, `save-effect:${effect.type}`);
        }
      }
    } finally {
      depth -= 1;
      // 终态的全部效果执行完之后才释放（只在最外层派发；嵌套派发如 settle-failed 不提前释放）。
      if (depth === 0 && state.phase === 'idle') {
        // 借用的 Open 租约不释放（属于 Open）；结果在全部终态效果之后给出（M25）。
        if (lease !== null && borrowed === null) deps.gate.release(lease);
        const sink = borrowed;
        const outcome = last;
        lease = null;
        entry = null;
        captured = null;
        borrowed = null;
        last = null;
        if (sink !== null) sink.resolve(saveResultOf(sink.documentId, outcome));
      }
    }
  }

  function saveResultOf(documentId: number, outcome: SaveMessage | null): SaveResult {
    const { session } = useMuseAppStore.getState();
    const ok = outcome !== null && OK_MESSAGES.has(outcome.kind);
    return { ok, clean: ok && session.documentId === documentId && session.fileOp === null && !isSourceDirty(session) };
  }

  function fail(txn: number, error: unknown): void {
    report(error, 'save');
    try {
      dispatch({ type: 'aborted', txn, committed: null, ticket: null });
    } catch (again) {
      report(again, 'save-fail-closed');
    }
  }

  /** await 恢复后的统一入口：迟到（事务已终结或已换代）直接忽略；租约 / 文档身份不成立 → aborted；否则执行。 */
  function resume(txn: number, task: () => void, committed: boolean | null = null, ticket: DocumentActivationTicket | null = null): void {
    if (txn !== state.txn || state.phase === 'idle') return;
    try {
      if (!held()) {
        dispatch({ type: 'aborted', txn, committed, ticket });
        return;
      }
      task();
    } catch (error) {
      fail(txn, error);
    }
  }

  /** R5：先订阅、再 blur、再核验；通知或超时；所有路径解除订阅与定时器。 */
  async function settleIme(): Promise<'ready' | 'timeout'> {
    if (deps.ime.view() !== 'composing') return 'ready';
    let finish: (outcome: 'ready' | 'timeout') => void = () => undefined;
    const settled = new Promise<'ready' | 'timeout'>((resolve) => {
      finish = resolve;
    });
    const unsubscribe = deps.ime.subscribe((view) => {
      if (view !== 'composing') finish('ready');
    });
    let cancel: () => void = () => undefined;
    try {
      deps.blur();
      if (deps.ime.view() !== 'composing') return 'ready';
      cancel = deps.schedule(IME_SETTLE_TIMEOUT_MS, () => {
        finish('timeout');
      });
      return await settled;
    } finally {
      unsubscribe();
      cancel();
    }
  }

  function flushLedger(): Promise<FlushOutcome> {
    try {
      return deps.ledger.pending() === 0 ? Promise.resolve('delivered') : deps.ledger.flush().catch(() => 'undelivered' as const);
    } catch {
      return Promise.resolve('undelivered');
    }
  }

  function firstUnencodable(source: string, encoding: JcxEncoding): UnencodableAt | null {
    const [first] = findUnencodableCharacters(source);
    return first === undefined ? null : { line: first.line, column: first.column, encoding };
  }

  function invoke<T>(call: () => Promise<T>): Promise<T> {
    try {
      return call();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function write(txn: number, kind: SaveKind, targetCapabilityId: string | null): void {
    const { session } = useMuseAppStore.getState();
    const current = entry;
    const capabilityId = kind === 'save' ? (session.file?.capability.id ?? null) : targetCapabilityId;
    const begun = capabilityId === null || current === null ? null : beginFileOperation(kind);
    if (begun === null || !begun.ok || capabilityId === null || current === null) {
      dispatch({ type: 'aborted', txn, committed: false, ticket: null });
      return;
    }
    captured = { documentId: begun.documentId, op: begun.op, source: begun.capturedSource };
    const base = { capabilityId, documentId: begun.documentId, source: begun.capturedSource };
    const request = kind === 'save' ? { ...base, encoding: session.writeEncoding } : { ...base, encoding: current.encoding, sourceCapabilityId: current.sourceCapabilityId };
    invoke(() => deps.bridge().saveDocument(request)).then(
      (raw) => {
        const reply = saveReply(raw);
        const ticket = reply !== null && reply.outcome !== 'not-committed' ? reply.ticket : null;
        resume(txn, () => dispatch({ type: 'save-replied', txn, reply }), committedOf(reply), ticket);
      },
      () => {
        resume(txn, () => dispatch({ type: 'save-replied', txn, reply: null }));
      },
    );
  }

  function activate(txn: number, attempt: number, ticket: DocumentActivationTicket): void {
    let settled = false;
    const cancel = deps.schedule(SAVE_ACTIVATION_TIMEOUT_MS, () => {
      resume(txn, () => {
        if (settled) return;
        settled = true;
        dispatch({ type: 'activate-failed', txn, attempt });
      });
    });
    invoke(() => deps.bridge().activateDocument(ticket)).then(
      (reply) => {
        resume(txn, () => {
          settled = true;
          cancel();
          // 已超时尝试的迟到明确应答同样回送：事务仍在激活时终结它，已终结时由状态机忽略。
          if (isActivateReply(reply)) dispatch({ type: 'activate-replied', txn, attempt, reply });
          else dispatch({ type: 'activate-failed', txn, attempt });
        });
      },
      () => {
        resume(txn, () => {
          const first = !settled;
          settled = true;
          cancel();
          if (first) dispatch({ type: 'activate-failed', txn, attempt });
        });
      },
    );
  }

  function run(effect: SaveFlowEffect): void {
    switch (effect.type) {
      case 'settle-ime': {
        const { txn } = effect;
        settleIme().then(
          (outcome) => {
            resume(txn, () => {
              deps.flushParse();
              const { session } = useMuseAppStore.getState();
              dispatch({ type: 'ime-settled', txn, outcome, facts: { hasFile: session.file !== null, dirty: isSourceDirty(session) } });
            });
          },
          (error: unknown) => {
            fail(txn, error);
          },
        );
        return;
      }
      case 'check-gate': {
        const { txn, beforeWrite } = effect;
        void flushLedger().then((outcome) => {
          resume(txn, () => {
            // 最终核对（同步，与随后的对话框 / IPC 之间没有 await）：账本为空、源能力仍是入口时的能力（勘误 §2.1：
            // 任一不成立都按送达门拒绝；租约与文档号已由 resume 复核）。
            const { session } = useMuseAppStore.getState();
            const sameSource = (session.file?.capability.id ?? null) === entry?.sourceCapabilityId;
            const delivered = outcome === 'delivered' && deps.ledger.pending() === 0 && sameSource;
            const encoding = state.kind === 'save' ? session.writeEncoding : (entry?.encoding ?? session.writeEncoding);
            dispatch({ type: 'gate-checked', txn, delivered, unencodable: beforeWrite ? firstUnencodable(session.source, encoding) : null });
          });
        });
        return;
      }
      case 'request-target': {
        const { txn } = effect;
        const { session } = useMuseAppStore.getState();
        const request = {
          suggestedName: session.file?.displayName ?? 'untitled.jcx',
          encoding: entry?.encoding ?? session.writeEncoding,
          sourceCapabilityId: entry?.sourceCapabilityId ?? null,
        };
        invoke(() => deps.bridge().requestSaveTarget(request)).then(
          (raw) => {
            resume(txn, () => dispatch({ type: 'target-replied', txn, reply: targetReply(raw) }));
          },
          () => {
            resume(txn, () => dispatch({ type: 'target-replied', txn, reply: null }));
          },
        );
        return;
      }
      case 'write':
        write(effect.txn, effect.kind, effect.target?.capabilityId ?? null);
        return;
      case 'activate':
        activate(effect.txn, effect.attempt, effect.ticket);
        return;
      case 'settle-save': {
        if (captured === null) return;
        const settled = settleSave(captured.documentId, captured.op, captured.source);
        if (!settled.ok) {
          finishFileOperation(captured.documentId, captured.op, false);
          last = { kind: 'result-not-applied' };
          deps.publish(last);
          return;
        }
        if (effect.downgrade) downgradeCapabilityTrust();
        return;
      }
      case 'settle-save-as': {
        if (captured === null) return;
        const { activation, txn } = effect;
        const facts = {
          file: { capability: { id: activation.ticket.capabilityId }, displayName: activation.displayName, displayPath: activation.displayPath },
          writeEncoding: activation.writeEncoding,
          byteBom: activation.byteBom,
          encodingRoundTrip: activation.encodingRoundTrip,
        };
        if (!settleSaveAs(captured.documentId, captured.op, captured.source, facts).ok) {
          finishFileOperation(captured.documentId, captured.op, false);
          dispatch({ type: 'settle-failed', txn, ticket: activation.ticket, displayName: activation.displayName });
          return;
        }
        // Q4：会话已切换（写入已生效）；静默重解析的异常只报告，不影响切换结果。
        try {
          deps.refreshParse();
        } catch (error) {
          report(error, 'save-as-reparse');
        }
        return;
      }
      case 'finish': {
        if (captured === null) return;
        const { session, capabilityTrust } = useMuseAppStore.getState();
        const downgrade = effect.reason === 'save-as-activation' && trustAfterSaveAsFailure(session.file, capabilityTrust) !== capabilityTrust;
        finishFileOperation(captured.documentId, captured.op, downgrade);
        return;
      }
      case 'send-reject':
        deps.ledger.send(effect.ticket);
        return;
      case 'flush-ledger':
        void flushLedger();
        return;
      case 'report': {
        const message: SaveMessage =
          effect.message.kind === 'saved-as' && entry?.toUtf8 === true ? { kind: 'saved-as-utf8', displayName: effect.message.displayName } : effect.message;
        last = message;
        deps.publish(message);
        return;
      }
    }
  }

  function start(kind: SaveKind, utf8 = false, within: { readonly lease: FileIntentLease; readonly resolve: (result: SaveResult) => void } | null = null): void {
    try {
      const { session } = useMuseAppStore.getState();
      // 首个 await 之前同步获取共享租约：Open / 另一次保存进行中（含尚未建立 fileOp 的准入期）都拿不到。
      // 守卫的保存（within）不另取租约，而是复用 Open 已持有的那一张（必须仍由它持有、属于 Open、文档号一致）。
      const usable =
        within !== null && deps.gate.holds(within.lease) && within.lease.kind === 'open' && within.lease.documentId === session.documentId ? within.lease : null;
      const granted = state.phase === 'idle' && session.fileOp === null ? (within === null ? deps.gate.tryAcquire(kind, session.documentId) : usable) : null;
      if (granted === null) {
        // 先交付守卫的结果：提示抛错也不能让守卫停在「保存中」、永久占住 Open 的租约。
        within?.resolve({ ok: false, clean: false });
        deps.publish({ kind: 'busy' });
        return;
      }
      lease = granted;
      borrowed = within === null ? null : { documentId: session.documentId, resolve: within.resolve };
      const toUtf8 = (session.encodingRoundTrip === 'unsafe' || utf8) && session.writeEncoding !== 'utf-8';
      entry = { sourceCapabilityId: session.file?.capability.id ?? null, encoding: toUtf8 ? 'utf-8' : session.writeEncoding, toUtf8 };
      dispatch({ type: 'save-requested', kind, saveEnabled: deps.saveEnabled() });
    } catch (error) {
      report(error, 'save');
      if (state.phase === 'idle' && lease !== null) {
        if (borrowed === null) deps.gate.release(lease);
        else borrowed.resolve({ ok: false, clean: false });
        lease = null;
        borrowed = null;
      }
    }
  }

  return {
    save: () => {
      start('save');
    },
    saveAs: (options) => {
      start('saveAs', options?.utf8 === true);
    },
    saveWithin: (granted) =>
      new Promise<SaveResult>((resolve) => {
        start('save', false, { lease: granted, resolve });
      }),
    state: () => state,
  };
}

/** R5 前让源码面板失焦（输入法可能因此同步派发 compositionend；保存路径不 discard，只等待它结束）。 */
function blurSourceEditor(): void {
  const doc = globalThis.document;
  if (doc === undefined) return;
  const active = doc.activeElement;
  if (active instanceof HTMLTextAreaElement && active.classList.contains('source-editor')) active.blur();
}

/** 产品使用的模块级保存控制器。 */
export const museSaveController: SaveController = createSaveController({
  gate: museFileIntentGate,
  ledger: museRejectLedger,
  bridge: () => window.museDesktop,
  ime: museImeSession,
  blur: blurSourceEditor,
  flushParse: () => {
    museParseController.flush('blur');
  },
  refreshParse: () => {
    museParseController.refreshSnapshot();
  },
  saveEnabled: sourceEditingEnabled,
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
  report: reportEditorError,
  publish: (message) => {
    publishSaveView({ message });
  },
});
