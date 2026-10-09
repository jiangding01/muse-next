/**
 * M3 架构守卫的静态分析辅助（测试侧 harness，用 TypeScript 编译器 API 解析 AST）。
 *
 * 与既有守卫的正则扫描不同，这里按 AST 区分「真实的标识符使用」与「注释 / 字符串字面量 / 属性名」，
 * 避免说明文字里出现 `window` 之类的词就误报。只供 `tests/unit/editor/**` 使用。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptKind,
  ScriptTarget,
  SyntaxKind,
  canHaveModifiers,
  createCompilerHost,
  createProgram,
  createSourceFile,
  flattenDiagnosticMessageText,
  forEachChild,
  getModifiers,
  getPreEmitDiagnostics,
  isCallExpression,
  isEnumMember,
  isExportAssignment,
  isExportDeclaration,
  isExportSpecifier,
  isExpressionWithTypeArguments,
  isExternalModuleReference,
  isHeritageClause,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isInterfaceDeclaration,
  isJsxElement,
  isJsxFragment,
  isJsxSelfClosingElement,
  isMethodDeclaration,
  isMethodSignature,
  isNamedExports,
  isNamedImports,
  isNamespaceImport,
  isNewExpression,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
  isPropertySignature,
  isQualifiedName,
  isSpreadElement,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeReferenceNode,
  isVariableStatement,
} from 'typescript';
import type { CompilerOptions, Identifier, Node, SourceFile } from 'typescript';

export const REPO_ROOT = resolve(import.meta.dirname, '../../..');

export const posixPath = (absolute: string): string => relative(REPO_ROOT, absolute).split(sep).join('/');

export interface ImportRecord {
  readonly specifier: string;
  readonly typeOnly: boolean;
  /** 导入 / 再导出的原始名字；`default`、`*` 表示默认导入与命名空间 / 整体再导出。 */
  readonly names: readonly string[];
  readonly kind: 'import' | 'export' | 'dynamic' | 'require';
}

export function collectTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return collectTsFiles(full);
      return /\.tsx?$/.test(entry.name) ? [full] : [];
    })
    .sort();
}

export function parse(fileName: string, source: string): SourceFile {
  return createSourceFile(fileName, source, ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ScriptKind.TSX : ScriptKind.TS);
}

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => {
    walk(child, visit);
  });
}

const containsJsx = (file: SourceFile): boolean => {
  let found = false;
  walk(file, (node) => {
    if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) found = true;
  });
  return found;
};

/**
 * 导入记录。`tsconfig` 开启了 `verbatimModuleSyntax`：只有子句级 `import type` / `export type` 会被完整擦除；
 * `import { type A }`（即使全部内联 type）在运行时仍保留为 `import {} from 'm'`，模块照样加载，因此按值依赖处理。
 * `.tsx` 中的 JSX 在 `jsx: react-jsx` 下会隐式引入 `react/jsx-runtime`，这里补成一条值依赖。
 */
export function parseImports(fileName: string, source: string): ImportRecord[] {
  const records: ImportRecord[] = [];
  const file = parse(fileName, source);
  walk(file, (node) => {
    if (isImportDeclaration(node) && isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const names: string[] = [];
      if (clause?.name !== undefined) names.push('default');
      const bindings = clause?.namedBindings;
      if (bindings !== undefined && isNamespaceImport(bindings)) names.push('*');
      if (bindings !== undefined && isNamedImports(bindings)) {
        for (const element of bindings.elements) names.push((element.propertyName ?? element.name).text);
      }
      const typeOnly = clause !== undefined && clause.phaseModifier === SyntaxKind.TypeKeyword;
      records.push({ specifier: node.moduleSpecifier.text, typeOnly, names, kind: 'import' });
    } else if (isExportDeclaration(node) && node.moduleSpecifier !== undefined && isStringLiteral(node.moduleSpecifier)) {
      const clause = node.exportClause;
      const named = clause !== undefined && isNamedExports(clause) ? clause.elements : undefined;
      const names = named === undefined ? ['*'] : named.map((element) => (element.propertyName ?? element.name).text);
      records.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly, names, kind: 'export' });
    } else if (isImportEqualsDeclaration(node) && isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (isStringLiteral(expression)) records.push({ specifier: expression.text, typeOnly: false, names: ['*'], kind: 'require' });
    } else if (isCallExpression(node)) {
      const [first] = node.arguments;
      const specifier = first !== undefined && isStringLiteral(first) ? first.text : '<non-literal>';
      if (node.expression.kind === SyntaxKind.ImportKeyword) records.push({ specifier, typeOnly: false, names: ['*'], kind: 'dynamic' });
      if (isIdentifier(node.expression) && node.expression.text === 'require') {
        records.push({ specifier, typeOnly: false, names: ['*'], kind: 'require' });
      }
    }
  });
  if (fileName.endsWith('.tsx') && containsJsx(file)) {
    records.push({ specifier: 'react/jsx-runtime', typeOnly: false, names: ['*'], kind: 'import' });
  }
  return records;
}

