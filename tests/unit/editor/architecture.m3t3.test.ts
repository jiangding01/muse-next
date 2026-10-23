/**
 * M3 T3a 架构守卫（新建；用户裁决 Q1 / S1，T3 Preflight r3 §10.1、实施 Gate v2 §7）。
 *
 * `architecture.m3t1c.test.ts:139-140` 把 store 写入函数集合从「只有 commitSession」放宽为 T3a 的四个原子写入函数；
 * 本守卫用更精确的规则钉住放宽的部分，并覆盖 T3a 新增的约束：
 * 1. store 中每个写入函数写到的字段集合精确固定（派生字段只在 commitSession / publishParsedSession 中写）。
 * 2. 新纯模块 `editorTransitions` / `parseSchedule` 只依赖 Editor Core（或无依赖），不用平台全局。
 * 3. T3a 只产生 `none` / `source` 两种选中。
 * 4. `replacementPending` 只由 Open 控制器写入；beforeunload 只在模块级阻止器中注册，且入口在 createRoot 之前安装并传入根错误回调。
 * 5. 开发期整页刷新插件：renderer 配置中紧随 CSP 插件、只在 serve 生效，插件文件只有 vite 的类型依赖。
 * 6. M3 T3b：preload `onMenuCommand` 方法体调用集合精确；`IPC.menuCommand` 只在 main 菜单模块发送、只在 preload 接收；
 *    menuBridge 只订阅、在 createRoot 之前安装一次；状态栏纯模块与组件的派发集合；`src/main/menu/**` 不 import electron；
 *    菜单只经 installAppMenu 安装、无危险 role；main 与 smoke 的 `new BrowserWindow` 与 `wireEditorWindow` 一一对应；
 *    `src/main/**` 无写盘 API。
 * 每条附反例。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  forEachChild,
  isArrowFunction,
  isCallExpression,
  isConditionalExpression,
  isFunctionDeclaration,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isShorthandPropertyAssignment,
  isSpreadAssignment,
} from 'typescript';
import type { Expression, Node, SourceFile } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, forbiddenGlobalUses, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const read = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const RENDERER = join(REPO_ROOT, 'src/renderer');
const EDITOR_ADAPTER = join(RENDERER, 'app/editor');
const STORE = join(RENDERER, 'app/store.ts');

/** 一个对象字面量的字段名（展开写成 `...表达式`）。 */
function literalFields(file: SourceFile, expression: Expression): string[] {
  if (isParenthesizedExpression(expression)) return literalFields(file, expression.expression);
  if (isConditionalExpression(expression)) return [...literalFields(file, expression.whenTrue), ...literalFields(file, expression.whenFalse)];
  if (!isObjectLiteralExpression(expression)) return [];
  return expression.properties.map((property) => {
    if (isSpreadAssignment(property)) return `...${property.expression.getText(file)}`;
    if (isPropertyAssignment(property) || isShorthandPropertyAssignment(property)) return property.name.getText(file);
    return `?${property.getText(file)}`;
  });
}

/** store 源码中每个顶层函数（模块级为 `<module>`）里 `setState` / `set` 写到的字段集合。 */
function storeWriteFields(source: string): Record<string, string[]> {
  const file = parse(STORE, source);
  const writes: Record<string, string[]> = {};
  const visit = (node: Node, owner: string): void => {
    const fn = isFunctionDeclaration(node) && node.name !== undefined ? node.name.text : owner;
    if (isCallExpression(node)) {
      const callee = node.expression;
      const name = isPropertyAccessExpression(callee) ? callee.name.text : callee.getText(file);
      const [arg] = node.arguments;
      if ((name === 'setState' || name === 'set') && arg !== undefined) {
        const body = isArrowFunction(arg) && !('statements' in arg.body) ? arg.body : arg;
        writes[fn] = [...(writes[fn] ?? []), ...literalFields(file, body)].sort();
      }
    }
    forEachChild(node, (child) => {
      visit(child, fn);
    });
  };
  visit(file, '<module>');
  return writes;
}

const EXPECTED_WRITES: Record<string, string[]> = {
  '<module>': ['zoom'],
  commitSession: ['...derived', 'capabilityTrust', 'editor', 'history', 'selection', 'session'],
  applyEditorStep: ['history', 'selection', 'session'],
  publishParsedSession: ['...derive(session)', 'session'],
  setEditorSelection: ['history', 'selection'],
  publishEditorView: ['editor'],
  downgradeCapabilityTrust: ['capabilityTrust'],
  publishOpenView: ['open'],
};

