/**
 * M3 T1c-2 架构守卫（新建，不修改 m3t0 / m3t1b* / m3t1c1 的既有断言含义；T1c Preflight r2 §9.3）。
 *
 * 1. renderer 对 `src/formats/**` 只经 parse façade（值导入与类型导入都算），名称在 T0 白名单内；m3t0 的遗留放行已经用不到。
 * 2. 旧 Open 通道（`muse:open-score` 等）在 src 与 smoke 中零出现；preload 白名单恰为三个方法。
 * 3. renderer 中只有 `openController.ts` 调用 `window.museDesktop`；组件只派发 `museOpenController.open()` / `dismissNotice()`。
 * 4. store 中写入会话与派生字段的只有 `commitSession`；renderer 其它文件不直接 `setState`。
 * 5. `sessionFactory` / `openTransaction` 是纯模块：只依赖 T0 editor、parse façade、shared 类型与彼此，不用平台全局。
 * 6. SourceInspector 只读：显示 `session.projection.view`，不处理输入、不读回 `textarea.value`；Reparse 在 T1c 隐藏。
 * 7. main 中旧的对话框与解码路径已删除：不再 import `node:fs` / iconv-lite，`dialog.showOpenDialog` 只出现在共享选择器表达式中。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCallExpression, isFunctionDeclaration, isPropertyAccessExpression } from 'typescript';
import type { Node } from 'typescript';
import { forEachChild } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, forbiddenGlobalUses, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (file: string): string => normalizeEol(readFileSync(file, 'utf8'));
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RENDERER = join(REPO_ROOT, 'src/renderer');
const EDITOR_ADAPTER = join(RENDERER, 'app/editor');
const STORE = join(RENDERER, 'app/store.ts');
const FACADE = 'src/formats/jcxParse.ts';
const FACADE_NAMES: ReadonlySet<string> = new Set(['loadJcx', 'LoadResult', 'JcxDiagnostic', 'JcxEncoding']);
const LEGACY_PATTERN = /muse:open-score|\bdecodeLegacyText\b|\bOpenedScoreFile\b|\bopenScore\b/;
const rendererFiles = collectTsFiles(RENDERER);

/** renderer 文件对 formats 的违规导入。 */
function formatViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null || resolved === undefined) return [];
    const path = posixPath(resolved);
    if (path === FACADE) return record.names.filter((name) => !FACADE_NAMES.has(name)).map((name) => `facade-name:${name}`);
    return path.startsWith('src/formats/') ? [`direct-formats-import:${path}`] : [];
  });
}

/** 纯模块允许的依赖：T0 editor、parse façade、shared（只类型）、同目录纯模块。 */
function pureImportViolations(file: string, source: string, siblings: ReadonlySet<string>): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null) return [`bare:${record.specifier}`];
    if (resolved === undefined) return [`unresolved:${record.specifier}`];
    const path = posixPath(resolved);
    if (path.startsWith('src/editor/') || path === FACADE || siblings.has(path)) return [];
    if (path.startsWith('src/shared/') && record.typeOnly) return [];
    return [`${record.typeOnly ? 'type' : 'value'}-import:${path}`];
  });
}

/** store.ts 中每个顶层函数里调用 setState / set 时写到的字段名（属性名与展开表达式的文本）。 */
function storeWrites(source: string): { readonly fn: string; readonly fields: string }[] {
  const file = parse(STORE, source);
  const writes: { fn: string; fields: string }[] = [];
  const visit = (node: Node, fn: string): void => {
    const owner = isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : fn;
    if (isCallExpression(node)) {
      const callee = node.expression;
      const name = isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(file);
      if (name === 'setState' || name === 'set') writes.push({ fn: owner, fields: node.arguments.map((a) => a.getText(file)).join(',') });
    }
    forEachChild(node, (child) => {
      visit(child, owner);
    });
  };
  visit(file, '<module>');
  return writes;
}

const SESSION_FIELDS = /\bsession\b|\bscore\b|\bindex\b|\bdiagnostics\b|\.\.\.derived/;

