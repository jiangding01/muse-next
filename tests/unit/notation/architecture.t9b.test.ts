/**
 * M2.5 T9b 架构守卫（renderer systemization；`architecture.test.ts` 自 T8 起冻结，本阶段守卫一律住在这里，自带最小本地
 * helper，不抽共享模块、不改历史文件）。所有 matcher 先去注释（必要时把空白归一成单个空格）再扫描，并各带反例；
 * 不把换行 / 空格 / import 顺序当成契约。
 *
 * - 编排（裁决 A / M1）：renderer 全体不得**值导入或调用**声部 layout 入口、T4–T9a planner（`measureDemand` / `justify` /
 *   `geometryTicks` / `measurePlacement` / `layout/systems` / `composeSystem` / `chordOverlay` planner / `pageModel` …），
 *   `import type` 照常放行；`composeScoreLayout` 只允许 ScoreView 值导入；旧路径文件已删、没有 feature flag。
 * - ScoreView 接线（M2）：screen policy、zoom 进入可用宽度换算、`systemGap` 只由 `.score-systems` 的 row-gap 消费一次、
 *   诊断 = `scoreLayout.diagnostics` + 页眉诊断（不再合并 `renderScore.diagnostics`）、高亮 effect 依赖含 `renderGeneration`。
 * - VexFlow 边界（L9）：`components/**` 不 import vexflow；adapter 不做 Staff tier 2（不碰 TickContext / x 覆写 / preFormat）；
 *   五线谱 host 由 VexFlow 独占。
 * - 几何与 CSS（M5 / J4）：SystemView 不读 `box.origin`（只消费 `leftOffset`）；chordSymbol 的抑制只在 `systemSlices.ts`；
 *   五线谱层 / host / svg 与 system 都 `overflow: visible`；system 间距不在 CSS 里重复。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '../../../src');
const RENDERER_DIR = join(SRC_DIR, 'renderer');
const COMPONENTS_DIR = join(RENDERER_DIR, 'components/notation');
const VEXFLOW_DIR = join(RENDERER_DIR, 'integrations/vexflow');
const CSS_FILE = join(RENDERER_DIR, 'styles/global.css');

function collectFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return collectFiles(full);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

/** 去掉块注释与行注释（保留 `://`）。已知限制：字符串里的 `//` 会被当成注释。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 去注释并把连续空白归一成一个空格：守卫只看语义，不看排版。 */
const normalize = (source: string): string => stripComments(source).replace(/\s+/g, ' ');

/**
 * **值**依赖的模块说明符：值导入（含 `import { a, type B }`）、bare import、re-export、动态 import、require；
 * `import type { … }` 与只含 `type` 成员的 `import { type A }` 不算。
 */
function valueImportSpecs(source: string): string[] {
  const code = stripComments(source);
  const statements = [...code.matchAll(/^\s*(import|export)\s+([^;]*?)\s*\bfrom\s*['"]([^'"]+)['"]/gm)].flatMap((m) => {
    const [, keyword, clause = '', spec = ''] = m;
    if (keyword === 'export') return [spec];
    if (/^type\s/.test(clause)) return [];
    const named = /^\{([^}]*)\}$/.exec(clause.trim());
    const names = named === null ? [] : (named[1] ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '');
    return named !== null && names.every((n) => n.startsWith('type ')) ? [] : [spec];
  });
  const others = [/\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g]
    .flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ''));
  return [...statements, ...others];
}

