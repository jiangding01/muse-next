/**
 * M3 T2 History —— 字节敏感源码（测试 #17、#18）：CRLF、混合换行、孤立 CR、受保护开头 U+FEFF、非 BMP 字符。
 *
 * History 不规范化任何文本：补丁与逆补丁按 UTF-16 偏移原样保存，往返后未触及的字节逐字保留。
 */

import { describe, expect, it } from 'vitest';

import { begin, caretAt, commit, edit, expectText, redoOk, undoDepth, undoOk } from './historyKit';
import type { Editor } from './historyKit';

const at = (editor: Editor, offset: number): Editor => ({ ...editor, selection: caretAt(editor.session, offset) });

function backspaceRun(editor: Editor, count: number): Editor {
  let current = editor;
  for (let i = 0; i < count; i += 1) {
    const caret = current.selection.ranges[0]?.start ?? 0;
    current = edit(current, [{ start: caret - 1, end: caret, text: '' }], { coalesce: 'delete-backward', timestamp: i * 10 });
  }
  return current;
}

describe('M3 T2 History —— CRLF / 孤立 CR / U+FEFF（#17）', () => {
  const MIXED = '﻿X:1\r\nT:a\rb\nK:C\r\nCDEF|\r\n';

  it('混合换行文件中的编辑与往返：未触及的 CRLF、孤立 CR、开头 U+FEFF 逐字保留', () => {
    const start = begin(MIXED);
    expect(start.session.protectedLeadingFeff).toBe(true);
    const edited = edit(start, [{ start: 8, end: 9, text: 'Title' }]);
    expect(edited.session.source).toBe('﻿X:1\r\nT:Title\rb\nK:C\r\nCDEF|\r\n');
    expectText(undoOk(edited), MIXED);
    expectText(redoOk(undoOk(edited)), edited.session.source);
  });

  it('触及受保护前缀、拆开 CRLF、合并出 CRLF 的补丁被拒，状态不变', () => {
    const start = begin(MIXED);
    expect(commit(start, [{ start: 0, end: 1, text: '' }])).toEqual({ ok: false, reason: 'touches-protected-prefix', patchIndex: 0 });
    expect(commit(start, [{ start: 5, end: 5, text: 'x' }])).toEqual({ ok: false, reason: 'splits-crlf', patchIndex: 0 });
    expect(commit(start, [{ start: 9, end: 10, text: '' }])).toMatchObject({ ok: true });
    expect(commit(start, [{ start: 10, end: 10, text: '\n' }])).toEqual({ ok: false, reason: 'merges-cr-lf', patchIndex: 0 });
  });

  it('在 CRLF / 孤立 CR 旁（不跨过换行）连续退格的合成与逐步执行一致，全部 undo 回原文', () => {
    const source = 'ab\r\ncdef\rgh';
    const merged = backspaceRun(at(begin(source), 8), 3);
    expectText(merged, 'ab\r\nc\rgh');
    expect(undoDepth(merged.history)).toBe(1);
    expect(merged.history.undo?.top.inverse).toEqual([{ start: 5, end: 5, text: 'def' }]);
    expectText(undoOk(merged), source);
  });

  it('未受保护文档：在开头插入 U+FEFF 被拒；删除首字符使后面的 U+FEFF 前移被拒', () => {
    const start = begin('a﻿b');
    expect(commit(start, [{ start: 0, end: 0, text: '﻿' }])).toEqual({ ok: false, reason: 'creates-leading-feff', patchIndex: 0 });
    expect(commit(start, [{ start: 0, end: 1, text: '' }])).toEqual({ ok: false, reason: 'creates-leading-feff', patchIndex: 0 });
  });
});

describe('M3 T2 History —— 非 BMP 字符（#18）', () => {
  it('按 UTF-16 偏移编辑：键入 😀 与 𝄞 合成为一个补丁，undo / redo 逐字往返', () => {
    let editor = at(begin('A𝄞B'), 3);
    for (const [index, char] of ['😀', '𝄞'].entries()) {
      const caret = editor.selection.ranges[0]?.start ?? 0;
      editor = edit(editor, [{ start: caret, end: caret, text: char }], { coalesce: 'insert', timestamp: index * 10 });
    }
    expectText(editor, 'A𝄞😀𝄞B');
    expect(editor.history.undo?.top.patches).toEqual([{ start: 3, end: 3, text: '😀𝄞' }]);
    expect(editor.selection.ranges).toEqual([{ start: 7, end: 7 }]);
    expectText(undoOk(editor), 'A𝄞B');
  });

  it('补丁落在代理对中间时 History 不修正，往返逐字还原（孤立代理项原样保存）', () => {
    const source = 'x😀y';
    const edited = edit(begin(source), [{ start: 2, end: 3, text: 'Z' }]);
    expect(edited.session.source).toBe('x\uD83DZy');
    expect(edited.history.undo?.top.inverse).toEqual([{ start: 2, end: 3, text: '\uDE00' }]);
    expectText(undoOk(edited), source);
  });
});
