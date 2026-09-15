/**
 * JCX Lossless AST —— 对外入口（M1.5）。
 *
 * 分层约定（HANDOFF §53）：`RAW SOURCE → LOSSLESS AST → NORMALIZED DOMAIN → APPLICATION`。
 * 本模块只负责中间那一层的**结构化**，不做归一化、不依赖渲染器、不碰 Node / Electron。
 */

export type {
  AstPath,
  JcxAstNodeBase,
  JcxAstNode,
  JcxAstDocument,
  JcxTokenLeaf,
  JcxTokenLeafOf,
  JcxBodyLeafKind,
  JcxBodyLeafNode,
  JcxBodyNode,
  JcxNoteNode,
  JcxRestNode,
  JcxChordNode,
  JcxGraceNode,
  JcxTabNoteNode,
  JcxTabGroupNode,
  JcxLineNode,
  JcxMagicHeaderLineNode,
  JcxFieldLineNode,
  JcxDirectiveLineNode,
  JcxCommentLineNode,
  JcxBlankLineNode,
  JcxInlineFieldLineNode,
  JcxBodyLineNode,
  JcxRawLineNode,
  JcxTextBlockBoundaryLineNode,
  JcxTextLineNode,
  JcxTextBlockNode,
} from './nodes';
export { isLeaf, isTokenLeaf, isTextBlock } from './nodes';

export type { ParsedAstPath } from './astPath';
export { linePath, childPath, parseAstPath, isDescendantPath } from './astPath';

export { printNode, printLine, printAst } from './printAst';

import type { JcxLexResult } from '../lexer';
import type { JcxAstDocument } from './nodes';

/**
 * 把 M1.4 的词法结果结构化为 Lossless AST。
 *
 * 契约（M1.5 已拍板）：
 * - **只分组、不重扫**：输入的 token 流原样进入叶子，不重新扫描字符、零归一化；
 * - 不变量 `printAst(buildAst(result)) === source`；
 * - 永不抛异常（实现完成后）：一切异常写法降级为 raw 节点 + diagnostic；
 * - 无增量接口：不接受 previousAst，不做复用。
 *
 * @throws 目前恒抛 —— 实现由 M1.5 T2–T4 补齐，T1 只落地类型与打印器。
 */
export function buildAst(lexResult: JcxLexResult): JcxAstDocument {
  void lexResult;
  throw new Error('buildAst is not implemented yet (M1.5 T2–T4)');
}
