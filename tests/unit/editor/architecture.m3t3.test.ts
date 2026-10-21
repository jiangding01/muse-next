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
