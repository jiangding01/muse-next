import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { decodeJcx } from '../../../../src/formats/jcx/encoding/decodeJcx';
import { buildAst, isTextBlock, parseAstPath, printAst, printNode } from '../../../../src/formats/jcx/ast';
import type { JcxAstDocument, JcxAstNode, JcxLineNode } from '../../../../src/formats/jcx/ast';

/**
 * M1.5 T2 DoD：对全部 fixture 校验 `printAst(buildAst(lexJcx(bytes))) === decodedText`，
 * 外加逐行、path 唯一性两条更细的回归。
 *
 * **不直接 zip `ast.lines` 与 `lex.lines`**：`textBlock` 一个 AST 节点覆盖多条物理行
 * （begin + 内容行 + 可选 end），下标不再一一对应。逐行断言改为：
 * - 普通行节点：`line.path` 形如 `L<physicalIndex>`，直接解析出物理行下标；
 * - `textBlock`：`block.path` 是 `L<beginIndex>`（见 buildLines.ts 的 path 取舍），
 *   它覆盖的物理行区间是 `[beginIndex, beginIndex + lines.length + (end ? 1 : 0)]`
 *   （text block 内容行在源文件里必然连续，lexer 逐行顺序处理保证了这一点）；
 *   期望值是这个区间内所有物理行原文的拼接，而不是单行。
 *
 * 带 BOM 的文档：物理第 0 行的原始 span 含 BOM 字符，但 BOM 被提升到
 * `document.bom`、从第 0 行 children 里剥离（不允许双重 ownership），故第 0 行的
 * `printNode` 不含 BOM —— 比较时对第 0 行的期望切片跳过 BOM 那 1 个 code unit。
 */
const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function listFixtures(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...listFixtures(full));
    } else if (entry.isFile() && entry.name.endsWith('.jcx')) {
      found.push(full);
    }
  }
  return found.sort();
}

const fixtures = listFixtures(FIXTURES_DIR).map((full) => relative(FIXTURES_DIR, full));

it('至少存在 lossless 回归用的 fixture', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

/** 物理行 `beginIndex` 起、`beginIndex + span` 条连续行原文的拼接。 */
function joinPhysicalLines(
  decodedText: string,
  physicalLines: ReturnType<typeof lexJcx>['lines'],
  startIndex: number,
  endIndexInclusive: number,
  hasBom: boolean,
): string {
  const startOffset =
    (physicalLines[startIndex]?.span.start.offset ?? 0) + (startIndex === 0 && hasBom ? 1 : 0);
  const endOffset = physicalLines[endIndexInclusive]?.span.end.offset ?? startOffset;
  return decodedText.slice(startOffset, endOffset);
}

/** 收集文档内每个节点的 path（含 `document.bom`、textBlock 内部子行），用于唯一性断言。 */
function collectPaths(document: JcxAstDocument): string[] {
  const out: string[] = [];
  if (document.bom !== undefined) {
    out.push(document.bom.path);
  }
  const visit = (node: JcxAstNode): void => {
    out.push(node.path);
    if (isTextBlock(node)) {
      visit(node.begin);
      for (const line of node.lines) {
        visit(line);
      }
      if (node.end !== undefined) {
        visit(node.end);
      }
      return;
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
    if ('trailing' in node) {
      for (const child of node.trailing) {
        visit(child);
      }
    }
  };
  for (const line of document.lines) {
    visit(line);
  }
  return out;
}

describe.each(fixtures)('lossless AST invariant: %s', (name) => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
  const decodedText = decodeJcx(bytes).text;
  const lex = lexJcx(bytes);
  const ast = buildAst(lex);

  it('① 全文不变式：printAst(buildAst(lex)) === decodedText', () => {
    expect(printAst(ast)).toBe(decodedText);
  });

  it('② 逐行不变式：每个行节点的 printNode 等于其覆盖的物理行原文拼接', () => {
    for (const line of ast.lines) {
      if (isTextBlock(line)) {
        const beginIndex = parseAstPath(line.path)?.line;
        expect(beginIndex).not.toBeUndefined();
        const span = 1 + line.lines.length + (line.end !== undefined ? 1 : 0);
        const endIndex = (beginIndex as number) + span - 1;
        const expected = joinPhysicalLines(decodedText, lex.lines, beginIndex as number, endIndex, lex.hasBom);
        expect(printNode(line)).toBe(expected);
        continue;
      }
      const physicalIndex = parseAstPath(line.path)?.line;
      expect(physicalIndex).not.toBeUndefined();
      const expected = joinPhysicalLines(
        decodedText,
        lex.lines,
        physicalIndex as number,
        physicalIndex as number,
        lex.hasBom,
      );
      expect(printNode(line as JcxLineNode)).toBe(expected);
    }
  });

  it('③ 所有 path（含 document.bom、textBlock 内部子行）互不相同', () => {
    const paths = collectPaths(ast);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('④ diagnostics 直接透传自 lexer（引用相等）', () => {
    expect(ast.diagnostics).toBe(lex.diagnostics);
  });
});
