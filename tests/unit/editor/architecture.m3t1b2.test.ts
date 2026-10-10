/**
 * M3 T1b-2a / T1b-2a′ 架构守卫（新建，不修改 m3t0 / m3t1b 与任何历史守卫）。
 *
 * - `src/main/ipc/**`：不 import electron（Electron 能力全部由 main 注入），不 import editor / renderer / formats；
 *   不读取 `getURL`、不使用 `loadFile`（页面身份只来自 main 配置）；Open 路径不调用 `.destroy(`（T5 强制关闭合同未重裁，
 *   这里只约束 Open 路径，不是全仓规则）；物理对话框所有权只在选择器 settle 后释放（AST）。
 * - preload：只经白名单通道 `invoke`，每个通道恰好一处；不使用 send / on / sendSync / postMessage；`activate-document`
 *   只出现在 `activateDocument` 方法里（不主动确认）；只暴露 `museDesktop`。
 * - `MuseDesktopApi`：方法集合固定；没有任何字符串参数（页面不能提交路径）。
 * - main.ts：webPreferences 保持 `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`；用 `loadURL(pageEntry.loadUrl)`
 *   加载、不用 `loadFile`；新对话框经共享选择器绑定父窗口；`getURL` 只用于诊断比对；窗口事件只经共享的
 *   `wireOpenIpcWindow` 接线（main 不自己登记这些事件，smoke 复用同一份）。
 * - 全仓（src / scripts / CI / package.json）不出现关闭 sandbox 的开关。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  forEachChild,
  isArrayLiteralExpression,
  isFunctionDeclaration,
  isSpreadElement,
  isVariableDeclaration,
  isPropertyAccessExpression,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isExpressionStatement,
  isTryStatement,
  isCallExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodSignature,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isVariableStatement,
  SyntaxKind,
} from 'typescript';
import type { Node, SourceFile } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const IPC_DIR = join(REPO_ROOT, 'src/main/ipc');
const PRELOAD = join(REPO_ROOT, 'src/preload/preload.ts');
const SHARED_IPC = join(REPO_ROOT, 'src/shared/ipc.ts');
const MAIN = join(REPO_ROOT, 'src/main/main.ts');
const read = (file: string): string => readFileSync(file, 'utf8');

function ipcImportViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null) return record.specifier === 'node:path' || record.specifier === 'node:url' ? [] : [`bare:${record.specifier}`];
    if (resolved === undefined) return [`unresolved:${record.specifier}`];
    const path = posixPath(resolved);
    return /^src\/(main\/(ipc|open|document)|shared)\//.test(path) ? [] : [`import:${path}`];
  });
}

const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

const OWNERSHIP_COLLECTIONS = new Set(['dialogByWindow', 'unsettledDialogs']);
const READ_METHODS = new Set(['has', 'get']);
const WRITE_METHODS = new Set(['set', 'add', 'delete']);

/** 语句所在的函数声明名（没有则为 null）。 */
function enclosingFunctionName(node: Node): string | null {
  for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isFunctionDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

/** try 语句的 try 块里是否 await 了 `deps.chooseOpenPath(...)`。 */
function awaitsChooser(statement: Node | undefined, file: SourceFile): boolean {
  return statement !== undefined && isTryStatement(statement) && /await deps\.chooseOpenPath\(/.test(statement.tryBlock.getText(file));
}

/**
 * 物理对话框所有权（`dialogByWindow` / `unsettledDialogs`）的全部写入点与释放调用。合法形态只有：
 * - `dialogByWindow.set(window, operation);` 紧跟 `unsettledDialogs.add(operation);`，其后紧跟 await 选择器的 try 语句；
 * - 该 try 的 finally 首句是 `releaseNativeDialog(operation);`（全文件唯一一次调用）；
 * - 两个集合的 `.delete(` 各一次，且只在 `releaseNativeDialog` 函数内。
 * 其它任何写入（`.clear(`、其它位置的 set / add / delete、对集合重新赋值、未知方法）都报告；集合标识符的其它引用
 * （别名、下标访问、作为参数传出）也报告——只允许 `.has(` / `.get(` / `.size` 与 `[...集合]` 展开读取。
 */
function nativeDialogOwnershipWrites(file: SourceFile): string[] {
  const findings: string[] = [];
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && isIdentifier(node.expression.expression)) {
      const target = node.expression.expression.text;
      const method = node.expression.name.text;
      if (OWNERSHIP_COLLECTIONS.has(target) && !READ_METHODS.has(method)) {
        const text = node.getText(file);
        const statement = node.parent;
        const block = statement.parent;
        const index = isExpressionStatement(statement) && isBlock(block) ? block.statements.indexOf(statement) : -1;
        if (text === 'dialogByWindow.set(window, operation)' && index >= 0 && isBlock(block)) {
          const next = block.statements[index + 1];
          const ok = next !== undefined && next.getText(file) === 'unsettledDialogs.add(operation);' && awaitsChooser(block.statements[index + 2], file);
          findings.push(ok ? 'set before try' : `unexpected write: ${text}`);
        } else if (text === 'unsettledDialogs.add(operation)' && index >= 1 && isBlock(block)) {
          const ok = block.statements[index - 1]?.getText(file) === 'dialogByWindow.set(window, operation);' && awaitsChooser(block.statements[index + 1], file);
          findings.push(ok ? 'add before try' : `unexpected write: ${text}`);
        } else if (method === 'delete' && enclosingFunctionName(node) === 'releaseNativeDialog') {
          findings.push(`${target}.delete in releaseNativeDialog`);
        } else {
          findings.push(`unexpected write: ${text}`);
        }
      }
    }
    if (isIdentifier(node) && OWNERSHIP_COLLECTIONS.has(node.text)) {
      const parent = node.parent;
      const declared = isVariableDeclaration(parent) && parent.name === node;
      const member = isPropertyAccessExpression(parent) && parent.expression === node ? parent.name.text : null;
      const calledMember = member !== null && isCallExpression(parent.parent) && parent.parent.expression === parent;
      const allowed =
        declared ||
        (member === 'size' && !calledMember) ||
        (member !== null && calledMember && (READ_METHODS.has(member) || WRITE_METHODS.has(member))) ||
        (isSpreadElement(parent) && isArrayLiteralExpression(parent.parent));
      // 非 has / get / set / add / delete 的方法调用由上面的调用检查报告。
      const reportedAsCall = member !== null && calledMember && !READ_METHODS.has(member);
      if (!allowed && !reportedAsCall) findings.push(`unexpected reference: ${parent.getText(file)}`);
    }
    if (isCallExpression(node) && isIdentifier(node.expression) && node.expression.text === 'releaseNativeDialog') {
      const statement = node.parent;
      const block = statement.parent;
      const ok =
        node.getText(file) === 'releaseNativeDialog(operation)' &&
        isExpressionStatement(statement) &&
        isBlock(block) &&
        block.statements[0] === statement &&
        isTryStatement(block.parent) &&
        block.parent.finallyBlock === block &&
        awaitsChooser(block.parent, file);
      findings.push(ok ? 'release first in finally of chooser try' : `unexpected release: ${node.getText(file)}`);
    }
    forEachChild(node, visit);
  };
  visit(file);
  return findings.sort();
}

