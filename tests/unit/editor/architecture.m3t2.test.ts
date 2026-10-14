/**
 * M3 T2 架构守卫（Preflight r3 §8；用户裁决 Q1、R3-H1）。
 *
 * - 目录：T0 四个目录与 history 都存在且非空；**不设目录白名单**，未来 T4 / T6 / T7 / T8 的合法目录（save、locator、
 *   reconciliation、commands 等）加入时本文件与 m3t0 都不需要修改；只对确定的错误拼写做单独的精确断言。
 * - history 进入 T0 的全局扫描：与 m3t0 相同的 `collectTsFiles(src/editor)` 结果包含 history 文件，并对其运行已导出的
 *   禁用全局与受限类型环境检查。
 * - history 专属规则：直接导入只来自按文件精确列出的 T0 模块（text/types、text/transform、selection/types、session/reducer，
 *   以及只做类型导入的 session/types、session/invariants），不导入 text/apply、session/create、projection、formats、shared、
 *   外部包；不用 `Math.random`；存储结构不出现快照 id；`basisVersion` 只在一处构造、一处读取；不构造会话对象；
 *   `src/` 中只有 history 调用 `applySourceTransaction`（所有成功的 source 变化都经 T0 reducer）。
 *
 * 每条规则都配合成源码反例，保证规则会真的失败。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { forEachChild, isIdentifier, isPropertyAccessExpression, isPropertyAssignment, isShorthandPropertyAssignment } from 'typescript';
import type { Node } from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, collectTsFiles, forbiddenGlobalUses, parse, parseImports, platformFreeDiagnostics, posixPath, resolveSpecifier } from './staticAnalysis';

const EDITOR_DIR = join(REPO_ROOT, 'src/editor');
const HISTORY_DIR = join(EDITOR_DIR, 'history');
const REQUIRED_DIRS = ['history', 'projection', 'selection', 'session', 'text'];
/** 确定的错误拼写（不是未来可能合法的目录名）。 */
const MISSPELLINGS: ReadonlySet<string> = new Set(['histroy', 'hisotry', 'histories', 'History']);
/**
 * history 的直接依赖按文件精确列出：value = 允许值导入；type = 只允许子句级 `import type`。
 * 只经 T0 reducer 获得新会话：不导入 session/create（不自建会话）、text/apply（不另建补丁引擎）、projection。
 */
const HISTORY_DEPS: ReadonlyMap<string, 'value' | 'type'> = new Map([
  ['src/editor/text/types.ts', 'type'],
  ['src/editor/text/transform.ts', 'value'],
  ['src/editor/selection/types.ts', 'value'],
  ['src/editor/session/reducer.ts', 'value'],
  ['src/editor/session/types.ts', 'type'],
  ['src/editor/session/invariants.ts', 'type'],
]);
const SNAPSHOT_IDS: ReadonlySet<string> = new Set(['EventId', 'eventId', 'RelationId', 'relationId', 'AstPath', 'astPath', 'anchorKey', 'NoteRef']);

const editorDirs = (): string[] => readdirSync(EDITOR_DIR).filter((name) => statSync(join(EDITOR_DIR, name)).isDirectory());
const historyFiles = collectTsFiles(HISTORY_DIR);
const read = (file: string): string => readFileSync(file, 'utf8');

function misspelledDirs(dirs: readonly string[]): string[] {
  return dirs.filter((dir) => MISSPELLINGS.has(dir));
}

function historyImportViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    if (record.kind === 'dynamic' || record.kind === 'require') return [`${record.kind}:${record.specifier}`];
    const target = resolveSpecifier(file, record.specifier);
    if (target === null || target === undefined) return [`bare-or-unresolved:${record.specifier}`];
    const path = posixPath(target);
    if (path === 'src/editor/text/apply.ts') return [`second-patch-engine:${path}`];
    if (path.startsWith('src/editor/history/')) return [];
    const allowed = HISTORY_DEPS.get(path);
    if (allowed === undefined) return [`forbidden-target:${path}`];
    return allowed === 'type' && !record.typeOnly ? [`value-import-of-type-only:${path}`] : [];
  });
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => {
    walk(child, visit);
  });
}

