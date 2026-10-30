/**
 * M3 T4 B3a-1 架构守卫（B3 r0.1 勘误 §1 / §2 / §5.4；GA12 §3；Gate B3a-1 追加硬门 5：按阶段核验允许调用者）。
 *
 * - R1：renderer 中 `rejectDocument(` 只在 `save/rejectLedger.ts` 中、且都位于 `createRejectLedger(...)` 的参数中（GA12 §3，r0 §7）。
 * - R2：产品 Open 控制器注入了共享账本与共享准入（`ledger: museRejectLedger`、`admission: museOpenAdmission`）。
 * - L1：`tryAcquire(` 只在 `openEntry.ts` 的 `admit` 与（B3a-2）`saveController.ts` 的 `start` 中、直接位于其函数体（不在回调里）
 *   调用，且这两个入口函数中没有 `await`（首个 await 之前同步获取）。
 * - L2：准入租约的释放只经 `openEntry.ts`（`deps.gate.release(lease)`）；`museFileIntentGate` 只由 `openEntry.ts` 使用；
 *   `museRejectLedger` 只由 `openController.ts` 与 `openEntry.ts` 使用。B3a-2 追加 `saveController.ts`（获取、释放、账本）与
 *   `unloadBlocker.ts`（只读租约，beforeunload 覆盖完整保存租约）；B3b 的调用者在其批次再追加。
 * - S1–S5（B3a-2，r0 §7 新增守卫）：保存控制器是唯一调用 `requestSaveTarget` / `saveDocument` 的文件；`saveTransaction` /
 *   `saveMessages` 是纯模块；保存路径不调用 `.discard(`；组件不使用 `museDesktop` 与保存协议标识符；S 键只经菜单加速键派发。
 * - P1：`fileIntentGate.ts` 与 `rejectLedger.ts` 不依赖 store、React 或编辑器状态（只依赖 shared 类型）。
 *
 * 每条规则都有反例。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  forEachChild,
  isArrowFunction,
  isAwaitExpression,
  isCallExpression,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyAssignment,
  isVariableDeclaration,
} from 'typescript';
import type { Node } from 'typescript';
import { describe, expect, it } from 'vitest';

import { collectTsFiles, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const RENDERER = join(REPO_ROOT, 'src/renderer');
const read = (file: string): string => readFileSync(file, 'utf8');
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function walk(node: Node, visit: (node: Node) => void): void {
  visit(node);
  forEachChild(node, (child) => walk(child, visit));
}

const calleeName = (node: Node): string | null => {
  if (!isCallExpression(node)) return null;
  if (isIdentifier(node.expression)) return node.expression.text;
  if (isPropertyAccessExpression(node.expression)) return node.expression.name.text;
  return null;
};

/** 最近的具名函数（声明、方法、对象方法属性或 `const f = () =>`）。 */
function enclosingName(node: Node): string {
  for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if ((isFunctionDeclaration(current) || isMethodDeclaration(current)) && current.name !== undefined) return current.name.getText();
    if ((isVariableDeclaration(current) || isPropertyAssignment(current)) && current.name !== undefined) {
      const init = isVariableDeclaration(current) ? current.initializer : current.initializer;
      if (init !== undefined && /=>|function/.test(init.getText().slice(0, 200))) return current.name.getText();
    }
  }
  return '<module>';
}

/** R1：不在 `createRejectLedger(...)` 参数中的 `rejectDocument(` 调用。 */
function rejectOutsideLedger(file: string, source: string): number {
  let offenders = 0;
  walk(parse(file, source), (node) => {
    if (calleeName(node) !== 'rejectDocument') return;
    let inside = false;
    for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (calleeName(current) === 'createRejectLedger') {
        inside = true;
        break;
      }
    }
    if (!inside) offenders += 1;
  });
  return offenders;
}

/** 最近的外层函数是否就是具名函数本身（不在任何匿名回调里）。 */
function directlyIn(node: Node): boolean {
  for (let current: Node | undefined = node.parent; current !== undefined; current = current.parent) {
    if (isArrowFunction(current) || isFunctionExpression(current)) {
      const owner = current.parent;
      return isVariableDeclaration(owner) || isPropertyAssignment(owner);
    }
    if (isFunctionDeclaration(current) || isMethodDeclaration(current)) return true;
  }
  return true;
}

