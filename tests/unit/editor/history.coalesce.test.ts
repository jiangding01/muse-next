/**
 * M3 T2 History —— 合并规则与单补丁代数合成（Preflight r3 §6.3、§6.4；测试 #3–#6、#25）。
 *
 * 每类合成都把「合成后的单个补丁 / 逆补丁」与「逐步执行」逐字比对，不只依赖形式证明（Q3）。
 */

import { describe, expect, it } from 'vitest';

import { endCoalescing } from '../../../src/editor/history/history';
import { applyTextPatches } from '../../../src/editor/text/apply';
import type { TextPatch } from '../../../src/editor/text/types';
import { begin, caretAt, commit, edit, expectText, rangeOf, redoOk, typeText, undoDepth, undoOk } from './historyKit';
import type { Editor } from './historyKit';

function composedRoundTrip(start: string, editor: Editor): void {
  const tx = editor.history.undo?.top;
  if (tx === undefined) throw new Error('empty stack');
  expect(tx.patches).toHaveLength(1);
  expect(tx.inverse).toHaveLength(1);
  const forward = applyTextPatches(start, tx.patches);
  const backward = applyTextPatches(editor.session.source, tx.inverse);
  expect(forward.ok && forward.text).toBe(editor.session.source);
  expect(backward.ok && backward.text).toBe(start);
}

function backspaces(editor: Editor, count: number, stepMs = 100): Editor {
  let current = editor;
  for (let i = 0; i < count; i += 1) {
    const caret = current.selection.ranges[0]?.start ?? 0;
    current = edit(current, [{ start: caret - 1, end: caret, text: '' }], { coalesce: 'delete-backward', timestamp: i * stepMs });
  }
  return current;
}

function forwardDeletes(editor: Editor, count: number, stepMs = 100): Editor {
  let current = editor;
  for (let i = 0; i < count; i += 1) {
    const caret = current.selection.ranges[0]?.start ?? 0;
    current = edit(current, [{ start: caret, end: caret + 1, text: '' }], { coalesce: 'delete-forward', timestamp: i * stepMs });
  }
  return current;
}

const at = (editor: Editor, offset: number): Editor => ({ ...editor, selection: caretAt(editor.session, offset) });

describe('M3 T2 History —— 三类合成（#3、#4）', () => {
  it('连续键入合成为一个插入补丁；与逐步执行逐字一致；一次 undo 回到初始（#3）', () => {
    const typed = typeText(at(begin('ab'), 1), 'Hello');
    expectText(typed, 'aHellob');
    expect(undoDepth(typed.history)).toBe(1);
    expect(typed.history.undo?.top.patches).toEqual([{ start: 1, end: 1, text: 'Hello' }]);
    expect(typed.history.undo?.top.inverse).toEqual([{ start: 1, end: 6, text: '' }]);
    composedRoundTrip('ab', typed);
    expectText(undoOk(typed), 'ab');
  });

  it('连续退格：合成逆补丁按「后删的在前」拼接，undo 逐字还原（#4）', () => {
    const deleted = backspaces(at(begin('abcdef'), 5), 3);
    expectText(deleted, 'abf');
    expect(deleted.history.undo?.top.patches).toEqual([{ start: 2, end: 5, text: '' }]);
    expect(deleted.history.undo?.top.inverse).toEqual([{ start: 2, end: 2, text: 'cde' }]);
    expect(deleted.history.open?.anchor).toBe(2);
    composedRoundTrip('abcdef', deleted);
    expectText(undoOk(deleted), 'abcdef');
  });

  it('连续向前删除：光标不动，合成逆补丁按「先删的在前」拼接；abc 在 0 处删两次必须还原为 abc（#4）', () => {
    const deleted = forwardDeletes(at(begin('abc'), 0), 2);
    expectText(deleted, 'c');
    expect(deleted.selection.ranges).toEqual([{ start: 0, end: 0 }]);
    expect(deleted.history.undo?.top.inverse).toEqual([{ start: 0, end: 0, text: 'ab' }]);
    expect(deleted.history.open?.anchor).toBe(0);
    composedRoundTrip('abc', deleted);
    expectText(undoOk(deleted), 'abc');
  });

  it('插入与删除、向前与向后删除互不合并（#4）', () => {
    const typed = typeText(at(begin('abc'), 3), 'xy');
    const back = backspaces(typed, 1);
    expect(undoDepth(back.history)).toBe(2);
    const forward = forwardDeletes(at(back, 1), 1);
    expect(undoDepth(forward.history)).toBe(3);
    expectText(undoOk(undoOk(undoOk(forward))), 'abc');
  });
});

