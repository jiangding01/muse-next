/**
 * M3 T0 架构守卫（`docs/M3_EDITOR_CORE_PLAN.md` §21.2、T0 用户裁决）。
 *
 * - `src/editor/**`：不依赖 React / renderer / notation / Electron / DOM / Node / 定时器 / 墙钟；格式层只经
 *   `src/formats/jcxParse.ts`；`src/shared/**` 只能子句级 `import type`；可依赖 `src/domain/**`；不得有 `.tsx` / JSX。
 *   两道防线：AST 黑名单扫描 + 以不含 DOM / Node 的类型环境编译 `src/editor`。
 * - parse façade：位于 `src/formats/jcx/` 之外；不经 `index.ts`；只导出 `loadJcx` 与三个类型；静态值依赖闭包不含
 *   serializer / `encodeJcx` / 裸说明符（含 iconv-lite 与 `node:`）/ 动态 import。
 * - `src/shared/**`：只放跨进程纯数据契约；值依赖只能在 shared 内部，类型依赖可来自 façade 与 domain。
 * - renderer：从 façade 只能导入白名单名字；对 `formats/jcx` 的直接导入只放行 T1 迁移前已存在的
 *   `store.ts → formats/jcx` 两条遗留导入（被删除后本守卫仍通过；T1 的 m3t1 守卫再要求归零）；非字面量动态 import 违规。
 *
 * 每条规则都配合成源码反例，保证规则会真的失败。冻结的历史守卫不修改。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  REPO_ROOT,
  collectTsFiles,
  exportedNames,
  forbiddenGlobalUses,
  parseImports,
  platformFreeDiagnostics,
  posixPath,
  resolveSpecifier,
  valueClosure,
} from './staticAnalysis';

const EDITOR_DIR = join(REPO_ROOT, 'src/editor');
const SHARED_DIR = join(REPO_ROOT, 'src/shared');
const RENDERER_DIR = join(REPO_ROOT, 'src/renderer');
const FACADE = join(REPO_ROOT, 'src/formats/jcxParse.ts');
const FACADE_PATH = 'src/formats/jcxParse.ts';
const RENDERER_FACADE_WHITELIST: ReadonlySet<string> = new Set(['loadJcx', 'LoadResult', 'JcxDiagnostic', 'JcxEncoding']);
/** T1 迁移前已存在的 renderer → formats/jcx 直接导入（grandfathered transitional debt）。 */
const GRANDFATHERED = { file: 'src/renderer/app/store.ts', target: 'src/formats/jcx/index.ts', names: new Set(['JcxDiagnostic', 'loadJcx']) };

function editorImportViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    if (record.kind === 'dynamic' || record.kind === 'require') return [`${record.kind}:${record.specifier}`];
    const target = resolveSpecifier(file, record.specifier);
    if (target === null || target === undefined) return [`bare-or-unresolved:${record.specifier}`];
    const path = posixPath(target);
    if (path.startsWith('src/editor/') || path === FACADE_PATH || path.startsWith('src/domain/')) return [];
    if (path.startsWith('src/shared/')) return record.typeOnly ? [] : [`shared-value-import:${record.specifier}`];
    return [`forbidden-target:${path}`];
  });
}

function sharedImportViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    if (record.kind === 'dynamic' || record.kind === 'require') return [`${record.kind}:${record.specifier}`];
    const target = resolveSpecifier(file, record.specifier);
    if (target === null || target === undefined) return [`bare-or-unresolved:${record.specifier}`];
    const path = posixPath(target);
    if (path.startsWith('src/shared/')) return [];
    if (record.typeOnly && (path === FACADE_PATH || path.startsWith('src/domain/'))) return [];
    return [`forbidden-target:${path}`];
  });
}

function rendererFormatViolations(file: string, source: string): string[] {
  const rel = posixPath(file);
  return parseImports(file, source).flatMap((record) => {
    if (record.kind === 'dynamic' && record.specifier === '<non-literal>') return [`non-literal-dynamic-import:${rel}`];
    const target = resolveSpecifier(file, record.specifier);
    if (target === null || target === undefined) return [];
    const path = posixPath(target);
    if (path === FACADE_PATH) return record.names.filter((name) => !RENDERER_FACADE_WHITELIST.has(name)).map((name) => `facade-name:${name}`);
    if (!path.startsWith('src/formats/')) return [];
    const grandfathered =
      rel === GRANDFATHERED.file && path === GRANDFATHERED.target && record.names.every((name) => GRANDFATHERED.names.has(name));
    return grandfathered ? [] : [`direct-formats-import:${rel} → ${path} {${record.names.join(', ')}}`];
  });
}

