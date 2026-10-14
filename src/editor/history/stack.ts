/**
 * History 栈：持久化单链表（M3 T2 Preflight r3 §6.8）。
 *
 * 压栈与替换栈顶都只新建一个节点，`rest` 直接引用旧节点（结构共享），旧状态的任何节点都不被修改，
 * 因此旧的 HistoryState 始终可以当作不可变快照使用。所有操作 O(1)。
 */

import type { HistoryStack, HistoryTransaction } from './types';

export function push(stack: HistoryStack | null, top: HistoryTransaction): HistoryStack {
  return Object.freeze({ top, rest: stack, size: (stack?.size ?? 0) + 1 });
}

export function replaceTop(stack: HistoryStack, top: HistoryTransaction): HistoryStack {
  return Object.freeze({ top, rest: stack.rest, size: stack.size });
}