/** 某源码中调用某名字的位置（文件#函数；在匿名回调里的标 `#<callback>`）。 */
function sourceCallSites(file: string, source: string, callee: string): string[] {
  const sites: string[] = [];
  walk(parse(file, source), (node) => {
    if (calleeName(node) === callee) sites.push(`${posixPath(file)}#${directlyIn(node) ? enclosingName(node) : '<callback>'}`);
  });
  return sites;
}

/** 调用某名字的位置（文件#函数）。 */
const callSites = (files: readonly string[], callee: string): string[] => files.flatMap((file) => sourceCallSites(file, read(file), callee)).sort();

/** `…gate.release(x)` 形式的释放点（文件:实参）；`receiver` 匹配接收者文本（缺省为准入租约本身）。 */
function gateReleaseSites(file: string, source: string, receiver: RegExp = /gate$/i): string[] {
  const sites: string[] = [];
  walk(parse(file, source), (node) => {
    if (isCallExpression(node) && isPropertyAccessExpression(node.expression) && node.expression.name.text === 'release' && receiver.test(node.expression.expression.getText())) {
      sites.push(`${posixPath(file)}:${node.arguments.map((arg) => arg.getText()).join(',')}`);
    }
  });
  return sites;
}

const users = (files: readonly string[], identifier: RegExp): string[] => files.filter((file) => identifier.test(stripComments(read(file)))).map(posixPath).sort();

describe('M3 T4 B3a-1 守卫 —— reject 只经账本（R1 / R2）', () => {
  const files = collectTsFiles(RENDERER);

  it('R1：renderer 中 rejectDocument( 只在 rejectLedger.ts 中、且都在 createRejectLedger(...) 的参数中', () => {
    expect(files.map((file) => [posixPath(file), rejectOutsideLedger(file, read(file))]).filter(([, n]) => n !== 0)).toEqual([]);
    // 不空跑：产品账本与桥账本工厂各有一处，都在 rejectLedger.ts。
    expect(callSites(files, 'rejectDocument').map((site) => site.split('#')[0])).toEqual(['src/renderer/app/save/rejectLedger.ts', 'src/renderer/app/save/rejectLedger.ts']);
  });

  it('R1 反例：直接调用、或在账本之外的闭包中调用都被识别', () => {
    const fake = join(RENDERER, '__fake__.ts');
    expect(rejectOutsideLedger(fake, 'function f(b: B) { void b.rejectDocument(t); }')).toBe(1);
    expect(rejectOutsideLedger(fake, 'const send = (b: B) => b.rejectDocument(t); createRejectLedger({ reject: send });')).toBe(1);
    expect(rejectOutsideLedger(fake, 'createRejectLedger({ reject: (t) => window.museDesktop.rejectDocument(t) });')).toBe(0);
  });

  it('R2：产品 Open 控制器注入共享账本与共享准入', () => {
    const controller = stripComments(read(join(RENDERER, 'app/editor/openController.ts')));
    const wiring = controller.slice(controller.indexOf('export const museOpenController'));
    expect(wiring).toContain('  ledger: museRejectLedger,');
    expect(wiring).toContain('  admission: museOpenAdmission,');
  });
});

