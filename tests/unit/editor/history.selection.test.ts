/**
 * M3 T2 History —— 选中的存储、候选与恢复（Preflight r3 §6.6，Q2、Q7；测试 #15、#16）。
 *
 * 候选只是 §17.1 入口 1 的候选：T2 不做 §17.4 的候选查找与指纹比较，也不宣告语义匹配成功。
 */

import { describe, expect, it } from 'vitest';

import { candidateSelectionAfter, sameSelection } from '../../../src/editor/history/selection';
import { DEFAULT_RANGE_BIAS } from '../../../src/editor/selection/types';
import type { EditorSelection, PersistedSelection } from '../../../src/editor/selection/types';
import { begin, caretAt, commit, edit, rangeOf, typeText, undoOk, redoOk } from './historyKit';
import type { Editor } from './historyKit';

const NOTE_FP = { kind: 'note', fields: { step: 'C', octave: 4, accidental: null } } as const;
const withSelection = (editor: Editor, selection: EditorSelection): Editor => ({ ...editor, selection });

describe('M3 T2 History —— 存储与恢复（#15）', () => {
  it('undo 返回 selectionBefore、redo 返回 selectionAfter（方向不能反），basisVersion = 新版本', () => {
    const start = begin('C D E');
    const before = rangeOf(start.session, 2, 3, 'note', NOTE_FP);
    const edited = edit(withSelection(start, before), [{ start: 0, end: 0, text: 'G ' }]);
    expect(edited.selection).toMatchObject({ kind: 'note', ranges: [{ start: 4, end: 5 }], basisVersion: 2 });
    const undone = undoOk(edited);
    expect(undone.selection).toEqual({ ...before, basisVersion: 3 });
    const redone = redoOk(undone);
    expect(redone.selection).toEqual({ ...edited.selection, basisVersion: 4 });
  });

  it('栈中只存持久合同：键集合恰为 kind / ranges / bias（/ fingerprint），没有 basisVersion 或额外字段', () => {
    const start = begin('abc');
    const noisy = { ...rangeOf(start.session, 0, 1, 'note', NOTE_FP), anchorKey: 'v1:e0', eventId: 'e0' };
    const edited = edit(withSelection(start, noisy), [{ start: 2, end: 3, text: 'Z' }]);
    const tx = edited.history.undo?.top;
    expect(Object.keys(tx?.selectionBefore ?? {}).sort()).toEqual(['bias', 'fingerprint', 'kind', 'ranges']);
    expect(Object.keys(tx?.selectionAfter ?? {}).sort()).toEqual(['bias', 'fingerprint', 'kind', 'ranges']);
    const plain = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]).history.undo?.top;
    expect(Object.keys(plain?.selectionBefore ?? {}).sort()).toEqual(['bias', 'kind', 'ranges']);
  });

  it('入栈对象是拷贝：调用方之后修改自己的 ranges / fingerprint.fields / patches 不影响栈', () => {
    const start = begin('abcdef');
    const ranges = [{ start: 1, end: 2 }];
    const fields: Record<string, string> = { step: 'C' };
    const selection: EditorSelection = { kind: 'note', ranges, bias: DEFAULT_RANGE_BIAS, fingerprint: { kind: 'note', fields }, basisVersion: 1 };
    const patches = [{ start: 4, end: 5, text: 'Q' }];
    const edited = edit(withSelection(start, selection), patches);
    ranges[0] = { start: 0, end: 6 };
    fields.step = 'D';
    patches[0] = { start: 0, end: 6, text: '' };
    const tx = edited.history.undo?.top;
    expect(tx?.selectionBefore.ranges).toEqual([{ start: 1, end: 2 }]);
    expect(tx?.selectionBefore.fingerprint?.fields).toEqual({ step: 'C' });
    expect(tx?.patches).toEqual([{ start: 4, end: 5, text: 'Q' }]);
    expect(Object.isFrozen(tx)).toBe(true);
    expect(Object.isFrozen(tx?.patches)).toBe(true);
  });

  it('合并组：undo 返回组首的 selectionBefore，redo 返回组尾的 selectionAfter', () => {
    const start = begin('ab');
    const typed = typeText(withSelection(start, caretAt(start.session, 1)), 'xyz');
    expect(typed.history.undo?.size).toBe(1);
    const undone = undoOk(typed);
    expect(undone.selection.ranges).toEqual([{ start: 1, end: 1 }]);
    const redone = redoOk(undone);
    expect(redone.selection.ranges).toEqual([{ start: 4, end: 4 }]);
  });

  it('undo 不对存储的选中做第二次映射：恢复值与提交时记录的 selectionBefore 逐字相同', () => {
    const start = begin('0123456789');
    const before = rangeOf(start.session, 6, 8);
    const edited = edit(withSelection(start, before), [{ start: 0, end: 4, text: '' }]);
    expect(edited.selection.ranges).toEqual([{ start: 2, end: 4 }]);
    // 若 undo 把当前选中按逆补丁再映射一次，会得到 [6,8) 之外的结果或依赖当前选中；这里断言直接取存储值。
    const elsewhere = withSelection(edited, caretAt(edited.session, 0));
    expect(undoOk(elsewhere).selection.ranges).toEqual([{ start: 6, end: 8 }]);
  });
});

