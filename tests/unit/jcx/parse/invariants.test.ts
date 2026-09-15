import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { buildAst } from '../../../../src/formats/jcx/ast';
import { parseJcxDocument } from '../../../../src/formats/jcx/parse';
import {
  checkEventKindsAllowed,
  checkIndexConsistency,
  checkNoErrorDiagnostics,
  checkUnitLengthChangeOutsideLyricRanges,
} from '../../../../scripts/jcx/lib/parseInvariants';

/**
 * M1.6 T10a DoD：对 `tests/fixtures/jcx/**\/*.jcx` 全部 fixture 跑 parse 级四条
 * 断言（方案 §5 T10a 行）。断言逻辑与语料回归脚本
 * （`scripts/jcx/corpus-lex-test.ts`）共用 `scripts/jcx/lib/parseInvariants.ts`，
 * 不重写第二份。表驱动：fixture 数量由 glob 运行时统计，不硬编码。
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

it('至少存在 parse 级回归用的 fixture', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)('parse invariants: %s', (name) => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
  const ast = buildAst(lexJcx(bytes));

  it('① parseJcxDocument 对 buildAst 产出的 AST 不抛异常', () => {
    expect(() => parseJcxDocument(ast)).not.toThrow();
  });

  const { score, diagnostics, index } = parseJcxDocument(ast);

  it('② diagnostics 中无 error 级', () => {
    expect(checkNoErrorDiagnostics(diagnostics)).toEqual([]);
  });

  it('③ index 自洽：eventById / relationById 数量匹配，byPath 的 key 均可被 parseAstPath 解析', () => {
    expect(checkIndexConsistency(score, index)).toEqual([]);
  });

  it('④ 每个 voice 的 events 不含 marker kind（kind 集合 ⊆ 十种 MusicEvent）', () => {
    expect(checkEventKindsAllowed(score)).toEqual([]);
  });

  it('⑥（M1.7 T5 补充）unitLengthChanges 不落在任何 LyricLine.bodyRange 内部（首事件除外）', () => {
    expect(checkUnitLengthChangeOutsideLyricRanges(score)).toEqual([]);
  });
});
