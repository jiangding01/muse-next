/**
 * 源码输入的合并规则（`docs/M3_EDITOR_CORE_PLAN.md` §9.3；M3 T2 Preflight r3 §6.3、§6.4，Q3、Q6、C1）。
 *
 * - 只有 source-input 可以合并；可视化命令永不开组、永不续组（`coalesceKey` 只存储，Q6）。
 * - 开组与续组都要求：单补丁、形状符合类别、当前选中是单个折叠的 source 光标；插入文本或被删原文含换行时
 *   不合并（C1：换行自身是独立事务，并结束合并组）。
 * - 合并采用单补丁代数合成：组内恒为 1 个补丁，合成的 forward / inverse 不需要起点文本即可算出；
 *   undo / redo 时仍经 T0 reducer 重新校验区间与源码不变量。
 */

import type { TextPatch } from '../text/types';
import type { PersistedSelection } from '../selection/types';
import { sameSelection } from './selection';
import type { CoalesceKind, CoalescingGroup, CommitInput, HistoryOptions, HistoryTransaction } from './types';

const LINE_BREAK = /[\r\n]/;

const isCollapsedSourceCaret = (selection: PersistedSelection): boolean =>
  selection.kind === 'source' && selection.ranges.length === 1 && selection.ranges[0]?.start === selection.ranges[0]?.end;

const validTimestamp = (timestamp: number): boolean => Number.isFinite(timestamp) && timestamp >= 0;

/** 单补丁事务的形状是否符合类别；删除类同时检查被删原文（来自逆补丁）不含换行。 */
function shapeMatches(kind: CoalesceKind, tx: HistoryTransaction): boolean {
  const [patch] = tx.patches;
  const [inverse] = tx.inverse;
  if (tx.patches.length !== 1 || patch === undefined || inverse === undefined) return false;
  if (kind === 'insert') return patch.start === patch.end && patch.text.length > 0 && !LINE_BREAK.test(patch.text);
  return patch.text === '' && patch.end > patch.start && !LINE_BREAK.test(inverse.text);
}

/** 本步完成后下一步必须对齐的位置。 */
function anchorAfter(kind: CoalesceKind, patch: TextPatch): number {
  return kind === 'insert' ? patch.start + patch.text.length : patch.start;
}

/** 新事务是否可以开一个合并组；可以则返回组，否则 null。 */
export function openGroup(input: CommitInput, before: PersistedSelection, tx: HistoryTransaction): CoalescingGroup | null {
  const hint = input.coalesce;
  const [patch] = tx.patches;
  if (input.origin !== 'source-input' || hint === null || patch === undefined || !validTimestamp(hint.timestamp)) return null;
  if (!isCollapsedSourceCaret(before) || !shapeMatches(hint.kind, tx)) return null;
  return Object.freeze({ kind: hint.kind, lastTimestamp: hint.timestamp, anchor: anchorAfter(hint.kind, patch) });
}

/** 新事务能否并入当前打开的组（栈顶）。 */
export function canCoalesce(
  open: CoalescingGroup | null,
  top: HistoryTransaction | undefined,
  input: CommitInput,
  before: PersistedSelection,
  tx: HistoryTransaction,
  options: HistoryOptions,
): boolean {
  const hint = input.coalesce;
  const [patch] = tx.patches;
  if (open === null || top === undefined || hint === null || patch === undefined) return false;
  if (input.origin !== 'source-input' || hint.kind !== open.kind || !validTimestamp(hint.timestamp)) return false;
  if (!isCollapsedSourceCaret(before) || !shapeMatches(hint.kind, tx)) return false;
  const adjacent = open.kind === 'delete-backward' ? patch.end === open.anchor : patch.start === open.anchor;
  const elapsed = hint.timestamp - open.lastTimestamp;
  return adjacent && elapsed >= 0 && elapsed < options.coalesceWindowMs && sameSelection(before, top.selectionAfter);
}

/** 合并后的组状态。 */
export function advanceGroup(open: CoalescingGroup, timestamp: number, tx: HistoryTransaction): CoalescingGroup {
  const [patch] = tx.patches;
  return Object.freeze({ kind: open.kind, lastTimestamp: timestamp, anchor: patch === undefined ? open.anchor : anchorAfter(open.kind, patch) });
}

/**
 * 三类单补丁合成（Preflight r3 §6.4 表）。旧组相对 S0、新步相对 S1，结果相对 S0：
 * - insert：`{s,s,t1}` + `{s+|t1|, ·, t2}` → `{s,s,t1+t2}`，逆 `{s, s+|t1+t2|, ''}`；
 * - delete-backward：`{s1,e1,''}`（逆文本 d1）+ `{s2,s1,''}`（逆文本 d2）→ `{s2,e1,''}`，逆 `{s2,s2,d2+d1}`；
 * - delete-forward：`{c,c+k1,''}`（d1）+ `{c,c+k2,''}`（d2）→ `{c, c+|d1|+|d2|, ''}`，逆 `{c,c,d1+d2}`。
 * 元数据（baseVersion、label、coalesceKey、origin、selectionBefore）取组首，selectionAfter 取最后一步。
 */
export function composeTransactions(top: HistoryTransaction, next: HistoryTransaction, kind: CoalesceKind): HistoryTransaction | null {
  const [p1] = top.patches;
  const [i1] = top.inverse;
  const [p2] = next.patches;
  const [i2] = next.inverse;
  if (top.patches.length !== 1 || next.patches.length !== 1 || p1 === undefined || i1 === undefined || p2 === undefined || i2 === undefined) {
    return null;
  }
  let patch: TextPatch;
  let inverse: TextPatch;
  if (kind === 'insert') {
    const text = p1.text + p2.text;
    patch = { start: p1.start, end: p1.start, text };
    inverse = { start: p1.start, end: p1.start + text.length, text: '' };
  } else if (kind === 'delete-backward') {
    patch = { start: p2.start, end: p1.end, text: '' };
    inverse = { start: p2.start, end: p2.start, text: i2.text + i1.text };
  } else {
    const removed = i1.text + i2.text;
    patch = { start: p1.start, end: p1.start + removed.length, text: '' };
    inverse = { start: p1.start, end: p1.start, text: removed };
  }
  return Object.freeze({
    baseVersion: top.baseVersion,
    patches: Object.freeze([Object.freeze(patch)]),
    inverse: Object.freeze([Object.freeze(inverse)]),
    selectionBefore: top.selectionBefore,
    selectionAfter: next.selectionAfter,
    label: top.label,
    coalesceKey: top.coalesceKey,
    origin: top.origin,
  });
}
