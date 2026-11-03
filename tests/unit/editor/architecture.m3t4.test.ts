/**
 * M3 T4 架构守卫（B1：保存纯核心、写 port、原子保存）。
 *
 * 补偿 `architecture.m3t3` G1 的受控放宽（Gate A R1、Gate B1 C3）：能否写盘由「谁持有 Node fs 能力」决定，
 * 用 TypeScript AST 与解析后的导入图判定，不用字符串匹配判断是否导入 fs。
 *
 * - W1：`src/main/**` 中导入 fs 模块（含 import type、再导出、require、动态 import）的文件恰为只读 port 与写 port 的 Node 实现；
 * - W2：`src/main/**` 不导入 child_process / worker_threads / cluster / module（createRequire），不使用 `process.binding` /
 *   `process.dlopen` / `process._linkedBinding`，不出现非字面量的动态 import / require；
 * - W3：只读 port 不出现任何写类 API 名与非只读 open flag；
 * - W4：写 port 的 Node 实现在产品源码中只有 main.ts 一个值导入者（B1 不接线；M3 T4 B2 G-10 起由 main.ts 接线）；写 port 接口只被保存模块以 `import type` 使用；
 *   Node 实现只导入 fs 模块与写 port 接口，且不再导出 fs 绑定；
 * - W5：提交前同步临界区的函数是同步函数，无 await / then / Promise，对 port 只调用 `*Sync` 方法；
 * - W6：初始不存在目标的提交不调用 `renameSync`；已存在目标的提交在 `renameSync` 之前做内容核验（SHA-256）；
 * - W7：保存模块不导入能力表、`src/main/open/**`、`src/main/ipc/**`、electron、renderer、editor（B1 / B2 边界）；
 * - W8：检查点纯函数只写 saved / fileOp（Save As 另写文件四项），不写 source / sourceVersion / projection / parsed；
 * - W9：每条规则都有反例自检（Gate B1 增补合同 B：BY-1…BY-17），防止守卫空跑。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isAwaitExpression,
  isCallExpression,
  isFunctionDeclaration,
  isIdentifier,
  isNewExpression,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
  isStringLiteral,
  forEachChild,
  SyntaxKind,
} from 'typescript';
import type { FunctionDeclaration, Node, SourceFile } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, exportedNames, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const MAIN = join(REPO_ROOT, 'src/main');
const DOCUMENT = join(MAIN, 'document');
const READ_PORT = 'src/main/document/fileSystemPort.ts';
const WRITE_IMPL = 'src/main/document/nodeWriteFileSystem.ts';
const WRITE_PORT = 'src/main/document/writeFileSystemPort.ts';
const SAVE_MODULES = ['atomicWrite.ts', 'savePipeline.ts', 'saveTargetResolve.ts', 'saveEncoding.ts', 'saveErrors.ts'];

const FS_MODULES: ReadonlySet<string> = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises', 'original-fs']);
const PROCESS_MODULES: ReadonlySet<string> = new Set([
  'child_process', 'node:child_process', 'worker_threads', 'node:worker_threads', 'cluster', 'node:cluster', 'module', 'node:module',
  'process', 'node:process', 'vm', 'node:vm',
]);
const PROCESS_ESCAPES: ReadonlySet<string> = new Set(['binding', 'dlopen', '_linkedBinding', 'getBuiltinModule', 'mainModule']);

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => {
    walk(child, visit);
  });
}

/** 一个 main 源文件中所有「取得 fs / 进程能力」的途径（AST 判定）。 */
function capabilitySources(fileName: string, source: string): string[] {
  const found: string[] = [];
  for (const record of parseImports(fileName, source)) {
    if (FS_MODULES.has(record.specifier)) found.push(`fs:${record.kind}:${record.specifier}`);
    if (PROCESS_MODULES.has(record.specifier)) found.push(`process:${record.specifier}`);
    if (record.specifier === '<non-literal>') found.push(`non-literal:${record.kind}`);
  }
  walk(parse(fileName, source), (node) => {
    if (isPropertyAccessExpression(node) && isIdentifier(node.expression) && node.expression.text === 'process' && PROCESS_ESCAPES.has(node.name.text)) {
      found.push(`process.${node.name.text}`);
    }
    // 取得模块加载器或动态求值的其它途径：globalThis.require、eval、Function 构造。
    if (isPropertyAccessExpression(node) && node.name.text === 'require') found.push('member.require');
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'eval') found.push('eval');
    if ((isCallExpression(node) || isNewExpression(node)) && isIdentifier(node.expression) && node.expression.text === 'Function') found.push('Function');
  });
  return found;
}