describe('M3 T4 B3a-1 守卫 —— 准入租约（L1 / L2，按阶段）', () => {
  const files = collectTsFiles(RENDERER).filter((file) => posixPath(file) !== 'src/renderer/app/fileIntentGate.ts');

  it('L1：tryAcquire( 只在 openEntry.ts 的 admit 与 saveController.ts 的 start 中调用，且这两个入口中没有 await', () => {
    expect(callSites(files, 'tryAcquire')).toEqual(['src/renderer/app/editor/openEntry.ts#admit', 'src/renderer/app/save/saveController.ts#start']);
    for (const [rel, name] of [
      ['app/editor/openEntry.ts', 'admit'],
      ['app/save/saveController.ts', 'start'],
    ] as const) {
      const entry = join(RENDERER, rel);
      let awaits = 0;
      walk(parse(entry, read(entry)), (node) => {
        if (isAwaitExpression(node) && enclosingName(node) === name) awaits += 1;
      });
      expect(awaits, rel).toBe(0);
    }
  });

  it('L2：租约释放只经 openEntry（gate.release）；museFileIntentGate / museRejectLedger 的使用者精确', () => {
    const gateReleases = files.flatMap((file) => gateReleaseSites(file, read(file)));
    expect([...new Set(gateReleases)].sort()).toEqual(['src/renderer/app/editor/openEntry.ts:lease', 'src/renderer/app/save/saveController.ts:lease']);
    // 经准入层的释放（勘误 §5.4）：只在 Open 控制器、只以本事务持有的租约变量为实参；准入实例只由控制器使用。
    expect(files.flatMap((file) => gateReleaseSites(file, read(file), /admission$/i))).toEqual(['src/renderer/app/editor/openController.ts:lease']);
    expect(users(files, /\bmuseOpenAdmission\b/)).toEqual(['src/renderer/app/editor/openController.ts', 'src/renderer/app/editor/openEntry.ts']);
    expect(users(files, /\bmuseFileIntentGate\b/)).toEqual([
      'src/renderer/app/editor/openEntry.ts',
      'src/renderer/app/editor/unloadBlocker.ts',
      'src/renderer/app/save/saveController.ts',
    ]);
    expect(users(files, /\bmuseRejectLedger\b/).filter((file) => file !== 'src/renderer/app/save/rejectLedger.ts')).toEqual([
      'src/renderer/app/editor/openController.ts',
      'src/renderer/app/editor/openEntry.ts',
      'src/renderer/app/save/saveController.ts',
    ]);
    // unloadBlocker 只读租约（current），不获取、不释放。
    const unload = stripComments(read(join(RENDERER, 'app/editor/unloadBlocker.ts')));
    expect(unload.match(/museFileIntentGate\.\w+/g)).toEqual(['museFileIntentGate.current']);
  });

  it('L1 / L2 反例：await 之后获取、在回调里获取、在别处释放都被识别', () => {
    const fake = join(RENDERER, '__fake__.ts');
    const source = 'async function admit() { await flush(); const lease = gate.tryAcquire("open", 1); gate.release(other); }';
    let awaits = 0;
    walk(parse(fake, source), (node) => {
      if (isAwaitExpression(node) && enclosingName(node) === 'admit') awaits += 1;
    });
    expect(awaits).toBe(1);
    expect(gateReleaseSites(fake, source)).toEqual(['src/renderer/__fake__.ts:other']);
    expect(gateReleaseSites(fake, 'deps.admission?.release(stale); museOpenAdmission.release(x);', /admission$/i)).toEqual(['src/renderer/__fake__.ts:stale', 'src/renderer/__fake__.ts:x']);
    const deferred = 'const x = { admit(h) { ledger.flush().then(() => { const lease = deps.gate.tryAcquire("open", 1); }); } };';
    expect(sourceCallSites(fake, deferred, 'tryAcquire')).toEqual(['src/renderer/__fake__.ts#<callback>']);
    const direct = 'const x = { admit(h) { const lease = deps.gate.tryAcquire("open", 1); } };';
    expect(sourceCallSites(fake, direct, 'tryAcquire')).toEqual(['src/renderer/__fake__.ts#admit']);
  });
});

describe('M3 T4 B3a-1 守卫 —— 纯模块（P1）', () => {
  it.each(['src/renderer/app/fileIntentGate.ts', 'src/renderer/app/save/rejectLedger.ts'])('%s 只依赖 shared 类型', (rel) => {
    const file = join(REPO_ROOT, rel);
    const imports = parseImports(file, read(file)).map((record) => {
      const resolved = resolveSpecifier(file, record.specifier);
      return { path: resolved === null || resolved === undefined ? record.specifier : posixPath(resolved), typeOnly: record.typeOnly };
    });
    expect(imports.filter((item) => !(item.typeOnly && item.path.startsWith('src/shared/')))).toEqual([]);
  });

  it('saveMessages.ts（B3a-2）只有类型导入：shared 与 formats façade 的编码类型', () => {
    const file = join(REPO_ROOT, 'src/renderer/app/save/saveMessages.ts');
    const imports = parseImports(file, read(file)).map((record) => {
      const resolved = resolveSpecifier(file, record.specifier);
      return { path: resolved === null || resolved === undefined ? record.specifier : posixPath(resolved), typeOnly: record.typeOnly };
    });
    expect(imports).toEqual([
      { path: 'src/formats/jcxParse.ts', typeOnly: true },
      { path: 'src/shared/saveContracts.ts', typeOnly: true },
    ]);
  });

  it('saveTransaction.ts 是纯模块：只有类型导入（shared / formats façade / 同目录 / openTransaction 的类型），不碰 store、React 与平台', () => {
    const file = join(REPO_ROOT, 'src/renderer/app/save/saveTransaction.ts');
    const imports = parseImports(file, read(file)).map((record) => {
      const resolved = resolveSpecifier(file, record.specifier);
      return { path: resolved === null || resolved === undefined ? record.specifier : posixPath(resolved), typeOnly: record.typeOnly };
    });
    expect(imports.filter((item) => !item.typeOnly)).toEqual([]);
    expect(imports.map((item) => item.path).sort()).toEqual([
      'src/formats/jcxParse.ts',
      'src/renderer/app/editor/openTransaction.ts',
      'src/renderer/app/save/saveMessages.ts',
      'src/shared/activationContracts.ts',
      'src/shared/documentContracts.ts',
      'src/shared/saveContracts.ts',
    ]);
    expect(/\b(window|document|globalThis|navigator|useMuseAppStore)\b/.test(stripComments(read(file)))).toBe(false);
  });
});

