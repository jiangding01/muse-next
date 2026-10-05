/**
 * M2.5 T9b.S 架构守卫（Staff vertical demand；`architecture.test.ts` 自 T8 起冻结，本阶段守卫住在这里，自带最小本地
 * helper，不抽共享模块）。所有 matcher 先去注释再扫描，并各带反例。
 *
 * - helper 边界：`staff/staffVerticalDemand.ts` 不 import 渲染器 / VexFlow / `layoutStaff` / `system/**`；事件语义只经
 *   `planStaffNode`，谱号只经 `resolveStaffClef`，tie 端点只经 `resolveVoiceRelations`；尺寸只取 `STAFF_METRICS`。
 * - 谱号三态规则唯一：缺省值与已知集合只在 `staff/staffClef.ts`。
 * - 唯一来源：`composeLayout.ts` 恰好一处调用 `staffLayerDemands` 并把结果作为必填 `topInsets` 交给 `layoutStaff`；
 *   `layoutStaff` 不 import helper、不读纵向墨迹常量、不回退 0；`layoutStaff` 全仓只由 composeLayout 调用一次。
 * - 渲染器：不重算纵向需求；线距显式取 `STAFF_METRICS.lineGap`，不读 `STAVE_LINE_DISTANCE`；viewBox 取切片高。
 * - PageModel 零渲染器 / 记谱依赖；不引入 Staff tier 2。
 *
 * 已知限制（正则级源码守卫，由 mutation / review 兜底，不写伪 parser）：`.5` 这类前导点数字、任意复杂解构、`includes` /
 * `new Set` 等各种谱号集合变体、别名 import 与运行时二次调用都可能绕过静态匹配。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC_DIR = join(import.meta.dirname, '../../../src');
const NOTATION_DIR = join(SRC_DIR, 'notation');
const RENDERER_DIR = join(SRC_DIR, 'renderer');
const HELPER = join(NOTATION_DIR, 'staff/staffVerticalDemand.ts');
const CLEF = join(NOTATION_DIR, 'staff/staffClef.ts');
const LAYOUT_STAFF = join(NOTATION_DIR, 'staff/layoutStaff.ts');
const COMPOSE = join(NOTATION_DIR, 'system/composeLayout.ts');
const VERTICAL_DEMAND = join(NOTATION_DIR, 'system/verticalDemand.ts');
const PAGE_MODEL = join(NOTATION_DIR, 'system/pageModel.ts');
const RENDER_STAFF = join(RENDERER_DIR, 'integrations/vexflow/renderStaff.ts');

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

const normalize = (source: string): string => stripComments(source).replace(/\s+/g, ' ');

/** 全部模块说明符（含 `import type`、re-export、动态 import）。 */
function allSpecs(source: string): string[] {
  const code = stripComments(source);
  return [/\bfrom\s*['"]([^'"]+)['"]/g, /\bimport\s*['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g]
    .flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ''));
}

/** 值导入的名字（`import type` 与 `type X` 成员不算）。 */
function valueImports(source: string, spec: string): string[] {
  return [...stripComments(source).matchAll(/^\s*import\s+(?!type\s)\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm)]
    .filter((m) => m[2] === spec)
    .flatMap((m) => (m[1] ?? '').split(',').map((n) => n.trim()).filter((n) => n !== '' && !n.startsWith('type ')));
}

/** 去掉 import 与注释后 `name(` 的调用次数（不含 `function name(` 声明）。 */
function callCount(source: string, name: string): number {
  const body = stripComments(source).replace(/^\s*import\b[^;]*;/gm, '');
  return [...body.matchAll(new RegExp(`(?<!function\\s)\\b${name}\\s*\\(`, 'g'))].length;
}

const read = (file: string): string => readFileSync(file, 'utf8');
const rel = (file: string): string => relative(SRC_DIR, file).split(sep).join('/');

