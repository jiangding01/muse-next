/**
 * M3 T1b-2a 架构守卫（新建，不修改 m3t0 / m3t1b 与任何历史守卫）。
 *
 * - `src/main/ipc/**`：不 import electron（Electron 能力全部由 main 注入），不 import editor / renderer / formats；
 *   不读取 `getURL`、不使用 `loadFile`（页面身份只来自 main 配置）。
 * - preload：只经白名单通道 `invoke`，每个通道恰好一处；不使用 send / on / sendSync / postMessage；`activate-document`
 *   只出现在 `activateDocument` 方法里（不主动确认）；只暴露 `museDesktop`。
 * - `MuseDesktopApi`：方法集合固定；没有任何字符串参数（页面不能提交路径）。
 * - main.ts：webPreferences 保持 `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`；用 `loadURL(pageEntry.loadUrl)`
 *   加载、不用 `loadFile`；新对话框绑定父窗口；`getURL` 只用于诊断比对；窗口事件转发齐全。
 * - 全仓（src / scripts / CI / package.json）不出现关闭 sandbox 的开关。
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  forEachChild,
  isArrowFunction,
  isBinaryExpression,
  isBlock,
  isExpressionStatement,
  isPostfixUnaryExpression,
  isPrefixUnaryExpression,
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

/**
 * 物理对话框计数 `nativeDialogs` 的全部写入点（声明除外）。合法形态只有：一条 `nativeDialogs += 1;` 语句，其后紧跟的
 * try 语句的 finally 块首句是 `nativeDialogs -= 1;`。其它任何写入（含 `++` / `--`、直接赋值、其它复合赋值）都报告。
 */
function nativeDialogWrites(file: SourceFile): string[] {
  const findings: string[] = [];
  const isCounter = (node: Node): boolean => isIdentifier(node) && node.text === 'nativeDialogs';
  const visit = (node: Node): void => {
    const writes =
      (isBinaryExpression(node) &&
        isCounter(node.left) &&
        node.operatorToken.kind >= SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= SyntaxKind.LastAssignment) ||
      ((isPrefixUnaryExpression(node) || isPostfixUnaryExpression(node)) &&
        isCounter(node.operand) &&
        (node.operator === SyntaxKind.PlusPlusToken || node.operator === SyntaxKind.MinusMinusToken));
    if (writes) {
      const text = node.getText(file);
      const statement = node.parent;
      const block = statement.parent;
      if (text === 'nativeDialogs += 1' && isExpressionStatement(statement) && isBlock(block)) {
        const next = block.statements[block.statements.indexOf(statement) + 1];
        const first = next !== undefined && isTryStatement(next) ? next.finallyBlock?.statements[0] : undefined;
        if (first !== undefined && first.getText(file) === 'nativeDialogs -= 1;') findings.push('+= 1 before try');
        else findings.push(`unexpected write: ${text}`);
      } else if (
        text === 'nativeDialogs -= 1' &&
        isExpressionStatement(statement) &&
        isBlock(block) &&
        block.statements[0] === statement &&
        isTryStatement(block.parent) &&
        block.parent.finallyBlock === block
      ) {
        findings.push('-= 1 first in finally of that try');
      } else {
        findings.push(`unexpected write: ${text}`);
      }
    }
    forEachChild(node, visit);
  };
  visit(file);
  return findings;
}

/** 去掉块注释与行注释（守卫检查代码，不检查解释性注释）。 */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('M3 T1b-2a 架构守卫 —— src/main/ipc', () => {
  const files = collectTsFiles(IPC_DIR);

  it('扫到接线与页面身份两个模块', () => {
    expect(files.map(posixPath)).toEqual(['src/main/ipc/pageIdentity.ts', 'src/main/ipc/registerOpenIpc.ts']);
  });

  it.each(files.map((f) => [posixPath(f), f]))('%s 不 import electron / editor / renderer / formats', (_rel, file) => {
    expect(ipcImportViolations(file, read(file))).toEqual([]);
  });

  it.each(files.map((f) => [posixPath(f), f]))('%s 不读取 getURL、不使用 loadFile', (_rel, file) => {
    expect(/\bgetURL\b|\bloadFile\b/.test(stripComments(read(file)))).toBe(false);
  });

  it('AST：物理对话框计数恰好两处写入——try 之前 += 1、紧随其后的 try 的 finally 首句 -= 1；没有其它写入', () => {
    const file = join(IPC_DIR, 'registerOpenIpc.ts');
    expect(nativeDialogWrites(parse(file, read(file)))).toEqual(['+= 1 before try', '-= 1 first in finally of that try']);
  });

  it('反例：-- / 直接赋值 / 位置不对的写入都会被识别', () => {
    const fake = join(IPC_DIR, '__fake__.ts');
    expect(nativeDialogWrites(parse(fake, 'let nativeDialogs = 0; nativeDialogs--;'))).toEqual(['unexpected write: nativeDialogs--']);
    expect(nativeDialogWrites(parse(fake, 'let nativeDialogs = 0; nativeDialogs = 0;'))).toEqual(['unexpected write: nativeDialogs = 0']);
    expect(nativeDialogWrites(parse(fake, 'let nativeDialogs = 0; nativeDialogs += 1; foo();'))).toEqual(['unexpected write: nativeDialogs += 1']);
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

  it('registerOpenIpc 只调用一次；新对话框绑定父窗口；窗口事件转发齐全', () => {
    expect(count(source, /registerOpenIpc\(/g)).toBe(1);
    expect(source).toContain('pageIdentity: pageEntry.identity,');
    expect(source).toContain('dialog.showOpenDialog(parent,');
    for (const wiring of [
      "contents.on('did-start-navigation'",
      "contents.on('render-process-gone'",
      "contents.on('did-navigate'",
      'openIpc.handleNavigationCommitted(ownerId)',
      "contents.once('destroyed'",
      "mainWindow.once('closed'",
      'openIpc.attachWindow(ownerId, mainWindow)',
    ]) {
      expect(source).toContain(wiring);
    }
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