const WRITE_NAMES: ReadonlySet<string> = new Set([
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'rename', 'renameSync', 'unlink', 'unlinkSync',
  'rm', 'rmSync', 'rmdir', 'rmdirSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync',
  'truncate', 'truncateSync', 'ftruncate', 'ftruncateSync', 'symlink', 'symlinkSync', 'link', 'linkSync', 'chmod', 'chmodSync',
  'fchmod', 'fchmodSync', 'lchmod', 'chown', 'fchown', 'lchown', 'utimes', 'utimesSync', 'futimes', 'lutimes', 'write', 'writeSync',
  'writev', 'writevSync', 'fsync', 'fsyncSync', 'fdatasync', 'fdatasyncSync', 'sync', 'O_WRONLY', 'O_RDWR', 'O_CREAT', 'O_TRUNC', 'O_APPEND',
]);
const OPEN_FLAG = /^(?:rs\+?|sr\+?|r\+|w\+?|wx\+?|xw\+?|a\+?|ax\+?|xa\+?|as\+?|sa\+?)$/;

/** 只读 port 中的写能力痕迹：写类标识符（含属性名）与除 'r' 之外的 open flag 字面量。 */
function writeTraces(fileName: string, source: string): string[] {
  const found: string[] = [];
  walk(parse(fileName, source), (node) => {
    if (isIdentifier(node) && WRITE_NAMES.has(node.text)) found.push(`name:${node.text}`);
    if (isStringLiteral(node) && OPEN_FLAG.test(node.text)) found.push(`flag:${node.text}`);
  });
  return found;
}

function functionNamed(fileName: string, source: string, name: string): FunctionDeclaration | undefined {
  return parse(fileName, source).statements.find((statement): statement is FunctionDeclaration => isFunctionDeclaration(statement) && statement.name?.text === name);
}

/** 函数中类型标注为 `WriteFileSystem` 的参数名（不依赖参数叫什么）。 */
function portParameters(fn: FunctionDeclaration, source: SourceFile): Set<string> {
  return new Set(fn.parameters.filter((parameter) => parameter.type?.getText(source) === 'WriteFileSystem').map((parameter) => parameter.name.getText(source)));
}

/** 同步临界区函数的违规：async、await、then、Promise、对写 port 参数调用非 *Sync 方法。 */
function syncSectionViolations(fn: FunctionDeclaration, source: SourceFile): string[] {
  const found: string[] = [];
  const ports = portParameters(fn, source);
  if (fn.modifiers?.some((modifier) => modifier.kind === SyntaxKind.AsyncKeyword) === true) found.push('async');
  walk(fn, (node) => {
    if (isAwaitExpression(node)) found.push('await');
    if (isPropertyAccessExpression(node) && node.name.text === 'then') found.push('then');
    if (isIdentifier(node) && node.text === 'Promise') found.push('Promise');
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.expression) && ports.has(node.expression.expression.text)) {
      if (!node.expression.name.text.endsWith('Sync')) found.push(`port.${node.expression.name.text}`);
    }
  });
  return found;
}

