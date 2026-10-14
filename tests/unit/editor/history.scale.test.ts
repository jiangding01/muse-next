/**
 * M3 T2 History —— 规模、结构共享与复杂文本（Preflight r3 §6.8；测试 #26、#27、#28）。
 *
 * - CI 只依赖结构与正确性断言，不做计时断言（避免抖动）；每个用例显式 30 s 超时。
 * - 已接受的 C2 风险：引擎可能让较长子串保留整份旧 source，真实内存无法在单测中可靠度量；这里用大文本与长会话
 *   验证正确性与「栈操作不随历史深度增长」的结构性质。注意栈操作 O(1) 不代表整个编辑 O(1)：每次 source 变化都经
 *   T0 reducer（切片 + 投影重建），为 O(n)。
 */

import { describe, expect, it } from 'vitest';

import { commitTransaction, redo, undo } from '../../../src/editor/history/history';
import type { HistoryState } from '../../../src/editor/history/types';
import { begin, caretAt, edit, expectText, inputFor, undoDepth } from './historyKit';
import type { Editor } from './historyKit';
import { createPrng } from './prng';

const SLOW = { timeout: 30_000 };
const at = (editor: Editor, offset: number): Editor => ({ ...editor, selection: caretAt(editor.session, offset) });
const filler = (length: number): string => Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');

function undoAll(editor: Editor): Editor {
  let current = editor;
  while (current.history.undo !== null) {
    const result = undo(current.session, current.history);
    if (!result.ok) throw new Error(result.reason);
    current = result;
  }
  return current;
}

function redoAll(editor: Editor): Editor {
  let current = editor;
  while (current.history.redo !== null) {
    const result = redo(current.session, current.history);
    if (!result.ok) throw new Error(result.reason);
    current = result;
  }
  return current;
}

describe('M3 T2 History —— 长文本高频合并（#26）', () => {
  const BASE = filler(8 * 1024);

  it('8 KB 文本中连续插入 2,000 个字符：栈 1 项、组内 1 个补丁、一次 undo 逐字还原', SLOW, () => {
    let editor = at(begin(BASE), 4096);
    for (let i = 0; i < 2000; i += 1) {
      const caret = editor.selection.ranges[0]?.start ?? 0;
      editor = edit(editor, [{ start: caret, end: caret, text: i % 7 === 0 ? '中' : 'x' }], { coalesce: 'insert', timestamp: i * 10 });
    }
    expect(undoDepth(editor.history)).toBe(1);
    expect(editor.history.undo?.top.patches).toHaveLength(1);
    expect(editor.history.undo?.top.patches[0]?.text).toHaveLength(2000);
    expect(editor.history.undo?.top.inverse).toEqual([{ start: 4096, end: 6096, text: '' }]);
    const undone = undoAll(editor);
    expectText(undone, BASE);
    expectText(redoAll(undone), editor.session.source);
  });

  it.each([
    ['向后', 'delete-backward', 6000],
    ['向前', 'delete-forward', 2000],
  ] as const)('8 KB 文本中连续%s删除 1,000 次：栈 1 项、合成逆补丁恰为被删原文、undo 还原', (_name, kind, caret) => {
    let editor = at(begin(BASE), caret);
    for (let i = 0; i < 1000; i += 1) {
      const c = editor.selection.ranges[0]?.start ?? 0;
      const patch = kind === 'delete-backward' ? { start: c - 1, end: c, text: '' } : { start: c, end: c + 1, text: '' };
      editor = edit(editor, [patch], { coalesce: kind, timestamp: i * 10 });
    }
    expect(undoDepth(editor.history)).toBe(1);
    const removed = kind === 'delete-backward' ? BASE.slice(caret - 1000, caret) : BASE.slice(caret, caret + 1000);
    expect(editor.history.undo?.top.inverse[0]?.text).toBe(removed);
    expect(editor.session.source).toHaveLength(BASE.length - 1000);
    expectText(undoAll(editor), BASE);
  }, 30_000);
});

