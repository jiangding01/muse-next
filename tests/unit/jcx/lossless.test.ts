import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexJcx } from '../../../src/formats/jcx/lexer';
import { decodeJcx } from '../../../src/formats/jcx/encoding/decodeJcx';
import { flattenTokens, rawOf } from '../../../src/formats/jcx/lexer/token';

/**
 * §29.5 行级不变式 + 全文不变式的 fixture 回归。
 *
 * T7 起改为经**对外入口 `lexJcx` 并以字节喂入**：这样同时覆盖 `decodeJcx`
 * 的编码检测路径（`encoding/` 子目录的 GB18030 / BOM fixture 正是为此存在），
 * 并保证「应用层实际调用的那条路径」满足无损不变量，而不只是内部的 `lexDocument`。
 *
 * 遍历 `tests/fixtures/jcx/` 及其子目录下的全部 `*.jcx`。
 */
const FIXTURES_DIR = resolve(__dirname, '../../fixtures/jcx');

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

// 保底：确保 fixture 目录确实非空，避免这份测试因为目录读空而「假绿」。
it('至少存在 lossless 回归用的 fixture', () => {
  expect(fixtures.length).toBeGreaterThan(0);
});

// 保底：确认 encoding/ 子目录确实被纳入遍历（T7 扩大遍历范围的回归锚点）。
it('遍历范围包含 encoding/ 子目录', () => {
  expect(fixtures.some((name) => name.startsWith('encoding'))).toBe(true);
});

describe.each(fixtures)('lossless invariant: %s', (name) => {
  const bytes = new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
  // 期望文本取自同一个解码器 —— 不变量比较的是「解码文本 ↔ token raw」，
  // 而不是「字节 ↔ token raw」（编码回写是 M1.7 Serializer 的职责）。
  const text = decodeJcx(bytes).text;
  const result = lexJcx(bytes);

  it('① 全文不变式：flattenTokens 的 raw 拼接等于解码文本', () => {
    expect(rawOf(flattenTokens([...result.lines]))).toBe(text);
  });

  it('② 逐行不变式：每行 tokens 的 raw 拼接等于 text.slice(line.span)', () => {
    for (const line of result.lines) {
      const expected = text.slice(line.span.start.offset, line.span.end.offset);
      expect(rawOf(line.tokens)).toBe(expected);
    }
  });

  it('③ 每个 token 的 raw 等于 text.slice(token.span)', () => {
    for (const line of result.lines) {
      for (const token of line.tokens) {
        const expected = text.slice(token.span.start.offset, token.span.end.offset);
        expect(token.raw).toBe(expected);
      }
    }
  });

  it('④ Lexer 阶段不产生 error 级 diagnostic', () => {
    expect(result.diagnostics.filter((item) => item.severity === 'error')).toEqual([]);
  });
});
