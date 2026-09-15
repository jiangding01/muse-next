/**
 * JCX preserve 序列化回归（M1.7 T2，方案 v1.1 §2/§5/§6 Level 3）。
 *
 * 四组用例：
 * ① 全部 `tests/fixtures/jcx/**\/*.jcx`（运行时 glob，数量不写死）：
 *    `bytes → loadJcx → serializeJcx(result, {mode:'preserve'})`，`bytes` 与原字节
 *    逐字节相等（preserve round-trip 的核心承诺）。
 * ② 显式 `encoding: 'utf-8'`：GB18030 fixture 转码后 `text` 不变、`bytes` 变成 UTF-8。
 * ③ span 失效守卫：把 `document.bom`（一个叶子）的 `span` 换成结构展开出的新对象
 *    （`offset: -1`），`printAst` 仍然只读 `raw`，输出不受影响。
 * ④ `LoadResult` 与裸 `JcxAstDocument` 两种输入的结果一致（`preserve.ts` 的 `resolveAst`
 *    分支覆盖）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadJcx, printAst } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import { encodeJcx } from '../../../../src/formats/jcx/serialize/encodeJcx';

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

const fixtureNames = listFixtures(FIXTURES_DIR).map((full) => relative(FIXTURES_DIR, full));

function readFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(FIXTURES_DIR, name)));
}

it('至少存在 preserve round-trip 用的 fixture', () => {
  expect(fixtureNames.length).toBeGreaterThan(0);
});

describe.each(fixtureNames)('preserve Level 3 round-trip: %s', (name) => {
  it('bytes → loadJcx → serializeJcx(preserve) 的 bytes 与原字节逐字节相等', () => {
    const original = readFixtureBytes(name);
    const loaded = loadJcx(original);
    const result = serializeJcx(loaded, { mode: 'preserve' });

    expect(Array.from(result.bytes)).toEqual(Array.from(original));
    expect(result.encoding).toBe(loaded.ast.encoding);
    expect(result.diagnostics).toEqual([]);
  });
});

describe('preserve：显式转码', () => {
  it("GB18030 fixture 显式 encoding: 'utf-8'：text 不变、bytes 变成 UTF-8", () => {
    const original = readFixtureBytes('encoding/encoding-gb18030.jcx');
    const loaded = loadJcx(original);
    expect(loaded.ast.encoding).toBe('gb18030');

    const preservedSameEncoding = serializeJcx(loaded, { mode: 'preserve' });
    const recoded = serializeJcx(loaded, { mode: 'preserve', encoding: 'utf-8' });

    // text 不变：都等于 printAst(ast) 的结果，与目标编码无关。
    expect(recoded.text).toBe(preservedSameEncoding.text);
    expect(recoded.text).toBe(printAst(loaded.ast));
    expect(recoded.encoding).toBe('utf-8');

    // bytes 确实变成了 UTF-8：与独立调用 encodeJcx(text, 'utf-8') 的结果一致，
    // 且与原始（GB18030）字节不同。
    const expectedUtf8 = encodeJcx(recoded.text, 'utf-8');
    expect(Array.from(recoded.bytes)).toEqual(Array.from(expectedUtf8.bytes));
    expect(Array.from(recoded.bytes)).not.toEqual(Array.from(original));
  });
});

describe('preserve：span 失效守卫', () => {
  it('叶子 span 被替换为结构展开的新对象（offset: -1）后，printAst 输出不受影响', () => {
    const original = readFixtureBytes('bom-utf8.jcx');
    const loaded = loadJcx(original);
    const bomLeaf = loaded.ast.bom;
    expect(bomLeaf).toBeDefined();
    if (bomLeaf === undefined) {
      throw new Error('unreachable: bom-utf8.jcx 应当带 BOM');
    }

    const expectedText = printAst(loaded.ast);

    const corruptedBom = {
      ...bomLeaf,
      span: {
        start: { ...bomLeaf.span.start, offset: -1 },
        end: { ...bomLeaf.span.end },
      },
    };
    const corruptedAst = { ...loaded.ast, bom: corruptedBom };

    expect(printAst(corruptedAst)).toBe(expectedText);

    const result = serializeJcx(corruptedAst, { mode: 'preserve' });
    expect(Array.from(result.bytes)).toEqual(Array.from(original));
  });
});

describe('preserve：LoadResult 与裸 JcxAstDocument 输入一致', () => {
  it('两种输入形态对同一份 fixture 产出相同的 SerializeResult', () => {
    const original = readFixtureBytes('minimal.jcx');
    const loaded = loadJcx(original);

    const fromLoadResult = serializeJcx(loaded, { mode: 'preserve' });
    const fromBareAst = serializeJcx(loaded.ast, { mode: 'preserve' });

    expect(fromBareAst.text).toBe(fromLoadResult.text);
    expect(fromBareAst.encoding).toBe(fromLoadResult.encoding);
    expect(Array.from(fromBareAst.bytes)).toEqual(Array.from(fromLoadResult.bytes));
    expect(fromBareAst.diagnostics).toEqual(fromLoadResult.diagnostics);
  });
});
