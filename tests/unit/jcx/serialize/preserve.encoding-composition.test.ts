/**
 * fixture 级多编码往返矩阵（M1.8 T3，方案 v1.1 §4 T3）。
 *
 * 与语料级 `scripts/jcx/lib/encodingComposition.ts` 同规则，对
 * `tests/fixtures/jcx/encoding/**\/*.jcx` 里检测到的 GB18030 fixture（glob，
 * 非空断言）做 GB18030 → UTF-8 → GB18030 三段往返：
 *
 *   `loadedOriginal = loadJcx(originalBytes)`
 *   → `utf8Bytes = serializeJcx(loadedOriginal, {mode:'preserve', encoding:'utf-8'}).bytes`
 *   → `loadedUtf8 = loadJcx(utf8Bytes)`（应检测为 `'utf-8'`）
 *   → `gb18030Bytes = serializeJcx(loadedUtf8, {mode:'preserve', encoding:'gb18030'}).bytes`
 *   → 必须与 `originalBytes` 逐字节相等。
 *
 * 中间 UTF-8 态额外断言：编码检测、BOM 状态符合预期、L2 投影相等。**BOM 预期值
 * 不是 `loadedOriginal.ast.hasBom`**（`decodeJcx.ts` 的 GB18030 分支恒定
 * `hasBom: false`），而是「原始文本首字符是否为 U+FEFF」（`printAst` 还原全文本
 * 后取首字符）——`gb18030-leading-feff.jcx` 就是覆盖这条分支专门自造的
 * fixture：内容首字符是 U+FEFF，但源编码是 GB18030，`decodeJcx` 对它恒报
 * `hasBom: false`，转存 UTF-8 后重新触发 BOM 前缀检测，应正确得到 `hasBom: true`。
 *
 * 另做反向组合：UTF-8 fixture → GB18030 → UTF-8。`encoding-utf8.jcx` 的内容
 * 实测可被 GB18030 完整编码（`serializeJcx(..., {encoding:'gb18030'}).diagnostics`
 * 为空数组，无 `onUnencodable` 替换发生），因此这里断言的是「无不可编码字符时
 * 三段往返同样逐字节回到原文」；若某天该 fixture 换成含 GB18030 不可编码字符的
 * 内容，默认 `onUnencodable: 'error'` 策略会在中途抛 `JcxEncodingError`，
 * 那属于 `encodeJcx.ts` 既有语义，不是本文件要新增的分支。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadJcx, printAst } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import { projectScore, projectionEquals } from '../../../../src/formats/jcx/serialize';

/** §5.5：BOM 不剥离，文本首字符即 U+FEFF——与 `lexer/index.ts` 的同名常量同值。 */
const BOM_CHAR = '﻿';

const ENCODING_FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx/encoding');

function listEncodingFixtures(): string[] {
  return readdirSync(ENCODING_FIXTURES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jcx'))
    .map((entry) => entry.name)
    .sort();
}

function readEncodingFixtureBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(ENCODING_FIXTURES_DIR, name)));
}

const encodingFixtureNames = listEncodingFixtures();

const gb18030FixtureNames = encodingFixtureNames.filter(
  (name) => loadJcx(readEncodingFixtureBytes(name)).ast.encoding === 'gb18030',
);

const utf8FixtureNames = encodingFixtureNames.filter(
  (name) => loadJcx(readEncodingFixtureBytes(name)).ast.encoding === 'utf-8',
);

it('encoding/ 下至少存在一个 GB18030 fixture', () => {
  expect(gb18030FixtureNames.length).toBeGreaterThan(0);
});

it('encoding/ 下至少存在一个 UTF-8 fixture', () => {
  expect(utf8FixtureNames.length).toBeGreaterThan(0);
});

describe.each(gb18030FixtureNames)(
  'GB18030 -> UTF-8 -> GB18030 三段往返: %s',
  (name) => {
    it('中间 UTF-8 态：编码检测为 utf-8，BOM 符合「原始文本首字符是否为 U+FEFF」，L2 投影相等', () => {
      const originalBytes = readEncodingFixtureBytes(name);
      const loadedOriginal = loadJcx(originalBytes);
      expect(loadedOriginal.ast.encoding).toBe('gb18030');

      const utf8Result = serializeJcx(loadedOriginal, { mode: 'preserve', encoding: 'utf-8' });
      const loadedUtf8 = loadJcx(utf8Result.bytes);

      expect(loadedUtf8.ast.encoding).toBe('utf-8');
      // 预期值不是 `loadedOriginal.ast.hasBom`（GB18030 分支恒 false），而是
      // 原始文本首字符是否为 U+FEFF——见文件头注释与 `gb18030-leading-feff.jcx`。
      const expectedBom = printAst(loadedOriginal.ast).startsWith(BOM_CHAR);
      expect(loadedUtf8.ast.hasBom).toBe(expectedBom);
      expect(
        projectionEquals(projectScore(loadedUtf8.score), projectScore(loadedOriginal.score)),
      ).toBe(true);
    });

    it('回存 GB18030 后与原字节逐字节相等', () => {
      const originalBytes = readEncodingFixtureBytes(name);
      const loadedOriginal = loadJcx(originalBytes);

      const utf8Result = serializeJcx(loadedOriginal, { mode: 'preserve', encoding: 'utf-8' });
      const loadedUtf8 = loadJcx(utf8Result.bytes);
      const gb18030Result = serializeJcx(loadedUtf8, { mode: 'preserve', encoding: 'gb18030' });

      expect(Array.from(gb18030Result.bytes)).toEqual(Array.from(originalBytes));
    });
  },
);

