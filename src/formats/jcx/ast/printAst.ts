/**
 * JCX Lossless AST —— 打印器（M1.5 T1）。
 *
 * 唯一职责：把 AST 还原成原文。核心不变量（M1.5 DoD，HANDOFF §57）：
 *
 * ```text
 * printAst(buildAst(lexJcx(source))) === source
 * ```
 *
 * 机械保证来自节点设计：叶子节点存 `raw`，组合节点**不存** `raw` 而由 children
 * 按源顺序拼接；行节点在末尾追加自己的 `eol`。因此不存在「两份原文副本不一致」
 * 的可能，打印器本身也不做任何补全（未闭合的 `]` / `}` / `%%endtext` 一律不补）。
 *
 * 永不抛异常：未知 kind 走穷尽性检查，编译期即拦下。
 */

import type { JcxAstDocument, JcxAstNode, JcxLineNode } from './nodes';

/** 打印任意节点（不含文档级 BOM）。 */
export function printNode(node: JcxAstNode): string {
  switch (node.kind) {
    // —— 叶子：原文即 raw ——
    case 'token':
    case 'barline':
    case 'repeatEnding':
    case 'chordSymbol':
    case 'decoration':
    case 'tupletStart':
    case 'slurOpen':
    case 'slurClose':
    case 'tie':
    case 'brokenRhythm':
    case 'tabRelation':
    case 'strokePrefix':
    case 'whitespace':
    case 'rawToken':
      return node.raw;

    // —— 正文组合节点 ——
    case 'note':
    case 'rest':
    case 'tabNote':
      return printAll(node.children);
    case 'chord':
    case 'grace':
    case 'tabGroup':
      return printNode(node.open) + printAll(node.items) + printOptional(node.close);

    // —— 行节点 ——
    case 'magicHeaderLine':
    case 'fieldLine':
    case 'directiveLine':
    case 'commentLine':
    case 'blankLine':
    case 'rawLine':
    case 'textBlockBoundaryLine':
    case 'textLine':
      return printAll(node.children) + node.eol;
    case 'inlineFieldLine':
      return printAll(node.children) + printAll(node.trailing) + node.eol;
    case 'bodyLine':
      return printAll(node.items) + node.eol;
    case 'textBlock':
      return printNode(node.begin) + printAll(node.lines) + printOptional(node.end);

    default:
      return assertNever(node);
  }
}

/** 打印一个行节点（`textBlock` 视作一组行，整块打印）。 */
export function printLine(line: JcxLineNode): string {
  return printNode(line);
}

/** 打印整篇文档：BOM（若有）+ 逐行原文。 */
export function printAst(document: JcxAstDocument): string {
  let out = document.bom === undefined ? '' : document.bom.raw;
  for (const line of document.lines) {
    out += printNode(line);
  }
  return out;
}

function printAll(nodes: readonly JcxAstNode[]): string {
  let out = '';
  for (const node of nodes) {
    out += printNode(node);
  }
  return out;
}

function printOptional(node: JcxAstNode | undefined): string {
  return node === undefined ? '' : printNode(node);
}

function assertNever(node: never): never {
  throw new Error(`printNode: unhandled AST node ${JSON.stringify(node)}`);
}