describe('M3 T4 B3a-2 守卫 —— 保存协议的使用范围（S1–S5）', () => {
  const files = collectTsFiles(RENDERER);
  const components = files.filter((file) => posixPath(file).startsWith('src/renderer/components/'));

  it('S1：requestSaveTarget( / saveDocument( 只由 saveController.ts 调用', () => {
    const sites = [...callSites(files, 'requestSaveTarget'), ...callSites(files, 'saveDocument')].map((site) => site.split('#')[0]);
    expect([...new Set(sites)]).toEqual(['src/renderer/app/save/saveController.ts']);
    expect(sites.length).toBe(2);
  });

  it('S2：保存路径（app/save/）不调用 .discard(；DiscardReason 不变', () => {
    const save = files.filter((file) => posixPath(file).startsWith('src/renderer/app/save/'));
    expect(save.length).toBeGreaterThan(0);
    expect(save.filter((file) => /\.discard\(/.test(stripComments(read(file)))).map(posixPath)).toEqual([]);
    expect(/\.discard\(/.test('museImeSession.discard(\'x\')')).toBe(true);
  });

  it('S3：组件不使用 museDesktop、stepSaveFlow、requestSaveTarget、saveDocument、rejectDocument 与保存控制器', () => {
    const forbidden = /\b(museDesktop|stepSaveFlow|requestSaveTarget|saveDocument|rejectDocument|museSaveController|createSaveController)\b/;
    expect(components.length).toBeGreaterThan(0);
    expect(components.filter((file) => forbidden.test(stripComments(read(file)))).map(posixPath)).toEqual([]);
  });

  it('S4：S 键只经菜单加速键派发——main before-input-event 与 renderer 键盘处理都不匹配 S', () => {
    const intercept = stripComments(read(join(REPO_ROOT, 'src/main/menu/wireEditorWindow.ts')));
    const S_KEY = /\b(key|code)(\.toLowerCase\(\))?\s*===?\s*['"](s|S|KeyS)['"]|case\s+['"](s|S|KeyS)['"]\s*:|['"]KeyS['"]/;
    expect(S_KEY.test(intercept)).toBe(false);
    expect(files.filter((file) => S_KEY.test(stripComments(read(file)))).map(posixPath)).toEqual([]);
    for (const sample of ["if (key === 's') return 'save';", "if (input.key.toLowerCase() === 's')", "case 'S':", "code == 'KeyS'"]) expect(S_KEY.test(sample), sample).toBe(true);
  });

  it('S5：菜单 Save / Save As 的加速键与命令；菜单桥把它们转交保存控制器', () => {
    const menu = stripComments(read(join(REPO_ROOT, 'src/main/menu/appMenu.ts')));
    expect(menu).toContain("command('save', 'Save', 'CmdOrCtrl+S')");
    expect(menu).toContain("command('saveAs', 'Save As…', 'Shift+CmdOrCtrl+S')");
    const bridge = stripComments(read(join(RENDERER, 'app/editor/menuBridge.ts')));
    expect(bridge).toContain('museSaveController.save();');
    expect(bridge).toContain('museSaveController.saveAs();');
  });
});
