/**
 * JCX Lossless AST —— inlineFieldLine / bodyLine 的行级组装（M1.5 T3 骨架 / T4 建树）。
 *
 * 职责：把 `inlineField` / `body` 两种行类别分别组装成 `JcxInlineFieldLineNode`
 * / `JcxBodyLineNode`。内联字段自身的 5 个外壳 token 仍是扁平的通用叶子（§9.1
 * 不切属性，属 M1.6）；**正文部分一律交给 `groupBodyItems`**——`bodyLine.items`
 * 与 `inlineFieldLine.trailing` 走同一个组合入口，没有第二条路径，也不向它传
 * `mode`（组合纯由 token kind 驱动，见 `buildBodyItems.ts`）。
 *
 * 不重扫字符：inline field 与 trailing 正文的分界只看 lexer 已经产出的
 * `inlineFieldClose` token 位置，不对原始字符串做任何正则 / indexOf。
 */

import type { SourceSpan } from '../lexer/sourceSpan';
import type { JcxInlineFieldKeyToken, JcxLexLine, JcxToken } from '../lexer/token';
import { childPath } from './astPath';
import { groupBodyItems } from './buildBodyItems';
import { tokenLeaf } from './leaf';
import type { AstPath, JcxBodyLineNode, JcxBodyNode, JcxInlineFieldLineNode, JcxTokenLeaf } from './nodes';

/** 通用 token 叶子数组：inline field 自身的 5 个语义 token + 若干 whitespace。 */
function tokenLeaves(tokens: readonly JcxToken[], base: AstPath, startIndex: number): JcxTokenLeaf[] {
  return tokens.map((token, offset) => tokenLeaf(token, childPath(base, startIndex + offset)));
}

/**
 * 节点数组为空时的兜底 span：与 `buildLines.ts` 的 `contentSpan` 同一套取舍
 * （零宽 span，落在该行 `eol` 起点，没有 `eol` 时落在行尾）——两处各自独立实现，
 * 不跨文件复用私有函数，避免 `buildLines.ts` ⇄ `buildBodyLine.ts` 产生循环依赖。
 * 该分支在实践中不可达：`inlineField` 行恒有 9 个内联字段自身 token，
 * `body` 行的 `pushBody` 只在 `content.length > 0` 时才被调用（见
 * `lexDocument.ts` 第 125 行），因此 `tokens` 不会为空；保留它只是为了让
 * `span` 的计算对「空数组」这一输入形态保持类型与语义上的完整。
 */
function fallbackSpan(line: JcxLexLine): SourceSpan {
  const lastToken = line.tokens[line.tokens.length - 1];
  const point = lastToken !== undefined && lastToken.kind === 'eol' ? lastToken.span.start : line.span.end;
  return { start: point, end: point };
}

function spanOfNodes(nodes: readonly { readonly span: SourceSpan }[], line: JcxLexLine): SourceSpan {
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  if (first !== undefined && last !== undefined) {
    return { start: first.span.start, end: last.span.end };
  }
  return fallbackSpan(line);
}

/**
 * §9.1：`[V:1]`（可能带 `[ V:1]` / `[V :1]` 这类容忍异常空格的形态）开头的行。
 *
 * `lexInlineFieldLine` 固定按序产出 9 个内联字段自身 token（`whitespace?
 * inlineFieldOpen whitespace? inlineFieldKey whitespace? inlineFieldColon
 * whitespace? inlineFieldValue inlineFieldClose`），随后（同行还有正文时）紧跟
 * trailing 正文 token——用 `inlineFieldClose` 的下标切开两段，不扫描原始字符串。
 * `children` 与 `trailing` 共用同一段连续 path 编号空间：`trailing` 从
 * `children.length` 续编号，不与 `children` 重号。
 */
export function buildInlineFieldLine(
  line: JcxLexLine,
  tokens: readonly JcxToken[],
  eol: string,
  path: AstPath,
): JcxInlineFieldLineNode {
  const closeIndex = tokens.findIndex((token) => token.kind === 'inlineFieldClose');
  const headEnd = closeIndex === -1 ? tokens.length : closeIndex + 1;
  const headTokens = tokens.slice(0, headEnd);
  const trailingTokens = tokens.slice(headEnd);

  const children = tokenLeaves(headTokens, path, 0);
  const trailing = groupBodyItems(trailingTokens, path, children.length);

  const keyToken = tokens.find((token): token is JcxInlineFieldKeyToken => token.kind === 'inlineFieldKey');
  const key = keyToken?.key ?? '';

  return {
    kind: 'inlineFieldLine',
    path,
    span: spanOfNodes([...children, ...trailing], line),
    eol,
    key,
    children,
    trailing,
  };
}

/**
 * §13：正文行。`mode` 直接透传 `lexJcx` 的判定结果（`lexDocument.ts` 只在
 * `kind === 'body'` 时才写 `line.mode`，见其第 166–168 行），因此实践中恒有值；
 * `?? 'pitch'` 只是应对 `JcxLexLine.mode` 类型上可选（`?:`）的契约兜底，
 * 不代表真的会在 body 行上取到 `undefined`。
 */
export function buildBodyLineNode(
  line: JcxLexLine,
  tokens: readonly JcxToken[],
  eol: string,
  path: AstPath,
): JcxBodyLineNode {
  const items = groupBodyItems(tokens, path, 0);
  return {
    kind: 'bodyLine',
    path,
    span: spanOfNodes(items, line),
    eol,
    mode: line.mode ?? 'pitch',
    items,
  };
}
