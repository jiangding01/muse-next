/**
 * M3 T2 History —— dirty 派生与保存点（`docs/M3_EDITOR_CORE_PLAN.md` §7.2、§7.3、§9.3；测试 #12、#13）。
 *
 * History 不存 dirty、不读写 saved；保存由 T4 实现，这里只用「改写 saved 检查点 + endCoalescing」模拟保存成功。
 */

import { describe, expect, it } from 'vitest';

import { endCoalescing } from '../../../src/editor/history/history';
import { isSourceDirty } from '../../../src/editor/session/derive';
import type { DocumentSession } from '../../../src/editor/session/types';
import { begin, caretAt, edit, expectText, redoOk, typeText, undoDepth, undoOk } from './historyKit';
import type { Editor } from './historyKit';

/** 模拟保存成功：检查点前移到当前 source，开始保存时结束合并组（§9.3）。 */
function save(editor: Editor): Editor {
  const session: DocumentSession = { ...editor.session, saved: { source: editor.session.source } };
  return { session, history: endCoalescing({ ...editor.history }), selection: editor.selection };
}

describe('M3 T2 History —— §7.3 状态序列（#12）', () => {
  it('Open → 输入 → Undo（自动 clean）→ Redo（自动 dirty）→ Save → Undo（dirty）', () => {
    const T0 = 'X:1\nK:C\nC D E F|\n';
    let editor = begin(T0);
    const rows: [string, string, number, boolean][] = [];
    const record = (step: string): void => {
      rows.push([step, editor.session.source, editor.session.sourceVersion, isSourceDirty(editor.session)]);
    };
    record('Open T0');
    editor = edit(editor, [{ start: 8, end: 9, text: 'D' }]); // C → D（第 8 个字符是 C）
    const T1 = editor.session.source;
    record('输入 → T1');
    editor = undoOk(editor);
    record('Undo → T0');
    editor = redoOk(editor);
    record('Redo → T1');
    editor = save(editor);
    record('Save 成功');
    editor = undoOk(editor);
    record('Undo → T0');
    expect(rows).toEqual([
      ['Open T0', T0, 1, false],
      ['输入 → T1', T1, 2, true],
      ['Undo → T0', T0, 3, false],
      ['Redo → T1', T1, 4, true],
      ['Save 成功', T1, 4, false],
      ['Undo → T0', T0, 5, true],
    ]);
  });
});

describe('M3 T2 History —— Save 只结束合并组，不清除历史（#13）', () => {
  it('键入 → 保存 → 相邻窗口内继续键入：新事务；两次 undo 分别回到保存点与保存前；saved 不被 History 改动', () => {
    const start = begin('ab');
    const typed = typeText({ ...start, selection: caretAt(start.session, 2) }, 'cd', 0, 100);
    expect(undoDepth(typed.history)).toBe(1);
    expect(typed.history.open).not.toBeNull();
    const saved = save(typed);
    expect(saved.history.open).toBeNull();
    const savedCheckpoint = saved.session.saved;
    const more = typeText(saved, 'ef', 150, 100);
    expect(undoDepth(more.history)).toBe(2);
    expect(more.session.saved).toBe(savedCheckpoint);
    const back1 = undoOk(more);
    expectText(back1, 'abcd');
    expect(isSourceDirty(back1.session)).toBe(false);
    expect(back1.session.saved).toBe(savedCheckpoint);
    const back2 = undoOk(back1);
    expectText(back2, 'ab');
    expect(isSourceDirty(back2.session)).toBe(true);
    expect(redoOk(back2).session.saved).toBe(savedCheckpoint);
  });
});