describe('M3 T3a 架构守卫 —— store 写入字段精确集合', () => {
  it('每个写入函数写到的字段恰为期望集合；派生字段只在 commitSession / publishParsedSession 中写', () => {
    const writes = storeWriteFields(read(STORE));
    expect(Object.keys(writes).sort()).toEqual(Object.keys(EXPECTED_WRITES).sort());
    for (const [fn, fields] of Object.entries(EXPECTED_WRITES)) expect(writes[fn], fn).toEqual([...fields].sort());
    const derivedWriters = Object.entries(writes)
      .filter(([, fields]) => fields.some((field) => field.startsWith('...derive') || ['score', 'index', 'diagnostics'].includes(field)))
      .map(([fn]) => fn)
      .sort();
    expect(derivedWriters).toEqual(['commitSession', 'publishParsedSession']);
  });

  it('反例：编辑写入顺带改派发字段、选区写入顺带换会话、展开别的对象都会被识别', () => {
    expect(storeWriteFields('function applyEditorStep() { useMuseAppStore.setState({ session, history, selection, score }); }').applyEditorStep).toEqual([
      'history',
      'score',
      'selection',
      'session',
    ]);
    expect(storeWriteFields('function setEditorSelection() { useMuseAppStore.setState({ history, selection, session }); }').setEditorSelection).toContain('session');
    expect(storeWriteFields('function publishEditorView() { useMuseAppStore.setState((s) => ({ editor: s.editor, ...other })); }').publishEditorView).toEqual([
      '...other',
      'editor',
    ]);
  });
});

/** 纯模块允许的依赖：Editor Core（值或类型）；其它一律违规。 */
function pureViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null) return [`bare:${record.specifier}`];
    if (resolved === undefined) return [`unresolved:${record.specifier}`];
    const path = posixPath(resolved);
    return path.startsWith('src/editor/') ? [] : [`${record.typeOnly ? 'type' : 'value'}-import:${path}`];
  });
}

describe('M3 T3a 架构守卫 —— 新纯模块', () => {
  const pure = ['editorTransitions.ts', 'parseSchedule.ts'].map((name) => join(EDITOR_ADAPTER, name));

  it.each(pure.map((file) => [posixPath(file), file]))('%s：只依赖 Editor Core，不用平台全局（含定时器）', (_rel, file) => {
    const source = read(file);
    expect(pureViolations(file, source)).toEqual([]);
    expect(forbiddenGlobalUses(file, source)).toEqual([]);
  });

  it('parseSchedule 没有任何 import（调度只产出效果，定时器在控制器中）', () => {
    expect(parseImports(pure[1] ?? '', read(pure[1] ?? ''))).toEqual([]);
  });

  it('反例：store、React、formats 子路径与定时器都被识别', () => {
    const fake = join(EDITOR_ADAPTER, '__fake__.ts');
    expect(pureViolations(fake, "import { useMuseAppStore } from '../store';")).toEqual(['value-import:src/renderer/app/store.ts']);
    expect(pureViolations(fake, "import { useState } from 'react';")).toEqual(['bare:react']);
    expect(pureViolations(fake, "import type { LoadResult } from '../../../formats/jcxParse';")).toEqual(['type-import:src/formats/jcxParse.ts']);
    expect(forbiddenGlobalUses(fake, 'setTimeout(() => 0, 1);')).toHaveLength(1);
  });
});

