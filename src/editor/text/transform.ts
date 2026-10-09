/**
 * SourceRange 经补丁的确定性变换（`docs/M3_EDITOR_CORE_PLAN.md` §17.2）。
 *
 * 记补丁 `p = { start: ps, end: pe, text }`，`L = text.length`，`Δ = L − (pe − ps)`；范围 `r = [a, b)`。
 * 每条规则用**显式条件**表达，不依赖 `<` / `<=` 的隐式巧合；`RANGE_PATCH_RULES` 对外导出，测试穷举小样例
 * 断言任意合法输入恰好命中一条规则。
 *
 * 本层只给出「候选范围」的结构化结果：`covered` 表示纯删除整体覆盖了非空范围。语义目标被覆盖后是否清空、
 * source 选区是否折叠，由后续 selection / reconciliation 层解释（T6 / T7），本层不做选中策略。
 */

import type { RangeBias, SourceRange, TextPatch } from './types';

export type RangeTransformOutcome =
  | { readonly kind: 'mapped'; readonly range: SourceRange }
  /** 纯删除整体覆盖了非空范围；`collapseAt` 是删除点（对后续补丁继续按折叠范围变换）。 */
  | { readonly kind: 'covered'; readonly collapseAt: number }
  | { readonly kind: 'invalid'; readonly reason: 'range-malformed' | 'patch-malformed' | 'unclassified' };

interface Facts {
  readonly a: number;
  readonly b: number;
  readonly ps: number;
  readonly pe: number;
  readonly len: number;
}

export type RangePatchCase =
  | 'noop'
  | 'before'
  | 'after'
  | 'insert-inside'
  | 'insert-at-start'
  | 'insert-at-end'
  | 'insert-at-caret'
  | 'replace-overlap'
  | 'delete-partial'
  | 'delete-covering'
  | 'caret-inside';

interface RangePatchRule {
  readonly name: RangePatchCase;
  readonly when: (f: Facts) => boolean;
}

/**
 * §17.2 情形表（另加空补丁 `noop`）。条件对应冻结方案；`before` / `after` 额外要求补丁非空，
 * 使空补丁只命中 `noop`（冻结方案的情形表只讨论非空补丁）。
 */
export const RANGE_PATCH_RULES: readonly RangePatchRule[] = [
  { name: 'noop', when: ({ ps, pe, len }) => ps === pe && len === 0 },
  { name: 'before', when: ({ a, ps, pe, len }) => (ps < pe || len > 0) && (pe < a || (pe === a && ps < pe)) },
  { name: 'after', when: ({ b, ps, pe, len }) => (ps < pe || len > 0) && (ps > b || (ps === b && ps < pe)) },
  { name: 'insert-inside', when: ({ a, b, ps, pe, len }) => ps === pe && len > 0 && a < ps && ps < b },
  { name: 'insert-at-start', when: ({ a, b, ps, pe, len }) => ps === pe && len > 0 && ps === a && a < b },
  { name: 'insert-at-end', when: ({ a, b, ps, pe, len }) => ps === pe && len > 0 && ps === b && a < b },
  { name: 'insert-at-caret', when: ({ a, b, ps, pe, len }) => ps === pe && len > 0 && a === b && ps === a },
  { name: 'replace-overlap', when: ({ a, b, ps, pe, len }) => a < b && ps < pe && len > 0 && ps < b && pe > a },
  {
    name: 'delete-partial',
    when: ({ a, b, ps, pe, len }) => a < b && ps < pe && len === 0 && ps < b && pe > a && !(ps <= a && pe >= b),
  },
  { name: 'delete-covering', when: ({ a, b, ps, pe, len }) => len === 0 && ps <= a && pe >= b && a < b && ps < pe },
  { name: 'caret-inside', when: ({ a, b, ps, pe }) => a === b && ps < a && a < pe },
];

function isWellFormed(start: number, end: number): boolean {
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end;
}

/** 按 §17.2 判定范围与补丁的关系；输入合法时恰好命中一条规则。 */
export function classifyRangePatch(range: SourceRange, patch: TextPatch): RangePatchCase | undefined {
  const facts: Facts = {
    a: range.start,
    b: range.end,
    ps: patch.start,
    pe: patch.end,
    len: patch.text.length,
  };
  const hits = RANGE_PATCH_RULES.filter((rule) => rule.when(facts));
  return hits.length === 1 ? hits[0]?.name : undefined;
}

function mapped(start: number, end: number): RangeTransformOutcome {
  return { kind: 'mapped', range: { start, end } };
}

/** 把一个范围经单个补丁变换（§17.2）。 */
export function transformSourceRange(range: SourceRange, patch: TextPatch, bias: RangeBias): RangeTransformOutcome {
  if (!isWellFormed(range.start, range.end)) return { kind: 'invalid', reason: 'range-malformed' };
  if (!isWellFormed(patch.start, patch.end)) return { kind: 'invalid', reason: 'patch-malformed' };
  const a = range.start;
  const b = range.end;
  const ps = patch.start;
  const pe = patch.end;
  const len = patch.text.length;
  const delta = len - (pe - ps);
  switch (classifyRangePatch(range, patch)) {
    case 'noop':
    case 'after':
      return mapped(a, b);
    case 'before':
      return mapped(a + delta, b + delta);
    case 'insert-inside':
      return mapped(a, b + len);
    case 'insert-at-start':
      return bias.start === 'absorb' ? mapped(a, b + len) : mapped(a + len, b + len);
    case 'insert-at-end':
      return bias.end === 'absorb' ? mapped(a, b + len) : mapped(a, b);
    case 'insert-at-caret':
      return bias.caret === 'after' ? mapped(a + len, a + len) : mapped(a, a);
    case 'replace-overlap':
      return mapped(a <= ps ? a : ps, b >= pe ? b + delta : ps + len);
    case 'delete-partial':
      return mapped(a <= ps ? a : ps, b >= pe ? b + delta : ps);
    case 'delete-covering':
      return { kind: 'covered', collapseAt: ps };
    case 'caret-inside':
      return mapped(ps + len, ps + len);
    case undefined:
      return { kind: 'invalid', reason: 'unclassified' }; // 不可达：穷举测试保证合法输入恰好命中一条规则
  }
}

/**
 * 把一个范围依次经一组顺序补丁变换（第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本）。
 * 一旦被整体覆盖，结果保持 `covered`，删除点继续按折叠范围随后续补丁变换。
 */
export function transformSourceRangeThrough(
  range: SourceRange,
  patches: readonly TextPatch[],
  bias: RangeBias,
): RangeTransformOutcome {
  let current: RangeTransformOutcome = mapped(range.start, range.end);
  for (const patch of patches) {
    if (current.kind === 'invalid') return current;
    if (current.kind === 'mapped') {
      current = transformSourceRange(current.range, patch, bias);
      continue;
    }
    const caret = transformSourceRange({ start: current.collapseAt, end: current.collapseAt }, patch, bias);
    if (caret.kind !== 'mapped') return caret;
    current = { kind: 'covered', collapseAt: caret.range.start };
  }
  return current;
}