/** 从根函数出发，求同一文件内被（直接或间接）调用的函数声明闭包。 */
function callClosure(file: SourceFile, roots: readonly string[]): FunctionDeclaration[] {
  const declared = new Map<string, FunctionDeclaration>();
  for (const statement of file.statements) {
    if (isFunctionDeclaration(statement) && statement.name !== undefined) declared.set(statement.name.text, statement);
  }
  const seen = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift() ?? '';
    const fn = declared.get(name);
    if (fn === undefined || seen.has(name)) continue;
    seen.add(name);
    walk(fn, (node) => {
      if (isCallExpression(node) && isIdentifier(node.expression) && declared.has(node.expression.text)) queue.push(node.expression.text);
    });
  }
  return [...seen].flatMap((name) => {
    const fn = declared.get(name);
    return fn === undefined ? [] : [fn];
  });
}

const identifiersIn = (node: Node): string[] => {
  const names: string[] = [];
  walk(node, (child) => {
    if (isIdentifier(child)) names.push(child.text);
  });
  return names;
};

/** 解析后的 src 内导入目标（值 / 类型分开）。 */
function srcImports(file: string, source: string = read(file)): { readonly path: string; readonly typeOnly: boolean }[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    return typeof resolved === 'string' ? [{ path: posixPath(resolved), typeOnly: record.typeOnly }] : [];
  });
}

const mainFiles = collectTsFiles(MAIN);
const srcFiles = collectTsFiles(join(REPO_ROOT, 'src'));

describe('M3 T4 守卫 —— Node fs 能力来源（W1 / W2）', () => {
  it('W1：导入 fs 模块的 main 文件恰为只读 port 与写 port 的 Node 实现', () => {
    const holders = mainFiles.filter((file) => capabilitySources(file, read(file)).some((item) => item.startsWith('fs:'))).map(posixPath);
    expect(holders).toEqual([READ_PORT, WRITE_IMPL]);
  });

  it('W2：main 中没有进程级逃逸（子进程、worker、createRequire、process.binding）与非字面量动态导入', () => {
    const offenders = mainFiles.flatMap((file) => capabilitySources(file, read(file)).filter((item) => !item.startsWith('fs:')).map((item) => `${posixPath(file)}:${item}`));
    expect(offenders).toEqual([]);
  });

  it('W9（BY-1…BY-15）：各种取得 fs / 进程能力的写法都被识别', () => {
    const fake = join(DOCUMENT, '__fake__.ts');
    const flagged = [
      "import { rename } from 'node:fs/promises';",
      "import { rename as r } from 'fs/promises';",
      "import * as fsp from 'node:fs/promises';",
      "import fs from 'fs';",
      "import { promises as p } from 'node:fs';",
      "import fs = require('fs');",
      "const fs = require('node:fs');",
      "const m = await import('fs');",
      'const m = await import(`node:${"fs"}`);',
      "export { rename } from 'node:fs/promises';",
      "export * from 'fs';",
      "import { createRequire } from 'node:module'; createRequire(import.meta.url)('fs');",
      "import { rename } from 'original-fs';",
      "import { exec } from 'node:child_process';",
      "import { Worker } from 'worker_threads';",
      "import p from 'node:process';",
      "import { runInThisContext } from 'node:vm';",
      "const b = process.binding('fs');",
      'process.dlopen(m, p);',
      "const fs = process.getBuiltinModule('node:fs');",
      'const r = process.mainModule.require;',
      "const r = globalThis.require('fs');",
      "eval('require')('fs');",
      "const f = new Function('return require')();",
      "import type { FileHandle } from 'node:fs/promises';",
    ];
    for (const source of flagged) expect(capabilitySources(fake, source), source).not.toEqual([]);
    const clean = ["// import { rename } from 'fs';", "const text = 'node:fs';", 'await port.rename(a, b);', "import { join } from 'node:path';"];
    for (const source of clean) expect(capabilitySources(fake, source), source).toEqual([]);
  });
});