/** helper 禁止依赖：渲染器 / VexFlow / layout 入口 / system 目录。 */
function helperViolations(source: string): string[] {
  return allSpecs(source).filter((spec) => spec.startsWith('vexflow') || /(^|\/)renderer\//.test(spec) || /(^|\/)layoutStaff$/.test(spec)
    || /(^|\/)layout(Jianpu|Tab|Chord)$/.test(spec) || /(^|\/)system\//.test(spec) || spec.startsWith('react'));
}

/** 内缩的静默回退：直接 `?? 0` / `|| 0`，或判空后三元给 0。 */
function insetFallbacks(source: string): string[] {
  const code = stripComments(source);
  const name = '(?:staffTopInsets|topInsets|topInset|inset)';
  const patterns = [
    new RegExp(`\\b${name}\\b(?:\\.get\\([^)]*\\))?\\s*(?:\\?\\?|\\|\\|)\\s*0\\b`, 'g'),
    new RegExp(`\\b${name}\\b(?:\\.get\\([^)]*\\))?\\s*[!=]==?\\s*(?:undefined|null)\\s*\\?[^:;]*:\\s*0\\b`, 'g'),
    new RegExp(`\\b${name}\\b(?:\\.get\\([^)]*\\))?\\s*[!=]==?\\s*(?:undefined|null)\\s*\\?\\s*0\\s*:`, 'g'),
  ];
  return patterns.flatMap((re) => [...code.matchAll(re)].map((m) => m[0]));
}

/** 重新解释 MusicEvent 的写法（应全部经 `planStaffNode`）。 */
const EVENT_REINTERPRET = /\.event\.kind\b|\bcase\s+'(?:chord|rest|grace|decoration|unknown|tabNote|tabGroup|chordSymbol|barline)'/;

/** 去注释后源码里的数字字面量（不含标识符内的数字）。 */
function numericLiterals(source: string): string[] {
  return [...stripComments(source).replace(/'[^'\n]*'|"[^"\n]*"|`[^`]*`/g, "''").matchAll(/(?<![\w.])\d+(?:\.\d+)?(?![\w])/g)].map((m) => m[0]);
}

describe('T9b.S —— staffVerticalDemand 边界', () => {
  const helper = read(HELPER);

  it('不 import 渲染器 / VexFlow / layoutStaff / system/**（含反例）', () => {
    expect(helperViolations(helper)).toEqual([]);
    expect(helperViolations("import { layoutStaff } from './layoutStaff';")).toEqual(['./layoutStaff']);
    expect(helperViolations("import type { ScoreLayout } from '../system/composeLayout';")).toEqual(['../system/composeLayout']);
    expect(helperViolations("import { Stave } from 'vexflow/bravura';")).toEqual(['vexflow/bravura']);
    expect(helperViolations("import { cssPx } from '../../renderer/components/notation/systemRender';")).toEqual(['../../renderer/components/notation/systemRender']);
    expect(helperViolations("import { splitMeasures } from '../layout/systems';")).toEqual([]);
  });

  it('事件语义只经 planStaffNode、谱号只经 resolveStaffClef、tie 端点只经 resolveVoiceRelations（真正调用）', () => {
    expect(valueImports(helper, './staffEventNodes')).toEqual(['planStaffNode']);
    expect(callCount(helper, 'planStaffNode')).toBe(1);
    expect(valueImports(helper, './staffClef')).toContain('resolveStaffClef');
    expect(callCount(helper, 'resolveStaffClef')).toBe(1);
    expect(valueImports(helper, '../model/relations')).toEqual(['resolveVoiceRelations']);
    expect(callCount(helper, 'resolveVoiceRelations')).toBe(1);
    expect(valueImports(helper, '../layout/systems')).toEqual(['splitMeasures']);
    expect(EVENT_REINTERPRET.test(stripComments(helper))).toBe(false);
    expect(EVENT_REINTERPRET.test("switch (item.event.kind) { case 'chord': }")).toBe(true);
    expect(EVENT_REINTERPRET.test("if (plan.kind !== 'note') continue;")).toBe(false);
    expect(/\btoStaffPitch\b|\bresolveClef\b|'treble'|'bass'/.test(stripComments(helper))).toBe(false);
  });

  it('尺寸只取 STAFF_METRICS：数字字面量只有结构换算的 0 / 1 / 2 / 7（线数 − 1、每级半线距、一个八度 7 级；含反例）', () => {
    expect(valueImports(helper, '../layout/metrics')).toEqual(['STAFF_METRICS']);
    expect([...new Set(numericLiterals(helper))].sort()).toEqual(['0', '1', '2', '7']);
    expect(numericLiterals('const tip = center + 35; // 35 不算')).toEqual(['35']);
    expect(numericLiterals("const s = 'CDEFGAB'.indexOf(x) + v2;")).toEqual([]);
  });
});

describe('T9b.S —— 谱号三态规则唯一', () => {
  const notationFiles = collectFiles(NOTATION_DIR);

  /** 重新定义缺省谱号：缺省常量、`?? '<clef>'`、给 StaffClef 变量赋字面量。 */
  const DEFAULT_CLEF = /DEFAULT_STAFF_CLEF\s*(?::[^=]*)?=|\?\?\s*'(?:treble|bass|alto|tenor)'|:\s*StaffClef\s*=\s*'(?:treble|bass|alto|tenor)'/;
  /** 完整的已知谱号集合：同一文件里四个谱号字面量都出现（类型定义所在的 staffTypes.ts 除外）。 */
  const fullClefSet = (source: string): boolean => ['treble', 'bass', 'alto', 'tenor'].every((clef) => stripComments(source).includes(`'${clef}'`));
  const TYPES = join(NOTATION_DIR, 'staff/staffTypes.ts');

  it('staffClef.ts 之外不重新定义缺省谱号或完整的已知谱号集合（notation 全目录，含反例）', () => {
    const others = notationFiles.filter((file) => file !== CLEF);
    expect(others.filter((file) => DEFAULT_CLEF.test(stripComments(read(file)))).map(rel)).toEqual([]);
    expect(others.filter((file) => file !== TYPES && fullClefSet(read(file))).map(rel)).toEqual([]);
    expect(DEFAULT_CLEF.test("const DEFAULT_CLEF: StaffClef = 'treble';")).toBe(true);
    expect(DEFAULT_CLEF.test("const clef = voice.clef ?? 'treble';")).toBe(true);
    expect(fullClefSet("const KNOWN = ['treble', 'bass', 'alto', 'tenor'];")).toBe(true);
    expect(fullClefSet("const twoOnly = ['treble', 'bass'];")).toBe(false);
    expect(DEFAULT_CLEF.test(stripComments(read(CLEF)))).toBe(true);
    expect(fullClefSet(read(CLEF))).toBe(true);
  });

  it('已知谱号集合 / 缺省值只在 staffClef.ts；layoutStaff 与 helper 都调用 resolveStaffClef', () => {
    const known = /===\s*'tenor'|'tenor'\s*===|\bisKnownClef\b|DEFAULT_STAFF_CLEF\s*(?::[^=]*)?=/;
    const owners = notationFiles.filter((file) => known.test(stripComments(read(file)))).map(rel);
    expect(owners).toEqual([rel(CLEF)]);
    expect(known.test("return value === 'tenor';")).toBe(true);
    const layout = read(LAYOUT_STAFF);
    expect(valueImports(layout, './staffClef')).toEqual(['resolveStaffClef']);
    expect(callCount(layout, 'resolveStaffClef')).toBe(1);
    expect(/'treble'/.test(stripComments(layout))).toBe(false);
  });
});

describe('T9b.S —— 唯一来源：compose 注入 → layoutStaff 只消费', () => {
  const compose = read(COMPOSE);
  const layout = read(LAYOUT_STAFF);

  it('composeLayout 值导入并恰好一处调用 staffLayerDemands；layoutStaff 恰好一处调用；topInsets 取自 VoicePlan', () => {
    expect(valueImports(compose, '../staff/staffVerticalDemand')).toEqual(['staffLayerDemands']);
    expect(callCount(compose, 'staffLayerDemands')).toBe(1);
    expect(callCount(compose, 'layoutStaff')).toBe(1);
    expect(normalize(compose)).toMatch(/external: \{ \.\.\.external, topInsets: staffTopInsets \}/);
    expect(normalize(compose)).toMatch(/voicePlan\.staffTopInsets/);
  });

  it('layoutStaff 全仓只由 composeLayout 调用（含反例计数）', () => {
    const callers = collectFiles(SRC_DIR).filter((file) => file !== LAYOUT_STAFF && callCount(read(file), 'layoutStaff') > 0).map(rel);
    expect(callers).toEqual(['notation/system/composeLayout.ts']);
    expect(callCount("import { layoutStaff } from './x';\nlayoutStaff(a); layoutStaff(b);", 'layoutStaff')).toBe(2);
  });

  it('layoutStaff 不 import helper、不读纵向墨迹常量；topInsets 必填', () => {
    expect(allSpecs(layout).filter((spec) => /staffVerticalDemand$/.test(spec))).toEqual([]);
    expect(/\bverticalInk\b|\btieVerticalPadding\b|\bstaffLayerDemands\b|\bstaffNoteInk\b/.test(stripComments(layout))).toBe(false);
    expect(normalize(layout)).toMatch(/readonly topInsets: ReadonlyMap<number, number>;/);
    expect(/topInsets\?/.test(stripComments(layout))).toBe(false);
    expect(normalize(layout)).toMatch(/y: system\.box\.origin\.y \+ frame\.topInset/);
  });

  it('内缩不得静默回退 0：`?? 0` / `|| 0` / 三元回退都被命中（含反例）', () => {
    for (const file of [LAYOUT_STAFF, COMPOSE, VERTICAL_DEMAND]) expect(insetFallbacks(read(file))).toEqual([]);
    expect(insetFallbacks('const topInset = topInsets.get(i) ?? 0;')).toHaveLength(1);
    expect(insetFallbacks('const y = top + (topInset || 0);')).toHaveLength(1);
    expect(insetFallbacks('const inset = topInsets.get(i);\nconst y = inset === undefined ? 0 : inset;')).toHaveLength(1);
    expect(insetFallbacks('const v = staffTopInsets.get(i) !== undefined ? staffTopInsets.get(i) : 0;')).toHaveLength(1);
    expect(insetFallbacks('const x = (systemByIndex.get(i)?.box.origin.x ?? 0) + box.x;\nconst topInset = topInsets.get(i);')).toEqual([]);
  });

  it('verticalDemand.ts 不 import 任何 staff/** 或 layout 入口（Staff 需求经注入函数拿到）', () => {
    const demand = read(VERTICAL_DEMAND);
    expect(allSpecs(demand).filter((spec) => /\/staff\/|layoutStaff|layoutJianpu|layoutTab/.test(spec))).toEqual([]);
    expect(allSpecs("import { staffLayerDemands } from '../staff/staffVerticalDemand';").filter((spec) => /\/staff\//.test(spec))).toHaveLength(1);
  });
});

describe('T9b.S —— 渲染器不重算纵向需求；线距真源', () => {
  const rendererFiles = collectFiles(RENDERER_DIR);
  const RECOMPUTE = /\b(?:staffLayerDemands|staffNoteInk|staffStemTip|staffPosition|staffLineOffset|planStaffNode|toStaffPitch|resolveStaffClef|verticalInk|tieVerticalPadding)\b/;

  const recomputes = (source: string): boolean => RECOMPUTE.test(stripComments(source)) || allSpecs(source).some((spec) => /staffVerticalDemand$|staffClef$/.test(spec));

  it('renderer 全体不引用 notation 纵向需求 / 音高语义（含反例）', () => {
    expect(rendererFiles.filter((file) => recomputes(read(file))).map(rel)).toEqual([]);
    expect(recomputes('const ink = staffNoteInk(p, d, c, t);')).toBe(true);
    expect(recomputes("import { staffLayerDemands } from '../../../notation/staff/staffVerticalDemand';")).toBe(true);
    expect(recomputes("import type { StaffSystemDemand } from '../../../notation/staff/staffVerticalDemand';")).toBe(true);
    expect(recomputes('const plan = planStaffNode(node.event);')).toBe(true);
    expect(recomputes('const clef = resolveStaffClef(voice.clef).clef;')).toBe(true);
    expect(recomputes('// planStaffNode(event) 只在注释里\nconst x = 1;')).toBe(false);
  });

  it('占位 / 文本 tickable 热区取基础 Staff box，不再按 `lineGap × 3` 推导（含反例）', () => {
    const lineGapMultiple = /STAFF_METRICS\.lineGap\s*\*\s*\d|\d\s*\*\s*STAFF_METRICS\.lineGap/;
    expect(lineGapMultiple.test(stripComments(read(RENDER_STAFF)))).toBe(false);
    expect(lineGapMultiple.test('y: y - STAFF_METRICS.lineGap * 3,')).toBe(true);
    const source = normalize(read(RENDER_STAFF));
    expect(source).toMatch(/const band = staffBaseHitBand\(stave\.getYForLine\(0\)\);/);
    expect(source).toMatch(/return \{ y: topLineY - STAFF_METRICS\.staffTopOffset, height: STAFF_METRICS\.systemHeight \};/);
  });

  it('renderStaff：线距显式取 lineGap、上方余量按同一线距换算；不读 STAVE_LINE_DISTANCE；viewBox 取切片高', () => {
    const source = normalize(read(RENDER_STAFF));
    expect(source).toMatch(/spacingBetweenLinesPx: STAFF_METRICS\.lineGap/);
    expect(source).toMatch(/spaceAboveStaffLn: STAFF_METRICS\.staffTopOffset \/ STAFF_METRICS\.lineGap/);
    expect(/STAVE_LINE_DISTANCE/.test(stripComments(read(RENDER_STAFF)))).toBe(false);
    expect(source).toMatch(/const height = Math\.max\(slice\.height, 1\);/);
    expect(source).toMatch(/fitSvgToContainer\(host, ctx\.svg, width, height\)/);
    expect(source).toMatch(/new Stave\(spec\.x, spec\.y, /);
  });

  it('不引入 Staff tier 2（不碰 TickContext / x 覆写 / preFormat）', () => {
    const tier2 = /TickContext|tickContext|setXShift|preFormat|\.setX\s*\(/;
    const vexFiles = rendererFiles.filter((file) => rel(file).startsWith('renderer/integrations/vexflow/'));
    expect(vexFiles.length).toBeGreaterThan(0);
    expect(vexFiles.filter((file) => tier2.test(stripComments(read(file)))).map(rel)).toEqual([]);
    expect(tier2.test('new TickContext()')).toBe(true);
  });
});

describe('T9b.S —— PageModel 零渲染器 / 记谱依赖', () => {
  it('pageModel.ts 只依赖 metrics / contracts / primitives / diagnostics，不认识 Staff', () => {
    const source = read(PAGE_MODEL);
    const bad = allSpecs(source).filter((spec) => spec.startsWith('vexflow') || /renderer|\/staff\/|\/jianpu\/|\/tab\/|\/chord\//.test(spec));
    expect(bad).toEqual([]);
    expect(/\bstaff\w*|STAFF_METRICS/i.test(stripComments(source))).toBe(false);
  });
});
