/**
 * JCX Lossless AST —— 正文组合主循环（M1.5 T4）。
 *
 * 唯一入口 `groupBodyItems`：把一段正文 token 流（§14–§26）组合成 `JcxBodyNode[]`。
 * `bodyLine.items` 与 `inlineFieldLine.trailing` **走同一个入口**，没有第二条路径。
 *
 * ## 三条不可放宽的约束
 *
 * 1. **mode-free / 纯 token-driven**：本函数不接收、也不查询 `mode`。lexer 的模式
 *    状态机（§13.2）已经把模式固化进 token kind——`pitchLetter` 对 `stringLetter`、
 *    `chordOpen/Close` 对 `tabGroupOpen/Close`、`tabDurSep` 与 `strokePrefix` 只在
 *    TAB 出现——再判一次模式只会制造第二个事实来源。
 * 2. **零自产 diagnostic**：组合失败一律退回叶子，不报错、不抛异常。lexer 已经在
 *    对应位置发过 info / warning（如悬空 `strokePrefix`），AST 不重复。
 * 3. **降级唯一出口是 `buildBodyNode`**：任何 try 函数返回 `undefined`，主循环就把
 *    **当前这一个** token 装成叶子并前进一格，绝不跳过——跳过即丢失原文。
 *
 * 边组合边编号：`childIndexStart + items.length` 只在真正推入一个节点时前进，
 * 因此组合节点占一个编号（而不是它吃掉的 token 数），path 恒连续无空洞。
 */

import type { JcxToken, JcxTokenKind } from '../lexer/token';
import { childPath } from './astPath';
import { bodyLeaf, tokenLeaf } from './leaf';
import type { AstPath, JcxBodyNode } from './nodes';
import type { GroupAttempt } from './groupPitch';
import { tryNote, tryRest } from './groupPitch';
import { tryTabNote } from './groupTab';
import { CHORD_SPEC, GRACE_SPEC, TAB_GROUP_SPEC, tryOpenGroup } from './groupBrackets';

/**
 * 单个正文 token → 单个 `JcxBodyNode` 叶子（穷尽 `JcxToken` 全部 48 种 `kind`，见
 * `lexer/token.ts`）。**显式穷尽、禁止 `default` 静默兜底**：新增/删除 token
 * kind 时，本函数必须跟着改，否则 `assertNeverBodyToken` 的 `never` 收窄会让
 * 编译直接失败，而不是把新 token 悄悄落进某个不相关的分支。
 *
 * 这是 T4 组合失败后的**唯一降级出口**（原属 `buildBodyLine.ts`，T4 随主循环一起
 * 迁到本文件，使依赖单向：`buildBodyLine → buildBodyItems → group*`）。
 */
export function buildBodyNode(token: JcxToken, path: AstPath): JcxBodyNode {
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
    // §26.4：悬空（或作用于弦组）的拨弦前缀——`tryTabNote` 拒绝吸收时落到这里。
    case 'strokePrefix':
      return bodyLeaf('strokePrefix', token, path);
    case 'whitespace':
      return bodyLeaf('whitespace', token, path);
    case 'raw':
      return bodyLeaf('rawToken', token, path);

    // —— 没有专用叶子 kind 的「组合原料」token：组合成功时它们进 note / rest /
    //    tabNote / chord / grace / tabGroup，组合失败（孤立的 `duration`、多余的
    //    `]` / `}`、`accidental` 后没有音名……）时原样落成通用叶子。 ——
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
    //    `pushBody` 永不产出它们；出现即上游契约被打破。 ——
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
      // 它们——正常流程不可达，属于 lexer 契约之外的输入。buildAst 不为「契约保证
      // 不可达」的分支新增可达异常面：不抛异常，退回通用 `tokenLeaf` 保真。
      return tokenLeaf(token, path);

    default:
      // 至此已穷尽 `JcxTokenKind` 全部 48 种取值，`token` 收窄为 `never`——
      // 未来新增/删除 token kind 时，本行会因收窄失败而编译报错，逼迫同步改这里。
      return assertNeverBodyToken(token);
  }
}

/**
 * 按 token kind 派发到对应的 try 函数；全部失败返回 `undefined`。
 *
 * 只看**当前 token 的 kind**，不看模式、不回溯、不前瞻超过各 try 函数自身所需。
 */
function tryGroup(
  tokens: readonly JcxToken[],
  index: number,
  token: JcxToken,
  path: AstPath,
  ancestorCloses: readonly JcxTokenKind[],
): GroupAttempt<JcxBodyNode> | undefined {
  switch (token.kind) {
    case 'accidental':
    case 'pitchLetter':
      return tryNote(tokens, index, path);
    case 'rest':
    case 'hiddenRest':
      return tryRest(tokens, index, path);
    case 'strokePrefix':
    case 'stringLetter':
      return tryTabNote(tokens, index, path);
    case 'chordOpen':
      return tryOpenGroup(tokens, index, path, CHORD_SPEC, ancestorCloses, groupRange);
    case 'graceOpen':
      return tryOpenGroup(tokens, index, path, GRACE_SPEC, ancestorCloses, groupRange);
    case 'tabGroupOpen':
      return tryOpenGroup(tokens, index, path, TAB_GROUP_SPEC, ancestorCloses, groupRange);
    default:
      return undefined;
  }
}

/**
 * 组合主循环。遇到**祖先尚未匹配的 close kind** 立即收尾，把该 token 留给外层
 * 消费（见 `groupBrackets.ts` 的恢复说明）；最外层 `ancestorCloses` 为空数组，
 * 因此多余的 `]` / `}` 不会被误认为任何人的闭合，直接落成通用叶子。
 */
function groupRange(
  tokens: readonly JcxToken[],
  tokenIndex: number,
  parentPath: AstPath,
  childIndexStart: number,
  ancestorCloses: readonly JcxTokenKind[],
): { readonly items: readonly JcxBodyNode[]; readonly next: number } {
  const items: JcxBodyNode[] = [];
  let index = tokenIndex;

  while (index < tokens.length) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    const kind = token.kind;
    if (ancestorCloses.some((close) => close === kind)) {
      break;
    }
    const path = childPath(parentPath, childIndexStart + items.length);
    const attempt = tryGroup(tokens, index, token, path, ancestorCloses);
    if (attempt !== undefined) {
      // 每个 try 函数至少消费一个 token，`index` 严格递增，主循环必然终止。
      items.push(attempt.node);
      index = attempt.next;
      continue;
    }
    items.push(buildBodyNode(token, path));
    index += 1;
  }

  return { items, next: index };
}

/**
 * 把一段正文 token 流组合为 `JcxBodyNode[]`，path 从 `childPath(parentPath,
 * startIndex)` 开始连续编号——调用方（`buildBodyLineNode` / `buildInlineFieldLine`）
 * 负责保证 `startIndex` 与同一 `parentPath` 下其它子节点不重号。
 *
 * **不接收 mode**（M1.5 已拍板）：组合完全由 token kind 驱动。
 */
export function groupBodyItems(
  tokens: readonly JcxToken[],
  parentPath: AstPath,
  startIndex: number,
): JcxBodyNode[] {
  return [...groupRange(tokens, 0, parentPath, startIndex, []).items];
}

function assertNeverBodyToken(token: never): never {
  throw new Error(`buildBodyNode: unexpected token kind ${JSON.stringify(token)}`);
}
