/**
 * M3 T4 B2 架构守卫（B2 r0.1 勘误 §2.5 / §3.1；GA12 §3；Gate B2 编码授权的追加要求）。
 *
 * - S1：保存逻辑锁 `saveOperation` 只在 `saveCoordinator.ts` 的 acquire / release 与 `openCoordinator.ts` 的
 *   registerOwner / resetOwner / rebuildOwner 中写入（对象字面量键或赋值）；其它任何地方写入都会绕过 CAS 释放。
 * - S2：`nextOperationId` 只在 `createOpenCoordinator`（初值）与 `acquireSaveOperation`（递增）中写入：id 不可复用。
 * - S3：R19 的 `sourceCapabilityId` 不授予任何权限——在 `src/main/open/**` 中它只能作为 `anchorMatchesSource` 的直接实参；
 *   在 `src/main/**` 中它不得出现在任何授权查询（`lookupActive` / `authorizeCapability` / `authorize` / `beginSave` /
 *   `isActiveOpen` / `saveStillCurrent` / `holdsSaveOperation`）的实参里。
 *
 * - S4：保存锁只经 `saveIpc.ts` 的 `release` helper 以 CAS 释放，实参只能是本请求获取的票据（勘误 §2.5）。
 * - S5：写 port 的写类同步方法恰为 rename / link / unlink；提交原语恰为 rename / link，且被 `trackCommits` 完整包装
 *   （勘误 §3.1：B1 新增提交原语时本守卫失败）。
 * - S6：I6——授权查询与授权结果字段的类型不含墓碑（`anchorFacts` 只提供文件事实，不在此列，见 B2 审查处置）。
 * - S7：`saveIpc.ts` 只调用一次 `runSavePipeline`。
 *
 * 每条规则都有反例，证明守卫能识别违规。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  forEachChild,
  isBinaryExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isVariableDeclaration,
  SyntaxKind,
} from 'typescript';
import type { Node } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const MAIN_DIR = join(REPO_ROOT, 'src/main');
const OPEN_DIR = join(REPO_ROOT, 'src/main/open');
const read = (file: string): string => readFileSync(file, 'utf8');

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => walk(child, visit));
}

/** 最近的具名函数（函数声明、方法、或 `const name = (...) =>`）；顶层为 `<module>`。 */
function enclosingFunction(node: Node): string {
  for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if ((isFunctionDeclaration(current) || isMethodDeclaration(current)) && current.name !== undefined) return current.name.getText();
    if (isVariableDeclaration(current) && current.initializer !== undefined && (current.initializer.kind === SyntaxKind.ArrowFunction || current.initializer.kind === SyntaxKind.FunctionExpression)) {
      return current.name.getText();
    }
  }
  return '<module>';
}

/** 写入名为 `field` 的属性的位置：对象字面量键（含简写）与赋值目标 `x.field = …`。 */
function fieldWriters(file: string, source: string, field: string): string[] {
  const found: string[] = [];
  walk(parse(file, source), (node) => {
    const isKey = (isPropertyAssignment(node) || isShorthandPropertyAssignment(node)) && node.name.getText() === field;
    const isAssign =
      isBinaryExpression(node) && node.operatorToken.kind === SyntaxKind.EqualsToken && isPropertyAccessExpression(node.left) && node.left.name.text === field;
    if (isKey || isAssign) found.push(enclosingFunction(node));
  });
  return found;
}

function writersIn(files: readonly string[], field: string, scanner: (file: string, source: string, field: string) => string[] = fieldWriters): string[] {
  return files.flatMap((file) => scanner(file, read(file), field).map((fn) => `${posixPath(file)}#${fn}`)).sort();
}

const AUTH_QUERIES: ReadonlySet<string> = new Set(['lookupActive', 'authorizeCapability', 'authorize', 'beginSave', 'isActiveOpen', 'saveStillCurrent', 'holdsSaveOperation']);