const OWNERSHIP_EXPECTED = [
  'add before try',
  'dialogByWindow.delete in releaseNativeDialog',
  'release first in finally of chooser try',
  'set before try',
  'unsettledDialogs.delete in releaseNativeDialog',
];

/** 去掉块注释与行注释（守卫检查代码，不检查解释性注释）。 */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M3 T1b-2a 架构守卫 —— src/main/ipc', () => {
  const files = collectTsFiles(IPC_DIR);

  it('扫到接线、窗口事件接线与页面身份三个模块', () => {
    expect(files.map(posixPath)).toEqual(['src/main/ipc/pageIdentity.ts', 'src/main/ipc/registerOpenIpc.ts', 'src/main/ipc/wireOpenIpcWindow.ts']);
  });

  it.each(files.map((f) => [posixPath(f), f]))('%s 不 import electron / editor / renderer / formats', (_rel, file) => {
    expect(ipcImportViolations(file, read(file))).toEqual([]);
  });

  it.each(files.map((f) => [posixPath(f), f]))('%s 不读取 getURL、不使用 loadFile', (_rel, file) => {
    expect(/\bgetURL\b|\bloadFile\b/.test(stripComments(read(file)))).toBe(false);
  });

  it('Open 路径不调用 destroy（T5 强制关闭合同未重裁；不是全仓规则）', () => {
    for (const file of files) expect(/\.destroy\(/.test(stripComments(read(file)))).toBe(false);
  });

  it('AST：物理对话框所有权只在 await 选择器的 try 之前登记、只在其 finally 首句经 releaseNativeDialog 释放', () => {
    const file = join(IPC_DIR, 'registerOpenIpc.ts');
    expect(nativeDialogOwnershipWrites(parse(file, read(file)))).toEqual(OWNERSHIP_EXPECTED);
  });

  it('反例：clear、其它位置的 delete / set、重新赋值、提前释放都会被识别', () => {
    const fake = join(IPC_DIR, '__fake__.ts');
    const check = (source: string): string[] => nativeDialogOwnershipWrites(parse(fake, source));
    expect(check('dialogByWindow.clear();')).toEqual(['unexpected write: dialogByWindow.clear()']);
    expect(check('function disposeWindow() { unsettledDialogs.delete(op); }')).toEqual(['unexpected write: unsettledDialogs.delete(op)']);
    expect(check('dialogByWindow = new Map();')).toEqual(['unexpected reference: dialogByWindow = new Map()']);
    expect(check('dialogByWindow.set(window, operation); foo();')).toEqual(['unexpected write: dialogByWindow.set(window, operation)']);
    expect(check('async function f() { releaseNativeDialog(operation); try { await deps.chooseOpenPath(w); } finally { g(); } }')).toEqual([
      'unexpected release: releaseNativeDialog(operation)',
    ]);
    expect(check('async function f() { try { await deps.chooseOpenPath(w); } finally { g(); releaseNativeDialog(operation); } }')).toEqual([
      'unexpected release: releaseNativeDialog(operation)',
    ]);
    expect(check('dialogByWindow.has(w); dialogByWindow.get(w); unsettledDialogs.size; [...unsettledDialogs].length;')).toEqual([]);
    expect(check("function disposeWindow() { const owned = dialogByWindow; owned['delete'](w); }")).toEqual([
      'unexpected reference: owned = dialogByWindow',
    ]);
    expect(check("dialogByWindow['delete'](w);")).toEqual(["unexpected reference: dialogByWindow['delete']"]);
    expect(check('forget(unsettledDialogs);')).toEqual(['unexpected reference: forget(unsettledDialogs)']);
  });

  it('反例：识别 electron、editor、renderer 导入', () => {
    const fake = join(IPC_DIR, '__fake__.ts');
    expect(ipcImportViolations(fake, "import { ipcMain } from 'electron';")).toEqual(['bare:electron']);
    expect(ipcImportViolations(fake, "import { useMuseAppStore } from '../../renderer/app/store';")).toEqual(['import:src/renderer/app/store.ts']);
    expect(ipcImportViolations(fake, "import type { DocumentSession } from '../../editor/session/types';")).toEqual(['import:src/editor/session/types.ts']);
  });
});

