/**
 * Open 的准入入口（M3 T4 B3a-1；B3 r0.1 勘误 §1 H-B3-1 / §2 H-B3-2，Gate B3a-1 追加硬门 2）。
 *
 * - **同步获取准入租约**：在任何 `await` 之前 `tryAcquire('open')`；会话上已有进行中的文件操作或租约被占用 → 同步拒绝
 *   （`busy`），不 flush、不打开对话框、不发 IPC。
 * - **R20 送达门**：账本非空时先 `flush()` 并等待；账本为空时不让出事件循环（与 B3 之前的 Open 时序一致）。
 * - **最终同步核对**（flush 之后、开始事务之前，二者之间没有 `await`）：租约仍由本次持有、账本为空、文档号未变、会话上没有
 *   进行中的文件操作，并由调用方复核入口门（Open 仍 idle、未 dirty、未组字）。任一不成立 → 释放租约并拒绝。
 * - 通过后把租约交给 Open 控制器：控制器持有它直到事务的全部终态效果处理完成（含异常、取消与迟到回调），再以 CAS 释放；
 *   其间每个 await 恢复之后经 `holds` 复核租约与文档号，不成立即 fail closed（勘误 §1.3）。
 * - 账本只表示 main 已处理 reject，不推断锚点已收敛；main 的 R19 独立强制执行。
 */

import { isFileOperationBusy } from '../../../editor/session/derive';
import { museFileIntentGate } from '../fileIntentGate';
import type { FileIntentGate, FileIntentLease } from '../fileIntentGate';
import { museRejectLedger } from '../save/rejectLedger';
import type { FlushOutcome, RejectLedger } from '../save/rejectLedger';
import { useMuseAppStore } from '../store';
import type { OpenGate } from './editorController';
import type { EditorNoticeKind } from './editorTransitions';

export type OpenAdmissionRefusal = 'busy' | 'reject-pending' | 'changed';

export interface OpenAdmissionDeps {
  readonly gate: FileIntentGate;
  readonly ledger: Pick<RejectLedger, 'flush' | 'pending'>;
  /** store 当前文档号，以及会话上是否有进行中的文件操作（`fileOp !== null`）。 */
  readonly document: () => { readonly documentId: number; readonly fileBusy: boolean };
}

export interface OpenAdmissionHandlers {
  /** 准入通过：同步开始事务（调用方持有租约直到事务终态）。 */
  begin(lease: FileIntentLease): void;
  /** 准入被拒（同步或在 flush 之后）；租约已释放。 */
  refuse(reason: OpenAdmissionRefusal): void;
  /** 调用方入口门的复核：Open 仍 idle、未 dirty、未组字。 */
  stillAllowed(): boolean;
}

export interface OpenAdmission {
  admit(handlers: OpenAdmissionHandlers): void;
  /** await 恢复之后的复核：租约仍由本次持有，且 store 文档号仍是获取时的文档号（勘误 §1.3）。 */
  holds(lease: FileIntentLease): boolean;
  release(lease: FileIntentLease): void;
}

export function createOpenAdmission(deps: OpenAdmissionDeps): OpenAdmission {
  function finalCheck(lease: FileIntentLease, outcome: FlushOutcome, handlers: OpenAdmissionHandlers): OpenAdmissionRefusal | null {
    if (!deps.gate.holds(lease)) return 'changed';
    if (outcome !== 'delivered' || deps.ledger.pending() !== 0) return 'reject-pending';
    const current = deps.document();
    if (current.documentId !== lease.documentId || current.fileBusy) return 'changed';
    return handlers.stillAllowed() ? null : 'changed';
  }

  function settle(lease: FileIntentLease, outcome: FlushOutcome, handlers: OpenAdmissionHandlers): void {
    let reason: OpenAdmissionRefusal | null;
    try {
      reason = finalCheck(lease, outcome, handlers);
    } catch {
      reason = 'changed';
    }
    if (reason === null) {
      try {
        handlers.begin(lease);
      } catch {
        // 回调永不抛出到事件循环：开始失败即释放（CAS；调用方若已接管并释放，这里是空操作）。
        deps.gate.release(lease);
      }
      return;
    }
    deps.gate.release(lease);
    try {
      handlers.refuse(reason);
    } catch {
      // 拒绝提示失败不影响已释放的租约。
    }
  }

  return {
    admit(handlers) {
      const { documentId, fileBusy } = deps.document();
      const lease = fileBusy ? null : deps.gate.tryAcquire('open', documentId);
      if (lease === null) {
        try {
          handlers.refuse('busy');
        } catch {
          // 拒绝提示失败不外泄（同步入口）。
        }
        return;
      }
      let flushed: Promise<FlushOutcome> | null;
      try {
        flushed = deps.ledger.pending() === 0 ? null : deps.ledger.flush();
      } catch {
        flushed = Promise.resolve('undelivered');
      }
      if (flushed === null) {
        settle(lease, 'delivered', handlers);
        return;
      }
      flushed.then(
        (outcome) => {
          settle(lease, outcome, handlers);
        },
        () => {
          settle(lease, 'undelivered', handlers);
        },
      );
    },
    holds(lease) {
      return deps.gate.holds(lease) && deps.document().documentId === lease.documentId;
    },
    release(lease) {
      deps.gate.release(lease);
    },
  };
}

/** 拒绝原因 → 编辑器提示：未送达优先；否则按当前入口门（dirty / 组字）给出具体原因，其余为「另一项文件操作进行中」。 */
export function admissionNotice(reason: OpenAdmissionRefusal, gate: OpenGate): EditorNoticeKind {
  if (reason === 'reject-pending') return 'open-refused-reject-pending';
  if (gate.dirty) return 'open-refused-dirty';
  return gate.composing ? 'open-refused-composing' : 'open-refused-busy';
}

/** 产品使用的 Open 准入（共享准入租约 + 共享 reject 账本）。 */
export const museOpenAdmission: OpenAdmission = createOpenAdmission({
  gate: museFileIntentGate,
  ledger: museRejectLedger,
  document: () => {
    const { session } = useMuseAppStore.getState();
    return { documentId: session.documentId, fileBusy: isFileOperationBusy(session) };
  },
});
