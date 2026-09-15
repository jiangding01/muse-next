/**
 * JCX Lossless AST —— 节点路径工具（M1.5 T1）。
 *
 * 路径形如 `L12`（第 12 行，0-based）、`L12.3`（该行第 3 个子节点）、`L12.3.1`（更深一层），
 * 全部 0-based，层级用 `.` 连接。
 *
 * **稳定性承诺：仅在单次 AST 快照内唯一且确定。**
 * 同一份 `JcxLexResult` 重复 `buildAst` 得到同一批路径；但**不跨编辑稳定**——
 * 任何插入 / 删除行都会让其后的路径整体平移。禁止把 AstPath 写进文件、undo 栈，
 * 或当成跨文档的长期引用。
 *
 * 纯函数，无状态，不依赖 Node / Electron。
 */

import type { AstPath } from './nodes';

export interface ParsedAstPath {
  /** 0-based 行下标。 */
  readonly line: number;
  /** 逐层 0-based 子节点下标，行本身为空数组。 */
  readonly indices: readonly number[];
}

const PATH_RE = /^L(\d+)((?:\.\d+)*)$/;

/**
 * 构造行节点路径：`linePath(12) === 'L12'`。
 *
 * @throws RangeError 下标不是非负整数（负数 / 小数 / NaN / Infinity）。
 *   这类输入一律是调用方的 bug，静默归一只会把错误路径悄悄写进 AST。
 */
export function linePath(lineIndex: number): AstPath {
  return `L${assertIndex(lineIndex, 'lineIndex')}`;
}

/**
 * 构造子节点路径：`childPath('L12', 3) === 'L12.3'`。
 *
 * @throws RangeError 下标不是非负整数。
 */
export function childPath(parent: AstPath, index: number): AstPath {
  return `${parent}.${assertIndex(index, 'index')}`;
}

/**
 * 解析路径；形态非法（含负数、前导零之外的任何杂质）时返回 `null`，绝不抛异常。
 */
export function parseAstPath(path: string): ParsedAstPath | null {
  const match = PATH_RE.exec(path);
  if (!match) {
    return null;
  }
  const line = Number(match[1]);
  const rest = match[2] ?? '';
  const indices = rest.length === 0 ? [] : rest.slice(1).split('.').map(Number);
  return { line, indices };
}

/** 路径是否是 `ancestor` 的严格后代（`L1` 是 `L1.0` 的祖先，但不是自己的）。 */
export function isDescendantPath(ancestor: AstPath, path: AstPath): boolean {
  return path.length > ancestor.length && path.startsWith(`${ancestor}.`);
}

function assertIndex(index: number, name: string): number {
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${index}`);
  }
  return index;
}
