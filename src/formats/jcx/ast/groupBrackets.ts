/**
 * JCX Lossless AST —— 括号组组合：chord `[…]` / grace `{…}` / tabGroup `[…]`（M1.5 T4）。
 *
 * 三者的组合规则**完全同构**，唯一差别是 open / close 的 token kind 与节点 kind，
 * 因此参数化成一个 `tryOpenGroup`，由 `buildBodyItems.ts` 传入三组参数。
 * 主循环（递归入口）以 `recurse` **参数注入**，而不是直接 import ——
 * 否则 `buildBodyItems` ⇄ `groupBrackets` 会构成循环 import。
 *
 * 编号约定（M1.5 已拍板）：`open` 恒为 0，`items` 从 1 起连续，`close`（若有）
 * 恒为 `1 + items.length`。
 *
 * ## 未闭合与祖先 close 的恢复
 *
 * 未闭合时**构造节点并省略 `close`**（`close?` 已建模），而不是把整段退回叶子
 * ——后者会丢掉「这里确实开了一个组」这条结构信息，而 Lossless AST 的原文保真
 * 由 `printAst` 拼接保证，不依赖节点形态。
 *
 * 递归时把**祖先待匹配的 close kind 集合**一并传下去：内层遇到任何祖先的 close
 * 就立刻收尾（自身 close 缺失），把该 token 留给外层消费，绝不吞掉外层的闭合。
 * 例：`[a{b]` → chord 内含 grace（未闭合），`]` 归 chord；若不传祖先集合，grace 会
 * 一路吃到行尾，chord 也跟着未闭合，两层结构同时失真。
 * 同 kind 嵌套（`[[a]`、`{a{b}`）时，close 归**最内层**未闭合的组（标准括号匹配语义），
 * 外层因此缺 close；这是既定行为，不做"外层优先"的猜测。
 */

import type { JcxToken, JcxTokenKind } from '../lexer/token';
import { childPath } from './astPath';
import { tokenLeaf } from './leaf';
import type {
  AstPath,
  JcxBodyNode,
  JcxChordNode,
  JcxGraceNode,
  JcxTabGroupNode,
  JcxTokenLeaf,
} from './nodes';
import type { GroupAttempt } from './groupPitch';
import { isTokenOfKind, spanFrom } from './tokenCursor';

export type JcxBracketGroupNode = JcxChordNode | JcxGraceNode | JcxTabGroupNode;
export type BracketNodeKind = JcxBracketGroupNode['kind'];

/** 一组括号的参数化描述。 */
export interface BracketSpec {
  readonly openKind: JcxTokenKind;
  readonly closeKind: JcxTokenKind;
  readonly nodeKind: BracketNodeKind;
}

/** §14.4：`[CEG]`。 */
export const CHORD_SPEC: BracketSpec = {
  openKind: 'chordOpen',
  closeKind: 'chordClose',
  nodeKind: 'chord',
};

/** §21：`{c}` / `{@c}`（`{@` 是一个 graceOpen token）。 */
export const GRACE_SPEC: BracketSpec = {
  openKind: 'graceOpen',
  closeKind: 'graceClose',
  nodeKind: 'grace',
};

/** §26.8：TAB 的同时拨响弦组 `[ax/bx/]`。 */
export const TAB_GROUP_SPEC: BracketSpec = {
  openKind: 'tabGroupOpen',
  closeKind: 'tabGroupClose',
  nodeKind: 'tabGroup',
};

/** 主循环的递归入口签名；由调用方注入，避免循环 import。 */
export type GroupRecurse = (
  tokens: readonly JcxToken[],
  tokenIndex: number,
  parentPath: AstPath,
  childIndexStart: number,
  ancestorCloses: readonly JcxTokenKind[],
) => { readonly items: readonly JcxBodyNode[]; readonly next: number };

interface BracketParts {
  readonly path: AstPath;
  readonly span: JcxBracketGroupNode['span'];
  readonly open: JcxTokenLeaf;
  readonly items: readonly JcxBodyNode[];
  readonly close?: JcxTokenLeaf;
}

/**
 * 三个 kind 各写一行字面量，而不是 `{ kind: nodeKind, ...parts }`。
 *
 * 原因是类型而非风格：`kind` 为联合类型的对象字面量不满足判别联合中**任一**成员
 * （`'chord' | 'grace' | 'tabGroup'` 不可赋给 `'chord'`），要让它通过只能加断言。
 * 展开成 switch 后每个分支的 `kind` 都是字面量类型，结构由编译器逐个校验，
 * 既无断言也无穷尽性漏洞（末尾的 `never` 守卫兜底）。
 */
function makeBracketNode(nodeKind: BracketNodeKind, parts: BracketParts): JcxBracketGroupNode {
  switch (nodeKind) {
    case 'chord':
      return { kind: 'chord', ...parts };
    case 'grace':
      return { kind: 'grace', ...parts };
    case 'tabGroup':
      return { kind: 'tabGroup', ...parts };
    default:
      return assertNeverBracket(nodeKind);
  }
}

/**
 * 尝试从 `tokens[index]` 开始组一个括号组。
 *
 * @param ancestorCloses 外层**尚未匹配**的 close kind 集合（最外层为空数组）。
 * @param recurse 主循环入口，用于递归组合 items。
 * @returns `undefined` 表示 `tokens[index]` 不是本 spec 的 open token。
 */
export function tryOpenGroup(
  tokens: readonly JcxToken[],
  index: number,
  path: AstPath,
  spec: BracketSpec,
  ancestorCloses: readonly JcxTokenKind[],
  recurse: GroupRecurse,
): GroupAttempt<JcxBracketGroupNode> | undefined {
  const openToken = tokens[index];
  if (!isTokenOfKind(openToken, [spec.openKind])) {
    return undefined;
  }
  const open = tokenLeaf(openToken, childPath(path, 0));

  const { items, next } = recurse(tokens, index + 1, path, 1, [...ancestorCloses, spec.closeKind]);

  const closeToken = tokens[next];
  const close = isTokenOfKind(closeToken, [spec.closeKind])
    ? tokenLeaf(closeToken, childPath(path, 1 + items.length))
    : undefined;

  // span 终点：close > 最后一个 item > open 自身（未闭合的空组 `[` 即最后一档）。
  const tail: readonly { readonly span: JcxBracketGroupNode['span'] }[] =
    close !== undefined ? [...items, close] : items;

  return {
    node: makeBracketNode(spec.nodeKind, {
      path,
      span: spanFrom(open, tail),
      open,
      items,
      ...(close !== undefined ? { close } : {}),
    }),
    next: close !== undefined ? next + 1 : next,
  };
}

function assertNeverBracket(nodeKind: never): never {
  throw new Error(`makeBracketNode: unexpected bracket kind ${JSON.stringify(nodeKind)}`);
}