describe('M3 T2 History —— 候选规则（Q2、Q7）', () => {
  const note = (start: number, end: number): PersistedSelection => ({ kind: 'note', ranges: [{ start, end }], bias: DEFAULT_RANGE_BIAS, fingerprint: NOTE_FP });
  const source = (start: number, end: number): PersistedSelection => ({ kind: 'source', ranges: [{ start, end }], bias: DEFAULT_RANGE_BIAS });

  it.each([
    ['键入覆盖选区', { start: 2, end: 5, text: 'x' }, 3],
    ['粘贴覆盖选区', { start: 2, end: 5, text: 'PASTED' }, 8],
    ['IME 提交覆盖选区', { start: 2, end: 5, text: '中文' }, 4],
    ['删除选中内容', { start: 2, end: 5, text: '' }, 2],
  ])('Q7 %s：候选为补丁结束位置的折叠光标', (_name, patch, caret) => {
    expect(candidateSelectionAfter(source(2, 5), [patch], undefined, 'source-input')).toEqual(source(caret, caret));
  });

  it.each([
    ['可视化命令', source(2, 5), [{ start: 2, end: 5, text: 'x' }], 'visual-command', source(2, 3)],
    ['补丁只覆盖选区一部分（起点不同）', source(2, 5), [{ start: 3, end: 5, text: 'x' }], 'source-input', source(2, 4)],
    ['补丁只覆盖选区一部分（起点相同、终点不同）', source(2, 5), [{ start: 2, end: 4, text: 'x' }], 'source-input', source(2, 4)],
    ['多补丁事务', source(2, 5), [{ start: 2, end: 5, text: 'x' }, { start: 0, end: 0, text: '' }], 'source-input', source(2, 3)],
    ['语义目标被替换仍按吸收规则（C → D 不清空）', note(2, 3), [{ start: 2, end: 3, text: 'D' }], 'source-input', note(2, 3)],
    ['语义目标 C, 替换为 D', note(2, 4), [{ start: 2, end: 4, text: 'D' }], 'source-input', note(2, 3)],
  ] as const)('Q7 不适用：%s', (_name, before, patches, origin, expected) => {
    expect(candidateSelectionAfter(before, patches, undefined, origin)).toEqual(expected);
  });

  it('多 range 的 source 选区不触发 Q7，逐个按 §17.2 变换', () => {
    const multi: PersistedSelection = { kind: 'source', ranges: [{ start: 2, end: 5 }, { start: 7, end: 8 }], bias: DEFAULT_RANGE_BIAS };
    expect(candidateSelectionAfter(multi, [{ start: 2, end: 5, text: 'x' }], undefined, 'source-input')).toEqual({ ...multi, ranges: [{ start: 2, end: 3 }, { start: 5, end: 6 }] });
  });

  it('纯删除整体覆盖：语义目标清空为 none；source / document 折叠到删除点', () => {
    expect(candidateSelectionAfter(note(2, 3), [{ start: 1, end: 4, text: '' }], undefined, 'visual-command')).toEqual({ kind: 'none', ranges: [], bias: DEFAULT_RANGE_BIAS });
    expect(candidateSelectionAfter(source(2, 3), [{ start: 1, end: 4, text: '' }], undefined, 'visual-command')).toEqual(source(1, 1));
    const doc: PersistedSelection = { kind: 'document', ranges: [{ start: 0, end: 3 }], bias: DEFAULT_RANGE_BIAS };
    expect(candidateSelectionAfter(doc, [{ start: 0, end: 3, text: '' }], undefined, 'visual-command')).toEqual({ ...doc, ranges: [{ start: 0, end: 0 }] });
  });

  it('折叠光标处插入走 insert-at-caret（尊重 caret bias），不由 Q7 处理', () => {
    const before: PersistedSelection = { kind: 'source', ranges: [{ start: 2, end: 2 }], bias: { start: 'exclude', end: 'exclude', caret: 'before' } };
    expect(candidateSelectionAfter(before, [{ start: 2, end: 2, text: 'xy' }], undefined, 'source-input')).toEqual(before);
  });

  it('有 intent 时以 intent 为候选（kind、range、fingerprint，默认 bias，不继承原选中的 bias）', () => {
    const intent = { kind: 'note', range: { start: 4, end: 5 }, fingerprint: NOTE_FP } as const;
    const customBias: PersistedSelection = { kind: 'source', ranges: [{ start: 0, end: 0 }], bias: { start: 'absorb', end: 'absorb', caret: 'before' } };
    expect(candidateSelectionAfter(source(0, 0), [{ start: 0, end: 0, text: 'x' }], intent, 'visual-command')).toEqual(note(4, 5));
    expect(candidateSelectionAfter(customBias, [{ start: 0, end: 0, text: 'x' }], intent, 'visual-command')).toEqual(note(4, 5));
  });

  it('sameSelection：fingerprint 字段值不同即不同；键顺序不同仍相同；bias 不同即不同', () => {
    const a = note(1, 2);
    expect(sameSelection(a, { ...a, fingerprint: { kind: 'note', fields: { step: 'D', octave: 4, accidental: null } } })).toBe(false);
    expect(sameSelection(a, { ...a, fingerprint: { kind: 'note', fields: { accidental: null, octave: 4, step: 'C' } } })).toBe(true);
    expect(sameSelection(a, { ...a, fingerprint: { kind: 'note', fields: { step: 'C', octave: 4 } } })).toBe(false);
    expect(sameSelection(a, { ...a, bias: { ...a.bias, caret: 'before' } })).toBe(false);
  });

  it('无变化的可视化命令：intent 只在指纹字段值上不同，也算选中变化（返回新选中）', () => {
    const start = begin('aCb');
    const selection = rangeOf(start.session, 1, 2, 'note', NOTE_FP);
    const intent = { kind: 'note', range: { start: 1, end: 2 }, fingerprint: { kind: 'note', fields: { step: 'D', octave: 4, accidental: null } } } as const;
    const result = commit({ ...start, selection }, [{ start: 1, end: 1, text: '' }], { origin: 'visual-command', selectionIntent: intent });
    expect(result).toMatchObject({ ok: true, changed: false });
    expect(result.ok && result.selection.fingerprint?.fields).toEqual({ step: 'D', octave: 4, accidental: null });
  });
});

