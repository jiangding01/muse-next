/**
 * M3 T2 History —— 无文本变化的事务（Q4 / R3-H2、Q7；测试 #22）。
 *
 * 合法事务经 T0 全部校验后文本不变：source、sourceVersion 不变；不新增记录、不清 redo；选中可按 Q7 更新
 * （basisVersion 保持当前版本）；选中变化时结束当前合并组。非法补丁与空补丁序列依旧被拒。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_RANGE_BIAS } from '../../../src/editor/selection/types';
import { begin, caretAt, commit, edit, expectText, rangeOf, redoDepth, redoOk, typeText, undoDepth, undoOk } from './historyKit';
import type { Editor } from './historyKit';

const select = (editor: Editor, start: number, end: number): Editor => ({ ...editor, selection: rangeOf(editor.session, start, end) });

describe('M3 T2 History —— 回归：abc 选中 b 输入 b 再输入 x', () => {
  it('文本与版本不变、不入栈；光标折叠到 b 后；再输入 x 得到 abxc；undo / redo 选中正确', () => {
    const start = select(begin('abc'), 1, 2);
    const same = commit(start, [{ start: 1, end: 2, text: 'b' }], { coalesce: 'insert', timestamp: 0 });
    if (!same.ok) throw new Error(same.reason);
    expect(same.changed).toBe(false);
    expect(same.session).toBe(start.session);
    expect(same.session.sourceVersion).toBe(1);
    expect(undoDepth(same.history)).toBe(0);
    expect(same.selection).toEqual({ kind: 'source', ranges: [{ start: 2, end: 2 }], bias: DEFAULT_RANGE_BIAS, basisVersion: 1 });
    const typed = edit({ session: same.session, history: same.history, selection: same.selection }, [{ start: 2, end: 2, text: 'x' }], { coalesce: 'insert', timestamp: 10 });
    expectText(typed, 'abxc');
    expect(typed.selection.ranges).toEqual([{ start: 3, end: 3 }]);
    const undone = undoOk(typed);
    expectText(undone, 'abc');
    expect(undone.selection.ranges).toEqual([{ start: 2, end: 2 }]);
    const redone = redoOk(undone);
    expectText(redone, 'abxc');
    expect(redone.selection.ranges).toEqual([{ start: 3, end: 3 }]);
  });
});

describe('M3 T2 History —— 无变化事务的各类输入', () => {
  it.each([
    ['粘贴相同文本覆盖选区', 'hello world', 6, 11, 'world', 11],
    ['IME 提交相同文本覆盖选区', '你好世界', 2, 4, '世界', 4],
    ['相同文本替换（多字符）', 'abcdef', 1, 4, 'bcd', 4],
  ])('%s：changed=false、版本不变、光标折叠到补丁末尾', (_name, source, from, to, text, caret) => {
    const editor = select(begin(source), from, to);
    const result = commit(editor, [{ start: from, end: to, text }]);
    expect(result).toMatchObject({ ok: true, changed: false });
    if (!result.ok) return;
    expect(result.session).toBe(editor.session);
    expect(result.selection.ranges).toEqual([{ start: caret, end: caret }]);
    expect(result.selection.basisVersion).toBe(1);
  });

  it('删除选区必有文本变化（对照）：入栈、光标折叠到删除点', () => {
    const result = edit(select(begin('abcdef'), 1, 4), [{ start: 1, end: 4, text: '' }]);
    expectText(result, 'aef');
    expect(result.selection.ranges).toEqual([{ start: 1, end: 1 }]);
    expect(undoDepth(result.history)).toBe(1);
  });

  it('选中不变的无变化事务（{x,x,""}）：history 与 selection 都是传入的同一对象', () => {
    const editor = { ...begin('abc'), selection: caretAt(begin('abc').session, 1) };
    const result = commit(editor, [{ start: 1, end: 1, text: '' }]);
    expect(result).toMatchObject({ ok: true, changed: false });
    if (!result.ok) return;
    expect(result.history).toBe(editor.history);
    expect(result.selection).toBe(editor.selection);
  });

  it('选中变化时结束合并组；选中不变时合并组保留', () => {
    const typed = typeText({ ...begin('ab'), selection: caretAt(begin('ab').session, 2) }, 'xy');
    expect(typed.history.open).not.toBeNull();
    const unchanged = commit(typed, [{ start: 4, end: 4, text: '' }]);
    expect(unchanged.ok && unchanged.history).toBe(typed.history);
    const replaced = commit({ ...typed, selection: rangeOf(typed.session, 2, 3) }, [{ start: 2, end: 3, text: 'x' }]);
    if (!replaced.ok) throw new Error(replaced.reason);
    expect(replaced.changed).toBe(false);
    expect(replaced.history.open).toBeNull();
    expect(replaced.history.undo).toBe(typed.history.undo);
    const after = typeText({ session: replaced.session, history: replaced.history, selection: replaced.selection }, 'z', 50);
    expect(undoDepth(after.history)).toBe(2);
  });

  it('redo 非空时的无变化提交保留 redo', () => {
    const undone = undoOk(edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]));
    expect(redoDepth(undone.history)).toBe(1);
    const result = commit(select(undone, 1, 2), [{ start: 1, end: 2, text: 'b' }]);
    expect(result.ok && result.history.redo).toBe(undone.history.redo);
    expect(result.ok && result.session.sourceVersion).toBe(3);
  });
});

describe('M3 T2 History —— 非法但文本看似不变的输入依旧被拒', () => {
  it.each([
    ['空补丁触及受保护前缀', '﻿ab', [{ start: 0, end: 0, text: '' }], 'touches-protected-prefix'],
    ['空补丁落在 CRLF 中间', 'a\r\nb', [{ start: 2, end: 2, text: '' }], 'splits-crlf'],
    ['越界的空补丁', 'abc', [{ start: 4, end: 4, text: '' }], 'patch-out-of-range'],
    ['空补丁序列', 'abc', [], 'empty-transaction'],
  ] as const)('%s', (_name, source, patches, reason) => {
    expect(commit(begin(source), patches)).toMatchObject({ ok: false, reason });
  });

  it('过期选中与非法 intent 即使文本不变也被拒', () => {
    const edited = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]);
    expect(commit({ ...edited, selection: { ...edited.selection, basisVersion: 1 } }, [{ start: 1, end: 1, text: '' }])).toEqual({ ok: false, reason: 'stale-selection' });
    const intent = { kind: 'source', range: { start: 0, end: 0 }, fingerprint: { kind: 'source', fields: {} } } as const;
    expect(commit(edited, [{ start: 1, end: 1, text: '' }], { origin: 'visual-command', selectionIntent: intent })).toEqual({ ok: false, reason: 'invalid-selection-intent' });
  });
});
