/**
 * `notation/svg/**` 与 `notation/layout/{metrics,textMeasurer}.ts` 的契约测试
 * （M2 方案 v1.1.1 §2.3 / §2.5 / §2.8 / §6 T2）。
 *
 * 覆盖：
 * - `serializeSvg`：属性顺序稳定、转义、数字格式化、幂等/不修改输入；
 * - `node.ts`：tag 白名单拒绝非法 tag；
 * - `textMeasurer`：确定性默认实现——同输入同输出、ASCII/CJK 宽度差异、空串；
 * - **metrics 唯一来源守卫**：`src/notation/**` 下除 `metrics.ts`（与 `model/**`，渲染
 *   中立模型不含尺寸）外不得出现顶层裸数字尺寸常量，含正/反例证明规则既不漏也不过宽。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { element, isSvgTag, textElement, type SvgNode } from '../../../src/notation/svg/node';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';
import { TEXT_METRICS } from '../../../src/notation/layout/metrics';
import {
  createDeterministicTextMeasurer,
  type TextMetricsTable,
} from '../../../src/notation/layout/textMeasurer';

describe('serializeSvg —— 属性顺序稳定', () => {
  it('同一属性集合无论字面量书写顺序如何，序列化结果逐字符相等', () => {
    const a = element('rect', { x: 1, width: 10, y: 2, height: 20 });
    const b = element('rect', { height: 20, y: 2, width: 10, x: 1 });
    expect(serializeSvg(a)).toBe(serializeSvg(b));
    expect(serializeSvg(a)).toBe('<rect height="20" width="10" x="1" y="2"/>');
  });

  it('同一节点两次序列化逐字符相等（幂等的前提）', () => {
    const node = element('g', { 'data-voice-id': 'v1' }, [element('circle', { cx: 3, cy: 4, r: 5 })]);
    expect(serializeSvg(node)).toBe(serializeSvg(node));
  });
});

describe('serializeSvg —— 转义', () => {
  it('属性值转义 & < > "（& 先转义，避免二次转义）', () => {
    const withAttr = element('rect', { 'data-label': `a&b<c>d"e` });
    expect(serializeSvg(withAttr)).toBe('<rect data-label="a&amp;b&lt;c&gt;d&quot;e"/>');
  });

  it('文本内容只转义 & 与 <（不转义 > 与 "）', () => {
    const node = textElement('text', `a&b<c>d"e`);
    expect(serializeSvg(node)).toBe('<text>a&amp;b&lt;c>d"e</text>');
  });

  it('属性值与文本内容各自独立转义，互不影响', () => {
    const node = textElement('text', `<lyrics>`, { 'data-label': `"quoted"` });
    expect(serializeSvg(node)).toBe('<text data-label="&quot;quoted&quot;">&lt;lyrics></text>');
  });
});

describe('serializeSvg —— 数字格式化', () => {
  it('四舍五入到小数点后 4 位，并去掉多余尾随零/小数点', () => {
    expect(serializeSvg(element('rect', { x: 1.00001 }))).toBe('<rect x="1"/>');
    expect(serializeSvg(element('rect', { x: 1.23456789 }))).toBe('<rect x="1.2346"/>');
    expect(serializeSvg(element('rect', { x: 2 }))).toBe('<rect x="2"/>');
  });

  it('-0 归一化为 0', () => {
    expect(serializeSvg(element('rect', { x: -0 }))).toBe('<rect x="0"/>');
    expect(serializeSvg(element('rect', { x: -0.00001 }))).toBe('<rect x="0"/>');
  });

  it('非有限数抛错，不静默吞掉（坐标必须永远有限，§7-10）', () => {
    expect(() => serializeSvg(element('rect', { x: Number.NaN }))).toThrow(RangeError);
    expect(() => serializeSvg(element('rect', { x: Number.POSITIVE_INFINITY }))).toThrow(RangeError);
  });
});

describe('serializeSvg —— 幂等 / 不修改输入', () => {
  it('序列化前后输入深比较不变（结构与值都不变）', () => {
    const original = element('g', { 'data-event-id': 'e1' }, [
      element('line', { x1: 0, y1: 0, x2: 10, y2: 10 }),
      textElement('text', '1', { x: 5, y: 5 }),
    ]);
    const before = structuredClone(original);
    serializeSvg(original);
    serializeSvg(original);
    expect(original).toEqual(before);
  });
});

describe('serializeSvg —— 空节点是自闭合标签', () => {
  it('无 text 也无 children 的节点序列化为自闭合标签', () => {
    expect(serializeSvg(element('circle', { cx: 1, cy: 2, r: 3 }))).toBe('<circle cx="1" cy="2" r="3"/>');
    expect(serializeSvg(element('g'))).toBe('<g/>');
  });

  it('文本节点是合法形状：只有 text，没有 children（判别联合，类型上不可共存）', () => {
    const node: SvgNode = { tag: 'text', attrs: {}, text: 'wins' };
    expect(serializeSvg(node)).toBe('<text>wins</text>');
  });
});

describe('SvgNode —— tag 白名单', () => {
  it('白名单内的 tag 通过 isSvgTag / element / textElement', () => {
    expect(isSvgTag('svg')).toBe(true);
    expect(isSvgTag('polygon')).toBe(true);
    expect(() => element('path', { d: 'M0 0' })).not.toThrow();
    expect(() => textElement('tspan', 'x')).not.toThrow();
  });

  it('拒绝非法 tag：isSvgTag 返回 false，element/textElement 抛错', () => {
    // 用 JSON.parse 得到一个类型为 any 的字符串，绕开 SvgTag 字面量联合在编译期的收窄，
    // 从而能真正测到运行时校验（不使用 `as` 断言）。
    const foreignTag = JSON.parse('"foreignObject"');
    expect(isSvgTag(foreignTag)).toBe(false);
    expect(() => element(foreignTag, {}, [])).toThrow(RangeError);
    expect(() => textElement(foreignTag, 'x')).toThrow(RangeError);
  });
});

describe('textMeasurer —— 确定性', () => {
  const measurer = createDeterministicTextMeasurer();

  it('同输入同输出', () => {
    const a = measurer.measure('hello', { fontSize: 12 });
    const b = measurer.measure('hello', { fontSize: 12 });
    expect(a).toEqual(b);
  });

  it('空串宽度为 0，高度仍为一行行高', () => {
    const result = measurer.measure('', { fontSize: 12 });
    expect(result.width).toBe(0);
    expect(result.height).toBe(TEXT_METRICS.lineHeight);
  });

  it('CJK 字符比 ASCII 字符宽（同字号下）', () => {
    const ascii = measurer.measure('a', { fontSize: 12 });
    const cjk = measurer.measure('中', { fontSize: 12 });
    expect(cjk.width).toBeGreaterThan(ascii.width);
    expect(ascii.width).toBe(TEXT_METRICS.asciiCharWidth);
    expect(cjk.width).toBe(TEXT_METRICS.cjkCharWidth);
  });

  it('宽度按字号线性缩放', () => {
    const base = measurer.measure('ab', { fontSize: TEXT_METRICS.fontSize });
    const doubled = measurer.measure('ab', { fontSize: TEXT_METRICS.fontSize * 2 });
    expect(doubled.width).toBeCloseTo(base.width * 2, 10);
    expect(doubled.height).toBeCloseTo(base.height * 2, 10);
  });

  it('可注入自定义度量表：不是硬编码单例', () => {
    const customTable: TextMetricsTable = {
      fontSize: 10,
      lineHeight: 10,
      asciiCharWidth: 100,
      cjkCharWidth: 200,
      fallbackCharWidth: 300,
    };
    const custom = createDeterministicTextMeasurer(customTable);
    const result = custom.measure('a', { fontSize: 10 });
    expect(result.width).toBe(100);
  });

  it('无法归类的字符走 fallback 宽度（零宽连接符等）', () => {
    const result = measurer.measure('​', { fontSize: 12 });
    expect(result.width).toBe(TEXT_METRICS.fallbackCharWidth);
  });

  it('半角片假名 / 半角符号按 ASCII 宽度计（P2-4，不是 FF00–FFEF 一整块都算 CJK）', () => {
    // U+FF71 ｱ：半角片假名 "ア"。
    const halfwidthKatakana = measurer.measure('ｱ', { fontSize: 12 });
    expect(halfwidthKatakana.width).toBe(TEXT_METRICS.asciiCharWidth);
    // 对照：同一形状的全角片假名落在 CJK 区间，应更宽。
    const fullwidthKatakana = measurer.measure('ア', { fontSize: 12 });
    expect(fullwidthKatakana.width).toBe(TEXT_METRICS.cjkCharWidth);
  });

  it('代理对字符（emoji / CJK 扩展 B）按码点计数一次，不按 UTF-16 code unit 计数两次（P2-3）', () => {
    // U+1F600 😀：不在任何 CJK 区间，落 fallback；关键断言是「一个字符宽度」而不是
    // 「两个 UTF-16 code unit 各自算一次」（naive 的 text.length 遍历会错误地数成 2）。
    const emoji = measurer.measure('😀', { fontSize: 12 });
    expect(emoji.width).toBe(TEXT_METRICS.fallbackCharWidth);
    expect('😀'.length).toBe(2); // 佐证：这是一个 UTF-16 代理对，length 是 2 而不是 1。

    // U+20000 𠀀：CJK 扩展 B（补充表意文字平面），同样是代理对，应记 1 个 CJK 宽度。
    const extensionB = measurer.measure('𠀀', { fontSize: 12 });
    expect(extensionB.width).toBe(TEXT_METRICS.cjkCharWidth);
    expect('𠀀'.length).toBe(2);
  });

  it('多字符文本按码点求和，代理对不会让总宽度多算', () => {
    // "𠀀" + "a"：扩展 B 一个字 + ASCII 一个字，期望宽度 = cjkCharWidth + asciiCharWidth，
    // 而不是（错误地按 UTF-16 code unit 计数时）3 个宽度单位之和。
    const result = measurer.measure('𠀀a', { fontSize: 12 });
    expect(result.width).toBe(TEXT_METRICS.cjkCharWidth + TEXT_METRICS.asciiCharWidth);
  });
});

describe('metrics —— 尺寸常量唯一来源守卫（§2.8 / §7-19，P2-2 扩大扫描范围）', () => {
  /**
   * 规则（本文件选定，见 T2 报告，P1-2 修订为结构化按声明符解析而非单一大正则）：
   * 在 `src/notation/**` 下（排除 `layout/metrics.ts` 本身与 `model/**`——model 是
   * 渲染中立模型，不含任何尺寸；T3 已把 `chord/ChordDiagram.tsx` 整体迁出
   * `src/notation/**`，不再有任何例外），任何文件都不得
   * 出现**顶层**（零缩进、不在任何函数体内部）的 `const`/`let` 声明，其声明符
   * （单行可能有多个，用顶层逗号分隔）的右值是一个裸数字字面量：十进制整数/小数
   * （含 `_` 数字分隔符）、十六进制（`0x...`）、科学计数法（`1e3`），可选带一个
   * 尾随的 `as const`。
   *
   * 允许：
   * - 结构性数字 `0` / `1` / `-1` / `2`（数组下标、符号位、二分之类的结构含义，
   *   不是尺寸）——判定时先剥掉 `as const` 与 `_` 分隔符再比较；
   * - 带 `// numeric-guard: allow` 行尾注释的显式白名单（留给确有理由的例外，
   *   而不是删掉规则）；
   * - 函数体内部/嵌套的字面量（例如 `serializeSvg.ts` 里 `toFixed(4)` 的 `4` 是
   *   序列化精度、不是布局尺寸，不在本规则的管辖范围）。
   *
   * **第二条规则（本轮 /check P1 新增）**：除「顶层 const/let = 裸数字」外，还命中
   * **顶层 `const`/`let` 声明、右值是对象字面量（可选尾随 `as const`）时，该对象内部
   * 任意一条 `key: <纯数字>` 属性**——`layoutChord.ts` 曾经把一整张几何尺寸表就地
   * 塞进一个顶层对象常量（`CHORD_GEOMETRY`）绕过了第一条规则（对象字面量右值本身
   * 不是「纯数字」），这正是本条要堵住的漏洞。多行对象需要跨行解析：从顶层声明的
   * `{` 开始按括号深度找到匹配的 `}`，再对块内每一行按 `key: value` 判定，同样应用
   * 结构性白名单与 `// numeric-guard: allow`。**不递归进函数体**：只有顶层声明本身
   * 是对象字面量才会被扫描，函数内部构造的对象（例如 `element('rect', { x: 1 })`
   * 这种调用参数）不触发。
   */
  const STRUCTURAL_WHITELIST = new Set(['0', '1', '-1', '2']);

  /** 纯数字右值（可选尾随 `as const`）：十进制/十六进制/科学计数法/下划线分隔符。 */
  const NUMERIC_VALUE_RE = /^-?(0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?)\s*(?:as\s+const)?$/i;

  const TOP_LEVEL_DECL_RE = /^(?:export\s+)?(?:const|let)\s+(.*)$/;

  /** 按顶层逗号（跳过 `{}` `[]` `()` 与字符串/模板字面量内部）拆分同一行的多个声明符。 */
  function splitTopLevelCommas(text: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let current = '';
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] ?? '';
      if (quote !== null) {
        current += ch;
        if (ch === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        current += ch;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') depth += 1;
      if (ch === '}' || ch === ']' || ch === ')') depth -= 1;
      if (ch === ',' && depth === 0) {
        parts.push(current);
        current = '';
        continue;
      }
      current += ch;
    }
    parts.push(current);
    return parts;
  }

  function stripTrailingLineComment(line: string): { code: string; comment: string } {
    const index = line.indexOf('//');
    if (index === -1) return { code: line, comment: '' };
    return { code: line.slice(0, index), comment: line.slice(index) };
  }

  function normalizeForWhitelist(literal: string): string {
    return literal.replace(/\s*as\s+const\s*$/i, '').replace(/_/g, '').trim();
  }

  function findTopLevelBareNumericViolations(source: string): string[] {
    const offenders: string[] = [];
    for (const rawLine of source.split('\n')) {
      if (/^\s/.test(rawLine)) continue; // 有缩进：不是顶层声明（局部/嵌套 const 不算）。
      const { code, comment } = stripTrailingLineComment(rawLine);
      const declMatch = TOP_LEVEL_DECL_RE.exec(code.trimEnd());
      if (declMatch === null) continue;
      const declaratorsText = (declMatch[1] ?? '').trimEnd().replace(/;\s*$/, '');
      const isExplicitlyAllowed = /numeric-guard:\s*allow/.test(comment);

      for (const declarator of splitTopLevelCommas(declaratorsText)) {
        const eq = declarator.indexOf('=');
        if (eq === -1) continue;
        const name = (declarator.slice(0, eq).split(':')[0] ?? '').trim();
        const valueExpr = declarator.slice(eq + 1).trim();
        if (!NUMERIC_VALUE_RE.test(valueExpr)) continue;
        const isStructural = STRUCTURAL_WHITELIST.has(normalizeForWhitelist(valueExpr));
        if (!isStructural && !isExplicitlyAllowed) {
          offenders.push(`${name} = ${valueExpr}`);
        }
      }
    }
    return offenders;
  }

  /** 顶层 `const`/`let NAME = {`（可选类型标注），捕获组 2 是声明行里 `{` 之后的剩余文本。 */
  const TOP_LEVEL_OBJECT_DECL_RE = /^(?:export\s+)?(?:const|let)\s+([\w$]+)(?:\s*:\s*[^={]+)?\s*=\s*\{(.*)$/;

  /** 对象字面量内一条 `key: <纯数字>` 属性（不要求行尾边界——数字字符类本身就是天然边界）。 */
  const OBJECT_NUMERIC_PROP_RE = /(['"]?[\w$]+['"]?)\s*:\s*(-?(?:0x[\da-f]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?))/gi;

  /** 统计一段文本里 `{`/`}` 的净深度变化，跳过字符串/模板字面量内部的花括号。 */
  function countBraceDelta(text: string): number {
    let delta = 0;
    let quote: string | null = null;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i] ?? '';
      if (quote !== null) {
        if (ch === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        continue;
      }
      if (ch === '{') delta += 1;
      if (ch === '}') delta -= 1;
    }
    return delta;
  }

  /**
   * 顶层 `const`/`let X = { ... }`（单行或多行，可选尾随 `as const`）内部的裸数字
   * 属性。只扫描顶层声明本身是对象字面量的情况，不递归进函数体（P1，本轮 /check）。
   */
  function findTopLevelObjectLiteralNumericViolations(source: string): string[] {
    const lines = source.split('\n');
    const offenders: string[] = [];
    let i = 0;
    while (i < lines.length) {
      const rawLine = lines[i] ?? '';
      if (/^\s/.test(rawLine)) {
        i += 1;
        continue; // 有缩进：不是顶层声明。
      }
      const declMatch = TOP_LEVEL_OBJECT_DECL_RE.exec(stripTrailingLineComment(rawLine).code.trimEnd());
      if (declMatch === null) {
        i += 1;
        continue;
      }

      const firstLineRest = declMatch[2] ?? '';
      const blockLines = [firstLineRest];
      let depth = 1 + countBraceDelta(firstLineRest); // 声明行已吃掉开头的 `{`。
      let j = i;
      while (depth > 0 && j + 1 < lines.length) {
        j += 1;
        const nextLine = lines[j] ?? '';
        blockLines.push(nextLine);
        depth += countBraceDelta(nextLine);
      }

      for (const blockLine of blockLines) {
        const { code: lineCode, comment } = stripTrailingLineComment(blockLine);
        const isExplicitlyAllowed = /numeric-guard:\s*allow/.test(comment);
        for (const match of lineCode.matchAll(OBJECT_NUMERIC_PROP_RE)) {
          const key = (match[1] ?? '').replace(/^['"]|['"]$/g, '');
          const value = match[2] ?? '';
          const isStructural = STRUCTURAL_WHITELIST.has(normalizeForWhitelist(value));
          if (!isStructural && !isExplicitlyAllowed) {
            offenders.push(`${key}: ${value}`);
          }
        }
      }

      i = j + 1;
    }
    return offenders;
  }

  function findBareNumericConstantViolations(source: string): string[] {
    return [
      ...findTopLevelBareNumericViolations(source),
      ...findTopLevelObjectLiteralNumericViolations(source),
    ];
  }

  it('反例（应命中）：顶层 const 直接绑定非结构性数字（十进制/小数/负数）', () => {
    expect(findBareNumericConstantViolations('export const CHORD_DOT_RADIUS = 7;')).toEqual([
      'CHORD_DOT_RADIUS = 7',
    ]);
    expect(findBareNumericConstantViolations('const SPACING = 3.5;')).toEqual(['SPACING = 3.5']);
    expect(findBareNumericConstantViolations('const NEGATIVE = -12;')).toEqual(['NEGATIVE = -12']);
  });

  it('反例（应命中，P1-2）：`as const`、数字分隔符、十六进制、科学计数法', () => {
    expect(findBareNumericConstantViolations('export const RADIUS = 7 as const;')).toEqual([
      'RADIUS = 7 as const',
    ]);
    expect(findBareNumericConstantViolations('const BIG = 1_000;')).toEqual(['BIG = 1_000']);
    expect(findBareNumericConstantViolations('const HEX = 0x10;')).toEqual(['HEX = 0x10']);
    expect(findBareNumericConstantViolations('const SCI = 1e3;')).toEqual(['SCI = 1e3']);
  });

  it('反例（应命中，P1-2）：同一行逗号并列的多个声明符逐个命中', () => {
    expect(findBareNumericConstantViolations('const X = 8, Y = 9;')).toEqual(['X = 8', 'Y = 9']);
  });

  it('反例（不应命中）：结构性数字 0/1/-1/2，含 `as const` 形式', () => {
    expect(
      findBareNumericConstantViolations(
        [
          'const ZERO = 0;',
          'const ONE = 1;',
          'const NEG_ONE = -1;',
          'const TWO = 2;',
          'const TWO_CONST = 2 as const;',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('反例（不应命中）：带白名单注释的显式豁免', () => {
    expect(
      findBareNumericConstantViolations('const MAGIC_ANSWER = 42; // numeric-guard: allow 这不是尺寸'),
    ).toEqual([]);
  });

  it('反例（应命中，本轮 /check P1）：单行顶层 `as const` 对象字面量内的裸数字属性', () => {
    // 这条曾经是「不应命中」——`layoutChord.ts` 的 `CHORD_GEOMETRY` 正是靠这个漏洞
    // 绕过了守卫（对象字面量右值本身不是「纯数字」）。新规则堵住它：对象内部每条
    // `key: 数字` 都单独判定。
    expect(
      findBareNumericConstantViolations('export const TABLE = { fontSize: 12, lineHeight: 14 } as const;'),
    ).toEqual(['fontSize: 12', 'lineHeight: 14']);
  });

  it('反例（应命中，本轮 /check P1）：多行顶层对象字面量内的裸数字属性（如 `stringGap: 16`）', () => {
    const source = [
      'export const TABLE = {',
      '  stringGap: 16,',
      '  fretGap: 20,',
      '} as const;',
    ].join('\n');
    expect(findBareNumericConstantViolations(source)).toEqual(['stringGap: 16', 'fretGap: 20']);
  });

  it('反例（不应命中）：对象属性是字符串或结构性数字（0/1/-1/2）时不命中', () => {
    const source = ["const CONFIG = {", "  kind: 'x',", '  count: 1,', '} as const;'].join('\n');
    expect(findBareNumericConstantViolations(source)).toEqual([]);
  });

  it('反例（不应命中）：函数体内部构造的对象字面量不是顶层声明，不触发新规则', () => {
    const source = [
      'function toAttrs() {',
      "  return { x: 1, width: 10 };",
      '}',
    ].join('\n');
    expect(findBareNumericConstantViolations(source)).toEqual([]);
  });

  it('反例（不应命中）：带白名单注释的对象属性豁免', () => {
    const source = ['export const TABLE = {', '  magic: 42, // numeric-guard: allow 这不是尺寸', '} as const;'].join(
      '\n',
    );
    expect(findBareNumericConstantViolations(source)).toEqual([]);
  });

  it('反例（不应命中）：缩进的局部/嵌套 const 不算顶层声明', () => {
    const source = ['function f() {', '  const localMagic = 99;', '  return localMagic;', '}'].join('\n');
    expect(findBareNumericConstantViolations(source)).toEqual([]);
  });

  describe('真实文件扫描（P2-2：范围扩大到 src/notation/** 全部）', () => {
    const notationDir = join(import.meta.dirname, '../../../src/notation');

    function collect(dir: string): string[] {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...collect(full));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          out.push(full);
        }
      }
      return out;
    }

    function relPath(file: string): string {
      return relative(notationDir, file).split(sep).join('/');
    }

    const allFiles = collect(notationDir);
    const relevant = allFiles.filter((file) => {
      const rel = relPath(file);
      if (rel === 'layout/metrics.ts') return false;
      if (rel.startsWith('model/')) return false;
      return true;
    });

    it('扫描范围非空，守卫不能因为「没扫到文件」而假绿', () => {
      expect(allFiles.length).toBeGreaterThan(0);
      expect(relevant.length).toBeGreaterThan(0);
    });

    it.each(relevant.map((file) => [relPath(file), file] as const))(
      '%s 无裸数字尺寸常量',
      (_label, file) => {
        const offenders = findBareNumericConstantViolations(readFileSync(file, 'utf8'));
        expect(offenders).toEqual([]);
      },
    );
  });
});