describe('M3 T4 守卫 —— 只读 port 与写 port 的边界（W3 / W4）', () => {
  it('W3：只读 port 没有写类 API 名，也没有除只读外的 open flag', () => {
    expect(writeTraces(READ_PORT, read(join(REPO_ROOT, READ_PORT)))).toEqual([]);
    expect(writeTraces('x.ts', "await open(path, 'w');").length).toBeGreaterThan(0);
    expect(writeTraces('x.ts', 'fsync(fd);')).toEqual(['name:fsync']);
    expect(writeTraces('x.ts', "const flags = constants.O_WRONLY;")).toEqual(['name:O_WRONLY']);
  });

  it('W4：写 port 的 Node 实现在产品源码中只有 main.ts 一个值导入者（M3 T4 B2 G-10：B2 接线）', () => {
    const importers = srcFiles.filter((file) => srcImports(file).some((item) => item.path === WRITE_IMPL && !item.typeOnly)).map(posixPath);
    expect(importers).toEqual(['src/main/main.ts']);
  });

  it('W9（BY-16）：白名单之外的模块值导入 Node 写实现会被识别；import type 不算值导入', () => {
    const fake = join(MAIN, 'ipc', '__fake__.ts');
    const valueImport = srcImports(fake, "import { createNodeWriteFileSystem } from '../document/nodeWriteFileSystem';");
    expect(valueImport).toEqual([{ path: WRITE_IMPL, typeOnly: false }]);
    const typeImport = srcImports(fake, "import type { WriteFileSystem } from '../document/writeFileSystemPort';");
    expect(typeImport).toEqual([{ path: WRITE_PORT, typeOnly: true }]);
  });

  it('W4：写 port 接口只被保存模块以 import type 使用；接口文件没有值导出', () => {
    const users = srcFiles.flatMap((file) => srcImports(file).filter((item) => item.path === WRITE_PORT).map((item) => ({ file: posixPath(file), typeOnly: item.typeOnly })));
    expect(users.every((user) => user.typeOnly)).toBe(true);
    expect([...new Set(users.map((user) => user.file))].sort()).toEqual(
      // M3 T4 B2（G-11）：保存 IPC 执行体以 import type 使用写 port。
      [
        'src/main/document/atomicWrite.ts',
        'src/main/document/nodeWriteFileSystem.ts',
        'src/main/document/savePipeline.ts',
        'src/main/document/saveTargetResolve.ts',
        'src/main/ipc/saveIpc.ts',
      ].sort(),
    );
    expect(exportedNames(WRITE_PORT, read(join(REPO_ROOT, WRITE_PORT))).values).toEqual([]);
  });

  it('W4（BY-17）：Node 实现只导入 fs 模块与写 port 接口，且不再导出任何 fs 绑定', () => {
    const records = parseImports(WRITE_IMPL, read(join(REPO_ROOT, WRITE_IMPL)));
    expect(records.filter((record) => record.kind === 'export')).toEqual([]);
    expect(parseImports(WRITE_IMPL, "export { rename } from 'node:fs/promises';").filter((record) => record.kind === 'export')).not.toEqual([]);
    expect([...new Set(records.map((record) => record.specifier))].sort()).toEqual(['./writeFileSystemPort', 'node:fs', 'node:fs/promises']);
  });
});