function calleeName(node: Node): string | null {
  if (!isCallExpression(node)) return null;
  const callee = node.expression;
  if (isIdentifier(callee)) return callee.text;
  if (isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** S3：`sourceCapabilityId` 出现在授权查询实参中的位置。 */
function sourceInAuthorization(file: string, source: string): string[] {
  const found: string[] = [];
  walk(parse(file, source), (node) => {
    const name = calleeName(node);
    if (name === null || !AUTH_QUERIES.has(name) || !isCallExpression(node)) return;
    for (const argument of node.arguments) {
      walk(argument, (inner) => {
        if (isIdentifier(inner) && inner.text === 'sourceCapabilityId') found.push(`${name}@${enclosingFunction(node)}`);
      });
    }
  });
  return found;
}

/** S3（open 层）：读取 `sourceCapabilityId` 的表达式不是 `anchorMatchesSource` 的直接实参。 */
function sourceReadsOutsideCheck(file: string, source: string): string[] {
  const found: string[] = [];
  walk(parse(file, source), (node) => {
    if (!isIdentifier(node) || node.text !== 'sourceCapabilityId') return;
    const parent = node.parent;
    let expression: Node;
    if (isPropertyAccessExpression(parent) && parent.name === node) expression = parent;
    else if (parent.kind === SyntaxKind.Parameter || parent.kind === SyntaxKind.PropertySignature) return;
    else if ((isPropertyAssignment(parent) || isShorthandPropertyAssignment(parent)) && parent.name === node && !isShorthandPropertyAssignment(parent)) return;
    else expression = node;
    // 等值核对函数自身的函数体就是核对本身。
    if (enclosingFunction(node) === 'anchorMatchesSource') return;
    const call = expression.parent;
    const ok = isCallExpression(call) && calleeName(call) === 'anchorMatchesSource' && call.arguments.some((argument) => argument === expression);
    if (!ok) found.push(enclosingFunction(node));
  });
  return found;
}

describe('M3 T4 B2 守卫 —— 保存逻辑锁与操作 id（S1 / S2）', () => {
  const files = collectTsFiles(join(REPO_ROOT, 'src'));

  it('S1：saveOperation 只在 acquire / release 与 registerOwner / resetOwner / rebuildOwner 中写入', () => {
    expect(writersIn(files, 'saveOperation')).toEqual([
      'src/main/open/openCoordinator.ts#rebuildOwner',
      'src/main/open/openCoordinator.ts#registerOwner',
      'src/main/open/openCoordinator.ts#resetOwner',
      'src/main/open/saveCoordinator.ts#acquireSaveOperation',
      'src/main/open/saveCoordinator.ts#releaseSaveOperation',
    ]);
  });

  it('S2：nextOperationId 只在 createOpenCoordinator 与 acquireSaveOperation 中写入', () => {
    expect(writersIn(files, 'nextOperationId')).toEqual([
      'src/main/open/openCoordinator.ts#createOpenCoordinator',
      'src/main/open/saveCoordinator.ts#acquireSaveOperation',
    ]);
  });

  it('S1 / S2 反例：对象字面量键、简写键与赋值都被识别', () => {
    const fake = join(OPEN_DIR, '__fake__.ts');
    expect(fieldWriters(fake, 'function steal(meta: M) { return { ...meta, saveOperation: null }; }', 'saveOperation')).toEqual(['steal']);
    expect(fieldWriters(fake, 'const reuse = (s: S) => { const nextOperationId = 1; return { ...s, nextOperationId }; };', 'nextOperationId')).toEqual(['reuse']);
    expect(fieldWriters(fake, 'function poke(m: M) { m.saveOperation = null; }', 'saveOperation')).toEqual(['poke']);
    expect(fieldWriters(fake, 'function read(m: M) { return m.saveOperation === null; }', 'saveOperation')).toEqual([]);
  });
});

describe('M3 T4 B2 守卫 —— R19 不授权（S3）', () => {
  it('src/main/** 中 sourceCapabilityId 不出现在任何授权查询的实参里', () => {
    const files = collectTsFiles(MAIN_DIR);
    expect(files.flatMap((file) => sourceInAuthorization(file, read(file)).map((hit) => `${posixPath(file)}:${hit}`))).toEqual([]);
  });

  it('src/main/open/** 中读取 sourceCapabilityId 的表达式都是 anchorMatchesSource 的直接实参（载荷形状校验除外）', () => {
    // ipcValidation.ts 只做不可信载荷的形状校验（读取字段、构造请求对象），不接触能力表与协调器状态——下一条用例钉住这一点。
    const files = collectTsFiles(OPEN_DIR).filter((file) => posixPath(file) !== 'src/main/open/ipcValidation.ts');
    const reads = files.flatMap((file) => sourceReadsOutsideCheck(file, read(file)).map((fn) => `${posixPath(file)}#${fn}`));
    expect(reads).toEqual([]);
    // 不空跑：saveCoordinator 中确实存在这类读取（阶段 1 开始、授予前复核、阶段 2）。
    const text = read(join(OPEN_DIR, 'saveCoordinator.ts')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(text.match(/anchorMatchesSource\([^)]*sourceCapabilityId\)/g)?.length).toBe(3);
  });

  it('ipcValidation.ts 不导入能力表、协调器与锚点链（S3 例外的前提）', () => {
    const file = join(OPEN_DIR, 'ipcValidation.ts');
    const imports = parseImports(file, read(file)).map((record) => {
      const resolved = resolveSpecifier(file, record.specifier);
      return resolved === null || resolved === undefined ? record.specifier : posixPath(resolved);
    });
    const forbidden = ['src/main/document/capabilities.ts', 'src/main/open/openCoordinator.ts', 'src/main/open/saveCoordinator.ts', 'src/main/open/anchorChain.ts'];
    expect(imports.filter((path) => forbidden.includes(path))).toEqual([]);
    expect(imports.length).toBeGreaterThan(0);
  });

  it('S3 反例：授权查询实参中的 sourceCapabilityId、以及不经等值核对的读取都被识别', () => {
    const fake = join(OPEN_DIR, '__fake__.ts');
    expect(sourceInAuthorization(fake, 'function f(t: T) { return lookupActive(table, 1, t.sourceCapabilityId); }')).toEqual(['lookupActive@f']);
    expect(sourceInAuthorization(fake, 'function g(sourceCapabilityId: string) { return authorize(1, sourceCapabilityId ?? "x"); }')).toEqual(['authorize@g']);
    expect(sourceReadsOutsideCheck(fake, 'function h(t: T) { const token = t.sourceCapabilityId; return token; }')).toEqual(['h']);
    expect(sourceReadsOutsideCheck(fake, 'function k(t: T) { return anchorMatchesSource(c, t.sourceCapabilityId); }')).toEqual([]);
    expect(sourceReadsOutsideCheck(fake, 'function m(sourceCapabilityId: string | null) { return anchorMatchesSource(c, sourceCapabilityId) || sourceCapabilityId === "a"; }')).toEqual(['m']);
  });
});

/** 调用的实参文本（规范空白）。 */
function callArgs(file: string, source: string, callee: string): { fn: string; args: string }[] {
  const found: { fn: string; args: string }[] = [];
  const sf = parse(file, source);
  walk(sf, (node) => {
    if (isCallExpression(node) && calleeName(node) === callee) {
      found.push({ fn: enclosingFunction(node), args: node.arguments.map((arg) => arg.getText(sf).replace(/\s+/g, ' ')).join(', ') });
    }
  });
  return found;
}

const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const SAVE_IPC = join(MAIN_DIR, 'ipc', 'saveIpc.ts');

describe('M3 T4 B2 守卫 —— 释放、提交原语、I6（S4–S7）', () => {
  it('S4：releaseSaveOperation 在 saveIpc 中只出现在 release helper；release 的实参只能是本请求获取的票据', () => {
    expect(callArgs(SAVE_IPC, read(SAVE_IPC), 'releaseSaveOperation')).toEqual([{ fn: 'release', args: 'ctx.getState(), ownerId, operation' }]);
    expect(callArgs(SAVE_IPC, read(SAVE_IPC), 'release').map((call) => `${call.fn}(${call.args})`).sort()).toEqual([
      'requestSaveTarget(ownerId, operation)',
      'saveDocument(ownerId, prepared.operation)',
    ]);
    const text = stripComments(read(SAVE_IPC));
    expect(text).toContain('const { operation, anchor, anchorFacts } = begun.result;');
    expect(text.match(/\boperation = /g) ?? []).toEqual([]);
    const coordinator = join(OPEN_DIR, 'saveCoordinator.ts');
    expect(callArgs(coordinator, read(coordinator), 'releaseSaveOperation')).toEqual([{ fn: 'refuse', args: 'state, ownerId, operation' }]);
  });

  it('S4 反例：其它位置或其它实参的释放都被识别', () => {
    const fake = join(MAIN_DIR, 'ipc', '__fake__.ts');
    expect(callArgs(fake, 'async function f() { release(ownerId, stale); }', 'release')).toEqual([{ fn: 'f', args: 'ownerId, stale' }]);
  });

  it('S5：写类同步方法恰为 rename / link / unlink；提交原语 rename / link 被 trackCommits 完整包装', () => {
    const port = read(join(MAIN_DIR, 'document', 'writeFileSystemPort.ts'));
    const syncMethods = [...stripComments(port).matchAll(/^\s+(\w+Sync)\(/gm)].map((m) => m[1]).sort();
    const reads = new Set(['openReadSync', 'fstatSync', 'readSync', 'closeSync', 'statSync', 'realpathSync']);
    expect(syncMethods.filter((name) => !reads.has(name ?? ''))).toEqual(['linkSync', 'renameSync', 'unlinkSync']);
    const atomic = stripComments(read(join(MAIN_DIR, 'document', 'atomicWrite.ts')));
    expect([...atomic.matchAll(/\bfs\.(renameSync|linkSync)\(/g)].map((m) => m[1]).sort()).toEqual(['linkSync', 'renameSync']);
    const ipc = stripComments(read(SAVE_IPC));
    const wrapper = ipc.slice(ipc.indexOf('export function trackCommits'), ipc.indexOf('const factsOf'));
    expect([...wrapper.matchAll(/^\s{4}(\w+): \(/gm)].map((m) => m[1]).sort()).toEqual(['linkSync', 'renameSync']);
    expect(wrapper).toContain('...fs,');
  });

  it('S6（I6）：授权查询与授权结果字段的类型不含墓碑', () => {
    expect(stripComments(read(join(MAIN_DIR, 'document', 'capabilities.ts')))).toMatch(/export function lookupActive\([^)]*\): ActiveOpenRecord \| null \{/);
    expect(stripComments(read(join(OPEN_DIR, 'openCoordinator.ts')))).toMatch(/export function authorizeCapability\([^)]*\): ActiveOpenRecord \| null \{/);
    const coordinator = stripComments(read(join(OPEN_DIR, 'saveCoordinator.ts')));
    expect(coordinator).toContain('{ readonly ok: true; readonly record: ActiveOpenRecord; readonly operation: SaveOperation }');
    expect(coordinator).toContain('readonly target: SaveTargetRecord;');
  });

  it('S7：saveIpc.ts 只调用一次 runSavePipeline', () => {
    expect(stripComments(read(SAVE_IPC)).match(/runSavePipeline\(/g)?.length).toBe(1);
  });
});
