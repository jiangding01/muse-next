/**
 * JCX Lossless AST —— 共享不变量校验逻辑（M1.5 T6）。
 *
 * 被 `tests/unit/jcx/ast/lossless.test.ts`（fixture 级）与
 * `scripts/jcx/corpus-lex-test.ts`（语料级）共同复用，避免两处各写一份、
 * 逐渐漂移。纯函数，不依赖 Node fs / Electron，不 throw、不 console —— 失败
 * 用返回值表达，调用方各自决定怎么呈现（vitest `expect` / 脚本打印）。
 *
 * 四块能力：
 * 1. `lineIndexOf`：从 `AstPath` 解出物理行下标（行级 path 专用）。
 * 2. `joinPhysicalLines` + `checkLineTextInvariant`：逐行/逐 textBlock 的
 *    `printNode(node) === source.slice(span)` 校验（§29.5 行级不变式在 AST
 *    层的对应版本）。
 * 3. `collectAstPaths` + `findDuplicatePaths`：递归收集全部节点 path
 *    （含 `document.bom`、textBlock 的 begin/lines/end、body 组合节点
 *    `chord`/`grace`/`tabGroup`/`note`/`rest`/`tabNote` 的 children/items/
 *    open/close，以及它们之下的所有叶子），用于唯一性校验。
 * 4. `collectResidualItemLeaves`：只统计 **item 位置**（`bodyLine.items` /
 *    `inlineFieldLine.trailing` / chord-grace-tabGroup 的 `items`，含嵌套）
 *    上的通用叶子——即「正文里还有多少个位置没被组合」，口径明确排除
 *    note/rest/tabNote 内部 children、括号组 open/close、字段行外壳
 *    children（它们是专用叶子或已被组合消费，不是残留）。
 */

import type { JcxLexLine } from '../../../src/formats/jcx/lexer/token';
import {
  isTextBlock,
  parseAstPath,
  printNode,
  type JcxAstDocument,
  type JcxAstNode,
  type JcxBodyNode,
  type JcxLineNode,
} from '../../../src/formats/jcx/ast';

/** 从行级 `AstPath`（如 `L12` / `L12.3`）解出物理行下标；文档级 path 或非法 path 返回 `undefined`。 */
export function lineIndexOf(path: string): number | undefined {
  const parsed = parseAstPath(path);
  return parsed?.kind === 'line' ? parsed.line : undefined;
}

/** 物理行 `startIndex` 起、到 `endIndexInclusive`（含）条连续行原文的拼接。 */
export function joinPhysicalLines(
  decodedText: string,
  physicalLines: readonly JcxLexLine[],
  startIndex: number,
  endIndexInclusive: number,
  hasBom: boolean,
): string {
  const startOffset =
    (physicalLines[startIndex]?.span.start.offset ?? 0) + (startIndex === 0 && hasBom ? 1 : 0);
  const endOffset = physicalLines[endIndexInclusive]?.span.end.offset ?? startOffset;
  return decodedText.slice(startOffset, endOffset);
}

export interface LineTextMismatch {
  readonly path: string;
  readonly expected: string;
  readonly actual: string;
}

/**
 * 逐行不变式：每个行节点（含 textBlock，覆盖它跨越的全部物理行）的
 * `printNode` 都等于它所覆盖物理行原文的拼接。返回空数组表示全部通过。
 *
 * 与 `tests/unit/jcx/ast/lossless.test.ts` 原有断言②同一套逻辑（该文件已改为
 * 直接调用本函数，不再自带一份实现）。
 */
export function checkLineTextInvariant(
  documentLines: readonly JcxLineNode[],
  decodedText: string,
  physicalLines: readonly JcxLexLine[],
  hasBom: boolean,
): LineTextMismatch[] {
  const mismatches: LineTextMismatch[] = [];
  for (const line of documentLines) {
    if (isTextBlock(line)) {
      const beginIndex = lineIndexOf(line.path);
      if (beginIndex === undefined) {
        mismatches.push({ path: line.path, expected: '<parseable path>', actual: line.path });
        continue;
      }
      const span = 1 + line.lines.length + (line.end !== undefined ? 1 : 0);
      const endIndex = beginIndex + span - 1;
      const expected = joinPhysicalLines(decodedText, physicalLines, beginIndex, endIndex, hasBom);
      const actual = printNode(line);
      if (actual !== expected) {
        mismatches.push({ path: line.path, expected, actual });
      }
      continue;
    }
    const physicalIndex = lineIndexOf(line.path);
    if (physicalIndex === undefined) {
      mismatches.push({ path: line.path, expected: '<parseable path>', actual: line.path });
      continue;
    }
    const expected = joinPhysicalLines(decodedText, physicalLines, physicalIndex, physicalIndex, hasBom);
    const actual = printNode(line);
    if (actual !== expected) {
      mismatches.push({ path: line.path, expected, actual });
    }
  }
  return mismatches;
}

