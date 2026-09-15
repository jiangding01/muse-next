import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAst } from '../../../src/formats/jcx/ast';
import { lexJcx } from '../../../src/formats/jcx/lexer';
import { loadJcx } from '../../../src/formats/jcx/loadJcx';
import { parseJcxDocument } from '../../../src/formats/jcx/parse';

/**
 * M1.6 T10a DoD：`loadJcx` 串起 `lexJcx → buildAst → parseJcxDocument`，字节
 * 与字符串两条重载路径都要覆盖；异常契约与 `lexJcx` 完全一致（见
 * `src/formats/jcx/loadJcx.ts` 顶部注释）。
 */
const MINIMAL_PATH = resolve(__dirname, '../../fixtures/jcx/minimal.jcx');

describe('loadJcx', () => {
  it('字节输入：三层结果都在，且与手动串联 lexJcx → buildAst → parseJcxDocument 一致', () => {
    const bytes = new Uint8Array(readFileSync(MINIMAL_PATH));
    const result = loadJcx(bytes);

    const lex = lexJcx(bytes);
    const ast = buildAst(lex);
    const parsed = parseJcxDocument(ast);

    expect(result.lex).toEqual(lex);
    expect(result.ast).toEqual(ast);
    expect(result.score).toEqual(parsed.score);
    expect(result.index).toEqual(parsed.index);
    // diagnostics 与 parse 一致（同内容，ParseResult 契约本就保证是新数组，
    // 这里只锁内容相等，不断言引用）。
    expect(result.diagnostics).toEqual(parsed.diagnostics);
  });

  it('字符串输入：同样返回三层结果，且与字节输入内容等价', () => {
    const bytes = readFileSync(MINIMAL_PATH);
    const text = new TextDecoder('utf-8').decode(bytes);
    const result = loadJcx(text);
    const byteResult = loadJcx(new Uint8Array(bytes));

    expect(result.lex.lines).toEqual(byteResult.lex.lines);
    expect(result.score).toEqual(byteResult.score);
    expect(result.index).toEqual(byteResult.index);
  });

  it('字符串输入透传 sourceEncoding，仅影响 lex.encoding 标注', () => {
    const text = readFileSync(MINIMAL_PATH, 'utf-8');
    const result = loadJcx(text, { sourceEncoding: 'gb18030' });
    expect(result.lex.encoding).toBe('gb18030');
  });

  it('minimal fixture 的 LoadResult 三层都在，diagnostics 与 parse 结果一致', () => {
    const bytes = new Uint8Array(readFileSync(MINIMAL_PATH));
    const result = loadJcx(bytes);

    expect(result.lex).toBeDefined();
    expect(result.ast).toBeDefined();
    expect(result.score.voices).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.severity === 'error')).toBe(false);
    // diagnostics 是 ast.diagnostics 与 parse 阶段诊断的合并，理应与 lex 阶段
    // 的诊断内容一致地被包含（parse 未新增诊断时二者相等）。
    expect(result.diagnostics).toEqual([...result.ast.diagnostics]);
  });

  it('UTF-16 LE BOM 字节输入抛出 name === "JcxEncodingError" 的 Error，与 lexJcx 行为一致', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x54, 0x00]);
    expect(() => loadJcx(bytes)).toThrow();
    try {
      loadJcx(bytes);
      expect.unreachable();
    } catch (error) {
      expect(error instanceof Error && error.name === 'JcxEncodingError').toBe(true);
    }
  });

  it('UTF-16 BE BOM 字节输入同样抛出编码错误', () => {
    const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x54]);
    expect(() => loadJcx(bytes)).toThrow();
  });
});