const editorFiles = collectTsFiles(EDITOR_DIR);
const fakeEditorFile = join(EDITOR_DIR, 'text/__fake__.ts');
const fakeSharedFile = join(SHARED_DIR, '__fake__.ts');
const fakeRendererFile = join(RENDERER_DIR, 'app/__fake__.ts');
const rows = (files: readonly string[]): [string, string][] => files.map((file) => [posixPath(file), file]);

describe('M3 T0 架构守卫 —— src/editor 依赖与运行时', () => {
  it('扫到了 T0 的四个核心目录（守卫没有扫空目录），且没有 .tsx 文件', () => {
    const dirs = new Set(editorFiles.map((file) => posixPath(file).split('/')[2]));
    expect([...dirs].sort()).toEqual(['projection', 'selection', 'session', 'text']);
    expect(editorFiles.filter((file) => file.endsWith('.tsx'))).toEqual([]);
  });

  it.each(rows(editorFiles))('%s 只依赖 editor / façade / domain，shared 只做子句级 type 导入', (_rel, file) => {
    expect(editorImportViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it.each(rows(editorFiles))('%s 不使用 DOM / Node / 定时器 / 墙钟 / JSX', (_rel, file) => {
    expect(forbiddenGlobalUses(file, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('以不含 DOM / Node 的类型环境（lib ES2023、types []）编译 src/editor：零诊断', () => {
    expect(platformFreeDiagnostics(editorFiles)).toEqual([]);
  });

  it('反例：受限类型环境会拒绝值位置与类型位置的平台全局', () => {
    const bad = join(EDITOR_DIR, 'text/__virtual_bad__.ts');
    const clean = join(EDITOR_DIR, 'text/__virtual_clean__.ts');
    const virtualFiles = new Map([
      [bad, 'export const later = { schedule: setTimeout };\nexport type Host = HTMLTextAreaElement;\n'],
      [clean, "import type { TextPatch } from './types';\nexport const empty: TextPatch = { start: 0, end: 0, text: '' };\n"],
    ]);
    // 与生产检查放进同一个程序：若依赖链引入 DOM / Node 类型，生产文件零诊断与反例报错不可能同时成立。
    const diagnostics = platformFreeDiagnostics([...editorFiles, bad, clean], virtualFiles);
    const badMessages = diagnostics.filter((message) => message.includes('__virtual_bad__'));
    expect(badMessages.some((message) => message.includes("'setTimeout'"))).toBe(true);
    expect(badMessages.some((message) => message.includes("'HTMLTextAreaElement'"))).toBe(true);
    expect(diagnostics.filter((message) => !message.includes('__virtual_bad__'))).toEqual([]);
  });

  it('反例：依赖规则能识别外部包、Node、shared 值导入（含内联 type）、formats/jcx、notation、动态 import、JSX 运行时', () => {
    const cases: [string, string, string][] = [
      [fakeEditorFile, "import { useState } from 'react';", 'bare-or-unresolved:react'],
      [fakeEditorFile, "import { readFileSync } from 'node:fs';", 'bare-or-unresolved:node:fs'],
      [fakeEditorFile, "import x = require('electron');", 'require:electron'],
      [fakeEditorFile, "import { IPC } from '../../shared/ipc';", 'shared-value-import:../../shared/ipc'],
      [fakeEditorFile, "import { type ByteBom } from '../../shared/documentContracts';", 'shared-value-import:../../shared/documentContracts'],
      [fakeEditorFile, "export { type ByteBom } from '../../shared/documentContracts';", 'shared-value-import:../../shared/documentContracts'],
      [fakeEditorFile, "import '../../shared/documentContracts';", 'shared-value-import:../../shared/documentContracts'],
      [fakeEditorFile, "import { loadJcx } from '../../formats/jcx';", 'forbidden-target:src/formats/jcx/index.ts'],
      [fakeEditorFile, "export * from '../../formats/jcx/lexer';", 'forbidden-target:src/formats/jcx/lexer/index.ts'],
      [fakeEditorFile, "import type { Anchor } from '../../notation/model/types';", 'forbidden-target:src/notation/model/types.ts'],
      [fakeEditorFile, "const m = import('./ap' + 'ply');", 'dynamic:<non-literal>'],
      [join(EDITOR_DIR, 'text/__fake__.tsx'), 'export const X = <div />;', 'bare-or-unresolved:react/jsx-runtime'],
    ];
    for (const [file, source, expected] of cases) expect(editorImportViolations(file, source), source).toContain(expected);
    const allowed = [
      "import type { ByteBom } from '../../shared/documentContracts';",
      "export type { ByteBom } from '../../shared/documentContracts';",
      "import { loadJcx } from '../../formats/jcxParse';",
      "import { applyTextPatch } from './apply';",
    ];
    for (const source of allowed) expect(editorImportViolations(fakeEditorFile, source), source).toEqual([]);
  });

  it('反例：全局扫描只认真实标识符使用，不认注释、字符串与属性名；墙钟的各种写法都会被识别', () => {
    const flagged: [string, string][] = [
      ['x.ts', 'setTimeout(() => 0, 1);'],
      ['x.ts', 'const timers = { schedule: setTimeout };'],
      ['x.ts', 'const o = { w: window };'],
      ['x.ts', 'const o = { globalThis };'],
      ['x.ts', 'const env = process.env;'],
      ['x.ts', 'const loc = location.href;'],
      ['x.ts', 'const d = new TextDecoder();'],
      ['x.ts', "const g = Function('return this')();"],
      ['x.ts', "const v = eval('1');"],
      ['x.ts', 'const t = Date.now();'],
      ['x.ts', 'const s = Date();'],
      ['x.ts', 'const D = Date;'],
      ['x.ts', "const t = Date['now']();"],
      ['x.ts', 'const d = new Date();'],
      ['x.ts', 'const d = new (Date)();'],
      ['x.ts', 'const d = new Date(...[]);'],
      ['x.ts', 'class Clock extends Date {}'],
      ['x.ts', 'const p = performance.now();'],
      ['x.tsx', 'export const X = <div />;'],
    ];
    for (const [file, source] of flagged) expect(forbiddenGlobalUses(file, source), source).not.toEqual([]);
    const clean = [
      '// setTimeout window document Date.now()',
      "const s = 'window document process Date';",
      'const v = obj.document;',
      'interface X { readonly document: string; readonly location: number; }',
      'const o = { process: 1, location: 2 };',
      'type T = Date;',
      'const d = new Date(0);',
      'interface Stamp extends Date { readonly tag: string; }',
      'class Fake { setTimeout(): void {} }',
    ];
    for (const source of clean) expect(forbiddenGlobalUses('x.ts', source), source).toEqual([]);
  });
});

describe('M3 T0 架构守卫 —— src/shared 纯数据契约', () => {
  const sharedFiles = collectTsFiles(SHARED_DIR);

  it.each(rows(sharedFiles))('%s 的值依赖只在 shared 内部，类型依赖只来自 shared / façade / domain', (_rel, file) => {
    expect(sharedImportViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('反例：shared 经再导出把 serializer、editor 或 renderer 带进来都会失败', () => {
    expect(sharedImportViolations(fakeSharedFile, "export { serializeJcx } from '../formats/jcx';")).not.toEqual([]);
    expect(sharedImportViolations(fakeSharedFile, "export { loadJcx } from '../formats/jcxParse';")).not.toEqual([]);
    expect(sharedImportViolations(fakeSharedFile, "import { createDocumentSession } from '../editor/session/create';")).not.toEqual([]);
    expect(sharedImportViolations(fakeSharedFile, "import { contextBridge } from 'electron';")).not.toEqual([]);
    expect(sharedImportViolations(fakeSharedFile, "import type { JcxEncoding } from '../formats/jcxParse';")).toEqual([]);
  });
});

describe('M3 T0 架构守卫 —— renderer-safe parse façade', () => {
  const facadeSource = readFileSync(FACADE, 'utf8');

  it('位于 src/formats/jcx/ 目录之外', () => {
    expect(posixPath(FACADE)).toBe(FACADE_PATH);
    expect(FACADE_PATH.startsWith('src/formats/jcx/')).toBe(false);
  });

  it('只导出 loadJcx 与 LoadResult / JcxDiagnostic / JcxEncoding（没有 export * / export type *）', () => {
    expect(exportedNames(FACADE, facadeSource)).toEqual({ values: ['loadJcx'], types: ['JcxDiagnostic', 'JcxEncoding', 'LoadResult'] });
    expect(exportedNames('x.ts', "export type * from './jcx/parse';")).toEqual({ values: [], types: ['*'] });
    expect(exportedNames('x.ts', "export * as parse from './jcx/parse';")).toEqual({ values: ['*'], types: [] });
    expect(exportedNames('x.ts', 'export default loadJcxImpl;')).toEqual({ values: ['default'], types: [] });
    expect(exportedNames('x.ts', 'export const { a } = obj;')).toEqual({ values: ['<destructured-export>'], types: [] });
  });

  it('不经 formats/jcx/index.ts 导入或再导出任何东西；值导入只来自 loadJcx.ts', () => {
    const records = parseImports(FACADE, facadeSource);
    const targets = records.map((record) => ({ ...record, path: posixPath(resolveSpecifier(FACADE, record.specifier) ?? '') }));
    expect(targets.filter((record) => record.path === 'src/formats/jcx/index.ts')).toEqual([]);
    expect(targets.filter((record) => !record.typeOnly).map((record) => record.path)).toEqual(['src/formats/jcx/loadJcx.ts']);
  });

  it('静态值依赖闭包不含 serializer / encodeJcx / 裸说明符（iconv-lite、node:）/ 动态 import', () => {
    const closure = valueClosure(FACADE);
    expect(closure.files).toContain('src/formats/jcx/loadJcx.ts');
    expect(closure.files.length).toBeGreaterThan(10);
    expect(closure.files.filter((file) => file.includes('/serialize/') || file.endsWith('encodeJcx.ts'))).toEqual([]);
    expect(closure.bare).toEqual([]);
    expect(closure.dynamic).toEqual([]);
    expect(closure.unresolved).toEqual([]);
  });

  it('反例：总入口 formats/jcx/index.ts 的闭包会被识别出 serializer 与 iconv-lite', () => {
    const closure = valueClosure(join(REPO_ROOT, 'src/formats/jcx/index.ts'));
    expect(closure.files.some((file) => file.includes('/serialize/'))).toBe(true);
    expect(closure.bare).toContain('iconv-lite');
  });
});

describe('M3 T0 架构守卫 —— renderer 对格式层的导入', () => {
  const rendererFiles = collectTsFiles(RENDERER_DIR);

  it('扫到了 renderer 文件', () => {
    expect(rendererFiles.length).toBeGreaterThan(10);
  });

  it.each(rows(rendererFiles))('%s：façade 只按白名单导入；直接导入 formats/jcx 只放行遗留的 store.ts', (_rel, file) => {
    expect(rendererFormatViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('反例：新增直接导入、遗留文件新增名字、façade 白名单外名字、非字面量动态 import 都会失败', () => {
    const store = join(REPO_ROOT, GRANDFATHERED.file);
    expect(rendererFormatViolations(fakeRendererFile, "import { loadJcx } from '../../formats/jcx';")).not.toEqual([]);
    expect(rendererFormatViolations(store, "import { serializeJcx } from '../../formats/jcx';")).not.toEqual([]);
    expect(rendererFormatViolations(store, "import type { JcxDiagnostic } from '../../formats/jcx/lexer/diagnostics';")).not.toEqual([]);
    expect(rendererFormatViolations(fakeRendererFile, 'const m = import(`../../formats/${name}`);')).not.toEqual([]);
    expect(rendererFormatViolations(fakeRendererFile, "import { loadJcx, LoadResult } from '../../formats/jcxParse';")).toEqual([]);
    expect(rendererFormatViolations(fakeRendererFile, "import * as parse from '../../formats/jcxParse';")).toEqual(['facade-name:*']);
    expect(rendererFormatViolations(store, "import { loadJcx } from '../../formats/jcx';")).toEqual([]);
  });
});
