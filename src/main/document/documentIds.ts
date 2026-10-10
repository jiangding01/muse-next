/**
 * 进程级 documentId 分配器（`docs/M3_EDITOR_CORE_PLAN.md` §7.1，用户裁决 D2）。
 *
 * - documentId 是 `number`；分配器从 1 开始严格递增（0 留给 renderer 启动 demo，T1c）。
 * - 只在 Open 完整成功（读取 + 解码都通过）后分配；将来 New 也用同一个分配器。
 * - 超出 `Number.MAX_SAFE_INTEGER` 抛 RangeError，而不是静默重复或丢精度。
 * - 闭包实现，不用 class；main 进程持有唯一实例（T1b 接线）。
 */

export interface DocumentIdAllocator {
  next(): number;
}

/**
 * `lastIssued` 只用于测试上界（生产调用不传，等价于 0，即首个 id 为 1）；必须是非负安全整数。
 */
export function createDocumentIdAllocator(lastIssued = 0): DocumentIdAllocator {
  if (!Number.isSafeInteger(lastIssued) || lastIssued < 0) {
    throw new RangeError('createDocumentIdAllocator: lastIssued must be a non-negative safe integer');
  }
  let last = lastIssued;
  return {
    next: () => {
      if (last >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError('documentId allocator exhausted (exceeded Number.MAX_SAFE_INTEGER)');
      }
      last += 1;
      return last;
    },
  };
}
