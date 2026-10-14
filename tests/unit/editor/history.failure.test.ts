/**
 * M3 T2 History —— 失败原子性与绑定校验（测试 #10、#14、#23、#24）。
 *
 * 失败时不返回任何新的 session / history / selection；输入（深冻结）不被修改；旧 HistoryState 仍可作为不可变快照使用。
 */

import { describe, expect, it } from 'vitest';

import { commitTransaction, createHistory, redo, undo } from '../../../src/editor/history/history';
import { push } from '../../../src/editor/history/stack';
import type { HistoryState, HistoryTransaction } from '../../../src/editor/history/types';
import { applySourceTransaction } from '../../../src/editor/session/reducer';
import { DEFAULT_RANGE_BIAS } from '../../../src/editor/selection/types';
import type { PersistedSelection } from '../../../src/editor/selection/types';
import { begin, caretAt, commit, deepFreeze, edit, expectText, inputFor, open, undoOk } from './historyKit';

describe('M3 T2 History —— 多补丁事务原子失败（#10）', () => {
  // 基底 B 同时含受保护 U+FEFF、CRLF 与孤立 LF；第 1 个补丁在 1 处插入 x，之后偏移整体 +1：CR=4、LF=5、d=7、孤立 LF=8。
  const B = '\uFEFFab\r\ncd\nef';
  it.each([
    ['第 2 个补丁越界', [{ start: 1, end: 1, text: 'x' }, { start: 99, end: 99, text: 'y' }], 'patch-out-of-range'],
    ['第 2 个补丁触及受保护前缀', [{ start: 2, end: 2, text: 'x' }, { start: 0, end: 1, text: '' }], 'touches-protected-prefix'],
    ['第 2 个补丁拆开 CRLF', [{ start: 1, end: 1, text: 'x' }, { start: 5, end: 5, text: 'y' }], 'splits-crlf'],
    ['第 2 个补丁合并出 CRLF', [{ start: 1, end: 1, text: 'x' }, { start: 8, end: 8, text: '\r' }], 'merges-cr-lf'],
  ] as const)('%s：返回原因与补丁下标，session / history / selection 全部不变', (_name, patches, reason) => {
    const base = edit(begin(B), [{ start: 10, end: 10, text: 'g' }]);
    const editor = deepFreeze({ ...base });
    const input = deepFreeze(inputFor(editor, patches));
    const result = commitTransaction(editor.session, editor.history, input);
    expect(result).toEqual({ ok: false, reason, patchIndex: 1 });
    expectText(editor, `${B}g`);
    expect(editor.history.undo?.size).toBe(1);
    expect(editor.selection.basisVersion).toBe(2);
  });

  it('旧 HistoryState 是不可变快照：之后的提交、合并、undo 都不改变它', () => {
    const first = edit(begin('ab'), [{ start: 2, end: 2, text: 'c' }], { coalesce: 'insert', timestamp: 0 });
    const snapshot = deepFreeze(first.history);
    const serialized = JSON.stringify(snapshot);
    const merged = edit(first, [{ start: 3, end: 3, text: 'd' }], { coalesce: 'insert', timestamp: 10 });
    expect(merged.merged).toBe(true);
    const undone = undoOk(merged);
    expect(JSON.stringify(snapshot)).toBe(serialized);
    expect(undone.history).not.toBe(snapshot);
    // 旧快照与对应的旧会话仍可继续使用：从它出发 undo 回到 'ab'。
    expectText(undoOk({ session: first.session, history: snapshot, selection: first.selection }), 'ab');
  });
});

describe('M3 T2 History —— 文档隔离（#14）', () => {
  it('新文档会话 + 旧 History：document-mismatch；新文档用新 History 从空开始', () => {
    const old = edit(begin('abc', 1), [{ start: 0, end: 0, text: 'x' }]);
    const other = open('xabc', 2);
    expect(undo(other, old.history)).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(redo(other, old.history)).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(commitTransaction(other, old.history, inputFor({ session: other, history: old.history, selection: caretAt(other, 0) }, [{ start: 0, end: 0, text: 'y' }]))).toEqual({
      ok: false,
      reason: 'document-mismatch',
    });
    const fresh = createHistory(other);
    expect(fresh.undo).toBeNull();
    expect(fresh.documentId).toBe(2);
  });
});

describe('M3 T2 History —— 绕过 History 的写入（#23）', () => {
  it('直接用 reducer 改动会话后，undo / redo / commit 都被拒：history-out-of-sync', () => {
    const edited = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]);
    const bypass = applySourceTransaction(edited.session, { baseVersion: 2, patches: [{ start: 1, end: 2, text: 'Q' }] });
    if (!bypass.ok) throw new Error('fixture');
    expect(undo(bypass.session, edited.history)).toEqual({ ok: false, reason: 'history-out-of-sync' });
    expect(commit({ ...edited, session: bypass.session, selection: caretAt(bypass.session, 0) }, [{ start: 0, end: 0, text: 'y' }])).toEqual({
      ok: false,
      reason: 'history-out-of-sync',
    });
  });

  it('同版本不同文本的分叉配对也被拒（只比版本不够）', () => {
    const start = begin('abc');
    const viaHistory = edit(start, [{ start: 0, end: 0, text: 'x' }]);
    const forked = applySourceTransaction(start.session, { baseVersion: 1, patches: [{ start: 0, end: 0, text: 'y' }] });
    if (!forked.ok) throw new Error('fixture');
    expect(forked.session.sourceVersion).toBe(viaHistory.session.sourceVersion);
    expect(undo(forked.session, viaHistory.history)).toEqual({ ok: false, reason: 'history-out-of-sync' });
  });
});

describe('M3 T2 History —— 伪造的破坏栈（#24）', () => {
  it('栈顶 inverse 违反不变量或越界：history-corrupt，状态不变', () => {
    const start = begin('ab\r\ncd');
    const none: PersistedSelection = { kind: 'none', ranges: [], bias: DEFAULT_RANGE_BIAS };
    const corrupt: HistoryTransaction = Object.freeze({
      baseVersion: 1,
      patches: [{ start: 0, end: 0, text: 'x' }],
      inverse: [{ start: 3, end: 3, text: 'z' }],
      selectionBefore: none,
      selectionAfter: none,
      label: 'forged',
      coalesceKey: null,
      origin: 'source-input',
    });
    const history: HistoryState = deepFreeze({ ...createHistory(start.session), undo: push(null, corrupt), redo: push(null, corrupt) });
    expect(undo(start.session, history)).toEqual({ ok: false, reason: 'history-corrupt' });
    const outOfRange: HistoryTransaction = { ...corrupt, patches: [{ start: 99, end: 99, text: 'x' }] };
    expect(redo(start.session, { ...history, redo: push(null, outOfRange) })).toEqual({ ok: false, reason: 'history-corrupt' });
    expect(start.session.source).toBe('ab\r\ncd');
  });
});