/**
 * Editor Core 禁止使用的运行时 / 平台全局（DOM、Node、定时器、取得全局对象的途径）。这是黑名单式的第一道防线；
 * 第二道防线是 `platformFreeDiagnostics`：以不含 DOM / Node 的类型环境编译 `src/editor`，从编译期整体排除平台全局。
 */
const FORBIDDEN_GLOBALS: ReadonlySet<string> = new Set([
  'window', 'document', 'navigator', 'location', 'globalThis', 'self', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'MessageChannel', 'BroadcastChannel', 'crypto', 'TextDecoder', 'TextEncoder',
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'alert', 'confirm', 'prompt',
  'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
  'process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'performance', 'eval', 'Function',
]);

/** 标识符是否只是「名字本身」（属性名、成员名、导入导出说明符、限定名右侧），而不是对同名全局的引用。 */
function isNamePosition(node: Identifier): boolean {
  const parent = node.parent;
  if (isPropertyAccessExpression(parent)) return parent.name === node;
  if (isQualifiedName(parent)) return parent.right === node;
  if (isImportSpecifier(parent) || isExportSpecifier(parent)) return true;
  if (
    isPropertyAssignment(parent) ||
    isPropertySignature(parent) ||
    isPropertyDeclaration(parent) ||
    isMethodSignature(parent) ||
    isMethodDeclaration(parent) ||
    isEnumMember(parent)
  ) {
    return parent.name === node;
  }
  return false;
}

/**
 * 找出源码中对禁用全局的真实使用（`名字@行号`）；注释、字符串、属性名不计。
 * 墙钟：`Date` 的任何值位置使用都算违规（`Date.now`、`Date()`、别名、下标访问、无参 `new Date()`），
 * 只放行带参数的 `new Date(x)` 与类型位置；JSX 一律违规。
 */
export function forbiddenGlobalUses(fileName: string, source: string): string[] {
  const file = parse(fileName, source);
  const hits: string[] = [];
  const line = (node: Node): number => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  walk(file, (node) => {
    if (isJsxElement(node) || isJsxSelfClosingElement(node) || isJsxFragment(node)) hits.push(`jsx@${String(line(node))}`);
    if (!isIdentifier(node) || isNamePosition(node)) return;
    if (FORBIDDEN_GLOBALS.has(node.text)) hits.push(`${node.text}@${String(line(node))}`);
    if (node.text === 'Date') {
      const parent = node.parent;
      // 只有 interface 继承与 implements 子句才是类型位置；`class C extends Date` 是值位置。
      const heritage = isExpressionWithTypeArguments(parent) && isHeritageClause(parent.parent) ? parent.parent : undefined;
      const typePosition =
        isTypeReferenceNode(parent) ||
        (heritage !== undefined && (heritage.token === SyntaxKind.ImplementsKeyword || isInterfaceDeclaration(heritage.parent)));
      // `new Date(...[])` 实际读取当前时间：首个参数是展开参数时不放行。
      const [firstArgument] = isNewExpression(parent) && parent.expression === node ? (parent.arguments ?? []) : [];
      const constructedWithArgs = firstArgument !== undefined && !isSpreadElement(firstArgument);
      if (!typePosition && !constructedWithArgs) hits.push(`Date@${String(line(node))}`);
    }
  });
  return hits;
}

const isExported = (node: Node): boolean =>
  canHaveModifiers(node) && (getModifiers(node) ?? []).some((modifier) => modifier.kind === SyntaxKind.ExportKeyword);

/**
 * 模块的导出名：值导出与类型导出分开列出；`export *` / `export * as ns` 记为 `*`，`export default` 记为 `default`，
 * `export =` 记为 `export=`，解构导出记为 `<destructured-export>`。
 */