interface IdentifierFacts {
  readonly snapshotIds: string[];
  readonly basisVersionKeys: number;
  readonly basisVersionReads: number;
  readonly sessionKeys: string[];
  readonly applyCalls: number;
  readonly mathRandom: number;
}

/** 基于 AST 的标识符事实（注释与字符串不计入）。 */
function identifierFacts(file: string, source: string): IdentifierFacts {
  const snapshotIds: string[] = [];
  const sessionKeys: string[] = [];
  const facts = { snapshotIds, basisVersionKeys: 0, basisVersionReads: 0, sessionKeys, applyCalls: 0, mathRandom: 0 };
  walk(parse(file, source), (node) => {
    if (isIdentifier(node) && SNAPSHOT_IDS.has(node.text)) facts.snapshotIds.push(node.text);
    if (isIdentifier(node) && node.text === 'applySourceTransaction') facts.applyCalls += 1;
    if ((isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) && isIdentifier(node.name)) {
      if (node.name.text === 'basisVersion') facts.basisVersionKeys += 1;
      if (node.name.text === 'source' || node.name.text === 'sourceVersion') facts.sessionKeys.push(node.name.text);
    }
    if (isPropertyAccessExpression(node) && node.name.text === 'basisVersion') facts.basisVersionReads += 1;
    if (isPropertyAccessExpression(node) && node.name.text === 'random' && isIdentifier(node.expression) && node.expression.text === 'Math') facts.mathRandom += 1;
  });
  return facts;
}

const fake = join(HISTORY_DIR, '__fake__.ts');

describe('M3 T2 架构守卫 —— 目录与全局扫描（R3-H1）', () => {
  it('T0 四个目录与 history 都存在且非空（只断言存在，不设白名单）', () => {
    const dirs = editorDirs();
    for (const dir of REQUIRED_DIRS) {
      expect(dirs, dir).toContain(dir);
      expect(collectTsFiles(join(EDITOR_DIR, dir)).length, dir).toBeGreaterThan(0);
    }
  });

  it('确定的错误拼写不存在；反例：错误拼写被拒，未来合法目录（locator / save / commands）不被拒', () => {
    expect(misspelledDirs(editorDirs())).toEqual([]);
    expect(misspelledDirs(['histroy', 'history'])).toEqual(['histroy']);
    expect(misspelledDirs(['locator', 'save', 'reconciliation', 'commands', 'parse'])).toEqual([]);
  });

  it('history 文件进入 T0 的全局扫描（与 m3t0 相同的 collectTsFiles 结果），并通过已导出的禁用全局与受限类型环境检查', () => {
    const scanned = collectTsFiles(EDITOR_DIR).map(posixPath);
    expect(historyFiles.length).toBeGreaterThanOrEqual(5);
    for (const file of historyFiles) expect(scanned).toContain(posixPath(file));
    for (const file of historyFiles) expect(forbiddenGlobalUses(file, read(file)), posixPath(file)).toEqual([]);
    expect(platformFreeDiagnostics(historyFiles)).toEqual([]);
  });

  it('反例：history 位置的文件使用墙钟 / 定时器会被禁用全局检查拒绝', () => {
    expect(forbiddenGlobalUses(fake, 'export const now = (): number => Date.now();')).not.toEqual([]);
    expect(forbiddenGlobalUses(fake, 'export const later = (f: () => void): unknown => setTimeout(f, 1);')).not.toEqual([]);
  });
});

