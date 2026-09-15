import { expect } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { buildLineNodes } from '../../../../src/formats/jcx/ast/buildLines';
import { printLine, printNode } from '../../../../src/formats/jcx/ast';
import type { JcxAstNode, JcxBodyNode } from '../../../../src/formats/jcx/ast';

/**
 * M1.5 T4 组合测试的共用夹具。**全部基于 `lexJcx` 的真实输出**——不手搓 token，
 * 否则测的就不是「AST 如何消费 lexer」，而是测试作者对 lexer 的想象。
 */

/**
 * 切到 TAB 模式所需的最短前缀（§13.2 模式状态机：`V:` 声明 `style=tab` 之后，
 * 还要一条 `[V:1]` 内联字段行把当前声部切过去，其后的正文行才是 tab 模式）。
 * 因此 tab 用例的目标行恒为物理第 4 行。
 */
const TAB_PREFIX = '%MUSE2\nV:1 style=tab clef=standardtab\nK: C\n[V:1]\n';
const TAB_LINE_INDEX = 4;

function bodyItemsAt(
  source: string,
  lineIndex: number,
  mode: 'pitch' | 'tab',
  content: string,
): readonly JcxBodyNode[] {
  const line = buildLineNodes(lexJcx(source))[lineIndex];
  expect(line?.kind).toBe('bodyLine');
  if (line === undefined || line.kind !== 'bodyLine') {
    throw new Error(`expected a bodyLine at index ${lineIndex} of ${JSON.stringify(source)}`);
  }
  expect(line.mode).toBe(mode);
  // 每条用例都顺带验一次行级无损不变量与 path 连续 / 唯一。
  expect(printLine(line)).toBe(`${content}\n`);
  expectPathTree(line.items, line.path, 0);
  expectPaths(line.items);
  expectJoin(line.items, content);
  return line.items;
}

/** pitch 模式正文行（无任何 voice 上下文时的默认模式）。 */
export function pitchItems(content: string): readonly JcxBodyNode[] {
  return bodyItemsAt(`${content}\n`, 0, 'pitch', content);
}

/** TAB 模式正文行。 */
export function tabItems(content: string): readonly JcxBodyNode[] {
  return bodyItemsAt(`${TAB_PREFIX}${content}\n`, TAB_LINE_INDEX, 'tab', content);
}

/** 一组节点打印后拼接必须等于原文（组合节点递归拼接，叶子即 `raw`）。 */
export function expectJoin(nodes: readonly JcxAstNode[], expected: string): void {
  expect(nodes.map((node) => printNode(node)).join('')).toBe(expected);
}

/** 按源顺序列出一个节点的直接子节点（括号组为 open → items → close?）。 */
export function orderedChildren(node: JcxAstNode): readonly JcxAstNode[] {
  if ('open' in node) {
    return [node.open, ...node.items, ...(node.close === undefined ? [] : [node.close])];
  }
  if ('children' in node) {
    return node.children;
  }
  if ('items' in node) {
    return node.items;
  }
  return [];
}

/**
 * path 连续性：第 i 个子节点的 path 恒为 `${parentPath}.${start + i}`，逐层递归。
 * 括号组的 `open` 为 0、`items` 从 1 起、`close` 为 `1 + items.length`，
 * 正好落在同一条「按源顺序连续编号」的规则上。
 */
export function expectPathTree(nodes: readonly JcxAstNode[], parentPath: string, start: number): void {
  nodes.forEach((node, offset) => {
    expect(node.path).toBe(`${parentPath}.${start + offset}`);
    expectPathTree(orderedChildren(node), node.path, 0);
  });
}

/** path 全局唯一（含所有层级）。 */
export function expectPaths(nodes: readonly JcxAstNode[]): void {
  const paths: string[] = [];
  const visit = (node: JcxAstNode): void => {
    paths.push(node.path);
    for (const child of orderedChildren(node)) {
      visit(child);
    }
  };
  for (const node of nodes) {
    visit(node);
  }
  expect(new Set(paths).size).toBe(paths.length);
}

/**
 * 一个节点的直接子节点「是什么」的紧凑表示：通用 token 叶子报 `token.kind`
 * （如 `pitchLetter`），其余报节点自身的 `kind`（如 `note` / `whitespace`）。
 */
export function childKinds(node: JcxAstNode | undefined): readonly string[] {
  if (node === undefined) {
    return [];
  }
  return orderedChildren(node).map((child) => (child.kind === 'token' ? child.token.kind : child.kind));
}

/** 同上，但作用于一个节点数组（通常是某一行的 items）。 */
export function kindsOf(nodes: readonly JcxAstNode[]): readonly string[] {
  return nodes.map((node) => (node.kind === 'token' ? node.token.kind : node.kind));
}