/** preload 中 `const api: MuseDesktopApi = { … }` 每个方法的调用摘要：方法体内全部调用表达式的被调用者文本与参数文本。 */
function preloadMethodCalls(file: SourceFile): Map<string, { callee: string; args: string[] }[]> {
  const result = new Map<string, { callee: string; args: string[] }[]>();
  for (const statement of file.statements) {
    if (!isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || declaration.name.text !== 'api' || declaration.initializer === undefined) continue;
      if (!isObjectLiteralExpression(declaration.initializer)) continue;
      for (const property of declaration.initializer.properties) {
        if (!isPropertyAssignment(property) || !isIdentifier(property.name)) continue;
        const calls: { callee: string; args: string[] }[] = [];
        const visit = (node: Node): void => {
          if (isCallExpression(node)) calls.push({ callee: node.expression.getText(file), args: node.arguments.map((a) => a.getText(file).replace(/\s+/g, ' ')) });
          forEachChild(node, visit);
        };
        if (isArrowFunction(property.initializer)) visit(property.initializer.body);
        else calls.push({ callee: '<not-an-arrow-function>', args: [] });
        result.set(property.name.text, calls);
      }
    }
  }
  return result;
}

describe('M3 T1b-2a 架构守卫 —— preload 白名单', () => {
  const source = stripComments(read(PRELOAD));

  it('AST：每个方法体恰好一个调用，且是对同名通道的 ipcRenderer.invoke；票据方法只转发两个字段', () => {
    const calls = preloadMethodCalls(parse(PRELOAD, read(PRELOAD)));
    expect([...calls.keys()].sort()).toEqual(['activateDocument', 'openDocument', 'openScore', 'rejectDocument']);
    for (const [method, list] of calls) {
      expect(list).toHaveLength(1);
      expect(list[0]?.callee).toBe('ipcRenderer.invoke');
      expect(list[0]?.args[0]).toBe(`IPC.${method}`);
    }
    expect(calls.get('openScore')?.[0]?.args).toEqual(['IPC.openScore']);
    expect(calls.get('openDocument')?.[0]?.args).toEqual(['IPC.openDocument', "{ intent: 'dialog' }"]);
    for (const method of ['activateDocument', 'rejectDocument']) {
      expect(calls.get(method)?.[0]?.args).toEqual([`IPC.${method}`, '{ capabilityId: ticket.capabilityId, documentId: ticket.documentId }']);
    }
  });

  it('不经别名 / 下标间接取得 ipcRenderer 的方法', () => {
    expect(/ipcRenderer\s*\[|=\s*ipcRenderer\b|\{[^}]*\}\s*=\s*ipcRenderer/.test(source)).toBe(false);
  });

  it('只经四个白名单通道 invoke，每个恰好一处', () => {
    const channels = [...source.matchAll(/ipcRenderer\.invoke\(\s*IPC\.(\w+)/g)].map((m) => m[1]);
    expect(channels.sort()).toEqual(['activateDocument', 'openDocument', 'openScore', 'rejectDocument']);
    expect(count(source, /ipcRenderer\.invoke\(/g)).toBe(4);
  });

  it('不使用 send / on / sendSync / postMessage / 动态通道', () => {
    expect(/ipcRenderer\.(send|sendSync|sendToHost|on|once|postMessage|addListener)\b/.test(source)).toBe(false);
    expect(/ipcRenderer\.invoke\(\s*[^I\s]/.test(source)).toBe(false);
  });

  it('activate-document 只出现在 activateDocument 方法中（preload 不主动确认）', () => {
    expect(count(source, /IPC\.activateDocument/g)).toBe(1);
    expect(/activateDocument:\s*\(ticket\)\s*=>\s*ipcRenderer\.invoke\(IPC\.activateDocument/.test(source)).toBe(true);
  });

  it('只暴露 museDesktop 一个全局', () => {
    expect([...source.matchAll(/exposeInMainWorld\('(\w+)'/g)].map((m) => m[1])).toEqual(['museDesktop']);
  });
});

describe('M3 T1b-2a 架构守卫 —— MuseDesktopApi 不接受路径', () => {
  const file = parse(SHARED_IPC, read(SHARED_IPC));
  const api = file.statements.find((s) => isInterfaceDeclaration(s) && s.name.text === 'MuseDesktopApi');

  it('方法集合固定，且没有任何字符串参数', () => {
    if (api === undefined || !isInterfaceDeclaration(api)) throw new Error('MuseDesktopApi not found');
    const methods = api.members.filter(isMethodSignature);
    expect(methods.map((m) => (isIdentifier(m.name) ? m.name.text : '?')).sort()).toEqual([
      'activateDocument',
      'openDocument',
      'openScore',
      'rejectDocument',
    ]);
    expect(api.members.length).toBe(methods.length);
    for (const method of methods) {
      for (const parameter of method.parameters) {
        expect(parameter.type?.kind).not.toBe(SyntaxKind.StringKeyword);
        expect(/path/i.test(parameter.name.getText(file))).toBe(false);
      }
    }
  });
});

describe('M3 T1b-2a 架构守卫 —— main.ts 接线', () => {
  const source = stripComments(read(MAIN));

  it('webPreferences 保持 sandbox / contextIsolation / 关闭 nodeIntegration（每个 BrowserWindow 都有）', () => {
    const windows = count(source, /new BrowserWindow\(/g);
    expect(windows).toBeGreaterThan(0);
    expect(count(source, /sandbox: true,/g)).toBe(windows);
    expect(count(source, /contextIsolation: true,/g)).toBe(windows);
    expect(count(source, /nodeIntegration: false,/g)).toBe(windows);
    expect(/sandbox:(?!\s*true\b)/.test(source)).toBe(false);
  });

  it('用 main 配置的入口 loadURL，不用 loadFile；getURL 只出现在诊断比对中', () => {
    expect(source).toContain('mainWindow.loadURL(pageEntry.loadUrl)');
    expect(/\bloadFile\b/.test(source)).toBe(false);
    expect(count(source, /\bgetURL\(/g)).toBe(1);
    expect(/matchesPageIdentity\(contents\.getURL\(\), pageEntry\.identity\)/.test(source)).toBe(true);
  });

  it('registerOpenIpc 只调用一次；新对话框经共享选择器绑定父窗口；窗口事件只经共享接线', () => {
    expect(count(source, /registerOpenIpc\(/g)).toBe(1);
    expect(source).toContain('pageIdentity: pageEntry.identity,');
    expect(source).toContain('chooseOpenPath: createOpenPathChooser((parent: BrowserWindow, options) => dialog.showOpenDialog(parent, options)),');
    expect(count(source, /wireOpenIpcWindow\(openIpc, mainWindow\)/g)).toBe(1);
    expect(count(source, /new BrowserWindow\(/g)).toBe(count(source, /wireOpenIpcWindow\(/g));
    // main 不自己登记 Open 相关事件、不直接调用 handle 的生命周期方法：只有一份接线（smoke 复用）。
    expect(/'(did-start-navigation|did-navigate|render-process-gone|destroyed|closed)'/.test(source)).toBe(false);
    expect(/openIpc\.(attachWindow|handleNavigation|handleNavigationCommitted|handleRendererGone|disposeWindow)\b/.test(source)).toBe(false);
  });

  it('共享接线转发全部生命周期事件', () => {
    const wire = stripComments(read(join(IPC_DIR, 'wireOpenIpcWindow.ts')));
    for (const wiring of [
      "contents.on('did-start-navigation'",
      'isMainFrame: details.isMainFrame, isSameDocument: details.isSameDocument',
      "contents.on('did-navigate'",
      'openIpc.handleNavigationCommitted(ownerId)',
      "contents.on('render-process-gone'",
      'openIpc.handleRendererGone(ownerId)',
      "contents.once('destroyed'",
      "window.once('closed'",
      'openIpc.attachWindow(ownerId, window)',
    ]) {
      expect(wire).toContain(wiring);
    }
    expect(count(wire, /openIpc\.disposeWindow\(ownerId\)/g)).toBe(2);
  });
});

describe('M3 T1b-2a 架构守卫 —— 不关闭 sandbox', () => {
  it('src / scripts / CI / package.json 中没有关闭 sandbox 的开关', () => {
    const files = [
      ...collectTsFiles(join(REPO_ROOT, 'src')),
      ...collectTsFiles(join(REPO_ROOT, 'scripts')),
      join(REPO_ROOT, '.github/workflows/ci.yml'),
      join(REPO_ROOT, 'package.json'),
    ].filter((file) => existsSync(file));
    const offenders = files.filter((file) => /no-sandbox|disable-sandbox|sandbox:\s*false|ELECTRON_DISABLE_SANDBOX/.test(read(file)));
    expect(offenders.map(posixPath)).toEqual([]);
  });
});
