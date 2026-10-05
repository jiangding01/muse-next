/**
 * M2.5 T9c.P 架构守卫（简谱 x 合同 / 歌词 anchor / 弧线端点 / 全局歌词 gutter；`architecture.test.ts` 自 T8 起冻结，
 * 本阶段守卫住在这里，自带最小本地 helper，不抽共享模块）。所有 matcher 先去注释、把空白归一成单个空格再扫描，并各带反例。
 *
 * 1. CSS 不再对歌词 `<text>` 指定 `text-anchor`（D2；含 `.jianpu-lyric-*` 后缀类、`-group` 后代、简谱容器下的裸 `text`）；
 *    anchor 由 `lyricToSvg` 按 `aligned` 显式写出。
 * 2. `glyphWidth / 2` 全仓只剩默认路径的历史弧线端点 `legacyArcEndpointX`（D2 / D3：external 中心 = `node.x`）；
 *    `jianpuArcs.ts` 不 import system / external。
 * 3. `buildScoreRender` 的 leftGutter 纳入简谱歌词左 extent（D4），只测量、不反馈：renderer 对 jianpu layout / compose
 *    只做 type import，`src/notation/**` 不 import renderer、不出现 `leftGutter`，`pageModel.ts` 不碰歌词 / 测量。
 *
 * 已知限制（正则级源码守卫）：别名中转、动态 import、CSS 嵌套 / `@layer` 等写法可能绕过，由 review 兜底。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '../../../src');
const read = (path: string): string => readFileSync(join(SRC_DIR, path), 'utf8');

/** `src` 下全部 .ts / .tsx（相对 `src` 的 posix 路径）。 */
function sourceFiles(dir = SRC_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [relative(SRC_DIR, path).split('\\').join('/')] : [];
  });
}

/** 去掉块注释与行注释（保留 `://`）。已知限制：字符串里的 `//` 会被当成注释。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const normalize = (source: string): string => stripComments(source).replace(/\s+/g, ' ');

/**
 * 一条选择器能否命中歌词 `<text>`（高价值近似，不是 CSS parser）：
 * (a) 任何以 `jianpu-lyric` 开头的类（`.jianpu-lyric`、`.jianpu-lyric-text`、`.jianpu-lyric-group text` …）；
 * (b) 主体是裸 `text` / `*`，且祖先链里有简谱 / system 容器类（`.jianpu-score text`、`.system-layer-jianpu text` …）。
 */
function canStyleLyricText(selector: string): boolean {
  if (/\.jianpu-lyric[\w-]*/.test(selector)) return true;
  const subject = selector.trim().split(/[\s>+~]+/).pop() ?? '';
  return (subject === 'text' || subject === '*') && /\.(jianpu-score|system-layer(-jianpu)?|score-systems?)(?![\w-])/.test(selector);
}

/** 能命中歌词 `<text>` 的规则中出现的全部 `text-anchor` 值。 */
function lyricTextAnchors(css: string): string[] {
  const values: string[] = [];
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!(rule[1] ?? '').split(',').some(canStyleLyricText)) continue;
    for (const declaration of (rule[2] ?? '').split(';')) {
      const [property, raw] = declaration.split(':');
      if (property?.trim() === 'text-anchor' && raw !== undefined) values.push(raw.trim());
    }
  }
  return values;
}

/** 顶层 `function <name>(` 到下一个顶层 `function` 之间的源码（归一后）；找不到为 `undefined`。 */
function functionBody(source: string, name: string): string | undefined {
  const code = normalize(source);
  const start = code.search(new RegExp(`\\bfunction ${name}\\(`));
  if (start < 0) return undefined;
  const rest = code.slice(start + 1);
  const next = rest.search(/ (export )?function \w+\(/);
  return next < 0 ? code.slice(start) : code.slice(start, start + 1 + next);
}

/** `lyricToSvg` 里 `'text-anchor'` 属性的表达式。 */
function lyricAnchorExpression(source: string): string | undefined {
  return /'text-anchor': ([^,}]+?)\s*[,}]/.exec(functionBody(source, 'lyricToSvg') ?? '')?.[1];
}

const glyphHalfCount = (source: string): number => [...normalize(source).matchAll(/\bglyphWidth\s*\/\s*2\b/g)].length;

/** 全部 import 语句（归一后），返回 `[是否 type-only, 模块说明符]`。 */
function imports(source: string): (readonly [boolean, string])[] {
  return [...normalize(source).matchAll(/\bimport (type )?[^;]*?from '([^']+)'/g)].map((m) => [m[1] !== undefined, m[2] ?? ''] as const);
}

