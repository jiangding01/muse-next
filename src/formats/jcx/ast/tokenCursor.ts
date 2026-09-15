/**
 * JCX Lossless AST —— token 游标与叶子收集的纯函数工具（M1.5 T4）。
 *
 * 定位：T4 的组合（note / rest / tabNote / chord / grace / tabGroup）全部是
 * 「在 token 流上按 kind 相邻性取一段」这一种动作的不同参数化。本文件把这个动作
 * 抽成**无状态纯函数 + 一个显式游标记录**，让 `groupPitch` / `groupTab` /
 * `groupBrackets` 只描述「取什么」，不再各自手写下标推进与 path 编号。
 *
 * 两条硬约束在这里机械保证：
 * - **零自产 diagnostic**：本文件不引用 `DiagnosticBag`，任何匹配失败都只表达为
 *   「没取到」，由调用方退回叶子；
 * - **不用 `as` 掩盖类型**：token kind 的收窄走 `isTokenOfKind` 这个类型守卫，
 *   叶子的窄化返回类型由 `leaf.ts` 的 `tokenLeaf<K>` 承担（其内部断言已在该文件
 *   注释里说明理由，T4 不再叠加新的断言）。
 */

import type { SourceSpan } from '../lexer/sourceSpan';
import type { JcxToken, JcxTokenKind } from '../lexer/token';
import { childPath } from './astPath';
import { tokenLeaf } from './leaf';
import type { AstPath, JcxTokenLeafOf } from './nodes';

/** 按 kind 收窄后的 token 形态，与 `JcxTokenLeafOf<K>.token` 同构。 */
export type JcxTokenOf<K extends JcxTokenKind> = JcxToken & { readonly kind: K };

/**
 * 类型守卫：token 的 kind 是否落在给定集合内。
 *
 * 用 `kinds.some((k) => k === kind)` 而不是 `kinds.includes(kind)`：后者要求实参
 * 类型是 `readonly JcxTokenKind[]`，会逼出一个把 `readonly K[]` 放宽的断言；
 * `===` 比较在 `K extends JcxTokenKind` 下本就合法，无需任何断言。
 */
export function isTokenOfKind<K extends JcxTokenKind>(
  token: JcxToken | undefined,
  kinds: readonly K[],
): token is JcxTokenOf<K> {
  if (token === undefined) {
    return false;
  }
  const kind = token.kind;
  return kinds.some((k) => k === kind);
}

/** 读取下标处的 token；越界返回 `undefined`（`noUncheckedIndexedAccess` 已保证）。 */
export function tokenAt(tokens: readonly JcxToken[], index: number): JcxToken | undefined {
  return tokens[index];
}

/** 下标处 token 的 kind 是否落在集合内；越界恒为 `false`。 */
export function kindAtIs<K extends JcxTokenKind>(
  tokens: readonly JcxToken[],
  index: number,
  kinds: readonly K[],
): boolean {
  return isTokenOfKind(tokens[index], kinds);
}

/**
 * 一次组合过程的游标：`index` 是下一个待消费 token 的下标，`leaves` 是已收集的
 * 子叶子（顺序即原文顺序，下标即其在父节点内的 path 编号）。
 *
 * 刻意用可变记录而不是 class 或不可变折叠：组合是「顺序尝试、随时停」的过程，
 * 不可变写法会退化成大量 `{...run, index: run.index + 1}` 噪声。
 */
export interface LeafRun<K extends JcxTokenKind> {
  readonly leaves: JcxTokenLeafOf<K>[];
  index: number;
}

export function startRun<K extends JcxTokenKind>(index: number): LeafRun<K> {
  return { leaves: [], index };
}

/**
 * 若当前 token 的 kind 命中 `kinds`，收为一枚叶子并前进一格，返回 `true`。
 *
 * path 编号用 `run.leaves.length` —— 组合节点的 children 一律从 0 起连续编号，
 * 与 token 流下标无关。
 */
export function takeOne<K extends JcxTokenKind>(
  tokens: readonly JcxToken[],
  run: LeafRun<K>,
  kinds: readonly K[],
  parentPath: AstPath,
): boolean {
  const token = tokens[run.index];
  if (!isTokenOfKind(token, kinds)) {
    return false;
  }
  run.leaves.push(tokenLeaf<K>(token, childPath(parentPath, run.leaves.length)));
  run.index += 1;
  return true;
}

/** 连续吃掉所有命中 `kinds` 的 token，返回吃掉的个数（可能为 0）。 */
export function takeWhile<K extends JcxTokenKind>(
  tokens: readonly JcxToken[],
  run: LeafRun<K>,
  kinds: readonly K[],
  parentPath: AstPath,
): number {
  let count = 0;
  while (takeOne(tokens, run, kinds, parentPath)) {
    count += 1;
  }
  return count;
}

/**
 * 组合节点的 span：起点取 `first`，终点取 `rest` 中最后一个节点（为空时退回
 * `first` 自身）。
 *
 * 之所以要求调用方显式传入一个必存在的 `first`，而不是接一个「可能为空的数组」：
 * 组合节点在本层恒有至少一个子节点（note 必有 pitchLetter、括号组必有 open），
 * 把这个前提放进签名里，就不需要在实现里为空数组编造一个兜底 span，也就不需要
 * 非空断言。
 */
export function spanFrom(
  first: { readonly span: SourceSpan },
  rest: readonly { readonly span: SourceSpan }[],
): SourceSpan {
  const last = rest[rest.length - 1] ?? first;
  return { start: first.span.start, end: last.span.end };
}
