/**
 * JCX Lossless AST —— inlineFieldLine / bodyLine 骨架构造器（M1.5 T3）。
 *
 * 唯一职责：把 `lexJcx` 已经切好的正文 token（§14–§26）**逐个**装箱成 `JcxBodyNode`
 * 叶子，以及把 `inlineField` / `body` 两种行类别分别组装成 `JcxInlineFieldLineNode`
 * / `JcxBodyLineNode`。**本文件不做任何组合**——note / rest / chord / grace /
 * tabNote / tabGroup 的建树是 T4 的事；这里每个 token 恒定对应一个扁平节点
 * （有专用叶子 kind 的用 `bodyLeaf`，没有的用通用 `tokenLeaf`，包括 `rest` /
 * `hiddenRest` / `duration` 这些将来会被 T4 并入组合节点的原料 token）。
 *
 * 不重扫字符：inline field 与 trailing 正文的分界只看 lexer 已经产出的
 * `inlineFieldClose` token 位置，不对原始字符串做任何正则 / indexOf。
 */

import type { SourceSpan } from '../lexer/sourceSpan';
import type { JcxInlineFieldKeyToken, JcxLexLine, JcxToken } from '../lexer/token';
import { childPath } from './astPath';
import { bodyLeaf, tokenLeaf } from './leaf';
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
 * 单个正文 token → 单个 `JcxBodyNode`（穷尽 `JcxToken` 全部 48 种 `kind`，见
 * `lexer/token.ts`）。**显式穷尽、禁止 `default` 静默兜底**：新增/删除 token
 * kind 时，本函数必须跟着改，否则 `assertNeverBodyToken` 的 `never` 收窄会让
 * 编译直接失败，而不是把新 token 悄悄落进某个不相关的分支。
 */
function buildBodyNode(token: JcxToken, path: AstPath): JcxBodyNode {
  switch (token.kind) {
    // —— §14–§26 正文中有专用叶子 kind 的 token（JcxBodyLeafKind） ——
    case 'barline':
      return bodyLeaf('barline', token, path);
    case 'repeatEnding':
      return bodyLeaf('repeatEnding', token, path);
    case 'chordSymbol':
      return bodyLeaf('chordSymbol', token, path);
    // §23：simple / complex 两形态统一为 decoration，形态差异看 token.kind。
    case 'decorationSimple':
    case 'decorationComplex':
      return bodyLeaf('decoration', token, path);
    case 'tupletStart':
      return bodyLeaf('tupletStart', token, path);
    case 'slurOpen':
      return bodyLeaf('slurOpen', token, path);
    case 'slurClose':
      return bodyLeaf('slurClose', token, path);
    case 'tie':
      return bodyLeaf('tie', token, path);
    case 'brokenRhythm':
      return bodyLeaf('brokenRhythm', token, path);
    case 'tabRelation':
      return bodyLeaf('tabRelation', token, path);
    case 'strokePrefix':
      return bodyLeaf('strokePrefix', token, path);
    case 'whitespace':
      return bodyLeaf('whitespace', token, path);
    case 'raw':
      return bodyLeaf('rawToken', token, path);

    // —— 没有专用叶子 kind：通用 tokenLeaf 承载，组合（note/rest/chord/grace/
    //    tabNote/tabGroup）留给 T4。rest/hiddenRest/duration 与其他「组合原料」
    //    token 同等对待——T3 边界拍板：不提前把 rest 包成 JcxRestNode。 ——
    case 'accidental':
    case 'pitchLetter':
    case 'octaveMark':
    case 'duration':
    case 'rest':
    case 'hiddenRest':
    case 'chordOpen':
    case 'chordClose':
    case 'graceOpen':
    case 'graceClose':
    case 'stringLetter':
    case 'fret':
    case 'tabDurSep':
    case 'tabGroupOpen':
    case 'tabGroupClose':
      return tokenLeaf(token, path);

    // —— 其余 19 种是行级 token（bom/eol/magicHeader/字段/指令/内联字段外壳/文本块……），
    //    `pushBody` 永不产出它们；出现即上游契约被打破，用穷尽性检查在编译期拦下。 ——
    case 'bom':
    case 'eol':
    case 'blankLine':
    case 'magicHeader':
    case 'comment':
    case 'directivePrefix':
    case 'directiveName':
    case 'directiveValue':
    case 'textBlockBegin':
    case 'textBlockEnd':
    case 'textBlockContent':
    case 'fieldKey':
    case 'fieldColon':
    case 'fieldValue':
    case 'inlineFieldOpen':
    case 'inlineFieldKey':
    case 'inlineFieldColon':
    case 'inlineFieldValue':
    case 'inlineFieldClose':
      // 这些 kind 在类型层仍是 `JcxToken` 的合法成员（故此处 `token` 不是 `never`），
      // 但 `pushBody`（lexBodyCommon/lexBodyPitch/lexBodyTab）在实现上永不产出
      // 它们——正常流程不可达，属于 lexer 契约之外的输入。与 T2 收尾对嵌套
      // `%%begintext` 的处理一致（buildAst 不为「契约保证不可达」的分支新增可达
      // 异常面）：不抛异常，退回通用 `tokenLeaf` 保真——raw 原样保留，
      // printAst 不变量依旧成立，只是这个节点在语义上不该出现在这里。
      return tokenLeaf(token, path);

    default:
      // 至此已穷尽 `JcxTokenKind` 全部 48 种取值，`token` 收窄为 `never`——
      // 未来新增/删除 token kind 时，本行会因收窄失败而编译报错，逼迫同步改这里。
      return assertNeverBodyToken(token);
  }
}

/**
 * 把一段正文 token 流按序装箱为 `JcxBodyNode[]`，path 从 `childPath(parentPath,
 * startIndex)` 开始连续编号——调用方（`buildBodyLineNode` / `buildInlineFieldLine`）
 * 负责保证 `startIndex` 与同一 `parentPath` 下其它子节点不重号。
 */
export function buildBodyLeaves(
  tokens: readonly JcxToken[],
  parentPath: AstPath,
  startIndex: number,
): JcxBodyNode[] {
  const result: JcxBodyNode[] = [];
  for (const [i, token] of tokens.entries()) {
    result.push(buildBodyNode(token, childPath(parentPath, startIndex + i)));
  }
  return result;
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
  const trailing = buildBodyLeaves(trailingTokens, path, children.length);

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
  const items = buildBodyLeaves(tokens, path, 0);
  return {
    kind: 'bodyLine',
    path,
    span: spanOfNodes(items, line),
    eol,
    mode: line.mode ?? 'pitch',
    items,
  };
}

function assertNeverBodyToken(token: never): never {
  throw new Error(`buildBodyNode: unexpected token kind ${JSON.stringify(token)}`);
}
