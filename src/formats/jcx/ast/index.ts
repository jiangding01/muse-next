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

export type { ParsedAstPath, ParsedLineAstPath, ParsedDocumentAstPath } from './astPath';
export { linePath, childPath, parseAstPath, isDescendantPath, bomPath } from './astPath';
import { bomPath } from './astPath';

export { printNode, printLine, printAst } from './printAst';

export { buildLineNodes } from './buildLines';

import type { JcxLexResult } from '../lexer';
import { tokenLeaf } from './leaf';
import type { JcxAstDocument, JcxTokenLeaf } from './nodes';
import { buildLineNodes } from './buildLines';

/**
 * §6.5：BOM 不是任何一行的内容（被 `buildLineNodes` 从第 0 行 children 里剥离，
 * 避免 `printAst` 把它打印两遍），因此它不落在「行 / 行内子节点」这套路径体系里。
 * 取舍：给它一个不会与任何 `linePath` / `childPath` 冲突的固定 path 字面量
 * ——`AstPath` 只是 `` `L${string}` `` 模板类型，不强制数字形态，`parseAstPath`
 * 对这个值返回 `null` 是预期行为（它本就不是「某一行」）。
 */

function extractBom(lexResult: JcxLexResult): JcxTokenLeaf | undefined {
  if (!lexResult.hasBom) {
    return undefined;
  }
  const firstToken = lexResult.lines[0]?.tokens[0];
  if (firstToken === undefined || firstToken.kind !== 'bom') {
    return undefined;
  }
  return tokenLeaf(firstToken, bomPath());
}

/**
 * 把 M1.4 的词法结果结构化为 Lossless AST。
 *
 * 契约（M1.5 已拍板）：
 * - **只分组、不重扫**：输入的 token 流原样进入叶子，不重新扫描字符、零归一化；
 * - 不变量 `printAst(buildAst(result)) === source`；
 * - 永不抛异常：`buildLineNodes` 只做结构化分组，不做任何可能失败的解析；
 * - 无增量接口：不接受 previousAst，不做复用；
 * - `diagnostics` 直接透传 lexer 的列表——AST 层（T2）本身不新增诊断。
 */
export function buildAst(lexResult: JcxLexResult): JcxAstDocument {
  const bom = extractBom(lexResult);
  return {
    encoding: lexResult.encoding,
    hasBom: lexResult.hasBom,
    ...(bom !== undefined ? { bom } : {}),
    hasTrailingNewline: lexResult.hasTrailingNewline,
    lines: buildLineNodes(lexResult),
    diagnostics: lexResult.diagnostics,
  };
}
