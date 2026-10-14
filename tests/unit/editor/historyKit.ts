/**
 * M3 T2 History 测试辅助：建会话、构造选中、成对推进 (session, history, selection)、深冻结输入。
 * 只用自造文本，不读任何语料。
 */

import { expect } from 'vitest';

import { DEFAULT_HISTORY_OPTIONS, commitTransaction, createHistory, redo, undo } from '../../../src/editor/history/history';
import type { CoalesceKind, CommitInput, CommitResult, HistoryOptions, HistoryState, SelectionIntent } from '../../../src/editor/history/types';
import { createDocumentSession } from '../../../src/editor/session/create';
import type { DocumentSession } from '../../../src/editor/session/types';
import { DEFAULT_RANGE_BIAS } from '../../../src/editor/selection/types';
import type { EditorSelection, SelectionKind, SemanticFingerprint } from '../../../src/editor/selection/types';
import type { TextPatch } from '../../../src/editor/text/types';

export function open(source: string, documentId = 1): DocumentSession {
  return createDocumentSession({ documentId, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

export function caretAt(session: DocumentSession, offset: number): EditorSelection {
  return { kind: 'source', ranges: [{ start: offset, end: offset }], bias: DEFAULT_RANGE_BIAS, basisVersion: session.sourceVersion };
}

export function rangeOf(session: DocumentSession, start: number, end: number, kind: SelectionKind = 'source', fingerprint?: SemanticFingerprint): EditorSelection {
  const base = { kind, ranges: [{ start, end }], bias: DEFAULT_RANGE_BIAS, basisVersion: session.sourceVersion };
  return fingerprint === undefined ? base : { ...base, fingerprint };
}

/** 调用方成对持有的状态。 */
export interface Editor {
  readonly session: DocumentSession;
  readonly history: HistoryState;
  readonly selection: EditorSelection;
}

export function begin(source: string, documentId = 1): Editor {
  const session = open(source, documentId);
  return { session, history: createHistory(session), selection: caretAt(session, 0) };
}

export interface EditOptions {
  readonly coalesce?: CoalesceKind;
  readonly timestamp?: number;
  readonly origin?: CommitInput['origin'];
  readonly label?: string;
  readonly coalesceKey?: string;
  readonly selection?: EditorSelection;
  readonly selectionIntent?: SelectionIntent;
  readonly options?: HistoryOptions;
}

export function inputFor(editor: Editor, patches: readonly TextPatch[], edit: EditOptions = {}): CommitInput {
  const base: CommitInput = {
    baseVersion: editor.session.sourceVersion,
    patches,
    selection: edit.selection ?? editor.selection,
    label: edit.label ?? 'edit',
    origin: edit.origin ?? 'source-input',
    coalesce: edit.coalesce === undefined ? null : { kind: edit.coalesce, timestamp: edit.timestamp ?? 0 },
    ...(edit.coalesceKey === undefined ? {} : { coalesceKey: edit.coalesceKey }),
  };
  return edit.selectionIntent === undefined ? base : { ...base, selectionIntent: edit.selectionIntent };
}

export function commit(editor: Editor, patches: readonly TextPatch[], edit: EditOptions = {}): CommitResult {
  return commitTransaction(editor.session, editor.history, inputFor(editor, patches, edit), edit.options ?? DEFAULT_HISTORY_OPTIONS);
}

/** 提交并要求成功（文本有变化或无变化都可），返回新的一对。 */
export function edit(editor: Editor, patches: readonly TextPatch[], options: EditOptions = {}): Editor & { readonly merged: boolean } {
  const result = commit(editor, patches, options);
  if (!result.ok) throw new Error(`commit failed: ${result.reason}`);
  return { session: result.session, history: result.history, selection: result.selection, merged: result.changed && result.merged };
}

export function undoOk(editor: Editor): Editor {
  const result = undo(editor.session, editor.history);
  if (!result.ok) throw new Error(`undo failed: ${result.reason}`);
  return result;
}

export function redoOk(editor: Editor): Editor {
  const result = redo(editor.session, editor.history);
  if (!result.ok) throw new Error(`redo failed: ${result.reason}`);
  return result;
}

/** 在当前光标处连续键入（每个字符一个事务，带 insert 合并提示）。 */
export function typeText(editor: Editor, text: string, startTime = 0, stepMs = 100): Editor {
  let current = editor;
  let time = startTime;
  for (const char of Array.from(text)) {
    const [range] = current.selection.ranges;
    if (range === undefined) throw new Error('no caret');
    current = edit(current, [{ start: range.start, end: range.end, text: char }], { coalesce: 'insert', timestamp: time });
    time += stepMs;
  }
  return current;
}

export function undoDepth(history: HistoryState): number {
  return history.undo?.size ?? 0;
}

export function redoDepth(history: HistoryState): number {
  return history.redo?.size ?? 0;
}

/** 递归冻结，用来证明 History 不修改输入。 */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function expectText(editor: Editor, text: string): void {
  expect(editor.session.source).toBe(text);
  expect(editor.history.headSource).toBe(text);
  expect(editor.history.headVersion).toBe(editor.session.sourceVersion);
}