const BEFORE_UNLOAD = /['"]beforeunload['"]|\bonbeforeunload\b/;

/** `museOpenController` 声明（到文件末尾）中必须出现的产品接线。 */
function museOpenWiringProblems(source: string): string[] {
  const start = source.indexOf('export const museOpenController');
  if (start < 0) return ['missing museOpenController'];
  const wiring = source.slice(start);
  const required: readonly (readonly [string, string])[] = [
    ['  editor: {', 'missing editor gate'],
    ['museEditorController.openGate()', 'missing museEditorController.openGate()'],
    ['museEditorController.prepareReplacement();', 'missing museEditorController.prepareReplacement()'],
    ['museEditorController.setReplacementPending(pending);', 'missing museEditorController.setReplacementPending()'],
    ['commitSession(session, trust);', 'missing commitSession'],
    ['museParseController.documentReplaced();', 'missing museParseController.documentReplaced()'],
    // 解析调度通知必须在 afterCommit 中（提交成功之后、异常只报告；r3a 复核 H-1），且产品注入编辑器错误报告。
    ['  afterCommit: () => {\n    museParseController.documentReplaced();', 'documentReplaced() is not wired through afterCommit'],
    ['  report: reportEditorError,', 'missing report'],
  ];
  return required.filter(([needle]) => !wiring.includes(needle)).map(([, problem]) => problem);
}

/** 源码中 `kind: '…'` 字面量取值。 */
const kindLiterals = (source: string): string[] => [...stripComments(source).matchAll(/\bkind: '([a-z-]+)'/g)].map((m) => m[1] ?? '');

describe('M3 T3a 架构守卫 —— 选中种类、替换标志与卸载阻止', () => {
  it('editorTransitions 只产生 none / source 两种选中', () => {
    expect([...new Set(kindLiterals(read(join(EDITOR_ADAPTER, 'editorTransitions.ts'))))].sort()).toEqual(['none', 'source']);
    expect(kindLiterals("return { kind: 'document', ranges };")).toEqual(['document']);
  });

  it('replacementPending 只由 Open 控制器写入（editorController 只定义）；解构取得写入函数也算', () => {
    const writers = collectTsFiles(RENDERER)
      .filter((file) => posixPath(file) !== 'src/renderer/app/editor/editorController.ts')
      .filter((file) => /\bsetReplacementPending\b/.test(stripComments(read(file))))
      .map(posixPath);
    expect(writers).toEqual(['src/renderer/app/editor/openController.ts']);
    expect(/\bsetReplacementPending\b/.test('const { setReplacementPending } = museEditorController;')).toBe(true);
  });

  it('产品 Open 控制器注入了编辑器门控并接到编辑控制器；提交后通知解析调度文档已替换（r3a 审查 M-2）', () => {
    expect(museOpenWiringProblems(stripComments(read(join(EDITOR_ADAPTER, 'openController.ts'))))).toEqual([]);
  });

  it('反例：缺少 editor 门控、门控接到空实现、提交后不通知解析调度都会被识别', () => {
    const wired = stripComments(read(join(EDITOR_ADAPTER, 'openController.ts')));
    expect(museOpenWiringProblems(wired.replace('  editor: {', '  ignored: {'))).toContain('missing editor gate');
    expect(museOpenWiringProblems(wired.replace('museEditorController.openGate()', '({ dirty: false, composing: false })'))).toContain(
      'missing museEditorController.openGate()',
    );
    expect(museOpenWiringProblems(wired.replace('museParseController.documentReplaced();', ''))).toContain('missing museParseController.documentReplaced()');
    expect(museOpenWiringProblems(wired.replace('  afterCommit: () => {', '  onCommitted: () => {'))).toContain(
      'documentReplaced() is not wired through afterCommit',
    );
    expect(museOpenWiringProblems(wired.replace('  report: reportEditorError,', ''))).toContain('missing report');
  });

  it('beforeunload 只在模块级阻止器中注册（含 onbeforeunload 写法）；组件中不出现；入口在 createRoot 之前安装并传入根错误回调', () => {
    const registrants = collectTsFiles(RENDERER)
      .filter((file) => BEFORE_UNLOAD.test(stripComments(read(file))))
      .map(posixPath);
    expect(registrants).toEqual(['src/renderer/app/editor/unloadBlocker.ts']);
    const main = stripComments(read(join(RENDERER, 'main.tsx')));
    const install = main.indexOf('installMuseUnloadBlocker();');
    expect(install).toBeGreaterThan(-1);
    expect(install).toBeLessThan(main.indexOf('createRoot('));
    expect(main).toContain('createRoot(root, museRootErrorOptions)');
  });

  it('反例：组件里注册 beforeunload 或赋值 onbeforeunload 会被识别', () => {
    expect(BEFORE_UNLOAD.test("useEffect(() => { window.addEventListener('beforeunload', h); }, []);")).toBe(true);
    expect(BEFORE_UNLOAD.test('window.onbeforeunload = () => true;')).toBe(true);
  });
});

describe('M3 T3a 架构守卫 —— 开发期整页刷新插件', () => {
  it('配置中紧随 CSP 插件之后注册；插件文件只依赖 vite 的类型', () => {
    const config = stripComments(read(join(REPO_ROOT, 'vite.renderer.config.ts')));
    expect(config).toContain('plugins: [rendererCspPlugin(), rendererFullReload(), react()],');
    const reloadFile = join(REPO_ROOT, 'vite.renderer.reload.ts');
    const imports = parseImports(reloadFile, read(reloadFile));
    expect(imports.map((record) => [record.specifier, record.typeOnly])).toEqual([['vite', true]]);
  });

  it('插件只在 serve 生效、只处理 client 环境并返回 []；不使用无效的 hot.decline()', () => {
    const source = stripComments(read(join(REPO_ROOT, 'vite.renderer.reload.ts')));
    expect(source).toContain("apply: 'serve',");
    expect(source).toContain("if (environment.name !== 'client') return undefined;");
    expect(source).toContain("environment.hot.send({ type: 'full-reload' });");
    expect(/\.decline\(/.test(source)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// M3 T3b（用户裁决 Q1 / S1、Q2、Q-B1～Q-B4；T3 Preflight r3 §10 T3b、§10.1）：菜单、快捷键、命令桥与状态栏。
// ---------------------------------------------------------------------------------------------------------------------

const PRELOAD = join(REPO_ROOT, 'src/preload/preload.ts');
const MAIN = join(REPO_ROOT, 'src/main/main.ts');
const MENU_DIR = join(REPO_ROOT, 'src/main/menu');
const SMOKE_DIR = join(REPO_ROOT, 'tests/electron/ipcSmoke');
const count = (source: string, pattern: RegExp): number => [...source.matchAll(pattern)].length;

/** preload 中 `onMenuCommand` 方法体（含内部 handler 与注销函数）里全部调用表达式的文本（空白归一）。 */
function onMenuCommandCalls(source: string): string[] | null {
  const file = parse(PRELOAD, source);
  let calls: string[] | null = null;
  const visit = (node: Node): void => {
    if (isPropertyAssignment(node) && node.name.getText(file) === 'onMenuCommand' && isArrowFunction(node.initializer)) {
      const found: string[] = [];
      const collect = (inner: Node): void => {
        if (isCallExpression(inner)) found.push(inner.getText(file).replace(/\s+/g, ' '));
        forEachChild(inner, collect);
      };
      collect(node.initializer.body);
      calls = found.sort();
      return;
    }
    forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

const EXPECTED_ON_MENU_COMMAND_CALLS = [
  'ipcRenderer.on(IPC.menuCommand, handler)',
  'ipcRenderer.removeListener(IPC.menuCommand, handler)',
  'listener(message)',
  'parseMenuCommandMessage(payload)',
].sort();

describe('M3 T3b 架构守卫 —— preload 的菜单命令订阅', () => {
  it('onMenuCommand 方法体的调用集合精确：校验后只把消息交给 listener，不暴露 event；注销同一个 handler', () => {
    const source = read(PRELOAD);
    expect(onMenuCommandCalls(source)).toEqual(EXPECTED_ON_MENU_COMMAND_CALLS);
    expect(stripComments(source)).toContain('const handler = (_event: unknown, payload: unknown): void => {');
    expect(stripComments(source)).toContain('if (message !== null) listener(message);');
  });

  it('反例：把 event 交给页面、跳过校验、注销别的函数都会被识别', () => {
    const source = read(PRELOAD);
    expect(onMenuCommandCalls(source.replace('if (message !== null) listener(message);', 'listener(_event as never);'))).not.toEqual(EXPECTED_ON_MENU_COMMAND_CALLS);
    expect(onMenuCommandCalls(source.replace('parseMenuCommandMessage(payload)', '(payload as never)'))).not.toEqual(EXPECTED_ON_MENU_COMMAND_CALLS);
    expect(onMenuCommandCalls(source.replace('ipcRenderer.removeListener(IPC.menuCommand, handler)', 'ipcRenderer.removeAllListeners(IPC.menuCommand)'))).not.toEqual(
      EXPECTED_ON_MENU_COMMAND_CALLS,
    );
  });

  it('MuseDesktopApi.onMenuCommand 签名：参数为函数、返回注销函数；跨进程来源不含 renderer 内部来源', async () => {
    const ipc = stripComments(read(join(REPO_ROOT, 'src/shared/ipc.ts')));
    expect(ipc).toContain('onMenuCommand(listener: (message: MenuCommandMessage) => void): () => void;');
    const { MENU_COMMAND_SOURCES, MENU_COMMANDS } = await import('../../../src/shared/menuContracts');
    expect([...MENU_COMMAND_SOURCES]).toEqual(['key-intercept', 'menu-click', 'menu-accelerator']);
    expect([...MENU_COMMANDS]).toEqual(['undo', 'redo', 'reparse', 'open']);
  });
});

/** 源码中出现 `IPC.menuCommand` 的文件（去注释）。 */
function menuCommandChannelUsers(roots: readonly string[]): string[] {
  return roots
    .flatMap((root) => collectTsFiles(root))
    .filter((file) => /IPC\.menuCommand\b/.test(stripComments(read(file))))
    .map(posixPath)
    .sort();
}

describe('M3 T3b 架构守卫 —— menuCommand 通道只在 main 菜单模块发送、只在 preload 接收', () => {
  it('src 与 smoke 中使用 IPC.menuCommand 的文件恰为两个；main 侧恰一处 send', () => {
    expect(menuCommandChannelUsers([join(REPO_ROOT, 'src'), SMOKE_DIR])).toEqual(['src/main/menu/wireEditorWindow.ts', 'src/preload/preload.ts']);
    const wire = stripComments(read(join(MENU_DIR, 'wireEditorWindow.ts')));
    expect(count(wire, /IPC\.menuCommand/g)).toBe(1);
    expect(wire).toContain('contents.send(IPC.menuCommand, message);');
    const preload = stripComments(read(PRELOAD));
    expect(count(preload, /IPC\.menuCommand/g)).toBe(2);
  });

  it('通道字面量 muse:menu-command 只出现在 src/shared/ipc.ts（绕开 IPC 常量直接发送会被识别）', () => {
    const literal = /['"`]muse:menu-command['"`]/;
    const users = [...collectTsFiles(join(REPO_ROOT, 'src')), ...collectTsFiles(join(REPO_ROOT, 'tests/electron'))]
      .filter((file) => literal.test(stripComments(read(file))))
      .map(posixPath);
    expect(users).toEqual(['src/shared/ipc.ts']);
    expect(literal.test("contents.send('muse:menu-command', message);")).toBe(true);
    expect(/IPC\.menuCommand\b/.test(stripComments('mainWindow.webContents.send(IPC.menuCommand, { command: "undo" });'))).toBe(true);
  });
});

describe('M3 T3b 架构守卫 —— renderer 命令桥', () => {
  const bridge = stripComments(read(join(EDITOR_ADAPTER, 'menuBridge.ts')));

  it('menuBridge 只调用 onMenuCommand，不调用 Open 三方法；产品实例只路由到编辑 / Open 控制器', () => {
    expect([...bridge.matchAll(/museDesktop\.(\w+)/g)].map((m) => m[1])).toEqual(['onMenuCommand']);
    expect(/openDocument|activateDocument|rejectDocument/.test(bridge)).toBe(false);
    expect(bridge).toContain('subscribe: (listener) => window.museDesktop.onMenuCommand(listener),');
    expect(bridge).toContain('editor: museEditorController,');
    expect(bridge).toContain('museOpenController.open();');
    expect(bridge).toContain('if (unsubscribe !== null) return false;');
  });

  it('入口在 createRoot 之前安装一次（在卸载阻止器之后）；只有入口调用 installMenuBridge', () => {
    const main = stripComments(read(join(RENDERER, 'main.tsx')));
    expect(count(main, /installMenuBridge\(\);/g)).toBe(1);
    expect(main.indexOf('installMenuBridge();')).toBeGreaterThan(main.indexOf('installMuseUnloadBlocker();'));
    expect(main.indexOf('installMenuBridge();')).toBeLessThan(main.indexOf('createRoot('));
    const callers = collectTsFiles(RENDERER)
      .filter((file) => /\binstallMenuBridge\(|\bmuseMenuBridge\.install\(/.test(stripComments(read(file))))
      .map(posixPath)
      .sort();
    expect(callers).toEqual(['src/renderer/app/editor/menuBridge.ts', 'src/renderer/main.tsx']);
  });

  it('反例：组件里订阅菜单命令会被识别', () => {
    expect(/museDesktop\.(\w+)/.exec('useEffect(() => window.museDesktop.onMenuCommand(h), []);')?.[1]).toBe('onMenuCommand');
  });
});

/** 纯模块 editorStatus 允许的依赖：Editor Core（值或类型）与同目录 editorTransitions 的类型。 */
function editorStatusViolations(file: string, source: string): string[] {
  return parseImports(file, source).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null) return [`bare:${record.specifier}`];
    if (resolved === undefined) return [`unresolved:${record.specifier}`];
    const path = posixPath(resolved);
    if (path.startsWith('src/editor/')) return [];
    if (path === 'src/renderer/app/editor/editorTransitions.ts' && record.typeOnly) return [];
    return [`${record.typeOnly ? 'type' : 'value'}-import:${path}`];
  });
}

describe('M3 T3b 架构守卫 —— 状态栏', () => {
  const statusFile = join(EDITOR_ADAPTER, 'editorStatus.ts');

  it('editorStatus 是纯模块：只依赖 Editor Core 与 editorTransitions 的类型，不用平台全局', () => {
    const source = read(statusFile);
    expect(editorStatusViolations(statusFile, source)).toEqual([]);
    expect(forbiddenGlobalUses(statusFile, source)).toEqual([]);
  });

  it('反例：值导入 editorTransitions、导入 store 都会被识别', () => {
    expect(editorStatusViolations(statusFile, "import { initialEditorCore } from './editorTransitions';")).toEqual([
      'value-import:src/renderer/app/editor/editorTransitions.ts',
    ]);
    expect(editorStatusViolations(statusFile, "import { useMuseAppStore } from '../store';")).toEqual(['value-import:src/renderer/app/store.ts']);
    expect(editorStatusViolations(statusFile, "import { useState } from 'react';")).toEqual(['bare:react']);
  });

  it('EditorStatusBar 只派发 status-bar 来源的 Reparse 与清除提示；不注册 effect；没有来源 / 计数类测试钩子', () => {
    const bar = stripComments(read(join(RENDERER, 'components/EditorStatusBar.tsx')));
    expect([...bar.matchAll(/museEditorController\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1] ?? ''}(${m[2] ?? ''})`)).toEqual(["reparse('status-bar')"]);
    expect([...bar.matchAll(/publishEditorView\(([^)]*)\)/g)].map((m) => m[1])).toEqual(['{ notice: null }']);
    expect(/useEffect|useLayoutEffect|setState|museDesktop|museOpenController/.test(bar)).toBe(false);
    expect(/data-[\w-]*(dispatch|source=|count|origin)/.test(bar.replace('data-source-version', '').replace('data-source-dirty', ''))).toBe(false);
  });

  it('status-bar 来源只出现在状态栏与编辑控制器的类型中', () => {
    const users = collectTsFiles(join(REPO_ROOT, 'src'))
      .filter((file) => /'status-bar'/.test(stripComments(read(file))))
      .map(posixPath)
      .sort();
    expect(users).toEqual(['src/renderer/app/editor/editorController.ts', 'src/renderer/components/EditorStatusBar.tsx']);
  });

  it('Toolbar：dirty 只用于禁用 Open（读取 Editor Core 的派生函数），不新增其它入口', () => {
    const toolbar = stripComments(read(join(RENDERER, 'components/Toolbar.tsx')));
    expect(toolbar).toContain('const dirty = useMuseAppStore((state) => isSourceDirty(state.session));');
    expect(toolbar).toContain("disabled={open.phase !== 'idle' || dirty}");
    expect(/museEditorController|menuBridge/.test(toolbar)).toBe(false);
  });
});

describe('M3 T3b 架构守卫 —— main 菜单与窗口接线', () => {
  const main = stripComments(read(MAIN));

  it('src/main/menu/** 不 import electron，只依赖 shared 与同目录模块', () => {
    const files = collectTsFiles(MENU_DIR);
    expect(files.map(posixPath).sort()).toEqual(['src/main/menu/appMenu.ts', 'src/main/menu/wireEditorWindow.ts']);
    for (const file of files) {
      const imports = parseImports(file, read(file)).map((record) => resolveSpecifier(file, record.specifier));
      for (const resolved of imports) {
        expect(resolved === null || resolved === undefined ? `bare-or-unresolved` : posixPath(resolved)).toMatch(/^src\/(shared|main\/menu)\//);
      }
      expect(/from 'electron'/.test(read(file))).toBe(false);
    }
  });

  it('菜单只经 installAppMenu 安装：main 与 smoke 各恰一次，Menu.setApplicationMenu 只出现在该调用的注入函数中', () => {
    expect(count(main, /installAppMenu\(/g)).toBe(1);
    expect(count(main, /Menu\.setApplicationMenu\(/g)).toBe(1);
    expect(main.indexOf('installAppMenu({')).toBeLessThan(main.indexOf('Menu.setApplicationMenu(menu);'));
    const smoke = stripComments(read(join(SMOKE_DIR, 'smokeMain.entry.ts')));
    expect(count(smoke, /installAppMenu\(/g)).toBe(1);
    expect(count(smoke, /Menu\.setApplicationMenu\(/g)).toBe(1);
    const setters = [...collectTsFiles(join(REPO_ROOT, 'src')), ...collectTsFiles(SMOKE_DIR)]
      .filter((file) => /Menu\.setApplicationMenu\(/.test(stripComments(read(file))))
      .map(posixPath)
      .sort();
    expect(setters).toEqual(['src/main/main.ts', 'tests/electron/ipcSmoke/smokeMain.entry.ts']);
  });

  it('菜单模块没有危险 role；产品命令项不带 role', () => {
    const menu = stripComments(read(join(MENU_DIR, 'appMenu.ts')));
    expect(/role: '(undo|redo|reload|forceReload|editMenu|viewMenu|fileMenu)'/.test(menu)).toBe(false);
    expect(/'(undo|redo|reload|forceReload|editMenu|viewMenu|fileMenu)'/.test(menu.slice(menu.indexOf('export type AppMenuRole'), menu.indexOf('export interface AppMenuItem')))).toBe(false);
  });

  it('反例：加回 role undo / reload 会被识别', () => {
    expect(/role: '(undo|redo|reload|forceReload|editMenu|viewMenu|fileMenu)'/.test("{ role: 'reload' }")).toBe(true);
    expect(/role: '(undo|redo|reload|forceReload|editMenu|viewMenu|fileMenu)'/.test("{ role: 'undo' }")).toBe(true);
  });

  it('main.ts：new BrowserWindow 次数 = wireEditorWindow 次数；在安全与 Open 接线之后、加载页面之前', () => {
    expect(count(main, /new BrowserWindow\(/g)).toBe(count(main, /wireEditorWindow\(/g));
    expect(main).toContain('wireEditorWindow(editorCommands, mainWindow);');
    expect(main.indexOf('wireOpenIpcWindow(openIpc, mainWindow);')).toBeLessThan(main.indexOf('wireEditorWindow(editorCommands, mainWindow);'));
    expect(main.indexOf('wireWindowSecurity(mainWindow.webContents')).toBeLessThan(main.indexOf('wireEditorWindow(editorCommands, mainWindow);'));
    expect(main.indexOf('wireEditorWindow(editorCommands, mainWindow);')).toBeLessThan(main.indexOf('mainWindow.loadURL('));
    expect(main).toContain('send: sendMenuCommand,');
    expect(main).toContain('editorCommands.handleMenuCommand(command, window, event);');
  });

  it('smoke 窗口工厂：每个窗口无条件经生产 wireEditorWindow 登记（与 new BrowserWindow 一一对应）', () => {
    const windows = stripComments(read(join(SMOKE_DIR, 'windows.ts')));
    expect(count(windows, /new BrowserWindow\(/g)).toBe(1);
    expect(count(windows, /wireEditorWindow\(/g)).toBe(1);
    expect(windows).toContain('    wireEditorWindow(deps.editorCommands, win);\n');
    expect(windows.indexOf('wireEditorWindow(deps.editorCommands, win);')).toBeGreaterThan(windows.indexOf('wireOpenIpcWindow(deps.openIpc, win)'));
    const smoke = stripComments(read(join(SMOKE_DIR, 'smokeMain.entry.ts')));
    expect(smoke).toContain('sendMenuCommand(contents, message);');
  });

  it('src/main/** 不出现写盘 API（T3 零写盘）', () => {
    const WRITE_API = /\b(writeFile|appendFile|createWriteStream|rename|unlink|rmdir|rm|mkdir|copyFile|truncate|ftruncate|symlink|chmod|utimes|cp)(Sync)?\s*\(/;
    const offenders = collectTsFiles(join(REPO_ROOT, 'src/main')).filter((file) => WRITE_API.test(stripComments(read(file))));
    expect(offenders.map(posixPath)).toEqual([]);
    expect(WRITE_API.test("await writeFile(path, 'x');")).toBe(true);
    expect(WRITE_API.test('fs.renameSync(a, b);')).toBe(true);
  });
});