export function exportedNames(fileName: string, source: string): { values: string[]; types: string[] } {
  const values: string[] = [];
  const types: string[] = [];
  for (const statement of parse(fileName, source).statements) {
    if (isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      if (clause !== undefined && isNamedExports(clause)) {
        for (const element of clause.elements) (statement.isTypeOnly || element.isTypeOnly ? types : values).push(element.name.text);
      } else {
        (statement.isTypeOnly ? types : values).push('*');
      }
    } else if (isExportAssignment(statement)) {
      values.push(statement.isExportEquals === true ? 'export=' : 'default');
    } else if (isExported(statement)) {
      if (isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          values.push(isIdentifier(declaration.name) ? declaration.name.text : '<destructured-export>');
        }
      } else if (isInterfaceDeclaration(statement) || isTypeAliasDeclaration(statement)) {
        types.push(statement.name.text);
      } else {
        values.push('<other-export>');
      }
    }
  }
  return { values: values.sort(), types: types.sort() };
}

const isFile = (path: string): boolean => existsSync(path) && statSync(path).isFile();

/** 解析相对说明符到绝对文件路径；裸说明符返回 `null`，解析不到返回 `undefined`。 */
export function resolveSpecifier(fromFile: string, specifier: string): string | null | undefined {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), specifier);
  return [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx'), base].find(
    (candidate) => /\.tsx?$/.test(candidate) && isFile(candidate),
  );
}

export interface ValueClosure {
  /** 仓库相对路径，含入口本身。 */
  readonly files: readonly string[];
  readonly bare: readonly string[];
  readonly dynamic: readonly string[];
  readonly unresolved: readonly string[];
}

/** 从入口出发沿「值」依赖边（跳过纯类型导入 / 再导出）递归，求静态值依赖闭包。 */
export function valueClosure(entry: string): ValueClosure {
  const seen = new Set<string>();
  const bare = new Set<string>();
  const dynamic = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const record of parseImports(file, readFileSync(file, 'utf8'))) {
      if (record.typeOnly) continue;
      if (record.kind === 'dynamic' || record.kind === 'require') dynamic.add(`${posixPath(file)} → ${record.specifier}`);
      const target = resolveSpecifier(file, record.specifier);
      if (target === null) bare.add(record.specifier);
      else if (target === undefined) unresolved.add(`${posixPath(file)} → ${record.specifier}`);
      else queue.push(target);
    }
  }
  return { files: [...seen].map(posixPath).sort(), bare: [...bare].sort(), dynamic: [...dynamic].sort(), unresolved: [...unresolved].sort() };
}

/**
 * 以不含 DOM / Node 的类型环境（`lib: ES2023`、`types: []`）编译给定根文件，只返回根文件自身的诊断。
 * `src/editor/**` 若使用任何平台全局（值或类型，如 `setTimeout`、`HTMLTextAreaElement`、`NodeJS.Timeout`）都会在这里报错，
 * 比黑名单扫描更彻底。依赖链上的其它文件（如 formats 中使用 TextDecoder 的解码器）不在检查范围内。
 * `virtualFiles` 用于注入内存中的反例文件（绝对路径 → 源码）。
 */
export function platformFreeDiagnostics(rootFiles: readonly string[], virtualFiles: ReadonlyMap<string, string> = new Map()): string[] {
  const options: CompilerOptions = {
    target: ScriptTarget.ES2023,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
    lib: ['lib.es2023.d.ts'],
    types: [],
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
  };
  // TS 会把根文件路径规范为正斜杠（Windows 上 host 收到的是 `D:/…`），虚拟文件的 key 统一规范化后再查。
  const toKey = (path: string): string => path.split('\\').join('/');
  const virtual = new Map([...virtualFiles].map(([path, text]) => [toKey(path), text]));
  const host = createCompilerHost(options);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (fileName) => virtual.has(toKey(fileName)) || fileExists(fileName);
  host.readFile = (fileName) => virtual.get(toKey(fileName)) ?? readFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = virtual.get(toKey(fileName));
    return text === undefined
      ? getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
      : createSourceFile(fileName, text, languageVersion, true);
  };
  const program = createProgram({ rootNames: [...rootFiles], options, host });
  const messages = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()].map((diagnostic) =>
    flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  );
  for (const root of rootFiles) {
    const sourceFile = program.getSourceFile(root);
    if (sourceFile === undefined) {
      messages.push(`${posixPath(root)}: 未进入编译`);
      continue;
    }
    for (const diagnostic of getPreEmitDiagnostics(program, sourceFile)) {
      messages.push(`${posixPath(root)}: ${flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`);
    }
  }
  return messages;
}
