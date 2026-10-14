/**
 * History 中的选中处理（`docs/M3_EDITOR_CORE_PLAN.md` §9.2、§16.1、§17.1–§17.5；M3 T2 Preflight r3 Q2、Q7）。
 *
 * - 入栈前按字段拷贝并冻结：只保留 kind、ranges、bias、可选 fingerprint，丢弃运行时字段与一切额外字段，
 *   调用方之后修改自己的对象不会影响栈。
 * - 候选 selectionAfter 只是 §17.1 入口 1 的候选：进入新快照后仍须由 T6 / T7 做 §17.4 校验，这里不做候选查找、
 *   不比较指纹，也不宣告任何语义匹配成功。
 * - undo / redo 恢复存储的选中，不经过这里的任何映射（§17.3）。
 */

import { transformSourceRangeThrough } from '../text/transform';
import type { SourceRange, TextPatch } from '../text/types';
import { DEFAULT_RANGE_BIAS } from '../selection/types';
import type { PersistedSelection, SelectionKind, SemanticFingerprint } from '../selection/types';
import type { HistoryOrigin, SelectionIntent } from './types';

/** 语义目标（§16.1）：被纯删除整体覆盖时清空；其余 kind 折叠。 */
const SEMANTIC_KINDS: ReadonlySet<SelectionKind> = new Set(['voice', 'event', 'note', 'relation']);

function copyRange(range: SourceRange): SourceRange {
  return Object.freeze({ start: range.start, end: range.end });
}

function copyFingerprint(fingerprint: SemanticFingerprint): SemanticFingerprint {
  return Object.freeze({ kind: fingerprint.kind, fields: Object.freeze({ ...fingerprint.fields }) });
}

function persisted(
  kind: SelectionKind,
  ranges: readonly SourceRange[],
  bias: PersistedSelection['bias'],
  fingerprint: SemanticFingerprint | undefined,
): PersistedSelection {
  const base = {
    kind,
    ranges: Object.freeze(ranges.map(copyRange)),
    bias: Object.freeze({ start: bias.start, end: bias.end, caret: bias.caret }),
  };
  return Object.freeze(fingerprint === undefined ? base : { ...base, fingerprint: copyFingerprint(fingerprint) });
}

/** 按字段拷贝出纯持久合同（冻结）；传入 `EditorSelection` 时其 `basisVersion` 被丢弃。 */
export function toPersistedSelection(selection: PersistedSelection): PersistedSelection {
  return persisted(selection.kind, selection.ranges, selection.bias, selection.fingerprint);
}

const rangeFits = (range: SourceRange, length: number): boolean =>
  Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.start <= range.end && range.end <= length;

/** 每个 range 都是 `[0, length]` 内的合法整数区间。 */
export function selectionFitsSource(selection: PersistedSelection, length: number): boolean {
  return selection.ranges.every((range) => rangeFits(range, length));
}

/** intent 中与结果文本无关的形状：不能是 none / source，fingerprint 的 kind 一致，range 为整数且 start ≤ end。 */
export function intentShapeValid(intent: SelectionIntent): boolean {
  return (
    intent.kind !== 'none' &&
    intent.kind !== 'source' &&
    intent.fingerprint.kind === intent.kind &&
    Number.isInteger(intent.range.start) &&
    Number.isInteger(intent.range.end) &&
    intent.range.start >= 0 &&
    intent.range.start <= intent.range.end
  );
}

/**
 * Q7：源码输入替换单个完整 source 选区（键入、粘贴、IME 提交、删除选中内容）时，候选为补丁结束位置的折叠光标。
 * 只作用于普通源码输入的候选生成；不改 T0 `transformSourceRange`，不影响语义目标的 replacement 吸收规则。
 */
function replacedWholeSourceSelection(before: PersistedSelection, patches: readonly TextPatch[], origin: HistoryOrigin): number | null {
  const [range] = before.ranges;
  const [patch] = patches;
  if (origin !== 'source-input' || before.kind !== 'source' || before.ranges.length !== 1 || patches.length !== 1) return null;
  // 只针对非折叠选区：折叠光标处的插入照常走 §17.2 的 insert-at-caret 规则（尊重 caret bias）。
  if (range === undefined || patch === undefined || range.start === range.end) return null;
  if (patch.start !== range.start || patch.end !== range.end) return null;
  return patch.start + patch.text.length;
}

/**
 * §17.1 入口 1 的候选：有 intent 用 intent；Q7 规则；否则逐个 range 按 §17.2 变换——语义目标任一 range 被纯删除
 * 整体覆盖即清空为 `none`，source / document 被覆盖时折叠到删除点。任一 range 无法变换返回 'invalid'。
 */
export function candidateSelectionAfter(
  before: PersistedSelection,
  patches: readonly TextPatch[],
  intent: SelectionIntent | undefined,
  origin: HistoryOrigin,
): PersistedSelection | 'invalid' {
  if (intent !== undefined) return persisted(intent.kind, [intent.range], DEFAULT_RANGE_BIAS, intent.fingerprint);
  const caret = replacedWholeSourceSelection(before, patches, origin);
  if (caret !== null) return persisted('source', [{ start: caret, end: caret }], before.bias, undefined);

  const ranges: SourceRange[] = [];
  for (const range of before.ranges) {
    const outcome = transformSourceRangeThrough(range, patches, before.bias);
    if (outcome.kind === 'invalid') return 'invalid';
    if (outcome.kind === 'mapped') {
      ranges.push(outcome.range);
    } else if (SEMANTIC_KINDS.has(before.kind)) {
      return persisted('none', [], DEFAULT_RANGE_BIAS, undefined);
    } else {
      ranges.push({ start: outcome.collapseAt, end: outcome.collapseAt });
    }
  }
  return persisted(before.kind, ranges, before.bias, before.fingerprint);
}

function sameFingerprint(a: SemanticFingerprint | undefined, b: SemanticFingerprint | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(a.fields);
  return a.kind === b.kind && keys.length === Object.keys(b.fields).length && keys.every((key) => Object.hasOwn(b.fields, key) && a.fields[key] === b.fields[key]);
}

/** 持久合同的结构相等（忽略 basisVersion 等运行时字段；fingerprint 按键集合比较，不依赖键顺序）。 */
export function sameSelection(a: PersistedSelection, b: PersistedSelection): boolean {
  return (
    a.kind === b.kind &&
    a.bias.start === b.bias.start &&
    a.bias.end === b.bias.end &&
    a.bias.caret === b.bias.caret &&
    a.ranges.length === b.ranges.length &&
    a.ranges.every((range, index) => range.start === b.ranges[index]?.start && range.end === b.ranges[index]?.end) &&
    sameFingerprint(a.fingerprint, b.fingerprint)
  );
}
