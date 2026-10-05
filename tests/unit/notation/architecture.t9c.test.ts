/**
 * M2.5 T9c 架构守卫（seal coverage hardening；`architecture.test.ts` 自 T8 起冻结，本阶段守卫住在这里，自带最小本地
 * helper，不抽共享模块）。所有 matcher 先去注释、把空白归一成单个空格再扫描，并各带反例。
 *
 * 屏幕可用宽度的**反馈环防线**（D7 + T6.4 + T9b J4）：`ScoreView` 用 `ResizeObserver` 量 `.score-systems` 的 CSS 内容宽，
 * 换算成 `composeScoreLayout(screen)` 的 `availableWidth`；system 画布可能比容器更宽（单个超宽小节、和弦左墨迹留白），
 * 若容器被子内容撑宽，量到的宽度就会随布局结果变化而形成反馈循环。三件事必须指向**同一个容器**：
 * 1. 传给 `useAvailableWidth(…, zoom)` 的 ref；
 * 2. 挂在 `className="score-systems"` 元素上的 ref（hook 内部确实观察传入 ref 的 `.current`）；
 * 3. `global.css` 中选择器恰为 `.score-systems` 的规则最终生效的 `min-width` 为 `0`。
 * 浏览器里 ResizeObserver 的实际行为仍由 Electron smoke 验证，这里不引 jsdom、不测浏览器实现。
 *
 * 已知限制（正则级源码守卫）：JSX 属性写成展开对象、ref 经别名中转、CSS 用嵌套 / `@layer` 等写法都可能绕过，由 review 兜底。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '../../../src');
const SCORE_VIEW = join(SRC_DIR, 'renderer/components/notation/ScoreView.tsx');
const CSS_FILE = join(SRC_DIR, 'renderer/styles/global.css');

/** 去掉块注释与行注释（保留 `://`）。已知限制：字符串里的 `//` 会被当成注释。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

const normalize = (source: string): string => stripComments(source).replace(/\s+/g, ' ');

/** 调用（不是声明）`useAvailableWidth(<ref>, zoom)` 时传入的 ref 标识符。 */
function widthObserverRefs(source: string): string[] {
  const code = normalize(source).replace(/\bfunction useAvailableWidth\(/g, 'function __declared__(');
  return [...code.matchAll(/\buseAvailableWidth\(\s*(\w+)\s*,\s*zoom\s*\)/g)].map((m) => m[1] ?? '');
}

/** 带 `className="score-systems"` 的 JSX 开标签上挂的 `ref={…}`（属性顺序不限）。 */
function systemsContainerRefs(source: string): string[] {
  const tags = [...normalize(source).matchAll(/<\w+\b[^<>]*?\bclassName="score-systems"[^<>]*>/g)].map((m) => m[0]);
  return tags.map((tag) => /\bref=\{\s*(\w+)\s*\}/.exec(tag)?.[1] ?? '');
}

/** hook 观察的是自己的参数：`const el = <param>.current` 且 `observer.observe(el)`。 */
function hookObservesItsParam(source: string): boolean {
  const code = normalize(source);
  const param = /\bfunction useAvailableWidth\(\s*(\w+)\s*:/.exec(code)?.[1];
  if (param === undefined) return false;
  return new RegExp(`const el = ${param}\\.current;`).test(code) && /\.observe\(\s*el\s*\)/.test(code);
}

/** 选择器恰为 `.score-systems` 的全部规则中，最后一条 `min-width` 声明的值（缺席为 `undefined`）。 */
function scoreSystemsMinWidth(css: string): string | undefined {
  let value: string | undefined;
  for (const rule of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = (rule[1] ?? '').split(',').map((selector) => selector.trim());
    if (!selectors.includes('.score-systems')) continue;
    for (const declaration of (rule[2] ?? '').split(';')) {
      const [property, raw] = declaration.split(':');
      if (property?.trim() === 'min-width' && raw !== undefined) value = raw.trim();
    }
  }
  return value;
}

describe('T9c —— 屏幕可用宽度观察的是同一个 `.score-systems` 容器', () => {
  const source = readFileSync(SCORE_VIEW, 'utf8');

  it('ScoreView：useAvailableWidth 恰好一处调用，传入的 ref 就是 `.score-systems` 上挂的 ref', () => {
    const observed = widthObserverRefs(source);
    expect(observed).toHaveLength(1);
    expect(systemsContainerRefs(source)).toEqual(observed);
    expect(hookObservesItsParam(source)).toBe(true);
  });

  it('反例：观察另一个 ref、容器挂另一个 ref、hook 不观察参数，都会被识别', () => {
    expect(widthObserverRefs('const w = useAvailableWidth(containerRef, zoom);')).toEqual(['containerRef']);
    expect(widthObserverRefs('function useAvailableWidth(systemsRef: R, zoom: number): number { return 0; }')).toEqual([]);
    expect(systemsContainerRefs('<div className="score-systems" ref={containerRef}>')).toEqual(['containerRef']);
    expect(systemsContainerRefs('<div ref={systemsRef} style={{ a: 1 }} className="score-systems">')).toEqual(['systemsRef']);
    expect(systemsContainerRefs('<div className="score-systems">')).toEqual(['']);
    expect(systemsContainerRefs('<div className="score-header" ref={systemsRef}>')).toEqual([]);
    expect(hookObservesItsParam('function useAvailableWidth(systemsRef: R, zoom: number) { const el = otherRef.current; observer.observe(el); }')).toBe(false);
    expect(hookObservesItsParam('function useAvailableWidth(systemsRef: R, zoom: number) { const el = systemsRef.current; observer.observe(document.body); }')).toBe(false);
  });
});

describe('T9c —— `.score-systems` 的 `min-width: 0`（防止子内容撑宽容器形成反馈环）', () => {
  it('global.css：选择器恰为 `.score-systems` 的规则最终 min-width = 0', () => {
    expect(scoreSystemsMinWidth(readFileSync(CSS_FILE, 'utf8'))).toBe('0');
  });

  it('反例：auto、缺席、只在注释里、只在后代选择器上、被后一条规则覆盖，都不算', () => {
    expect(scoreSystemsMinWidth('.score-systems { display: grid; min-width: auto; }')).toBe('auto');
    expect(scoreSystemsMinWidth('.score-systems { display: grid; }')).toBeUndefined();
    expect(scoreSystemsMinWidth('/* .score-systems { min-width: 0; } */ .score-systems { display: grid; }')).toBeUndefined();
    expect(scoreSystemsMinWidth('.score-systems > div { min-width: 0; } .score-systems { display: grid; }')).toBeUndefined();
    expect(scoreSystemsMinWidth('.score-systems { min-width: 0; } .score-systems { min-width: auto; }')).toBe('auto');
    expect(scoreSystemsMinWidth('.score-workspace, .score-systems { min-width: 0; }')).toBe('0');
  });
});
