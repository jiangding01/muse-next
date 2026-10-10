/**
 * M3 T1b-1 架构守卫（新建，不修改 m3t0 与任何历史守卫）。
 *
 * - `src/main/open/**`：不 import electron、任何 Node builtin、外部包、editor / renderer / formats；只允许值依赖
 *   `src/main/open/**` 与 T1a 的 `src/main/document/capabilities.ts`；`src/main/document/**` 与 `src/shared/**` 只能子句级
 *   `import type`；其它任何模块一律禁止。
 * - 协调器与不变量检查是纯状态机：不使用定时器、墙钟（`Date`）、`process`、`performance`、`Math.random` 等平台全局或
 *   非确定性来源；时间只来自注入的 `now`，token 由调用方签发。
 * - `src/shared/activationContracts.ts`：只有类型，没有任何值导出，只 `import type` shared 内的模块。
 * - 旧 Open 通道（`muse:open-score` / `decodeLegacyText` / `OpenedScoreFile` / `openScore`）只允许留在既有的 5 个文件中，
 *   新代码零引用；T1c 切换 UI 时一次性删除（届时由 T1c 守卫要求归零）。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectTsFiles, exportedNames, forbiddenGlobalUses, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const OPEN_DIR = join(REPO_ROOT, 'src/main/open');
const CONTRACTS = join(REPO_ROOT, 'src/shared/activationContracts.ts');
const VALUE_ALLOWED = 'src/main/document/capabilities.ts';
const LEGACY_FILES: ReadonlySet<string> = new Set([
  'src/main/main.ts',
  'src/preload/preload.ts',
  'src/shared/ipc.ts',
  'src/renderer/app/store.ts',
  'src/renderer/components/Toolbar.tsx',
]);
const LEGACY_PATTERN = /muse:open-score|\bdecodeLegacyText\b|\bOpenedScoreFile\b|\bopenScore\b/;

/** `src/main/open/**` 单个文件的依赖违规。 */
function openImportViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null) return [`bare-specifier:${record.specifier}`];
    if (resolved === undefined) return [`unresolved:${record.specifier}`];
    const path = posixPath(resolved);
    if (path.startsWith('src/main/open/')) return [];
    if (path === VALUE_ALLOWED) return [];
    if (record.typeOnly && (path.startsWith('src/main/document/') || path.startsWith('src/shared/'))) return [];
    return [`${record.typeOnly ? 'type' : 'value'}-import:${path}`];
  });
}

/** 新的 shared 契约文件的违规：值导出、值导入、shared 之外的依赖。 */
function contractViolations(file: string, source: string): string[] {
  const values = exportedNames(file, source).values.map((name) => `value-export:${name}`);
  const imports = parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    const path = resolved === null || resolved === undefined ? record.specifier : posixPath(resolved);
    if (!record.typeOnly) return [`value-import:${path}`];
    return path.startsWith('src/shared/') ? [] : [`outside-shared:${path}`];
  });
  return [...values, ...imports];
}

const openFiles = collectTsFiles(OPEN_DIR);
const rows = (files: readonly string[]): [string, string][] => files.map((file) => [posixPath(file), file]);

describe('M3 T1b 架构守卫 —— src/main/open 纯协议层', () => {
  it('扫到了协调器、不变量与校验三个模块', () => {
    expect(openFiles.map(posixPath)).toEqual([
      'src/main/open/coordinatorInvariants.ts',
      'src/main/open/ipcValidation.ts',
      'src/main/open/openCoordinator.ts',
    ]);
  });

  it.each(rows(openFiles))('%s 只依赖 open / T1a capabilities（值）与 main/document、shared（仅类型）', (_rel, file) => {
    expect(openImportViolations(file, readFileSync(file, 'utf8'))).toEqual([]);
  });

  it.each(rows(openFiles))('%s 不使用定时器、墙钟、随机数或 Node / DOM 全局', (_rel, file) => {
    const source = readFileSync(file, 'utf8');
    expect(forbiddenGlobalUses(file, source)).toEqual([]);
    expect(/\bMath\.random\b/.test(source)).toBe(false);
  });

  it('反例：依赖规则能识别 electron、Node builtin、值导入 openDocument、editor / renderer / formats', () => {
    const fake = join(OPEN_DIR, '__fake__.ts');
    const cases: readonly (readonly [string, string])[] = [
      ["import { ipcMain } from 'electron';", 'bare-specifier:electron'],
      ["import { readFile } from 'node:fs/promises';", 'bare-specifier:node:fs/promises'],
      ["import { openDocumentAtPath } from '../document/openDocument';", 'value-import:src/main/document/openDocument.ts'],
      ["import { createDocumentSession } from '../../editor/session/create';", 'value-import:src/editor/session/create.ts'],
      ["import type { DocumentSession } from '../../editor/session/types';", 'type-import:src/editor/session/types.ts'],
      ["import { useMuseAppStore } from '../../renderer/app/store';", 'value-import:src/renderer/app/store.ts'],
      ["import { decodeJcx } from '../../formats/jcx/codec';", 'value-import:src/formats/jcx/codec.ts'],
      ["import { IPC } from '../../shared/ipc';", 'value-import:src/shared/ipc.ts'],
    ];
    for (const [source, expected] of cases) expect(openImportViolations(fake, source)).toContain(expected);
    expect(openImportViolations(fake, "import type { OpenAtPathResult } from '../document/openDocument';")).toEqual([]);
    expect(forbiddenGlobalUses(fake, 'const t = setTimeout(() => 0, 1); const n = Date.now();')).toHaveLength(2);
  });
});

describe('M3 T1b 架构守卫 —— activationContracts 只有类型', () => {
  it('没有值导出、值导入与 shared 之外的依赖', () => {
    expect(contractViolations(CONTRACTS, readFileSync(CONTRACTS, 'utf8'))).toEqual([]);
  });

  it('反例：值导出与值导入会被识别', () => {
    expect(contractViolations(CONTRACTS, 'export const TTL = 1;')).toContain('value-export:TTL');
    expect(contractViolations(CONTRACTS, "import { IPC } from './ipc';")).toContain('value-import:src/shared/ipc.ts');
    expect(contractViolations(CONTRACTS, "import type { LoadResult } from '../formats/jcxParse';")).toContain('outside-shared:src/formats/jcxParse.ts');
  });
});

describe('M3 T1b 架构守卫 —— 旧 Open 通道隔离到 T1c', () => {
  const srcFiles = collectTsFiles(join(REPO_ROOT, 'src'));

  it('旧通道标识符只出现在既有的 5 个文件中', () => {
    const offenders = srcFiles.filter((file) => LEGACY_PATTERN.test(readFileSync(file, 'utf8'))).map(posixPath);
    expect(offenders.filter((path) => !LEGACY_FILES.has(path))).toEqual([]);
  });

  it('反例：识别四种旧标识符', () => {
    for (const text of ["'muse:open-score'", 'decodeLegacyText(bytes)', 'OpenedScoreFile', 'api.openScore()']) {
      expect(LEGACY_PATTERN.test(text)).toBe(true);
    }
    expect(LEGACY_PATTERN.test('openScoreView')).toBe(false);
  });
});