describe('M3 T2 History —— 截断场景（#5）', () => {
  const typedOnce = (): Editor => typeText(at(begin('abc'), 3), 'x');

  it('非相邻（只靠相邻条件断开）：caret bias 为 before 时光标停在插入前，选中与栈顶候选一致但补丁不在 anchor', () => {
    const start = begin('abc');
    const before = { kind: 'source', ranges: [{ start: 1, end: 1 }], bias: { start: 'exclude', end: 'exclude', caret: 'before' }, basisVersion: 1 } as const;
    const first = edit({ ...start, selection: before }, [{ start: 1, end: 1, text: 'x' }], { coalesce: 'insert', timestamp: 0 });
    expect(first.selection.ranges).toEqual([{ start: 1, end: 1 }]);
    expect(first.history.open?.anchor).toBe(2);
    const second = edit(first, [{ start: 1, end: 1, text: 'y' }], { coalesce: 'insert', timestamp: 10 });
    expect(second.merged).toBe(false);
    expectText(second, 'ayxbc');
    expectText(redoOk(undoOk(second)), 'ayxbc');
    expectText(undoOk(undoOk(second)), 'abc');
  });

  it('带 insert 提示的替换补丁（start ≠ end）不合并，即使起点正好在 anchor', () => {
    const typed = typeText(at(begin('abcde'), 3), 'x');
    const next = edit(typed, [{ start: 4, end: 5, text: 'y' }], { coalesce: 'insert', timestamp: 50 });
    expect(next.merged).toBe(false);
    expectText(next, 'abcxye');
    expectText(redoOk(undoOk(next)), 'abcxye');
  });

  it('endCoalescing（blur / 光标跳转 / Save / IME 开始）之后相邻输入开新事务', () => {
    const typed = typedOnce();
    const ended = { ...typed, history: endCoalescing(typed.history) };
    expect(endCoalescing(ended.history)).toBe(ended.history);
    const next = typeText(ended, 'y', 50);
    expect(undoDepth(next.history)).toBe(2);
  });

  it('光标变成非折叠选区时不续组（由「必须是折叠光标」条件断开）', () => {
    const typed = typedOnce();
    const moved = { ...typed, selection: rangeOf(typed.session, 0, 4) };
    const replaced = edit(moved, [{ start: 4, end: 4, text: 'y' }], { coalesce: 'insert', timestamp: 50 });
    expect(replaced.merged).toBe(false);
  });

  it.each([
    ['插入 LF', '\n'],
    ['插入 CRLF', '\r\n'],
    ['插入含换行的文本', 'a\nb'],
  ])('C1 换行插入：即使误传 insert 提示，%s 也独立成事务并结束合并组', (_name, text) => {
    const typed = typedOnce();
    const caret = typed.selection.ranges[0]?.start ?? 0;
    const broken = edit(typed, [{ start: caret, end: caret, text }], { coalesce: 'insert', timestamp: 50 });
    expect(broken.merged).toBe(false);
    expect(broken.history.open).toBeNull();
    const after = typeText(broken, 'z', 60);
    expect(undoDepth(after.history)).toBe(3);
  });

  it.each([
    ['退格删掉 LF', 'ab\nxcd', 4, 'delete-backward', { start: 2, end: 3, text: '' }, 'abcd'],
    ['退格删掉整个 CRLF', 'ab\r\nxcd', 5, 'delete-backward', { start: 2, end: 4, text: '' }, 'abcd'],
    ['向前删除 LF', 'abx\ncd', 2, 'delete-forward', { start: 2, end: 3, text: '' }, 'abcd'],
    ['向前删除整个 CRLF', 'abx\r\ncd', 2, 'delete-forward', { start: 2, end: 4, text: '' }, 'abcd'],
    ['退格删掉孤立 CR', 'ab\rxcd', 4, 'delete-backward', { start: 2, end: 3, text: '' }, 'abcd'],
    ['向前删除孤立 CR', 'abx\rcd', 2, 'delete-forward', { start: 2, end: 3, text: '' }, 'abcd'],
  ] as const)('C1 换行删除：%s——与上一步同类且相邻，仍独立成事务、不开组', (_name, source, caret, kind, lineBreak, result) => {
    // 先删一个普通字符开组（anchor 正好对齐换行），再删换行：只有「被删原文含换行」这一条阻止合并。
    const first = kind === 'delete-backward' ? backspaces(at(begin(source), caret), 1) : forwardDeletes(at(begin(source), caret), 1);
    expect(first.history.open).not.toBeNull();
    const next = edit(first, [lineBreak], { coalesce: kind, timestamp: 50 });
    expectText(next, result);
    expect(next.merged).toBe(false);
    expect(next.history.open).toBeNull();
    expect(undoDepth(next.history)).toBe(2);
    expectText(undoOk(undoOk(next)), source);
  });

  it('选中连续性兜底：光标在相邻位置但与栈顶候选不一致（bias 不同）时也不合并', () => {
    const typed = typedOnce();
    const caret = typed.selection.ranges[0]?.start ?? 0;
    const differentBias = { ...typed.selection, bias: { start: 'exclude', end: 'exclude', caret: 'before' } } as const;
    const next = edit({ ...typed, selection: differentBias }, [{ start: caret, end: caret, text: 'y' }], { coalesce: 'insert', timestamp: 50 });
    expect(next.merged).toBe(false);
    const same = edit(typed, [{ start: caret, end: caret, text: 'y' }], { coalesce: 'insert', timestamp: 50 });
    expect(same.merged).toBe(true);
  });

  it('粘贴 / IME 提交传 null：各自独立并结束合并组', () => {
    const typed = typedOnce();
    const pasted = edit(typed, [{ start: 4, end: 4, text: 'PASTE' }]);
    expect(pasted.merged).toBe(false);
    expect(pasted.history.open).toBeNull();
    const ime = edit(pasted, [{ start: 9, end: 9, text: '中文' }]);
    expect(ime.history.open).toBeNull();
    expect(undoDepth(ime.history)).toBe(3);
  });

  it('被拒的输入不打断合并组：在 LF 前键入 x，插入 \\r 会合并出 CRLF 被拒，随后的 y 仍并入同一组', () => {
    const typed = typeText(at(begin('a\nb'), 1), 'x', 0);
    expect(typed.history.open?.anchor).toBe(2);
    const rejected = commit(typed, [{ start: 2, end: 2, text: '\r' }], { coalesce: 'insert', timestamp: 10 });
    expect(rejected).toEqual({ ok: false, reason: 'merges-cr-lf', patchIndex: 0 });
    const next = edit(typed, [{ start: 2, end: 2, text: 'y' }], { coalesce: 'insert', timestamp: 20 });
    expect(next.merged).toBe(true);
    expectText(next, 'axy\nb');
    expect(undoDepth(next.history)).toBe(1);
  });

  it('剪切与替换选区（null 提示）各自独立；IME 组字前调用 endCoalescing 结束之前的组', () => {
    const typed = typedOnce();
    const cut = edit({ ...typed, selection: rangeOf(typed.session, 0, 2) }, [{ start: 0, end: 2, text: '' }]);
    expect(cut.merged).toBe(false);
    expect(cut.history.open).toBeNull();
    const replaced = edit({ ...cut, selection: rangeOf(cut.session, 0, 1) }, [{ start: 0, end: 1, text: 'R' }]);
    expect(replaced.history.open).toBeNull();
    const typing = typeText(replaced, 'k', 100);
    expect(typing.history.open).not.toBeNull();
    const composing = { ...typing, history: endCoalescing(typing.history) };
    const caret = composing.selection.ranges[0]?.start ?? 0;
    const ime = edit(composing, [{ start: caret, end: caret, text: '日本' }]);
    expect(ime.merged).toBe(false);
    expect(undoDepth(ime.history)).toBe(5);
  });

  it('删除非空选区不开组：其后的退格是新事务', () => {
    const start = begin('abcdef');
    const cut = edit({ ...start, selection: rangeOf(start.session, 1, 3) }, [{ start: 1, end: 3, text: '' }], { coalesce: 'delete-backward', timestamp: 0 });
    expect(cut.history.open).toBeNull();
    expect(cut.selection.ranges).toEqual([{ start: 1, end: 1 }]);
    const next = backspaces(cut, 1);
    expect(undoDepth(next.history)).toBe(2);
  });
});

