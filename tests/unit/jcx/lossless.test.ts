import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexDocument } from '../../../src/formats/jcx/lexer/lexDocument';
import { flattenTokens, rawOf } from '../../../src/formats/jcx/lexer/token';
import { createDiagnosticBag } from '../../../src/formats/jcx/lexer/diagnostics';

/**
 * §29.5 行级不变式 + 全文不变式的 fixture 回归。
 *
 * 只扫描 `tests/fixtures/jcx/` 根目录下的 `*.jcx`（非递归），不进入
 * `encoding/` 等子目录 —— 那些由 T2 负责，不属于本任务范围。
 */
const FIXTURES_DIR = resolve(__dirname, '../../fixtures/jcx');

function listFixtures(): string[] {
  return readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jcx'))
    .map((entry) => entry.name)
    .sort();
}

function readFixtureText(name: string): string {
  const bytes = readFileSync(resolve(FIXTURES_DIR, name));
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}

const fixtures = listFixtures();

// 保底：确保 fixture 目录确实非空，避免这份测试因为目录读空而「假绿」。
it('至少存在 lossless 回归用的根目录 fixture', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

describe.each(fixtures)('lossless invariant: %s', (name) => {
  const text = readFixtureText(name);
  const bag = createDiagnosticBag();
  const lines = lexDocument(text, bag);

  it('① 全文不变式：flattenTokens 的 raw 拼接等于原文', () => {
    expect(rawOf(flattenTokens(lines))).toBe(text);
  });

  it('② 逐行不变式：每行 tokens 的 raw 拼接等于 text.slice(line.span)', () => {
    for (const line of lines) {
      const expected = text.slice(line.span.start.offset, line.span.end.offset);
      expect(rawOf(line.tokens)).toBe(expected);
    }
  });

  it('③ 每个 token 的 raw 等于 text.slice(token.span)', () => {
    for (const line of lines) {
      for (const token of line.tokens) {
        const expected = text.slice(token.span.start.offset, token.span.end.offset);
        expect(token.raw).toBe(expected);
      }
    }
  });
});