/**
 * 深度优先遍历文档内每个节点：`document.bom`、每一行、textBlock 的
 * begin/lines/end，以及 body 组合节点（note/rest/tabNote 的 children，
 * chord/grace/tabGroup 的 open/items/close）向下直到全部叶子。
 *
 * `collectAstPaths` 与 `collectGenericLeafTokenKinds` 共用这一份遍历逻辑，
 * 避免同一套「AST 有哪些可下探字段」的知识散落成两份容易漂移的拷贝。
 */
function walkAstDocument(document: JcxAstDocument, visitLeafOrNode: (node: JcxAstNode) => void): void {
  const visit = (node: JcxAstNode): void => {
    visitLeafOrNode(node);
    if (isTextBlock(node)) {
      visit(node.begin);
      for (const line of node.lines) visit(line);
      if (node.end !== undefined) visit(node.end);
      return;
    }
    if ('children' in node) {
      for (const child of node.children) visit(child);
    }
    if ('trailing' in node) {
      for (const child of node.trailing) visit(child);
    }
    if ('items' in node) {
      for (const item of node.items) visit(item);
    }
    if ('open' in node && node.open !== undefined) {
      visit(node.open);
    }
    if ('close' in node && node.close !== undefined) {
      visit(node.close);
    }
  };
  for (const line of document.lines) {
    visit(line);
  }
}

/**
 * 递归收集文档内每个节点的 path：`document.bom` + `walkAstDocument` 覆盖的
 * 全部节点。
 *
 * 比 T2 阶段 `lossless.test.ts` 原有的 `collectPaths` 更彻底——原实现只看
 * `children`/`trailing`，不下探 `items`/`open`/`close`，漏掉了正文组合节点
 * 内部的 path。本函数是它的超集：多收集到的 path 不会让既有唯一性断言变得
 * 更容易失败（新增的 path 本就应当各自唯一），只会让检查覆盖面更完整。
 */
export function collectAstPaths(document: JcxAstDocument): string[] {
  const out: string[] = [];
  if (document.bom !== undefined) {
    out.push(document.bom.path);
  }
  walkAstDocument(document, (node) => out.push(node.path));
  return out;
}

/** 找出 `collectAstPaths` 结果里重复出现的 path；空数组表示全部唯一。 */
export function findDuplicatePaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) {
      duplicates.add(path);
    }
    seen.add(path);
  }
  return [...duplicates];
}

/**
 * 递归收集 `items` 数组里的通用叶子：`items` 里直接是 `kind === 'token'` 的
 * 项即收；`items` 里是 chord/grace/tabGroup 时，只下探它们各自的 `items`
 * 继续找（因为嵌套括号组的 `items` 仍然是「item 位置」）；`items` 里是
 * note/rest/tabNote 或其他已命名的 body 叶子 kind（barline/decoration/…）时
 * **不下探**——它们的 `children` 不是 item 位置，组合节点内部「被吃掉」的原料
 * token 不算残留。
 */
function collectResidualLeavesFromItems(items: readonly JcxBodyNode[], out: string[]): void {
  for (const item of items) {
    if (item.kind === 'token') {
      out.push(item.token.kind);
      continue;
    }
    if (item.kind === 'chord' || item.kind === 'grace' || item.kind === 'tabGroup') {
      collectResidualLeavesFromItems(item.items, out);
    }
  }
}

/**
 * T4 预演口径的「残留通用叶子」：只统计出现在 **item 位置**——
 * `bodyLine.items`、`inlineFieldLine.trailing`、以及 chord/grace/tabGroup
 * 的 `items` 数组（含嵌套）——里的 `kind === 'token'` 节点，返回它们各自
 * 承载的底层 `token.kind`（如 `duration`）。
 *
 * **不算**：note/rest/tabNote 的 `children`（组合节点内部已经被结构化消费
 * 掉的原料 token，不是「没被组合」）、chord/grace/tabGroup 的 `open`/
 * `close`（专用 body 叶子 kind，不是通用叶子）、fieldLine/inlineFieldLine
 * 自身外壳的 `children`（同样是专用叶子）。这三类都不进这份统计——早前
 * 版本把它们也算进去，导致「残留」虚高到把 note/tabNote 的组合原料
 * （pitchLetter/duration/fret/stringLetter……）全部算成残留，口径是错的。
 *
 * 仅用于观测——语料回归拿它统计「正文里还有多少个位置没能被结构化组合」，
 * 不构成任何断言、不作为失败条件（T4/T6 已拍板：通用叶子是永久合法的
 * fallback，不是缺陷）。
 */
export function collectResidualItemLeaves(document: JcxAstDocument): string[] {
  const out: string[] = [];
  for (const line of document.lines) {
    if (line.kind === 'bodyLine') {
      collectResidualLeavesFromItems(line.items, out);
    } else if (line.kind === 'inlineFieldLine') {
      collectResidualLeavesFromItems(line.trailing, out);
    }
  }
  return out;
}
