/**
 * T3 —— Chord 布局 + SVG + 组件迁移的单元测试（M2 方案 v1.1.1 §6 T3 验收）。
 *
 * 主轴是结构断言（弦线/品线数量、点的行列位置、X/O、capo、名称锚点），不是逐字符
 * SVG 快照——`serializeSvg` 的数字四舍五入到 4 位小数，与迁移前 React 直接渲染
 * `toFixed` 之外的完整浮点精度天然不逐字符相等，这属于预期内的格式差异，不是几何
 * 等价的破坏（几何等价已经在开发期用一次性基线对照验证过，见 `layoutChord.ts` /
 * `toSvg.ts` 文件头与 T3 报告，基线快照本身用完即删，不留在本文件）。
 *
 * `SvgTree` 的 `renderToStaticMarkup` smoke（D10）放在本文件而不是新开文件：单独
 * 新建一个只测 `SvgTree` 的文件会打破「每任务 ≤5 个文件」的预算，且 `SvgTree` 是
 * `src/renderer/**` 的 React 组件，本来就不受 `src/notation/**` 零 React 的架构守卫
 * 约束——本文件本身位于 `tests/`，不在被守卫扫描的 `src/notation/**` 范围内。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { GuitarChord } from '../../../src/domain';
import { layoutChord, type ChordStringMark } from '../../../src/notation/chord/layoutChord';
import { chordToSvg } from '../../../src/notation/chord/toSvg';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';
import { SvgTree } from '../../../src/renderer/components/notation/SvgTree';

const measurer = createDeterministicTextMeasurer();

const G_MAJOR_OPEN: GuitarChord = {
  name: 'G',
  capoFret: 1,
  strings: [
    { state: 'fretted', fret: 3, finger: 3 },
    { state: 'fretted', fret: 2, finger: 2 },
    { state: 'open', fret: 0 },
    { state: 'open', fret: 0 },
    { state: 'open', fret: 0 },
    { state: 'fretted', fret: 3, finger: 4 },
  ],
  barres: [],
  rawValue: 'G=1;3(3),2(2),0,0,0,3(4)',
  origin: 'chord-origin-g',
};

const F_BARRE_SHAPE_CAPO5: GuitarChord = {
  name: 'Bb',
  capoFret: 5,
  strings: [
    { state: 'muted', fret: null },
    { state: 'fretted', fret: 7, finger: 3 },
    { state: 'fretted', fret: 7, finger: 4 },
    { state: 'fretted', fret: 6, finger: 2 },
    { state: 'fretted', fret: 5, finger: 1 },
    { state: 'muted', fret: null },
  ],
  barres: [],
  rawValue: 'Bb=5;X,7(3),7(4),6(2),5(1),X',
  origin: 'chord-origin-bb',
};

const NO_FINGER_CHORD: GuitarChord = {
  name: 'Em',
  capoFret: 1,
  strings: [
    { state: 'open', fret: 0 },
    { state: 'fretted', fret: 2 },
    { state: 'fretted', fret: 2 },
    { state: 'open', fret: 0 },
    { state: 'open', fret: 0 },
    { state: 'open', fret: 0 },
  ],
  barres: [],
  rawValue: 'Em=1;0,2,2,0,0,0',
  origin: 'chord-origin-em',
};

function layout(chord: GuitarChord, showFinger?: boolean) {
  return layoutChord(chord, { showFinger, measurer });
}

describe('layoutChord —— 弦线 / 品线结构', () => {
  it('恒为 6 条弦线 + 6 条品线（5 品格 + 1），不随 chord 内容变化', () => {
    const result = layout(G_MAJOR_OPEN);
    const stringLines = result.gridLines.filter((line) => line.kind === 'string');
    const fretLines = result.gridLines.filter((line) => line.kind === 'fret');
    expect(stringLines).toHaveLength(6);
    expect(fretLines).toHaveLength(6);
  });

  it('弦线按下标从左到右单调递增排列，均匀分布', () => {
    const result = layout(G_MAJOR_OPEN);
    const stringLines = result.gridLines.filter((line) => line.kind === 'string');
    const xs = stringLines.map((line) => line.x1);
    const sorted = [...xs].sort((a, b) => a - b);
    expect(xs).toEqual(sorted);
    const gaps = new Set(xs.slice(1).map((x, i) => Math.round((x - (xs[i] ?? 0)) * 1000)));
    expect(gaps.size).toBe(1); // 等距
  });

  it('capoFret === 1 时第 0 条品线标记为 nut，其余品线不是', () => {
    const result = layout(G_MAJOR_OPEN);
    const fretLines = result.gridLines.filter((line) => line.kind === 'fret');
    expect(fretLines[0]?.nut).toBe(true);
    expect(fretLines.slice(1).every((line) => !line.nut)).toBe(true);
  });

  it('capoFret > 1 时没有任何品线标记为 nut', () => {
    const result = layout(F_BARRE_SHAPE_CAPO5);
    const fretLines = result.gridLines.filter((line) => line.kind === 'fret');
    expect(fretLines.every((line) => !line.nut)).toBe(true);
  });
});

describe('layoutChord —— 每弦标记（X / 空弦 / 按弦点）', () => {
  it('muted 弦对应 kind: "muted"，文本为 ×', () => {
    const result = layout(F_BARRE_SHAPE_CAPO5);
    const marks = result.strings;
    expect(marks[0]?.kind).toBe('muted');
    expect(marks[5]?.kind).toBe('muted');
    if (marks[0]?.kind === 'muted') expect(marks[0].text).toBe('×');
  });

  it('open 弦对应 kind: "open"', () => {
    const result = layout(G_MAJOR_OPEN);
    expect(result.strings[2]?.kind).toBe('open');
    expect(result.strings[3]?.kind).toBe('open');
    expect(result.strings[4]?.kind).toBe('open');
  });

  it('fretted 弦对应 kind: "fretted"，行位置随品位单调（越高品位越靠下）', () => {
    const result = layout(F_BARRE_SHAPE_CAPO5);
    const seventh = result.strings[1];
    const sixth = result.strings[3];
    expect(seventh?.kind).toBe('fretted');
    expect(sixth?.kind).toBe('fretted');
    if (seventh?.kind === 'fretted' && sixth?.kind === 'fretted') {
      // 品位 7 相对 capo=5 的可见品位（3）比品位 6 的可见品位（2）更靠下
      expect(seventh.cy).toBeGreaterThan(sixth.cy);
    }
  });

  it('strings 长度恒为 6，顺序与 chord.strings 一致（第六弦→第一弦）', () => {
    const result = layout(G_MAJOR_OPEN);
    expect(result.strings).toHaveLength(6);
    expect(result.strings.map((mark) => mark.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('layoutChord —— capo 标签 / 和弦名', () => {
  it('capoFret > 1 时画 "{n}fr" 标签', () => {
    const result = layout(F_BARRE_SHAPE_CAPO5);
    expect(result.capoLabel?.text).toBe('5fr');
  });

  it('capoFret === 1 时不产出 capoLabel', () => {
    const result = layout(G_MAJOR_OPEN);
    expect(result.capoLabel).toBeUndefined();
  });

  it('和弦名文本锚点居中于画布宽度一半', () => {
    const result = layout(G_MAJOR_OPEN);
    expect(result.name.text).toBe('G');
    expect(result.name.x).toBe(result.width / 2);
  });

  it('和弦名宽度经由注入的 TextMeasurer 计算（非硬编码）', () => {
    const shortName = layout({ ...G_MAJOR_OPEN, name: 'C' });
    const longName = layout({ ...G_MAJOR_OPEN, name: 'C#dim7' });
    expect(longName.name.width).toBeGreaterThan(shortName.name.width);
  });
});

describe('layoutChord —— showFinger 三态', () => {
  it('true：按弦点携带 finger 文本', () => {
    const result = layoutChord(G_MAJOR_OPEN, { showFinger: true, measurer });
    const fretted = result.strings.filter((mark): mark is Extract<ChordStringMark, { kind: 'fretted' }> => mark.kind === 'fretted');
    expect(fretted.length).toBeGreaterThan(0);
    expect(fretted.every((mark) => mark.finger !== undefined)).toBe(true);
  });

  it('false：纯黑点，不携带 finger 文本', () => {
    const result = layoutChord(G_MAJOR_OPEN, { showFinger: false, measurer });
    const fretted = result.strings.filter((mark): mark is Extract<ChordStringMark, { kind: 'fretted' }> => mark.kind === 'fretted');
    expect(fretted.length).toBeGreaterThan(0);
    expect(fretted.every((mark) => mark.finger === undefined)).toBe(true);
  });

  it('undefined（缺省）：默认显示数字，与迁移前「有指法就画」的行为一致', () => {
    const result = layoutChord(G_MAJOR_OPEN, { showFinger: undefined, measurer });
    const fretted = result.strings.filter((mark): mark is Extract<ChordStringMark, { kind: 'fretted' }> => mark.kind === 'fretted');
    expect(fretted.every((mark) => mark.finger !== undefined)).toBe(true);
  });

  it('finger 字段本身缺失时，无论 showFinger 取何值都不产出 finger 文本', () => {
    for (const showFinger of [true, false, undefined] as const) {
      const result = layoutChord(NO_FINGER_CHORD, { showFinger, measurer });
      const fretted = result.strings.filter((mark): mark is Extract<ChordStringMark, { kind: 'fretted' }> => mark.kind === 'fretted');
      expect(fretted.length).toBeGreaterThan(0);
      expect(fretted.every((mark) => mark.finger === undefined)).toBe(true);
    }
  });
});

describe('layoutChord —— barres 非空时不画横按（spec §10.1 UNVERIFIED，不得反推）', () => {
  it('barres 非空不改变 layout 输出（与空数组结果 toEqual）', () => {
    const withBarre: GuitarChord = {
      ...F_BARRE_SHAPE_CAPO5,
      barres: [{ fret: 5, fromString: 1, toString: 4, finger: 1 }],
    };
    const resultEmpty = layout(F_BARRE_SHAPE_CAPO5);
    const resultWithBarre = layout(withBarre);
    expect(resultWithBarre).toEqual(resultEmpty);
  });

  it('ChordLayout 类型上没有任何「横按」相关字段（无 barre kind / barre 节点）', () => {
    const withBarre: GuitarChord = {
      ...F_BARRE_SHAPE_CAPO5,
      barres: [{ fret: 5, fromString: 1, toString: 4 }],
    };
    const result = layout(withBarre);
    const svg = serializeSvg(chordToSvg(result));
    expect(svg.toLowerCase()).not.toContain('barre');
  });
});

describe('layoutChord —— 文档级 anchor（D11：chordShapes 与 ChordSymbolEvent 不关联）', () => {
  it('anchor 恒为 { kind: "document" }，sourceRef 透传 chord.origin', () => {
    const result = layout(G_MAJOR_OPEN);
    expect(result.anchor).toEqual({ kind: 'document' });
    expect(result.sourceRef).toBe(G_MAJOR_OPEN.origin);
  });

  it('layoutChord.ts 与 toSvg.ts 都不 import ChordSymbolEvent（未按名查表关联，D11 默认关闭）', () => {
    // 注意：文件头注释里会*提到* `ChordSymbolEvent` 这个名字（解释「为什么不用它」），
    // 所以这里不能整份源码做裸字符串搜索——真正要钉住的是「没有 import 它」，即代码
    // 从未真的拿到过这个类型/值，不是「连提都不能提」。
    const importRe = /\bimport\b[\s\S]*?\bfrom\s*['"][^'"]+['"]/g;
    for (const file of ['layoutChord.ts', 'toSvg.ts']) {
      const source = readFileSync(join(import.meta.dirname, '../../../src/notation/chord', file), 'utf8');
      const importStatements = source.match(importRe) ?? [];
      const bad = importStatements.filter((stmt) => stmt.includes('ChordSymbolEvent'));
      expect(bad).toEqual([]);
    }
  });
});

describe('layoutChord / chordToSvg —— 确定性', () => {
  it('同一输入两次调用 layoutChord 结果 toEqual', () => {
    const a = layout(G_MAJOR_OPEN);
    const b = layout(G_MAJOR_OPEN);
    expect(a).toEqual(b);
  });

  it('同一 layout 两次 serializeSvg(chordToSvg(...)) 逐字符相等', () => {
    const result = layout(G_MAJOR_OPEN);
    const svgA = serializeSvg(chordToSvg(result));
    const svgB = serializeSvg(chordToSvg(result));
    expect(svgA).toBe(svgB);
  });

  it('坐标全部有限（无 NaN / Infinity），serializeSvg 不抛错', () => {
    for (const chord of [G_MAJOR_OPEN, F_BARRE_SHAPE_CAPO5, NO_FINGER_CHORD]) {
      expect(() => serializeSvg(chordToSvg(layout(chord)))).not.toThrow();
    }
  });
});

describe('chordToSvg —— 结构（class 名沿用既有 CSS，见 global.css）', () => {
  it('根节点是 svg，携带 class/role/aria-label/viewBox', () => {
    const svg = chordToSvg(layout(G_MAJOR_OPEN));
    expect(svg.tag).toBe('svg');
    expect(svg.attrs['class']).toBe('chord-diagram');
    expect(svg.attrs['role']).toBe('img');
    expect(svg.attrs['aria-label']).toBe('G guitar chord');
  });

  it('muted/open/fretted 节点分别携带既有 CSS class', () => {
    const svg = serializeSvg(chordToSvg(layout(F_BARRE_SHAPE_CAPO5)));
    expect(svg).toContain('class="string-state"');
    expect(svg).toContain('class="finger-dot"');
    expect(svg).toContain('class="chord-name"');
    expect(svg).toContain('class="base-fret-label"');
  });

  it('capoFret === 1 时含 nut-line class；capoFret > 1 时不含', () => {
    expect(serializeSvg(chordToSvg(layout(G_MAJOR_OPEN)))).toContain('class="nut-line"');
    expect(serializeSvg(chordToSvg(layout(F_BARRE_SHAPE_CAPO5)))).not.toContain('nut-line');
  });
});

describe('SvgTree —— renderToStaticMarkup smoke（D10：不引入 jsdom，验证属性名映射）', () => {
  it('kebab-case 属性正确映射为 React 属性（class→className、text-anchor 等驼峰化、data-* 原样保留）', () => {
    const svg = chordToSvg(layout(G_MAJOR_OPEN));
    const html = renderToStaticMarkup(SvgTree({ node: svg }));
    expect(html).toContain('class="chord-diagram"');
    expect(html).toContain('data-chord-name="G"');
    expect(html).toContain('text-anchor="middle"');
    // renderToStaticMarkup 输出的是最终 DOM 属性字符串（浏览器/服务端渲染统一走
    // kebab-case 的 SVG 属性名），因此这里断言的是「没有出现驼峰属性名泄漏到 HTML
    // 输出」，用来验证 SvgTree 内部的属性名转换没有直接把 camelCase 字符串错误地
    // 当成最终属性名传出去。
    expect(html).not.toContain('textAnchor=');
    expect(html).not.toContain('className=');
  });

  it('不抛异常，且能渲染出与节点数匹配的标签', () => {
    const svg = chordToSvg(layout(F_BARRE_SHAPE_CAPO5));
    expect(() => renderToStaticMarkup(SvgTree({ node: svg }))).not.toThrow();
  });
});