describe('M3 T2 History —— 长会话的结构共享（#27，结构断言，不计时）', () => {
  it('5,000 个独立事务：每次压栈只新建一个节点，rest 引用旧栈；size 递增；旧状态不被修改', SLOW, () => {
    const base = filler(2048);
    let editor = begin(base);
    const snapshots: HistoryState[] = [];
    for (let i = 0; i < 5000; i += 1) {
      const position = (i * 37) % base.length;
      const current = editor.session.source[position] ?? 'a';
      // 等长替换：文本长度 n 保持 2 KB 不变，规模只来自事务数。
      const next = edit(editor, [{ start: position, end: position + 1, text: current === 'z' ? 'y' : 'z' }]);
      expect(next.history.undo?.rest).toBe(editor.history.undo);
      expect(next.history.undo?.size).toBe(i + 1);
      if (i % 1000 === 0) snapshots.push(next.history);
      editor = next;
    }
    expect(editor.session.source).toHaveLength(2048);
    for (const [index, snapshot] of snapshots.entries()) expect(snapshot.undo?.size).toBe(index * 1000 + 1);
    // undo / redo 只移动链表头：undo 后的 undo 栈就是原来的 rest，redo 栈的 rest 是原来的 redo 栈。
    const undone = undo(editor.session, editor.history);
    if (!undone.ok) throw new Error(undone.reason);
    expect(undone.history.undo).toBe(editor.history.undo?.rest);
    const undone2 = undo(undone.session, undone.history);
    if (!undone2.ok) throw new Error(undone2.reason);
    expect(undone2.history.redo?.rest).toBe(undone.history.redo);
    const redone = redo(undone2.session, undone2.history);
    if (!redone.ok) throw new Error(redone.reason);
    expect(redone.history.redo).toBe(undone.history.redo);
    expect(redone.history.undo?.rest).toBe(undone2.history.undo);
  });

  it('合并路径：每步替换栈顶只新建一个节点，rest 与 size 不变', SLOW, () => {
    let editor = at(edit(begin(filler(2048)), [{ start: 0, end: 1, text: 'Q' }]), 100);
    const below = editor.history.undo;
    for (let i = 0; i < 3000; i += 1) {
      const caret = editor.selection.ranges[0]?.start ?? 0;
      const next = edit(editor, [{ start: caret, end: caret, text: 'k' }], { coalesce: 'insert', timestamp: i * 10 });
      if (i > 0) {
        expect(next.merged).toBe(true);
        expect(next.history.undo?.rest).toBe(below);
        expect(next.history.undo?.size).toBe(2);
      }
      editor = next;
    }
  });
});

describe('M3 T2 History —— 复杂换行与非 BMP 的高频合并（#28）', () => {
  it('在 CRLF、孤立 CR、受保护 U+FEFF、代理对附近于光标处连续插入 / 删除 1,000 步：大量合并；被拒的一步不改变状态也不打断合并组；全部 undo / redo 往返', SLOW, () => {
    const prng = createPrng(2026);
    const initial = '\uFEFFX:1\r\nT:😀𝄞\rK:C\nC D|\r\n';
    const hotspots = [1, 5, 6, 9, 11, 13, 14, 17, 22];
    let editor = at(begin(initial), 6);
    let kind: 'insert' | 'delete-backward' | 'delete-forward' = 'insert';
    let merged = 0;
    let rejected = 0;
    let mergedAfterRejection = 0;
    let lastWasRejection = false;
    for (let step = 0; step < 1000; step += 1) {
      if (prng.int(40) === 0) {
        const target = Math.min(prng.pick(hotspots), editor.session.source.length);
        editor = at(editor, target);
      }
      if (prng.int(6) === 0) kind = prng.pick(['insert', 'delete-backward', 'delete-forward'] as const);
      const source = editor.session.source;
      const caret = editor.selection.ranges[0]?.start ?? 0;
      const patch =
        kind === 'insert'
          ? { start: caret, end: caret, text: prng.int(12) === 0 ? prng.pick(['\r', '\n']) : prng.pick(['a', '中', '😀', '\uD834', '\uDD1E']) }
          : kind === 'delete-backward'
            ? { start: Math.max(0, caret - 1), end: caret, text: '' }
            : { start: caret, end: Math.min(source.length, caret + 1), text: '' };
      const result = commitTransaction(editor.session, editor.history, inputFor(editor, [patch], { coalesce: kind, timestamp: step * 5 }));
      if (!result.ok) {
        // 被拒：没有返回任何新状态；继续使用原来的一对，合并组（open）原样保留。
        rejected += 1;
        lastWasRejection = true;
        continue;
      }
      if (result.changed && result.merged) {
        merged += 1;
        if (lastWasRejection) mergedAfterRejection += 1;
      }
      lastWasRejection = false;
      editor = result;
    }
    expect(merged).toBeGreaterThan(300);
    expect(rejected).toBeGreaterThan(10);
    expect(mergedAfterRejection).toBeGreaterThan(0);
    const final = editor.session.source;
    const undone = undoAll(editor);
    expectText(undone, initial);
    expectText(redoAll(undone), final);
  });
});