describe('M3 T2 架构守卫 —— history 专属规则', () => {
  it.each(historyFiles.map((file) => [posixPath(file), file]))('%s：直接导入只来自精确列出的 T0 文件与 history 自身（不导入 text/apply、session/create、projection）', (_rel, file) => {
    expect(historyImportViolations(file, read(file))).toEqual([]);
  });

  it('反例：导入规则拒绝 projection、text/apply、formats、shared、外部包、Node 与动态 import', () => {
    const cases: [string, string][] = [
      ["import { buildProjection } from '../projection/build';", 'forbidden-target:src/editor/projection/build.ts'],
      ["import { applyTextPatches } from '../text/apply';", 'second-patch-engine:src/editor/text/apply.ts'],
      ["import { loadJcx } from '../../formats/jcxParse';", 'forbidden-target:src/formats/jcxParse.ts'],
      ["import type { ByteBom } from '../../shared/documentContracts';", 'forbidden-target:src/shared/documentContracts.ts'],
      ["import { create } from 'zustand';", 'bare-or-unresolved:zustand'],
      ["import { readFileSync } from 'node:fs';", 'bare-or-unresolved:node:fs'],
      ["const m = import('../text/types');", 'dynamic:../text/types'],
      ["import { createDocumentSession } from '../session/create';", 'forbidden-target:src/editor/session/create.ts'],
      ["import { checkSourceTransaction } from '../session/invariants';", 'value-import-of-type-only:src/editor/session/invariants.ts'],
      ["import { checkSourcePatchInvariants } from '../text/sourceInvariants';", 'forbidden-target:src/editor/text/sourceInvariants.ts'],
      ["import { isSourceDirty } from '../session/derive';", 'forbidden-target:src/editor/session/derive.ts'],
    ];
    for (const [source, violation] of cases) expect(historyImportViolations(fake, source), source).toContain(violation);
    expect(historyImportViolations(fake, "import type { TextPatch } from '../text/types';")).toEqual([]);
    expect(historyImportViolations(fake, "import type { TransactionViolation } from '../session/invariants';")).toEqual([]);
    expect(historyImportViolations(fake, "import { applySourceTransaction } from '../session/reducer';")).toEqual([]);
  });

  it('不使用 Math.random；存储结构不出现快照 id；不构造会话对象（无 source / sourceVersion 键）', () => {
    for (const file of historyFiles) {
      const facts = identifierFacts(file, read(file));
      expect(facts.mathRandom, posixPath(file)).toBe(0);
      expect(facts.snapshotIds, posixPath(file)).toEqual([]);
      expect(facts.sessionKeys, posixPath(file)).toEqual([]);
    }
  });

  it('basisVersion 只在一处作为对象键构造（返回运行时选中）、一处被读取（版本校验）', () => {
    const totals = historyFiles.map((file) => identifierFacts(file, read(file)));
    expect(totals.reduce((sum, facts) => sum + facts.basisVersionKeys, 0)).toBe(1);
    expect(totals.reduce((sum, facts) => sum + facts.basisVersionReads, 0)).toBe(1);
  });

  it('反例：AST 事实能识别 Math.random、快照 id、会话字段、额外的 basisVersion，且忽略注释与字符串', () => {
    const bad = identifierFacts(fake, "const r = Math.random(); const s = { anchorKey: 'k', basisVersion: 1, source: 'x' }; const v = s.basisVersion;");
    expect(bad.mathRandom).toBe(1);
    expect(bad.snapshotIds).toEqual(['anchorKey']);
    expect(bad.basisVersionKeys).toBe(1);
    expect(bad.basisVersionReads).toBe(1);
    expect(bad.sessionKeys).toEqual(['source']);
    const comments = identifierFacts(fake, "// Math.random anchorKey basisVersion source\nconst s = 'EventId basisVersion';");
    expect(comments).toEqual({ snapshotIds: [], basisVersionKeys: 0, basisVersionReads: 0, sessionKeys: [], applyCalls: 0, mathRandom: 0 });
  });

  it('src/ 中只有 history 调用 applySourceTransaction（定义所在的 session/reducer.ts 除外）', () => {
    const callers = collectTsFiles(join(REPO_ROOT, 'src'))
      .filter((file) => identifierFacts(file, read(file)).applyCalls > 0)
      .map(posixPath)
      .filter((path) => path !== 'src/editor/session/reducer.ts');
    expect(callers.length).toBeGreaterThan(0);
    expect(callers.filter((path) => !path.startsWith('src/editor/history/'))).toEqual([]);
  });

  it('反例：调用方检查能识别其它位置的 applySourceTransaction', () => {
    const elsewhere = identifierFacts(join(REPO_ROOT, 'src/renderer/app/__fake__.ts'), "import { applySourceTransaction } from '../../editor/session/reducer';");
    expect(elsewhere.applyCalls).toBeGreaterThan(0);
  });
});