describe('M3 T4 守卫 —— 提交前同步临界区（W5 / W6）', () => {
  const ATOMIC = 'src/main/document/atomicWrite.ts';
  const source = read(join(REPO_ROOT, ATOMIC));
  const file = parse(ATOMIC, source);
  const section = callClosure(file, ['commitExistingSync', 'commitAbsentSync']);

  it('W5：临界区闭包（从两个提交函数出发求同文件调用闭包）包含全部核验辅助函数', () => {
    expect(section.map((fn) => fn.name?.text).sort()).toEqual(
      expect.arrayContaining(['closeSyncQuietly', 'commitAbsentSync', 'commitExistingSync', 'pathStillDescribesHandle', 'verifyContentSync', 'verifyIdentitySync']),
    );
  });

  it('W5：闭包中每个函数都是同步的：无 async / await / then / Promise，对写 port 参数只调用 *Sync 方法', () => {
    const offenders = section.flatMap((fn) => syncSectionViolations(fn, file).map((item) => `${fn.name?.text ?? '?'}:${item}`));
    expect(offenders).toEqual([]);
    // 根函数必须有类型为 WriteFileSystem 的参数，否则「只调用 *Sync」的检查会空跑。
    for (const fn of section.filter((item) => item.name?.text.startsWith('commit') === true)) expect(portParameters(fn, file).size).toBe(1);
  });

  it('W5 反例：async、await、then、Promise 与非 Sync 的 port 调用都被识别（参数改名也不失效）', () => {
    const fake = parse('x.ts', 'async function f(port: WriteFileSystem) { await port.rename(a, b); p.then(g); new Promise(h); }');
    const fn = fake.statements.find((statement): statement is FunctionDeclaration => isFunctionDeclaration(statement));
    expect(fn === undefined ? [] : syncSectionViolations(fn, fake)).toEqual(['async', 'await', 'port.rename', 'then', 'Promise']);
    const nested = parse('x.ts', 'function a() { b(); } function b() { c(); } function c() {} function unrelated() {}');
    expect(callClosure(nested, ['a']).map((fn) => fn.name?.text)).toEqual(['a', 'b', 'c']);
  });

  it('W6：commitAbsentSync 不调用 renameSync；commitExistingSync 先核验后 rename，内容核验调用 sha256Hex', () => {
    const absent = functionNamed(ATOMIC, source, 'commitAbsentSync');
    const existing = functionNamed(ATOMIC, source, 'commitExistingSync');
    const content = functionNamed(ATOMIC, source, 'verifyContentSync');
    if (absent === undefined || existing === undefined || content === undefined) throw new Error('临界区函数缺失');
    expect(identifiersIn(absent)).not.toContain('renameSync');
    expect(identifiersIn(absent)).toContain('linkSync');
    const names = identifiersIn(existing);
    expect(names.indexOf('verifyContentSync')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('verifyContentSync')).toBeLessThan(names.indexOf('renameSync'));
    expect(names.indexOf('verifyIdentitySync')).toBeLessThan(names.indexOf('renameSync'));
    expect(identifiersIn(content)).toContain('sha256Hex');
  });
});

describe('M3 T4 守卫 —— B1 / B2 边界与检查点（W7 / W8）', () => {
  it.each(SAVE_MODULES)('W7：%s 不导入能力表、open / ipc 协议层、electron、renderer、editor', (name) => {
    const file = join(DOCUMENT, name);
    const records = parseImports(file, read(file));
    expect(records.filter((record) => record.specifier === 'electron')).toEqual([]);
    const forbidden = srcImports(file).filter((item) =>
      /^src\/(main\/(open|ipc)\/|renderer\/|editor\/)/.test(item.path) || item.path === 'src/main/document/capabilities.ts',
    );
    expect(forbidden).toEqual([]);
  });

  it('W8：检查点纯函数构造的新会话只写 saved / fileOp / file / writeEncoding / byteBom / encodingRoundTrip', () => {
    const FILE_OPS = 'src/editor/session/fileOps.ts';
    const allowed = new Set(['saved', 'fileOp', 'file', 'writeEncoding', 'byteBom', 'encodingRoundTrip']);
    const written: string[] = [];
    walk(parse(FILE_OPS, read(join(REPO_ROOT, FILE_OPS))), (node) => {
      if (!isObjectLiteralExpression(node)) return;
      const spreadsSession = node.properties.some((property) => isSpreadAssignment(property) && isIdentifier(property.expression) && property.expression.text === 'session');
      if (!spreadsSession) return;
      for (const property of node.properties) {
        if ((isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) && isIdentifier(property.name)) written.push(property.name.text);
      }
    });
    expect(written.length).toBeGreaterThan(0);
    expect(written.filter((name) => !allowed.has(name))).toEqual([]);
  });
});
