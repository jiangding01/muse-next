/**
 * M2.5 T9a 架构守卫（用户裁决 L / M，2026-10-05）：`architecture.test.ts` 自 T8 起冻结，T9a 的守卫一律住在这里，
 * 并自带最小本地 helper（不抽共享模块、不改历史文件）。
 *
 * `system/pageModel.ts` 是纯数据的 system → page 分配：
 * - 正向：文件存在；type-only 依赖 `system/contracts`；真正值导入并使用 `SYSTEM_METRICS`（默认 PageSpec 不得写成
 *   硬编码数字）与诊断 helper / code 表。
 * - 反向：import 只允许白名单内的几条精确路径——renderer / React / DOM / VexFlow / 三个 voice layout / `composeSystem` /
 *   `composeLayout` 一律拒绝；源码（去注释后）不出现屏幕侧概念 `availableWidth` / `zoom`（**不设词边界**，
 *   `getAvailableWidth` / `maxZoom` 也命中）/ `ResizeObserver` / `scoreView` / `SCORE_VIEW` /
 *   `computeAvailableWidthUnits`；另对几个常见 DOM 入口（`document` / `window` / `HTML*Element` / `DOMParser`）
 *   做**抽样**检查——这不是对全部 DOM global 的完整识别，DOM 依赖主要靠 import 白名单拦截。
 * 所有 matcher 先去注释再扫描，并各带反例，证明守卫不是在对着空字符串变绿。已知限制（用户裁决 L4 接受）：去注释是
 * 正则级的，字符串字面量里的 `//` 可能误删同行后续代码。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const PAGE_MODEL_FILE = join(import.meta.dirname, '../../../src/notation/system/pageModel.ts');

/** 去掉块注释与行注释（保留 `https://` 一类的 `://`）。 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 全部模块说明符：静态 `import / export … from`、裸 `import 'm'`、动态 `import('m')`、`require('m')`。 */
function specifiers(source: string): string[] {
  const code = stripComments(source);
  const patterns = [
    /\b(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  return patterns.flatMap((re) => [...code.matchAll(re)].map((m) => m[1] ?? ''));
}

/** `import { … } from 'spec'` 的名字；`typeOnly` 区分 `import type { … }` 与值导入。 */
function importedNames(source: string, spec: string, typeOnly: boolean): string[] {
  const re = /^\s*import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  return [...stripComments(source).matchAll(re)]
    .filter((m) => m[3] === spec && (m[1] !== undefined) === typeOnly)
    .flatMap((m) => (m[2] ?? '').split(',').map((name) => name.trim().split(/\s+as\s+/).pop() ?? '').filter((name) => name !== ''));
}

/** 去掉 import 语句与注释后，`name` 作为标识符出现的次数（只 import 不用 = 0）。 */
function usageCount(source: string, name: string): number {
  const body = stripComments(source).replace(/^\s*import\b[^;]*;/gm, '');
  return [...body.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length;
}

const ALLOWED_SPECS: readonly string[] = [
  '../../domain',
  './contracts',
  '../layout/metrics',
  '../layout/primitives',
  '../model/diagnostics',
  '../model/types',
];

function importViolations(source: string): string[] {
  return specifiers(source).filter((spec) => !ALLOWED_SPECS.includes(spec));
}

/** 屏幕侧概念不设词边界（复合词也命中）；DOM 入口按词边界抽样。大小写不敏感。 */
const FORBIDDEN_WORDS =
  /computeAvailableWidthUnits|availableWidth|zoom|ResizeObserver|scoreView|SCORE_VIEW|\b(?:document|window|HTML\w*Element|DOMParser)\b/gi;

function wordViolations(source: string): string[] {
  return [...stripComments(source).matchAll(FORBIDDEN_WORDS)].map((m) => m[0]);
}

describe('M2.5 T9a 架构守卫 —— system/pageModel.ts', () => {
  const source = existsSync(PAGE_MODEL_FILE) ? readFileSync(PAGE_MODEL_FILE, 'utf8') : '';

  it('pageModel.ts 存在（防止改名 / 挪目录后守卫空跑）', () => {
    expect(existsSync(PAGE_MODEL_FILE)).toBe(true);
    expect(source.length).toBeGreaterThan(0);
  });

  it('import 只来自白名单：不认识 renderer / React / DOM / VexFlow / voice layout / composer', () => {
    expect(specifiers(source).length).toBeGreaterThan(0);
    expect(importViolations(source)).toEqual([]);
  });

  it('不出现屏幕侧宽度 / 缩放概念与抽样的 DOM 入口（去注释后）', () => {
    expect(wordViolations(source)).toEqual([]);
  });

  it('正向：type-only 依赖 contracts；真正使用 SYSTEM_METRICS 与诊断 helper；导出 pageModel', () => {
    const contractTypes = importedNames(source, './contracts', true);
    expect(contractTypes).toEqual(expect.arrayContaining(['PageComposedSystemLayout', 'PageModel', 'PageSpec']));
    expect(importedNames(source, './contracts', false)).toEqual([]);
    // L5：import 名称排序后再比较，不把书写顺序当契约。
    expect(importedNames(source, '../layout/metrics', false).sort()).toEqual(['SYSTEM_METRICS']);
    expect(usageCount(source, 'SYSTEM_METRICS')).toBeGreaterThanOrEqual(2);
    expect(importedNames(source, '../model/diagnostics', false).sort()).toEqual(['CODES', 'collectRenderDiagnostics'].sort());
    expect(usageCount(source, 'collectRenderDiagnostics')).toBeGreaterThan(0);
    expect(usageCount(source, 'systemPageOverflow')).toBeGreaterThan(0);
    expect(/^export function pageModel\(/m.test(stripComments(source))).toBe(true);
  });
});

describe('M2.5 T9a 架构守卫 —— matcher 反例', () => {
  it('越界 import 都被命中：renderer / React / VexFlow / voice layout / composeSystem / composeLayout / 动态 import', () => {
    const cases: readonly (readonly [string, string])[] = [
      ["import { ScoreView } from '../../renderer/components/ScoreView';", '../../renderer/components/ScoreView'],
      ["import { useState } from 'react';", 'react'],
      ["import { Stave } from 'vexflow';", 'vexflow'],
      ["import { layoutTab } from '../tab/layoutTab';", '../tab/layoutTab'],
      ["import { layoutJianpu } from '../jianpu/layoutJianpu';", '../jianpu/layoutJianpu'],
      ["import { layoutStaff } from '../staff/layoutStaff';", '../staff/layoutStaff'],
      ["import { composeSystemGeometry } from './composeSystem';", './composeSystem'],
      ["import type { ScoreLayout } from './composeLayout';", './composeLayout'],
      ["const m = await import('./composeLayout');", './composeLayout'],
    ];
    for (const [code, spec] of cases) expect(importViolations(code)).toEqual([spec]);
  });

  it('白名单路径与注释里的 import 不误判', () => {
    expect(importViolations("import type { PageModel } from './contracts';")).toEqual([]);
    expect(importViolations("import { SYSTEM_METRICS } from '../layout/metrics';")).toEqual([]);
    expect(importViolations("// import { layoutTab } from '../tab/layoutTab';\n/* import 'react'; */")).toEqual([]);
  });

  it('屏幕 / DOM 字样被命中（含复合词）；注释里的说明不误判', () => {
    expect(wordViolations('const w = policy.availableWidth;')).toEqual(['availableWidth']);
    expect(wordViolations('computeAvailableWidthUnits(a, b, c);')).toEqual(['computeAvailableWidthUnits']);
    expect(wordViolations('const z = ctx.zoomLevel; new ResizeObserver(cb);')).toEqual(['zoom', 'ResizeObserver']);
    expect(wordViolations('const w = getAvailableWidth(); const m = maxZoom;')).toEqual(['AvailableWidth', 'Zoom']);
    expect(wordViolations('const a = SCORE_VIEW_METRICS.x; const b = scoreView.y;')).toEqual(['SCORE_VIEW', 'scoreView']);
    expect(wordViolations('document.createElement("g"); window.print();')).toEqual(['document', 'window']);
    expect(wordViolations('let el: HTMLDivElement;')).toEqual(['HTMLDivElement']);
    expect(wordViolations('// 不认识 zoom / availableWidth / document\nexport const ok = 1;')).toEqual([]);
  });

  it('正向检查不被「只 import 不用」「值 / type 混淆」「注释里的 import」骗过', () => {
    const unused = "import { SYSTEM_METRICS } from '../layout/metrics';\nexport const x = 1;";
    expect(usageCount(unused, 'SYSTEM_METRICS')).toBe(0);
    expect(importedNames("import { PageModel } from './contracts';", './contracts', true)).toEqual([]);
    expect(importedNames("import { PageModel } from './contracts';", './contracts', false)).toEqual(['PageModel']);
    expect(importedNames("// import type { PageModel } from './contracts';", './contracts', true)).toEqual([]);
    const aliased = "import { RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';";
    expect(importedNames(aliased, '../model/diagnostics', false)).toEqual(['CODES']);
  });
});
