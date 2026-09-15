/**
 * JCX Lossless AST —— 叶子节点工厂（M1.5 T2）。
 *
 * 唯一职责：把一个 lexer token 包成一个 AST 叶子节点。`raw` / `span` 与
 * `token.raw` / `token.span`是**同一份引用**，不复制——这是 nodes.ts 顶部
 * 约定的「叶子存 raw，是无损拼接唯一来源」的机械保证来源。
 *
 * 原为 `tests/unit/jcx/ast/astFixtures.ts` 里的测试专用构造逻辑，T2 把它
 * 提升为正式工厂：真实 builder（`buildLines.ts`）与测试 fixture 共用同一套
 * 装箱规则，避免两处实现分叉。
 */

import type { JcxToken, JcxTokenKind } from '../lexer/token';
import type { AstPath, JcxBodyLeafKind, JcxBodyLeafNode, JcxTokenLeafOf } from './nodes';

/**
 * 通用 token 叶子：`kind` 恒为 `'token'`，返回类型按 `K` 参数化。
 *
 * `K` 默认从调用处的期望类型（返回值上下文）推导，不要求实参本身携带
 * `{ kind: K }` 交叉类型——`JcxToken` 是判别联合，强行在参数位置交叉一个
 * 泛型 `kind` 会在联合成员间触发不成立的结构比较（TS 分发问题）。真正的
 * 类型安全来自调用方（如 `JcxNoteNode.children` 的窄化声明），不需要这里
 * 再校验一遍；需要精确窄化返回类型时，调用方可显式传泛型：
 * `tokenLeaf<'pitchLetter'>(token, path)`。
 */
export function tokenLeaf<K extends JcxTokenKind = JcxTokenKind>(
  token: JcxToken,
  path: AstPath,
): JcxTokenLeafOf<K> {
  return {
    kind: 'token',
    token: token as JcxToken & { readonly kind: K },
    raw: token.raw,
    path,
    span: token.span,
  };
}

/**
 * 正文单 token 叶子：`kind` 是 `JcxBodyLeafKind` 之一，与承载它的 token 语义对应
 * （例如 `bodyLeaf('barline', barlineToken, path)`）。
 *
 * 调用方负责保证 `kind` 与 `token.kind` 语义相符——本函数不做运行时校验，
 * 因为 `JcxBodyLeafKind` 与 `JcxTokenKind` 是两套并不总是同名的枚举
 * （如 `slurOpen` 对应 token kind `'slurOpen'`，但 `chordSymbol` 同名而
 * `rawToken` 对应 token kind `'raw'`），强行校验反而会把「调用方决定归类」
 * 的职责错误地搬到这里。
 */
export function bodyLeaf<K extends JcxBodyLeafKind>(
  kind: K,
  token: JcxToken,
  path: AstPath,
): JcxBodyLeafNode {
  return { kind, token, raw: token.raw, path, span: token.span } as JcxBodyLeafNode;
}
