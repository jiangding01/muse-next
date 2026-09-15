import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { decodeJcx } from '../../../../src/formats/jcx/encoding/decodeJcx';
import { buildAst, printAst } from '../../../../src/formats/jcx/ast';
import { checkLineTextInvariant, collectAstPaths } from '../../../../scripts/jcx/lib/astInvariants';

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

describe.each(fixtures)('lossless AST invariant: %s', (name) => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
  const decodedText = decodeJcx(bytes).text;
  const lex = lexJcx(bytes);
  const ast = buildAst(lex);

  it('① 全文不变式：printAst(buildAst(lex)) === decodedText', () => {
    expect(printAst(ast)).toBe(decodedText);
  });

  it('② 逐行不变式：每个行节点的 printNode 等于其覆盖的物理行原文拼接', () => {
    const mismatches = checkLineTextInvariant(ast.lines, decodedText, lex.lines, lex.hasBom);
    expect(mismatches).toEqual([]);
  });

  it('③ 所有 path（含 document.bom、textBlock 内部子行、body 组合节点）互不相同', () => {
    const paths = collectAstPaths(ast);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('④ diagnostics 直接透传自 lexer（引用相等）', () => {
    expect(ast.diagnostics).toBe(lex.diagnostics);
  });
});