describe('T9c.P —— 歌词 anchor：CSS 不一刀切，lyricToSvg 按 aligned 显式写', () => {
  it('global.css：能命中歌词 `<text>` 的规则没有任何 text-anchor（与歌词无关的 middle 照常存在）', () => {
    const css = read('renderer/styles/global.css');
    expect(lyricTextAnchors(css)).toEqual([]);
    expect(stripComments(css)).toMatch(/\.jianpu-digit[^{}]*\{[^{}]*text-anchor: middle/);
  });

  it('toSvg.ts：lyricToSvg 写 `node.aligned ? \'middle\' : \'start\'`', () => {
    expect(lyricAnchorExpression(read('notation/jianpu/toSvg.ts'))).toBe("node.aligned ? 'middle' : 'start'");
  });

  it('反例：歌词类（含 -text / -group 后代）与简谱容器下的裸 text 居中都会被识别；注释与无关 middle 放行；anchor 缺失或写死都会被识别', () => {
    expect(lyricTextAnchors('.jianpu-lyric { fill: #000; text-anchor: middle; }')).toEqual(['middle']);
    expect(lyricTextAnchors('.jianpu-lyric-text { text-anchor: middle; }')).toEqual(['middle']);
    expect(lyricTextAnchors('.jianpu-lyric-group text { text-anchor: middle; }')).toEqual(['middle']);
    expect(lyricTextAnchors('.x .jianpu-lyric, .y { text-anchor: start; }')).toEqual(['start']);
    expect(lyricTextAnchors('.system-layer-jianpu text { text-anchor: middle; } .jianpu-score > * { text-anchor: end; }')).toEqual(['middle', 'end']);
    expect(lyricTextAnchors('/* .jianpu-lyric { text-anchor: middle; } */ .jianpu-digit, .jianpu-rest { text-anchor: middle; }')).toEqual([]);
    expect(lyricTextAnchors('.jianpu-tuplet-label { text-anchor: middle; } .vf-staff-placeholder text { text-anchor: middle; } .jianpu-score text { fill: red; }')).toEqual([]);
    expect(lyricAnchorExpression("function lyricToSvg(node) { textElement('text', t, { x, y }); } function other() {}")).toBeUndefined();
    expect(lyricAnchorExpression("function lyricToSvg(node) { textElement('text', t, { 'text-anchor': 'middle', x }); }")).toBe("'middle'");
    expect(lyricAnchorExpression("function lyricToSvg(n) { a(); } function z(node) { b({ 'text-anchor': node.aligned ? 'middle' : 'start' }); }")).toBeUndefined();
  });
});

describe('T9c.P —— external 中心 = node.x：`glyphWidth / 2` 只剩默认路径历史弧线端点', () => {
  it('全仓 `glyphWidth / 2` 恰好一处，在 jianpuArcs.ts 的 legacyArcEndpointX', () => {
    const hits = sourceFiles().filter((file) => glyphHalfCount(read(file)) > 0);
    expect(hits).toEqual(['notation/jianpu/jianpuArcs.ts']);
    const arcs = normalize(read('notation/jianpu/jianpuArcs.ts'));
    expect(glyphHalfCount(arcs)).toBe(1);
    expect(arcs).toContain('export const legacyArcEndpointX: ArcEndpointX = (node) => node.x + node.glyphWidth / 2;');
    expect(arcs).toContain('export const anchorArcEndpointX: ArcEndpointX = (node) => node.x;');
  });

  it('jianpuArcs.ts 不 import system / external', () => {
    expect(imports(read('notation/jianpu/jianpuArcs.ts')).filter(([, from]) => /\/system\/|external/.test(from))).toEqual([]);
  });

  it('反例：计数忽略注释、识别不同空白；import 解析区分 type-only', () => {
    expect(glyphHalfCount('// node.glyphWidth / 2\nconst a = n.glyphWidth/2;')).toBe(1);
    expect(imports("import type { A } from './a'; import { b } from '../system/b';")).toEqual([[true, './a'], [false, '../system/b']]);
  });
});

describe('T9c.P —— 全局歌词 gutter 只测量、不反馈 layout', () => {
  const render = read('renderer/components/notation/systemRender.ts');

  it('buildScoreRender 的 leftGutter 纳入 lyricLeftExtents；后者量 aligned 半宽 / unaligned 左缘', () => {
    expect(functionBody(render, 'buildScoreRender')).toContain('lyricLeftExtents(scoreLayout.voiceLayouts, measurer)');
    const extents = functionBody(render, 'lyricLeftExtents') ?? '';
    expect(extents).toContain('.lyrics');
    expect(extents).toMatch(/aligned \? text\.x - measurer\.measure\(text\.text, \{ fontSize: text\.fontSize \}\)\.width \/ 2 : text\.x/);
  });

  it('renderer 对 jianpu layout / 弧线 / 歌词只做 type import；systemRender / systemSlices 对 system compose 也只做 type import', () => {
    const valueImports = (file: string, pattern: RegExp): string[] =>
      imports(read(file)).filter(([typeOnly, from]) => !typeOnly && pattern.test(from)).map(([, from]) => `${file} ← ${from}`);
    const jianpu = sourceFiles()
      .filter((file) => file.startsWith('renderer/'))
      .flatMap((file) => valueImports(file, /notation\/jianpu\/(layoutJianpu|jianpuSections|jianpuArcs)/));
    expect(jianpu).toEqual([]);
    // ScoreView 调 composeScoreLayout 是正向管线；gutter 所在的组装层不得回调 compose（不形成 lyric → compose 反馈）。
    const assembly = ['renderer/components/notation/systemRender.ts', 'renderer/components/notation/systemSlices.ts'];
    expect(assembly.flatMap((file) => valueImports(file, /notation\/system\/compose/))).toEqual([]);
  });

  it('src/notation/** 不 import renderer、不出现 leftGutter；pageModel.ts 不碰歌词与文本测量', () => {
    const notation = sourceFiles().filter((file) => file.startsWith('notation/'));
    expect(notation.filter((file) => imports(read(file)).some(([, from]) => /\/renderer\//.test(from)))).toEqual([]);
    expect(notation.filter((file) => /\bleftGutter\b/.test(normalize(read(file))))).toEqual([]);
    const page = normalize(read('notation/system/pageModel.ts'));
    expect(page).not.toMatch(/lyric|TextMeasurer|measurer|jianpu/i);
  });

  it('反例：functionBody 截到下一个顶层函数为止', () => {
    const body = functionBody('function a() { x(); } export function b() { y(); }', 'a');
    expect(body).toContain('x()');
    expect(body).not.toContain('y()');
    expect(functionBody('function a() {}', 'missing')).toBeUndefined();
  });
});
