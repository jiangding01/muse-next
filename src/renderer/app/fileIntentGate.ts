/**
 * 文件操作准入租约（M3 T4 B3a-1；B3 r0.1 勘误 §1，H-B3-1）。
 *
 * - Open、Save、Save As 共用一把模块级租约：每个操作在入口第一个 `await` **之前**同步 `tryAcquire`，拿不到即同步拒绝
 *   （不等输入法、不弹对话框、不发 IPC）。
 * - 身份是租约对象本身（引用相等）；`id` 在页面生命周期内单调递增、从不复用，只用于诊断与测试。
 * - 只有持有者能释放（CAS）：旧任务的迟到释放是空操作，不会放掉新任务的租约。
 * - 租约只记录准入身份与获取时的 `documentId`（供 `await` 恢复后核对文档身份），不存任何文档事实——source、版本、文件与
 *   能力只在 store 中。store 的 `fileOp`（T0 `{ kind }`）仍是捕获保存快照之后回写的 CAS 依据，与租约并存。
 * - 不自动过期：main 一直不响应时所有文件操作都被拒（r1.2 ERRATA §2.5 的已知残余）。
 */

export type FileIntentKind = 'open' | 'save' | 'saveAs';

export interface FileIntentLease {
  readonly id: number;
  readonly kind: FileIntentKind;
  /** 获取时的文档号：`await` 恢复后与 store 当前会话比对。 */
  readonly documentId: number;
}

export interface FileIntentGate {
  /** 同步获取；已有持有者时返回 null。 */
  tryAcquire(kind: FileIntentKind, documentId: number): FileIntentLease | null;
  /** 该租约是否仍是当前持有者（引用相等）。 */
  holds(lease: FileIntentLease): boolean;
  /** 只有持有者能释放；否则无操作。 */
  release(lease: FileIntentLease): void;
  /** 只读诊断快照。 */
  current(): FileIntentLease | null;
}

export function createFileIntentGate(): FileIntentGate {
  let held: FileIntentLease | null = null;
  let lastId = 0;
  return {
    tryAcquire(kind, documentId) {
      if (held !== null) return null;
      lastId += 1;
      held = Object.freeze({ id: lastId, kind, documentId });
      return held;
    },
    holds: (lease) => held === lease,
    release(lease) {
      if (held === lease) held = null;
    },
    current: () => held,
  };
}

/** 产品使用的模块级准入租约（renderer 中唯一一份）。 */
export const museFileIntentGate: FileIntentGate = createFileIntentGate();
