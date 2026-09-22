/**
 * Parse 层 —— TAB 形态的值对象构建（M1.6 T6；spec §26）。
 *
 * 与 `scanPitch.ts` 对称：只把 AST 的 `tabNote` 翻译成 Domain `TabNote` 值对象。
 * `-S-` / `-H-` / `-P-` 是 marker，本模块不碰（T7）。
 *
 * `scanTopLevelItems`（M2.5 formats preflight，2026-09-22 新增）单独处理弦组前缀：
 * 作用于整个弦组的 `strokePrefix`（`V[...]` 的 `V`）在 AST 里是 `tabGroup` 的顶层
 * 兄弟节点而非子节点（见 `groupTab.ts` 的 `absorbsStrokePrefix` 注释），只能在
 * 顶层扫描时靠「相邻」绑定，回填进 `TabGroupEvent.stroke`；放在本文件而不是
 * `scan.ts` 纯粹是为了不把 `scan.ts` 顶到 350 行上限，调用方注入
 * `scanNode` / `scanTabGroup` 回调，避免与 `scan.ts` 形成循环依赖。
 */

import type { JcxBodyNode, JcxTabGroupNode, JcxTabNoteNode } from '../../ast';
import type { TabNote } from '../../../../domain';
import type { ScanValueContext } from './scanPitch';
import { tabDuration } from './scanPitch';

/** §26.2：`a`–`f` → 第 1–6 弦。大写字母在 TAB 中的含义 UNVERIFIED，不映射。 */
const STRING_INDEX: ReadonlyMap<string, TabNote['stringIndex']> = new Map([
  ['a', 1],
  ['b', 2],
  ['c', 3],
  ['d', 4],
  ['e', 5],
  ['f', 6],
]);

function rawOf(node: JcxTabNoteNode, kind: string): string {
  let text = '';
  for (const child of node.children) {
    if (child.token.kind === kind) {
      text += child.raw;
    }
  }
  return text;
}

/** 组合节点不存 raw（AST 不变量），需要原文时由 children 拼回。 */
export function tabNoteRaw(node: JcxTabNoteNode): string {
  return node.children.map((child) => child.raw).join('');
}

/**
 * §26.3：`fret = digit+ | "x"`。`x` 是「品位由和弦图决定的右手拨弦」，不是未知值。
 * 非数字、非 `x`（含缺省）返回 `undefined`，调用方降级为 `UnknownEvent`，不猜品位。
 */
function parseFret(raw: string): number | 'x' | undefined {
  if (raw === 'x') {
    return 'x';
  }
  if (!/^\d+$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * AST `tabNote` → Domain `TabNote`。
 *
 * 返回 `undefined` 表示「弦号不在 a–f，或缺品位」——这两种形态在 Domain 里无法
 * 如实表达（`stringIndex` / `fret` 都是必填事实），故退回 `UnknownEvent` 保留原文。
 */
export function buildTabNote(node: JcxTabNoteNode, dur: ScanValueContext): TabNote | undefined {
  const stringIndex = STRING_INDEX.get(rawOf(node, 'stringLetter'));
  if (stringIndex === undefined) {
    return undefined;
  }
  const fret = parseFret(rawOf(node, 'fret'));
  if (fret === undefined) {
    return undefined;
  }
  const stroke = rawOf(node, 'strokePrefix');
  return {
    stringIndex,
    fret,
    ...(stroke === '' ? {} : { stroke }),
    ...tabDuration(node.children, node, dur),
    origin: node.path,
  };
}

/**
 * §26.4：顶层扫描 `items` 时，紧邻右边 `tabGroup`（`V[...]`）的 `strokePrefix` 一次性
 * 绑定为 group stroke、跳两格，不落 marker；其余 item 照常交给 `scanNode`。
 */
export function scanTopLevelItems(
  items: readonly JcxBodyNode[],
  scanNode: (item: JcxBodyNode) => void,
  scanTabGroup: (node: JcxTabGroupNode, stroke: string) => void,
): void {
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const next = items[index + 1];
    if (item === undefined) continue;
    if (item.kind === 'strokePrefix' && 'raw' in item && next?.kind === 'tabGroup') {
      scanTabGroup(next, item.raw);
      index += 1;
    } else {
      scanNode(item);
    }
  }
}
