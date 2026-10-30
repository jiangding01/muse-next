/**
 * M3 T4 B3a-1 架构守卫（B3 r0.1 勘误 §1 / §2 / §5.4；GA12 §3；Gate B3a-1 追加硬门 5：按阶段核验允许调用者）。
 *
 * - R1：renderer 中 `rejectDocument(` 只在 `save/rejectLedger.ts` 中、且都位于 `createRejectLedger(...)` 的参数中（GA12 §3，r0 §7）。
 * - R2：产品 Open 控制器注入了共享账本与共享准入（`ledger: museRejectLedger`、`admission: museOpenAdmission`）。
 * - L1：`tryAcquire(` 只在 `openEntry.ts` 的 `admit` 中、直接位于其函数体（不在回调里）调用，且 `admit` 中没有 `await`
 *   （首个 await 之前同步获取）。
 * - L2：准入租约的释放只经 `openEntry.ts`（`deps.gate.release(lease)`）；`museFileIntentGate` 只由 `openEntry.ts` 使用；
 *   `museRejectLedger` 只由 `openController.ts` 与 `openEntry.ts` 使用。B3a-2 / B3b 的调用者在各自批次再追加。
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

  it('L1：tryAcquire( 只在 openEntry.ts 的 admit 中调用，且 admit 中没有 await', () => {
    expect(callSites(files, 'tryAcquire')).toEqual(['src/renderer/app/editor/openEntry.ts#admit']);
    const entry = join(RENDERER, 'app/editor/openEntry.ts');
    let awaitsInAdmit = 0;
    walk(parse(entry, read(entry)), (node) => {
      if (isAwaitExpression(node) && enclosingName(node) === 'admit') awaitsInAdmit += 1;
    });
    expect(awaitsInAdmit).toBe(0);
  });

  it('L2：租约释放只经 openEntry（gate.release）；museFileIntentGate / museRejectLedger 的使用者精确', () => {
    const gateReleases = files.flatMap((file) => gateReleaseSites(file, read(file)));
    expect([...new Set(gateReleases)].sort()).toEqual(['src/renderer/app/editor/openEntry.ts:lease']);
    // 经准入层的释放（勘误 §5.4）：只在 Open 控制器、只以本事务持有的租约变量为实参；准入实例只由控制器使用。
    expect(files.flatMap((file) => gateReleaseSites(file, read(file), /admission$/i))).toEqual(['src/renderer/app/editor/openController.ts:lease']);
    expect(users(files, /\bmuseOpenAdmission\b/)).toEqual(['src/renderer/app/editor/openController.ts', 'src/renderer/app/editor/openEntry.ts']);
    expect(users(files, /\bmuseFileIntentGate\b/)).toEqual(['src/renderer/app/editor/openEntry.ts']);
    expect(users(files, /\bmuseRejectLedger\b/).filter((file) => file !== 'src/renderer/app/save/rejectLedger.ts')).toEqual([
      'src/renderer/app/editor/openController.ts',
      'src/renderer/app/editor/openEntry.ts',
    ]);
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
});
