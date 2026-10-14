/**
 * M3 T2 History —— 栈状态机（Preflight r3 测试 #1、#2、#7、#8、#9）。
 */

import { describe, expect, it } from 'vitest';

import { canRedo, canUndo, commitTransaction, createHistory, redo, redoLabel, undo, undoLabel } from '../../../src/editor/history/history';
import { applyTextPatches } from '../../../src/editor/text/apply';
import { begin, caretAt, commit, edit, expectText, open, rangeOf, redoDepth, redoOk, undoDepth, undoOk } from './historyKit';

describe('M3 T2 History —— 单事务 undo / redo（#1）', () => {
  it.each([
    ['插入', 'abc', { start: 1, end: 1, text: 'XY' }, 'aXYbc'],
    ['删除', 'abcdef', { start: 2, end: 4, text: '' }, 'abef'],
    ['替换', 'abcdef', { start: 1, end: 5, text: '中' }, 'a中f'],
  ])('%s：往返逐字相等，版本 1→2→3→4，标签与可用性正确', (_name, source, patch, result) => {
    const start = begin(source);
    expect(canUndo(start.history)).toBe(false);
    expect(canRedo(start.history)).toBe(false);
    const edited = edit(start, [patch], { label: 'L1' });
    expectText(edited, result);
    expect(edited.session.sourceVersion).toBe(2);
    expect(undoLabel(edited.history)).toBe('L1');
    const undone = undoOk(edited);
    expectText(undone, source);
    expect(undone.session.sourceVersion).toBe(3);
    expect(canUndo(undone.history)).toBe(false);
    expect(redoLabel(undone.history)).toBe('L1');
    const redone = redoOk(undone);
    expectText(redone, result);
    expect(redone.session.sourceVersion).toBe(4);
    expect(canRedo(redone.history)).toBe(false);
  });

  it('栈空时 undo / redo 返回明确原因，状态不变', () => {
    const start = begin('abc');
    expect(undo(start.session, start.history)).toEqual({ ok: false, reason: 'nothing-to-undo' });
    expect(redo(start.session, start.history)).toEqual({ ok: false, reason: 'nothing-to-redo' });
  });

  it('redo 用当前版本而不是事务记录的 baseVersion（v1 提交 → v3 时 redo 必须成功）', () => {
    const edited = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]);
    expect(edited.history.undo?.top.baseVersion).toBe(1);
    const undone = undoOk(edited);
    expect(undone.session.sourceVersion).toBe(3);
    expectText(redoOk(undone), 'xabc');
  });
});

describe('M3 T2 History —— 多补丁事务（#2）', () => {
  it('偏移相互依赖的 3 个补丁：按中间文本语义应用，undo 逐字还原，inverse 为逆序', () => {
    const start = begin('0123456789');
    const patches = [
      { start: 2, end: 4, text: 'AB C' },
      { start: 0, end: 1, text: '' },
      { start: 8, end: 10, text: 'z' },
    ];
    const expected = applyTextPatches('0123456789', patches);
    if (!expected.ok) throw new Error('fixture');
    const edited = edit(start, patches);
    expectText(edited, expected.text);
    expect(edited.history.undo?.top.inverse).toEqual(expected.inverse);
    expect(edited.history.undo?.top.patches).toEqual(patches);
    expectText(undoOk(edited), '0123456789');
    expectText(redoOk(undoOk(edited)), expected.text);
  });
});

describe('M3 T2 History —— 历史分支（#7、#8）', () => {
  it('undo 后提交新事务清空 redo（#7）', () => {
    const a = edit(begin('abc'), [{ start: 3, end: 3, text: 'd' }]);
    const b = edit(a, [{ start: 4, end: 4, text: 'e' }]);
    const undone = undoOk(b);
    expect(redoDepth(undone.history)).toBe(1);
    const branched = edit(undone, [{ start: 0, end: 0, text: 'Z' }]);
    expect(branched.history.redo).toBeNull();
    expect(canRedo(branched.history)).toBe(false);
    expect(redo(branched.session, branched.history)).toEqual({ ok: false, reason: 'nothing-to-redo' });
    expect(undoDepth(branched.history)).toBe(2);
    expectText(branched, 'Zabcd');
  });

  it('undo 清空打开的合并组：之后在同一位置的向前删除是新事务，不能并入更早的事务（#8）', () => {
    const start = begin('XYZ');
    const inserted = edit(start, [{ start: 0, end: 0, text: 'Q' }], { selection: caretAt(start.session, 0) });
    expectText(inserted, 'QXYZ');
    expect(inserted.selection.ranges).toEqual([{ start: 1, end: 1 }]);
    const del1 = edit(inserted, [{ start: 1, end: 2, text: '' }], { coalesce: 'delete-forward', timestamp: 0 });
    const del2 = edit(del1, [{ start: 1, end: 2, text: '' }], { coalesce: 'delete-forward', timestamp: 100 });
    expect(del2.merged).toBe(true);
    expectText(del2, 'QZ');
    expect(del2.history.open).not.toBeNull();
    const undone = undoOk(del2);
    expectText(undone, 'QXYZ');
    expect(undone.history.open).toBeNull();
    const del3 = edit(undone, [{ start: 1, end: 2, text: '' }], { coalesce: 'delete-forward', timestamp: 150 });
    expect(del3.merged).toBe(false);
    expect(undoDepth(del3.history)).toBe(2);
    expectText(undoOk(del3), 'QXYZ');
  });
});

describe('M3 T2 History —— baseVersion（#9）', () => {
  it('新事务的 baseVersion 与当前版本不符：base-version-mismatch，状态不变', () => {
    const edited = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]);
    const stale = commitTransaction(edited.session, edited.history, {
      baseVersion: 1,
      patches: [{ start: 0, end: 0, text: 'y' }],
      selection: caretAt(edited.session, 0),
      label: 'stale',
      origin: 'source-input',
      coalesce: null,
    });
    expect(stale).toEqual({ ok: false, reason: 'base-version-mismatch' });
    expectText(edited, 'xabc');
  });

  it('commit 结果的 selection 带新版本；createHistory 绑定会话的身份与文本', () => {
    const session = open('abc', 7);
    const history = createHistory(session);
    expect(history).toEqual({ documentId: 7, headVersion: 1, headSource: 'abc', undo: null, redo: null, open: null });
    const result = commit({ session, history, selection: rangeOf(session, 0, 1) }, [{ start: 2, end: 3, text: 'Z' }]);
    expect(result.ok && result.changed && result.selection.basisVersion).toBe(2);
  });
});
