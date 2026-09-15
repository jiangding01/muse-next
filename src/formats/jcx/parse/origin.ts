/**
 * Parse 层 —— `SourceRef` 写入工具（M1.6 方案 v1.1 §1.1）。
 *
 * Domain 的 `SourceRef` 是不透明字符串；这里是唯一把 `AstPath` 降级成它的地方，
 * 于是 `src/domain/**` 不必认识 ast 层（架构守卫测试保证）。
 *
 * 稳定性同 `AstPath`：仅在单次快照内有效，禁止持久化。
 */

import type { AstPath } from '../ast';
import type { SourceRef } from '../../../domain';

/** 任何带 path 的 AST 节点（行节点、body 节点、token 叶子都满足）。 */
export interface HasAstPath {
  readonly path: AstPath;
}

/** 取单个节点的 origin。 */
export function originOf(node: HasAstPath): SourceRef {
  return node.path;
}

/** 取一组节点的 origins（顺序保持输入顺序）。 */
export function originsOf(nodes: readonly HasAstPath[]): readonly SourceRef[] {
  return nodes.map(originOf);
}
