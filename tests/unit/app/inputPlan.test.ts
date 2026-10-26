/**
 * M3 T3c：inputType 处理矩阵（`src/renderer/app/editor/inputPlan.ts`；方案 §9.1，T3c Preflight r0 §4）。
 *
 * 表驱动：已处理类型的补丁与合并提示；fail closed 类型；data 缺失；CR / CRLF 规范化；字素簇删除；边界无操作。
 */

import { describe, expect, it } from 'vitest';

import { normalizeNewlines, planInput } from '../../../src/renderer/app/editor/inputPlan';
import type { InputFacts } from '../../../src/renderer/app/editor/inputPlan';

function facts(inputType: string, start: number, end: number, view: string, data: string | null = null, dataTransferText: string | null = null): InputFacts {
  return { inputType, data, dataTransferText, selection: { start, end }, view };
}

describe('inputPlan —— 已处理类型', () => {
  it('insertText：折叠光标、无换行 → insert 可合并；非空选区替换 → 不合并', () => {
    expect(planInput(facts('insertText', 2, 2, 'abc', 'x'))).toEqual({ kind: 'patch', viewPatch: { start: 2, end: 2, text: 'x' }, coalesce: 'insert', label: 'insert-text' });
    expect(planInput(facts('insertText', 1, 2, 'abc', 'b'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 2, text: 'b' }, coalesce: null, label: 'insert-text' });
  });

  it('insertText：data 中的 CRLF / CR 规范为 LF，且含换行时不合并', () => {
    expect(planInput(facts('insertText', 0, 0, '', 'a\r\nb\rc'))).toEqual({ kind: 'patch', viewPatch: { start: 0, end: 0, text: 'a\nb\nc' }, coalesce: null, label: 'insert-text' });
  });

  it('insertText：data 为 null 或空 → fail closed（no-data）', () => {
    expect(planInput(facts('insertText', 0, 0, 'a', null))).toEqual({ kind: 'reject', reason: 'no-data' });
    expect(planInput(facts('insertText', 0, 0, 'a', ''))).toEqual({ kind: 'reject', reason: 'no-data' });
  });

  it('insertLineBreak / insertParagraph：选区替换为一个 LF，不合并', () => {
    for (const type of ['insertLineBreak', 'insertParagraph']) {
      expect(planInput(facts(type, 1, 3, 'abcd'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 3, text: '\n' }, coalesce: null, label: 'line-break' });
    }
  });

  it('deleteContentBackward：折叠时删前一个字素簇（可合并）；非空选区删选区；开头无操作', () => {
    expect(planInput(facts('deleteContentBackward', 2, 2, 'éx'))).toEqual({
      kind: 'patch',
      viewPatch: { start: 0, end: 2, text: '' },
      coalesce: 'delete-backward',
      label: 'delete-backward',
    });
    expect(planInput(facts('deleteContentBackward', 1, 3, 'abcd'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 3, text: '' }, coalesce: null, label: 'delete-selection' });
    expect(planInput(facts('deleteContentBackward', 0, 0, 'abc'))).toEqual({ kind: 'noop' });
  });

  it('deleteContentForward：折叠时删后一个字素簇；末尾无操作', () => {
    expect(planInput(facts('deleteContentForward', 0, 0, '👨‍👩‍👧x'))).toEqual({
      kind: 'patch',
      viewPatch: { start: 0, end: 8, text: '' },
      coalesce: 'delete-forward',
      label: 'delete-forward',
    });
    expect(planInput(facts('deleteContentForward', 3, 3, 'abc'))).toEqual({ kind: 'noop' });
  });

  it('insertFromPaste：优先 data，其次 dataTransfer；都不可得 fail closed；空串无操作；CR 规范化；NUL 原样；不合并', () => {
    expect(planInput(facts('insertFromPaste', 1, 2, 'abc', 'p\r\nq'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 2, text: 'p\nq' }, coalesce: null, label: 'paste' });
    expect(planInput(facts('insertFromPaste', 1, 1, 'abc', null, 'z'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 1, text: 'z' }, coalesce: null, label: 'paste' });
    expect(planInput(facts('insertFromPaste', 1, 1, 'abc', null, null))).toEqual({ kind: 'reject', reason: 'no-data' });
    expect(planInput(facts('insertFromPaste', 1, 2, 'abc', ''))).toEqual({ kind: 'noop' });
    expect(planInput(facts('insertFromPaste', 0, 0, '', 'p\u0000q'))).toMatchObject({ viewPatch: { text: 'p\u0000q' } });
  });

  it('deleteByCut：删选区；折叠选区无操作', () => {
    expect(planInput(facts('deleteByCut', 1, 2, 'abc'))).toEqual({ kind: 'patch', viewPatch: { start: 1, end: 2, text: '' }, coalesce: null, label: 'cut' });
    expect(planInput(facts('deleteByCut', 1, 1, 'abc'))).toEqual({ kind: 'noop' });
  });

  it('historyUndo / historyRedo → 派发；insertCompositionText → 交给输入法状态机', () => {
    expect(planInput(facts('historyUndo', 0, 0, ''))).toEqual({ kind: 'history', command: 'undo' });
    expect(planInput(facts('historyRedo', 0, 0, ''))).toEqual({ kind: 'history', command: 'redo' });
    expect(planInput(facts('insertCompositionText', 0, 0, '', 'n'))).toEqual({ kind: 'composition' });
  });
});

describe('inputPlan —— fail closed', () => {
  it.each([
    'deleteWordBackward',
    'deleteWordForward',
    'deleteSoftLineBackward',
    'deleteSoftLineForward',
    'deleteHardLineBackward',
    'deleteHardLineForward',
    'insertReplacementText',
    'insertTranspose',
    'insertFromYank',
    'insertFromDrop',
    'deleteByDrag',
    'insertFromComposition',
    'formatBold',
    '',
    'somethingNew',
  ])('%s → reject unsupported', (inputType) => {
    expect(planInput(facts(inputType, 0, 1, 'ab', 'x'))).toEqual({ kind: 'reject', reason: 'unsupported' });
  });

  it('normalizeNewlines 只改 CR，不改其它字符', () => {
    expect(normalizeNewlines('a\r\n\r\nb\r␍')).toBe('a\n\nb\n␍');
  });
});