describe('M3 T1c-2 架构守卫 —— renderer 格式层只经 parse façade', () => {
  it.each(rendererFiles.map((file) => [posixPath(file), file]))('%s', (_rel, file) => {
    expect(formatViolations(file, read(file))).toEqual([]);
  });

  it('反例：总入口、codec、子路径与白名单外名字都被识别', () => {
    const fake = join(RENDERER, 'app/__fake__.ts');
    expect(formatViolations(fake, "import { loadJcx } from '../../formats/jcx';")).toEqual(['direct-formats-import:src/formats/jcx/index.ts']);
    expect(formatViolations(fake, "import type { JcxDiagnostic } from '../../formats/jcx/lexer/diagnostics';")).toEqual([
      'direct-formats-import:src/formats/jcx/lexer/diagnostics.ts',
    ]);
    expect(formatViolations(fake, "import { decodeJcx } from '../../formats/jcx/codec';")).toEqual(['direct-formats-import:src/formats/jcx/codec.ts']);
    expect(formatViolations(fake, "import { loadJcx, lexJcx } from '../../formats/jcxParse';")).toEqual(['facade-name:lexJcx']);
  });
});

describe('M3 T1c-2 架构守卫 —— 旧 Open 通道零残留', () => {
  it('src 与真实窗口 smoke 中都不出现旧通道标识（含注释）', () => {
    const files = [...collectTsFiles(join(REPO_ROOT, 'src')), ...collectTsFiles(join(REPO_ROOT, 'tests/electron'))];
    expect(files.filter((file) => LEGACY_PATTERN.test(read(file))).map(posixPath)).toEqual([]);
  });

  it('preload 只暴露三个方法；MuseDesktopApi 恰为三个方法', () => {
    const preload = stripComments(read(join(REPO_ROOT, 'src/preload/preload.ts')));
    // M3 T3b（用户裁决 Q1 / S1，G1）：另有订阅方法 onMenuCommand；下面返回 Promise 的方法仍恰为三个（G6 钉住完整集合）。
    expect([...preload.matchAll(/^\s{2}(\w+): \(/gm)].map((m) => m[1]).sort()).toEqual(['activateDocument', 'onMenuCommand', 'openDocument', 'rejectDocument']);
    const ipc = stripComments(read(join(REPO_ROOT, 'src/shared/ipc.ts')));
    expect([...ipc.matchAll(/^\s{2}(\w+)\(.*\): Promise</gm)].map((m) => m[1]).sort()).toEqual(['activateDocument', 'openDocument', 'rejectDocument']);
  });

  it('main 不再含旧对话框与解码路径', () => {
    const main = stripComments(read(join(REPO_ROOT, 'src/main/main.ts')));
    expect(/from 'node:fs|from 'fs|iconv-lite|TextDecoder|ipcMain\.handle\(/.test(main)).toBe(false);
    expect([...main.matchAll(/dialog\.showOpenDialog\(/g)].map((m) => m[0])).toHaveLength(1);
    expect(main).toContain('chooseOpenPath: createOpenPathChooser((parent: BrowserWindow, options) => dialog.showOpenDialog(parent, options)),');
  });
});

describe('M3 T1c-2 架构守卫 —— 跨进程事务只在 openController', () => {
  it('renderer 中只有 openController.ts 使用 museDesktop（global.d.ts 只是类型声明）', () => {
    const users = rendererFiles.filter((file) => /museDesktop/.test(stripComments(read(file)))).map(posixPath);
    // M3 T3b（G2）：menuBridge 只订阅菜单命令，不调用 Open 三方法（architecture.m3t3 钉住）。
    expect(users.sort()).toEqual(['src/renderer/app/editor/menuBridge.ts', 'src/renderer/app/editor/openController.ts', 'src/renderer/global.d.ts']);
    expect(stripComments(read(join(RENDERER, 'global.d.ts')))).toContain('museDesktop: MuseDesktopApi;');
  });

  it('组件只派发 open / dismissNotice，不直接使用状态机或桥', () => {
    const components = collectTsFiles(join(RENDERER, 'components')).map((file) => ({ rel: posixPath(file), source: stripComments(read(file)) }));
    for (const { rel, source } of components) {
      expect(/stepOpenFlow|createOpenController|activateDocument|rejectDocument|openDocument\(/.test(source), rel).toBe(false);
    }
    const toolbar = stripComments(read(join(RENDERER, 'components/Toolbar.tsx')));
    expect([...toolbar.matchAll(/museOpenController\.(\w+)\(/g)].map((m) => m[1]).sort()).toEqual(['dismissNotice', 'open']);
    expect(/useEffect|useLayoutEffect/.test(toolbar)).toBe(false);
  });
});

describe('M3 T1c-2 架构守卫 —— 会话只由 commitSession 写入', () => {
  it('store.ts：写入会话 / 派生字段的 setState 只在 commitSession 中', () => {
    const writes = storeWrites(read(STORE));
    const sessionWriters = writes.filter((write) => SESSION_FIELDS.test(write.fields)).map((write) => write.fn);
    // M3 T3a（用户裁决 Q1 / S1，T3 Preflight r3 §10.1 G3）：编辑 / undo / redo 与解析发布各有一个原子写入函数；
    // 每个函数写入的字段集合由 architecture.m3t3 精确钉住。
    expect(sessionWriters).toEqual(['commitSession', 'applyEditorStep', 'publishParsedSession']);
    expect(writes.map((write) => write.fn).sort()).toEqual(
      [
        'commitSession',
        'applyEditorStep',
        'publishParsedSession',
        'setEditorSelection',
        'publishEditorView',
        'downgradeCapabilityTrust',
        'publishOpenView',
        '<module>',
      ].sort(),
    );
  });

  it('renderer 其它文件不直接 setState 或 getState().set…', () => {
    const offenders = rendererFiles.filter((file) => posixPath(file) !== posixPath(STORE) && /\.setState\(/.test(stripComments(read(file))));
    expect(offenders.map(posixPath)).toEqual([]);
  });

  it('反例：在其它函数里写派生字段会被识别', () => {
    const writes = storeWrites('function sneaky() { useMuseAppStore.setState({ score: other.score }); }');
    expect(writes.filter((write) => SESSION_FIELDS.test(write.fields)).map((write) => write.fn)).toEqual(['sneaky']);
  });
});

describe('M3 T1c-2 架构守卫 —— 纯模块', () => {
  const pure = ['sessionFactory.ts', 'openTransaction.ts'].map((name) => join(EDITOR_ADAPTER, name));
  const siblings: ReadonlySet<string> = new Set(pure.map(posixPath));

  it.each(pure.map((file) => [posixPath(file), file]))('%s：只依赖 T0 editor / façade / shared 类型，不用平台全局', (_rel, file) => {
    const source = read(file);
    expect(pureImportViolations(file, source, siblings)).toEqual([]);
    expect(forbiddenGlobalUses(file, source)).toEqual([]);
  });

  it('反例：store、react、electron 与定时器都被识别', () => {
    const fake = join(EDITOR_ADAPTER, '__fake__.ts');
    expect(pureImportViolations(fake, "import { useMuseAppStore } from '../store';", siblings)).toEqual(['value-import:src/renderer/app/store.ts']);
    expect(pureImportViolations(fake, "import { useState } from 'react';", siblings)).toEqual(['bare:react']);
    expect(pureImportViolations(fake, "import { IPC } from '../../../shared/ipc';", siblings)).toEqual(['value-import:src/shared/ipc.ts']);
    expect(forbiddenGlobalUses(fake, 'setTimeout(() => 0, 1); window.museDesktop;')).toHaveLength(2);
  });
});

describe('M3 T1c-2 架构守卫 —— SourceInspector 只读、Reparse 隐藏', () => {
  it('textarea 只读并显示 projection.view；不处理输入、不读回 value', () => {
    const inspector = stripComments(read(join(RENDERER, 'components/SourceInspector.tsx')));
    expect(inspector).toContain('useMuseAppStore((state) => state.session.projection.view)');
    expect(/<textarea[^>]*\breadOnly\b[^>]*value=\{view\}/.test(inspector)).toBe(true);
    expect(/onChange|onInput|onKeyDown|onPaste|\.value\b|setSource/.test(inspector)).toBe(false);
  });

  it('Toolbar 不提供 Reparse 与保存类操作', () => {
    const toolbar = stripComments(read(join(RENDERER, 'components/Toolbar.tsx')));
    expect(/Reparse|reparse|Save|另存/.test(toolbar)).toBe(false);
  });
});
