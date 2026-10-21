/**
 * M3 T3a：编辑器核心状态的纯迁移（`src/renderer/app/editor/editorTransitions.ts`；T3 Preflight r3 §4、§5.3）。
 *
 * 重点：源码输入经 T0 投影换算与 T2 事务提交；undo / redo 恢复存储选中；全选映射为 `[受保护前缀, 末尾)` 的 source 选中，
 * 键入后按 Q7 折叠；同文本替换写回选中、不建事务；CRLF 文件单键编辑只改一处；选区变化结束合并组；失败返回原因、不产生新状态。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentSession } from '../../../src/editor/session/create';
import type { DocumentSession } from '../../../src/editor/session/types';
import {
  applySourceInput,
  changeSelection,
  initialEditorCore,
  noSelection,
  redoStep,
  sourceSelectionFromView,
  undoStep,
} from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore, EditorStep } from '../../../src/renderer/app/editor/editorTransitions';

function session(source: string): DocumentSession {
  return createDocumentSession({ documentId: 1, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

function ok(step: EditorStep): EditorCore {
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

/** 在 view 区间上键入（选中取自同一区间）。 */
function type(core: EditorCore, start: number, end: number, text: string, timestamp: number | null = null): EditorStep {
  const selection = sourceSelectionFromView(core.session, { start, end });
  if (selection === null) throw new Error('selection');
  return applySourceInput(core, {
    viewPatch: { start, end, text },
    selection,
    coalesce: timestamp === null ? null : { kind: 'insert', timestamp },
    label: 'type',
  });
}

const caretAfter = (core: EditorCore): readonly { start: number; end: number }[] => core.selection.ranges.map((r) => ({ start: r.start, end: r.end }));

describe('editorTransitions —— 初始核心与选中', () => {
  it('初始核心：空历史、none 选中、basisVersion = 1', () => {
    const core = initialEditorCore(session('abc'));
    expect(core.history.undo).toBeNull();
    expect(core.selection).toEqual(noSelection(1));
    expect(core.selection.kind).toBe('none');
  });

  it('全选 [0, view.length] 映射为 [受保护前缀, source.length)，不选中开头 U+FEFF；CRLF 中的 LF 对应整个 CRLF', () => {
    const s = session('\uFEFFa\r\nb');
    const all = sourceSelectionFromView(s, { start: 0, end: s.projection.view.length });
    expect(all?.kind).toBe('source');
    expect(all?.ranges).toEqual([{ start: 1, end: 5 }]);
    expect(all?.bias).toEqual({ start: 'exclude', end: 'exclude', caret: 'after' });
    expect(sourceSelectionFromView(s, { start: 2, end: 2 })?.ranges).toEqual([{ start: 4, end: 4 }]);
    expect(sourceSelectionFromView(s, { start: 0, end: 99 })).toBeNull();
  });
});