/** 去掉 import 语句与注释后，`name(` 的调用次数（不含 `function name(` 声明）。 */
function callCount(source: string, name: string): number {
  const body = stripComments(source).replace(/^\s*import\b[^;]*;/gm, '');
  return [...body.matchAll(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g'))].length;
}

const read = (file: string): string => readFileSync(file, 'utf8');
const rel = (file: string): string => relative(SRC_DIR, file).split(sep).join('/');
const rendererFiles = collectFiles(RENDERER_DIR);
const componentFiles = collectFiles(COMPONENTS_DIR);
const SCORE_VIEW = join(COMPONENTS_DIR, 'ScoreView.tsx');
const SYSTEM_VIEW = join(COMPONENTS_DIR, 'SystemView.tsx');
const STAFF_VIEW = join(COMPONENTS_DIR, 'StaffSystemView.tsx');
const SLICES = join(COMPONENTS_DIR, 'systemSlices.ts');

const FORBIDDEN_MODULES = [
  'jianpu/layoutJianpu', 'tab/layoutTab', 'staff/layoutStaff',
  'system/measureDemand', 'system/justify', 'system/geometryTicks', 'system/measureFeatures', 'system/timedDuration',
  'system/composeSystem', 'system/chordOverlay', 'system/chordOverlaySources', 'system/pageModel', 'system/timeline',
  'system/measureIdentity', 'system/groupVoices', 'system/verticalLayout', 'system/verticalDemand',
  'layout/measurePlacement', 'layout/systems',
];
const isForbiddenModule = (spec: string): boolean => FORBIDDEN_MODULES.some((m) => spec === m || spec.endsWith(`/${m}`));
const FORBIDDEN_CALLS = [
  'layoutJianpu', 'layoutTab', 'layoutStaff', 'composeSystemGeometry', 'planChordOverlays', 'pageModel', 'planVoiceLayers', 'stackSystems',
];
const isComposeLayout = (spec: string): boolean => spec.endsWith('notation/system/composeLayout');
const isVexflow = (spec: string): boolean => spec === 'vexflow' || spec.startsWith('vexflow/');
const TIER2 = /TickContext|tickContext|setXShift|preFormat|\.setX\s*\(/;

/** global.css 中精确选择器的声明块（去掉注释）。 */
function cssRule(selector: string): string {
  const css = read(CSS_FILE).replace(/\/\*[\s\S]*?\*\//g, '');
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)?.[1] ?? '';
}

describe('M2.5 T9b 架构守卫 —— 编排入口（裁决 A / M1）', () => {
  it('renderer 全体不值导入、不调用声部 layout 与 T4–T9a planner（import type 放行）', () => {
    const bad = rendererFiles.flatMap((file) => [
      ...valueImportSpecs(read(file)).filter(isForbiddenModule).map((spec) => `${rel(file)} → ${spec}`),
      ...FORBIDDEN_CALLS.filter((name) => callCount(read(file), name) > 0).map((name) => `${rel(file)} 调用 ${name}`),
    ]);
    expect(bad).toEqual([]);
  });

  it('composeScoreLayout 只由 ScoreView 值导入并恰好调用一次；旧路径文件不存在；没有 systemLayoutEnabled 开关', () => {
    const importers = rendererFiles.filter((file) => valueImportSpecs(read(file)).some(isComposeLayout)).map(rel);
    expect(importers).toEqual([rel(SCORE_VIEW)]);
    expect(callCount(read(SCORE_VIEW), 'composeScoreLayout')).toBe(1);
    expect(existsSync(join(COMPONENTS_DIR, 'voiceRender.ts'))).toBe(false);
    expect(existsSync(join(COMPONENTS_DIR, 'StaffVoiceView.tsx'))).toBe(false);
    const flags = collectFiles(SRC_DIR).filter((file) => /\bsystemLayoutEnabled\b/.test(stripComments(read(file))));
    expect(flags.map(rel)).toEqual([]);
  });

  it('反例：值导入 / 混合导入 / re-export / 动态 import 命中；type-only 与注释不误杀；声明不算调用', () => {
    const forbidden = (code: string): string[] => valueImportSpecs(code).filter(isForbiddenModule);
    expect(forbidden("import { layoutTab } from '../../../notation/tab/layoutTab';")).toHaveLength(1);
    expect(forbidden("import { layoutTab, type TabLayout } from '../../../notation/tab/layoutTab';")).toHaveLength(1);
    expect(forbidden("export { justifyLine } from '../../../notation/system/justify';")).toHaveLength(1);
    expect(forbidden("const m = await import('../../../notation/layout/systems');")).toHaveLength(1);
    expect(forbidden("import type { TabLayout } from '../../../notation/tab/layoutTab';")).toEqual([]);
    expect(forbidden("import { type JianpuLayout } from '../../../notation/jianpu/layoutJianpu';")).toEqual([]);
    expect(forbidden("// import { pageModel } from '../../../notation/system/pageModel';")).toEqual([]);
    expect(callCount('const r = pageModel(a);', 'pageModel')).toBe(1);
    expect(callCount('export function pageModel(a) {}', 'pageModel')).toBe(0);
    expect(isComposeLayout('../../../notation/system/composeLayout')).toBe(true);
  });
});

describe('M2.5 T9b 架构守卫 —— ScoreView 接线（M2 / L9）', () => {
  const view = normalize(read(SCORE_VIEW));
  const composeArgs = (code: string): string => /composeScoreLayout\(([^)]*)\)/.exec(code)?.[1] ?? '';
  const effectDeps = (code: string): string[] =>
    (/function useAnchorHighlight\(.*?\}, \[([^\]]*)\]\);/.exec(code)?.[1] ?? '').split(',').map((d) => d.trim()).filter((d) => d !== '');
  const usesZoomForWidth = (code: string): boolean => /useAvailableWidth\( ?\w+ ?, ?zoom ?\)/.test(code);
  const consumesGapOnce = (code: string): boolean => /rowGap: ?cssPx\( ?SYSTEM_METRICS\.systemGap ?, ?zoom ?\)/.test(code);
  const mergesHeader = (code: string): boolean => /mergeScoreDiagnostics\( ?scoreLayout\.diagnostics ?, ?header\.diagnostics ?\)/.test(code);

  it('compose 用 screen policy（带 availableWidth），ScoreView 不出现 page policy', () => {
    expect(composeArgs(view)).toMatch(/kind: 'screen'/);
    expect(composeArgs(view)).toMatch(/\bavailableWidth\b/);
    expect(/kind: 'page'/.test(view)).toBe(false);
  });

  it('zoom 进入可用宽度换算：useAvailableWidth(…, zoom) 且 computeAvailableWidthUnits(…, zoom)', () => {
    expect(usesZoomForWidth(view)).toBe(true);
    expect(/computeAvailableWidthUnits\([^)]*, ?zoom ?\)/.test(view)).toBe(true);
  });

  it('systemGap 只由 .score-systems 的 row-gap 消费一次；其它 renderer 代码与 system CSS 都不再放间距', () => {
    expect(consumesGapOnce(view)).toBe(true);
    const uses = rendererFiles.flatMap((file) => [...stripComments(read(file)).matchAll(/\bsystemGap\b|\browGap\b/g)].map(() => rel(file)));
    expect(uses).toEqual([rel(SCORE_VIEW), rel(SCORE_VIEW)]);
    for (const selector of ['.score-systems', '.score-system']) expect(cssRule(selector)).not.toMatch(/\bgap\b|margin/);
  });

  it('诊断 = mergeScoreDiagnostics(scoreLayout.diagnostics, header.diagnostics)；不再合并 renderScore.diagnostics', () => {
    expect(mergesHeader(view)).toBe(true);
    expect(/renderScore\.diagnostics/.test(view)).toBe(false);
  });

  it('高亮 effect 的依赖含 renderGeneration（与 selectedAnchorKey / scoreRender 一起），调用处传入 renderGeneration', () => {
    expect(effectDeps(view)).toEqual(expect.arrayContaining(['selectedAnchorKey', 'scoreRender', 'renderGeneration']));
    expect(/useAnchorHighlight\([^)]*\brenderGeneration\b[^)]*\)/.test(view)).toBe(true);
    expect(callCount(read(SCORE_VIEW), 'useCallback')).toBe(1);
  });

  it('反例：上述 matcher 能识别缺失与改写', () => {
    expect(composeArgs("composeScoreLayout(rs, i, M, { kind: 'page', contentWidth: w })")).not.toMatch(/kind: 'screen'/);
    expect(usesZoomForWidth('useAvailableWidth(systemsRef, 1)')).toBe(false);
    expect(consumesGapOnce('rowGap: cssPx(SYSTEM_METRICS.systemGap, 1)')).toBe(false);
    expect(mergesHeader('mergeScoreDiagnostics(scoreLayout.diagnostics, [])')).toBe(false);
    const deps = effectDeps(normalize('function useAnchorHighlight(a) { useEffect(() => { x(); }, [selectedAnchorKey, scoreRender]); }'));
    expect(deps).toEqual(['selectedAnchorKey', 'scoreRender']);
    expect(deps).not.toContain('renderGeneration');
  });
});