describe('M3 T2 History —— 合并窗口与时间戳（#6）', () => {
  it.each([
    [999, true],
    [1000, false],
    [1001, false],
    [-1, false],
  ])('间隔 %d ms：合并 = %s', (gap, merged) => {
    const typed = typeText(at(begin('ab'), 2), 'x', 5000);
    const next = edit(typed, [{ start: 3, end: 3, text: 'y' }], { coalesce: 'insert', timestamp: 5000 + gap });
    expect(next.merged).toBe(merged);
  });

  it.each([Number.NaN, -5, Number.POSITIVE_INFINITY])('非法时间戳 %s：不合并、不开组，输入本身仍成功', (timestamp) => {
    const typed = typeText(at(begin('ab'), 2), 'x');
    const next = edit(typed, [{ start: 3, end: 3, text: 'y' }], { coalesce: 'insert', timestamp });
    expect(next.merged).toBe(false);
    expect(next.history.open).toBeNull();
    expectText(next, 'abxy');
  });
});

describe('M3 T2 History —— 可视化命令不合并（Q6，#25）', () => {
  it('相同 coalesceKey、窗口内、选中连续的可视化命令仍是两个事务；key 被存储；会结束之前的源码输入组', () => {
    const typed = typeText(at(begin('C D E'), 0), 'x');
    expect(typed.history.open).not.toBeNull();
    const patch: TextPatch = { start: 1, end: 2, text: 'D' };
    const first = edit(typed, [patch], { origin: 'visual-command', coalesceKey: 'move-pitch', coalesce: 'insert', timestamp: 10, selection: rangeOf(typed.session, 1, 2, 'note', { kind: 'note', fields: { step: 'C' } }) });
    expect(first.history.open).toBeNull();
    expect(first.history.undo?.top.coalesceKey).toBe('move-pitch');
    const second = edit(first, [{ start: 1, end: 2, text: 'E' }], { origin: 'visual-command', coalesceKey: 'move-pitch', timestamp: 20 });
    expect(second.merged).toBe(false);
    expect(undoDepth(second.history)).toBe(3);
  });

  it('即使形状、位置、时间、选中都符合插入合并条件，可视化命令也不并入源码输入组', () => {
    const typed = typeText(at(begin('abc'), 3), 'x');
    const caret = typed.selection.ranges[0]?.start ?? 0;
    const visual = edit(typed, [{ start: caret, end: caret, text: 'y' }], { origin: 'visual-command', coalesce: 'insert', timestamp: 50 });
    expect(visual.merged).toBe(false);
    expect(undoDepth(visual.history)).toBe(2);
    expect(visual.history.open).toBeNull();
  });
});