describe('GB18030 文本首字符为 U+FEFF 的边界情形: gb18030-leading-feff.jcx', () => {
  const FIXTURE_NAME = 'gb18030-leading-feff.jcx';

  it('原始检测为 gb18030、hasBom 恒 false，但文本首字符确实是 U+FEFF', () => {
    const loadedOriginal = loadJcx(readEncodingFixtureBytes(FIXTURE_NAME));
    expect(loadedOriginal.ast.encoding).toBe('gb18030');
    expect(loadedOriginal.ast.hasBom).toBe(false);
    expect(printAst(loadedOriginal.ast).startsWith(BOM_CHAR)).toBe(true);
  });

  it('转存 UTF-8 后中间态 hasBom 为 true，且三段往返字节与原文逐字节相等', () => {
    const originalBytes = readEncodingFixtureBytes(FIXTURE_NAME);
    const loadedOriginal = loadJcx(originalBytes);

    const utf8Result = serializeJcx(loadedOriginal, { mode: 'preserve', encoding: 'utf-8' });
    const loadedUtf8 = loadJcx(utf8Result.bytes);
    expect(loadedUtf8.ast.encoding).toBe('utf-8');
    expect(loadedUtf8.ast.hasBom).toBe(true);
    expect(
      projectionEquals(projectScore(loadedUtf8.score), projectScore(loadedOriginal.score)),
    ).toBe(true);

    const gb18030Result = serializeJcx(loadedUtf8, { mode: 'preserve', encoding: 'gb18030' });
    expect(Array.from(gb18030Result.bytes)).toEqual(Array.from(originalBytes));
  });
});

describe.each(utf8FixtureNames)('UTF-8 -> GB18030 -> UTF-8 三段往返（反向）: %s', (name) => {
  it('无 GB18030 不可编码字符时，三段往返逐字节回到原文', () => {
    const originalBytes = readEncodingFixtureBytes(name);
    const loadedOriginal = loadJcx(originalBytes);
    expect(loadedOriginal.ast.encoding).toBe('utf-8');

    const gb18030Result = serializeJcx(loadedOriginal, { mode: 'preserve', encoding: 'gb18030' });
    // 本 fixture 当前内容全部可编码：`onUnencodable` 默认策略 `'error'` 不会
    // 被触发，diagnostics 为空数组。若换成含孤立 surrogate 等不可编码字符的
    // 内容，这里会抛 `JcxEncodingError`（`encodeJcx.ts` 既有语义），需要改用
    // `expect(() => ...).toThrow()` 或显式传 `onUnencodable: 'replace'` 断言
    // 替换后的 `jcx.serialize.unencodable-replaced` diagnostic。
    expect(gb18030Result.diagnostics).toEqual([]);

    const loadedGb18030 = loadJcx(gb18030Result.bytes);
    expect(loadedGb18030.ast.encoding).toBe('gb18030');
    // `hasBom` **不**要求与原始一致：`decodeJcx.ts` 的 `DecodedJcx.hasBom` 文档
    // 明确「目前仅 UTF-8 BOM 可能为 true」——GB18030 检测分支恒定 `hasBom: false`
    // （见 `decodeJcx` 源码），即便 U+FEFF 字符本身仍原样保留在 `text` 里、
    // 编码进了 GB18030 字节。这与正向（GB18030→UTF-8）方向的
    // `utf8BomMatchesOriginal` 不对称：正向目标编码是 UTF-8，会重新触发 BOM
    // 前缀检测；反向目标编码是 GB18030，该检测分支从不设 `hasBom: true`。
    // 只要 U+FEFF 字符本身留在 text 里、最终 UTF-8 回写时又能重新产出
    // `EF BB BF` 前缀（下面的字节相等断言即验证这一点），这条不对称就不是缺陷。
    expect(
      projectionEquals(projectScore(loadedGb18030.score), projectScore(loadedOriginal.score)),
    ).toBe(true);

    const utf8Result = serializeJcx(loadedGb18030, { mode: 'preserve', encoding: 'utf-8' });
    expect(Array.from(utf8Result.bytes)).toEqual(Array.from(originalBytes));
  });
});