describe('M2.5 T9b 架构守卫 —— VexFlow 边界与 Staff tier 1（L9）', () => {
  it('components/notation/** 不 import vexflow 包', () => {
    expect(componentFiles.flatMap((file) => valueImportSpecs(read(file)).filter(isVexflow).map((spec) => `${rel(file)} → ${spec}`))).toEqual([]);
    expect(isVexflow('vexflow/bravura')).toBe(true);
    expect(isVexflow('../../integrations/vexflow/renderStaff')).toBe(false);
  });

  it('adapter 不碰 TickContext / x 覆写 / preFormat（不实现 Staff tier 2）', () => {
    const files = collectFiles(VEXFLOW_DIR).filter((file) => !file.endsWith('.test.ts'));
    expect(files.filter((file) => TIER2.test(stripComments(read(file)))).map(rel)).toEqual([]);
    const probes = ['note.getTickContext().setX(12);', 'note.setTickContext(ctx);', 'tickContext.x = 40;', 'tc.preFormat();', 'n.setXShift(3);'];
    for (const probe of probes) {
      expect(TIER2.test(probe)).toBe(true);
    }
    expect(TIER2.test(stripComments('// TickContext 由 Formatter 分配'))).toBe(false);
  });

  it('五线谱 host 由 VexFlow 独占：host 自闭合（无 React children），画完调用 onRendered；renderStaff 调用一次', () => {
    const hostSelfClosing = (code: string): boolean => /<div className="staff-canvas" ref=\{hostRef\} ?\/>/.test(code);
    const staff = normalize(read(STAFF_VIEW));
    expect(hostSelfClosing(staff)).toBe(true);
    expect(/onRendered\?\.\(\)/.test(staff)).toBe(true);
    expect(callCount(read(STAFF_VIEW), 'renderStaff')).toBe(1);
    expect(hostSelfClosing('<div className="staff-canvas" ref={hostRef}><span/></div>')).toBe(false);
  });
});