describe('editorTransitions —— 源码输入', () => {
  it('折叠光标键入：版本 +1，光标在插入文本之后（caret after），入栈一项', () => {
    const next = ok(type(initialEditorCore(session('abc')), 1, 1, 'x'));
    expect(next.session.source).toBe('axbc');
    expect(next.session.sourceVersion).toBe(2);
    expect(caretAfter(next)).toEqual([{ start: 2, end: 2 }]);
    expect(next.history.undo?.size).toBe(1);
  });

  it('连续键入在窗口内合并为一项；undo 一次回到原文', () => {
    let core = initialEditorCore(session('ab'));
    core = ok(type(core, 2, 2, 'c', 0));
    core = ok(type(core, 3, 3, 'd', 100));
    expect(core.history.undo?.size).toBe(1);
    expect(ok(undoStep(core)).session.source).toBe('ab');
  });

  it('Q7：全选后键入替换整个可编辑 source，光标折叠到末端；再键入不覆盖前一个字符', () => {
    const start = session('\uFEFFabc');
    let core = initialEditorCore(start);
    core = ok(type(core, 0, start.projection.view.length, 'X'));
    expect(core.session.source).toBe('\uFEFFX');
    expect(caretAfter(core)).toEqual([{ start: 2, end: 2 }]);
    core = ok(type(core, 1, 1, 'Y'));
    expect(core.session.source).toBe('\uFEFFXY');
  });

  it('同文本替换：abc 选中 b 输入 b → 无变化事务，选中折叠到 b 之后；再输入 x → abxc', () => {
    const core = initialEditorCore(session('abc'));
    const same = type(core, 1, 2, 'b');
    expect(same.ok && same.changed).toBe(false);
    const after = ok(same);
    expect(after.session).toBe(core.session);
    expect(after.history.undo).toBeNull();
    expect(caretAfter(after)).toEqual([{ start: 2, end: 2 }]);
    expect(ok(type(after, 2, 2, 'x')).session.source).toBe('abxc');
  });

  it('CRLF 文件单键编辑只改一处：其余 CRLF 与孤立 CR 逐字节不变', () => {
    const source = 'a\r\nb\rc\r\nd';
    const core = initialEditorCore(session(source));
    const next = ok(type(core, 2, 2, 'Z'));
    expect(next.session.source).toBe('a\r\nZb\rc\r\nd');
  });

  it('换行按 dominant EOL 写入；在孤立 CR 后插入换行（合并成 CRLF）被拒', () => {
    const crlf = initialEditorCore(session('a\r\nb\r\nc'));
    expect(ok(type(crlf, 1, 1, '\n')).session.source).toBe('a\r\n\r\nb\r\nc');
    const lone = initialEditorCore(session('a\rb'));
    expect(type(lone, 2, 2, '\n')).toEqual({ ok: false, reason: 'merges-cr-lf' });
  });

  it('失败不产生新状态：view 补丁越界、开头插入 U+FEFF、选中不属于当前版本', () => {
    const core = initialEditorCore(session('\uFEFFab'));
    const caret = sourceSelectionFromView(core.session, { start: 0, end: 0 });
    if (caret === null) throw new Error('selection');
    expect(applySourceInput(core, { viewPatch: { start: 0, end: 9, text: 'x' }, selection: caret, coalesce: null, label: 'type' })).toEqual({
      ok: false,
      reason: 'view-range-out-of-range',
    });
    const plain = initialEditorCore(session('ab'));
    expect(type(plain, 0, 0, '\uFEFF')).toEqual({ ok: false, reason: 'creates-leading-feff' });
    const stale = { ...core.selection, kind: 'source' as const, ranges: [{ start: 1, end: 1 }], basisVersion: 7 };
    expect(applySourceInput(core, { viewPatch: { start: 0, end: 0, text: 'x' }, selection: stale, coalesce: null, label: 'type' })).toEqual({
      ok: false,
      reason: 'stale-selection',
    });
  });
});

describe('editorTransitions —— undo / redo 与选区变化', () => {
  it('undo 恢复 selectionBefore、redo 恢复 selectionAfter，版本单调递增', () => {
    const typed = ok(type(initialEditorCore(session('abc')), 1, 1, 'x'));
    const undone = ok(undoStep(typed));
    expect(undone.session.source).toBe('abc');
    expect(undone.session.sourceVersion).toBe(3);
    expect(caretAfter(undone)).toEqual([{ start: 1, end: 1 }]);
    const redone = ok(redoStep(undone));
    expect(redone.session.source).toBe('axbc');
    expect(redone.session.sourceVersion).toBe(4);
    expect(caretAfter(redone)).toEqual([{ start: 2, end: 2 }]);
  });

  it('没有可撤销 / 可重做时返回原因，不产生新状态', () => {
    const core = initialEditorCore(session('abc'));
    expect(undoStep(core)).toEqual({ ok: false, reason: 'nothing-to-undo' });
    expect(redoStep(core)).toEqual({ ok: false, reason: 'nothing-to-redo' });
  });

  it('选区变化结束合并组；相同选中原样返回；旧版本或越界选中被拒', () => {
    const typed = ok(type(initialEditorCore(session('abc')), 3, 3, 'd', 0));
    expect(typed.history.open).not.toBeNull();
    const same = changeSelection(typed, typed.selection);
    expect(same.ok && same.changed).toBe(false);
    const moved = sourceSelectionFromView(typed.session, { start: 0, end: 0 });
    if (moved === null) throw new Error('selection');
    const changed = ok(changeSelection(typed, moved));
    expect(changed.history.open).toBeNull();
    expect(changed.session).toBe(typed.session);
    expect(changeSelection(typed, { ...moved, basisVersion: 1 })).toEqual({ ok: false, reason: 'stale-selection' });
    expect(changeSelection(typed, { ...moved, ranges: [{ start: 0, end: 99 }] })).toEqual({ ok: false, reason: 'selection-out-of-range' });
  });

  it('选区变化后再键入不再并入之前的组（光标跳转结束合并）', () => {
    let core = ok(type(initialEditorCore(session('ab')), 2, 2, 'c', 0));
    const moved = sourceSelectionFromView(core.session, { start: 3, end: 3 });
    if (moved === null) throw new Error('selection');
    core = ok(changeSelection(core, { ...moved, ranges: [{ start: 3, end: 3 }] }));
    core = ok(type(core, 3, 3, 'd', 50));
    expect(core.history.undo?.size).toBe(1);
  });
});