describe('M3 T2 History —— 选中校验（#16）', () => {
  it('basisVersion 过期：stale-selection；范围越界：selection-out-of-range；都不改变状态', () => {
    const edited = edit(begin('abc'), [{ start: 0, end: 0, text: 'x' }]);
    const stale = { ...edited.selection, basisVersion: 1 };
    expect(commit(withSelection(edited, stale), [{ start: 0, end: 0, text: 'y' }])).toEqual({ ok: false, reason: 'stale-selection' });
    expect(commit(withSelection(edited, rangeOf(edited.session, 2, 9)), [{ start: 0, end: 0, text: 'y' }])).toEqual({ ok: false, reason: 'selection-out-of-range' });
    expect(commit(withSelection(edited, rangeOf(edited.session, 1.5, 2)), [{ start: 0, end: 0, text: 'y' }])).toEqual({ ok: false, reason: 'selection-out-of-range' });
    // 带 intent 时候选不来自原选中，越界的原选中只能由提交前的范围校验拦下。
    const intent = { kind: 'note', range: { start: 0, end: 1 }, fingerprint: NOTE_FP } as const;
    expect(commit(withSelection(edited, rangeOf(edited.session, 2, 99)), [{ start: 0, end: 0, text: 'y' }], { origin: 'visual-command', selectionIntent: intent })).toEqual({ ok: false, reason: 'selection-out-of-range' });
  });

  it.each([
    ['kind 为 none', { kind: 'none', range: { start: 0, end: 1 }, fingerprint: { kind: 'none', fields: {} } }],
    ['kind 为 source', { kind: 'source', range: { start: 0, end: 1 }, fingerprint: { kind: 'source', fields: {} } }],
    ['fingerprint.kind 不一致', { kind: 'note', range: { start: 0, end: 1 }, fingerprint: { kind: 'event', fields: {} } }],
    ['range 倒置', { kind: 'note', range: { start: 2, end: 1 }, fingerprint: NOTE_FP }],
    ['range 越过结果文本', { kind: 'note', range: { start: 0, end: 99 }, fingerprint: NOTE_FP }],
  ] as const)('非法 intent（%s）：invalid-selection-intent', (_name, intent) => {
    const start = begin('abc');
    expect(commit(start, [{ start: 0, end: 1, text: 'Z' }], { origin: 'visual-command', selectionIntent: intent })).toEqual({ ok: false, reason: 'invalid-selection-intent' });
  });
});