describe('M2.5 T9b 架构守卫 —— system 几何、chordSymbol 归属与 CSS（J4 / E / M5）', () => {
  it('SystemView 不读 box.origin（x / y 都不读，只消费 leftOffset）；ScoreView 不读 origin.y', () => {
    const systemView = stripComments(read(SYSTEM_VIEW));
    expect(/\borigin\b/.test(systemView)).toBe(false);
    expect(/\bleftOffset\b/.test(systemView)).toBe(true);
    expect(/origin\.y\b/.test(stripComments(read(SCORE_VIEW)))).toBe(false);
    expect(/\borigin\b/.test('marginLeft: cssPx(system.box.origin.x, zoom)')).toBe(true);
  });

  it('chordSymbol 只在 systemSlices.ts 处理：唯一判断函数被三个切片构造调用；其它 components 文件不提 chordSymbol', () => {
    const slices = stripComments(read(SLICES));
    expect(/export function isSystemVisibleNode\b/.test(slices)).toBe(true);
    expect(callCount(slices, 'isSystemVisibleNode')).toBe(3);
    const others = componentFiles.filter((file) => file !== SLICES && /chordSymbol/.test(stripComments(read(file))));
    expect(others.map(rel)).toEqual([]);
    expect(callCount('export function isSystemVisibleNode(node) {}\nisSystemVisibleNode(n);', 'isSystemVisibleNode')).toBe(1);
  });

  it('overlay 只消费 T6 / T8 结果：systemSlices 调用既有 layoutChord + chordToSvg，不 import 查表 / planner 输入', () => {
    const slices = read(SLICES);
    expect(callCount(slices, 'layoutChord')).toBe(1);
    expect(callCount(slices, 'chordToSvg')).toBe(1);
    expect(valueImportSpecs(slices).filter((spec) => /chordSymbolDisplay|chordOverlay/.test(spec))).toEqual([]);
    expect(/\bchordDiagramWidth\b/.test(stripComments(slices))).toBe(true);
  });

  it('M5 / L：五线谱层的 host 与 svg、简谱 / TAB 层 svg、system 与层都 overflow: visible（越界墨迹、歌词不被裁剪）', () => {
    const selectors = ['.system-layer-staff .staff-canvas svg', '.system-layer-staff .staff-canvas', '.system-layer > svg', '.system-layer', '.score-system'];
    for (const selector of selectors) {
      expect(cssRule(selector)).toMatch(/overflow:\s*visible/);
    }
    expect(cssRule('.no-such-selector')).toBe('');
  });

  it('overlay 叠在各层之上且只有和弦组接收点击；L3 / L4 高亮规则存在', () => {
    const overlay = cssRule('.score-system > .system-overlay');
    expect(overlay).toMatch(/z-index:\s*1/);
    expect(overlay).toMatch(/pointer-events:\s*none/);
    expect(cssRule('.system-chord')).toMatch(/pointer-events:\s*visiblePainted/);
    expect(cssRule('.system-chord.render-anchor-highlighted .finger-number')).toMatch(/fill:\s*white/);
    expect(cssRule('.system-layer:not(.system-layer-fallback).render-anchor-highlighted')).toMatch(/outline:/);
    expect(cssRule('.system-layer.render-anchor-highlighted')).toBe('');
  });
});
