/**
 * Parse 层 —— `L:` 单位音长的解析、缺省推断与作用域（spec §8.5、方案 v1.1 §2 / §7 E1）。
 *
 * 三件事刻意分开：
 * 1. `parseUnitLength` —— 纯值解析；
 * 2. `resolveDefaultUnitLength` —— 无 `L:` 时按**文档规则**（不是语料）推断，必发 info；
 * 3. `UnitLengthScope` —— 位置敏感查询，供 T6 问「某个事件所在位置的 unitLength」。
 *
 * E1 已拍板：既无 `L:` 又无数值 `M:` 时**不兜底 1/8**，`unitLength` 留空，
 * 事件只保留 `durationRaw`（方案 §7）。
 */

import { parseAstPath } from '../ast';
import type { DiagnosticBag } from '../lexer/diagnostics';
import type { SourceSpan } from '../lexer/sourceSpan';
import type { Meter, Rational, SourceRef } from '../../../domain';
import { fromParts } from '../../../domain';
import { meterRatio } from './keyMeter';
import { reportParse } from './diagnostics';

/** spec §8.5 语料形态：`1/8`（多数）与 `1/4`，恒为 `<正整数>/<正整数>`。 */
const UNIT_LENGTH_PATTERN = /^(\d+)\/(\d+)$/;

/** §8.5 缺省推断的分界：`M:` 换算成小数后 `< 0.75` 取 1/16，否则取 1/8。 */
const DEFAULT_THRESHOLD = 0.75;

const SIXTEENTH: Rational = { num: 1, den: 16 };
const EIGHTH: Rational = { num: 1, den: 8 };

/** 解析 `L:` 的值；形态不符（含空值、0 分母）时返回 `undefined`，不臆造。 */
export function parseUnitLength(raw: string): Rational | undefined {
  const match = UNIT_LENGTH_PATTERN.exec(raw);
  if (match === null) {
    return undefined;
  }
  const num = Number(match[1]);
  const den = Number(match[2]);
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    return undefined;
  }
  return fromParts(num, den);
}

/**
 * 文档没写 `L:` 时的推断（spec §8.5，help 2.1.2 与 ABC 2.1 3.1.7 一致）。
 *
 * - 有数值 `M:`：`num/den < 0.75 → 1/16`，否则 `1/8`，发 info
 *   `jcx.parse.unit-length.defaulted`——等级是 `CONFIRMED BY DOCUMENTATION`，
 *   语料中 `L:` 从未缺席，故 message 里必须写明依据是文档/标准而非语料；
 * - 无数值 `M:`：返回 `undefined` 并发 warning `jcx.parse.unit-length.unresolved`（E1）。
 *   severity 取 warning 而非 error：Score 结构本身仍然可用，只是所有事件缺 `duration`。
 */
export function resolveDefaultUnitLength(
  meter: Meter | undefined,
  bag: DiagnosticBag,
  span: SourceSpan,
  path: SourceRef,
): Rational | undefined {
  const ratio = meterRatio(meter);
  if (ratio === undefined) {
    reportParse(
      bag,
      'jcx.parse.unit-length.unresolved',
      'warning',
      '缺少 L: 且 M: 无数值拍号，单位音长无法确定；事件只保留 durationRaw，不计算 duration',
      span,
      path,
    );
    return undefined;
  }
  const resolved = ratio < DEFAULT_THRESHOLD ? SIXTEENTH : EIGHTH;
  reportParse(
    bag,
    'jcx.parse.unit-length.defaulted',
    'info',
    `缺少 L:，按文档规则（help 2.1.2 / ABC 2.1 §3.1.7，非语料证据）由 M:${meter?.raw ?? ''} 推断单位音长为 ${resolved.num}/${resolved.den}`,
    span,
    path,
  );
  return resolved;
}

/** 一条 body 区 `L:` 的生效起点。`lineIndex` 是 AST 行下标（0-based），即 `AstPath` 的行号。 */
export interface UnitLengthEntry {
  readonly lineIndex: number;
  readonly unitLength: Rational;
  readonly origin: SourceRef;
}

/**
 * 位置敏感的单位音长查询（spec §8.5 UNVERIFIED U06）。
 *
 * 作用域规则按方案 §2 选定的那一支：**从该 `L:` 所在行起生效，直到被下一条 `L:` 覆盖**
 * （另一支解释是「到下一个 `[V:n]` 为止」，语料无法区分，故每条 body `L:` 都带 U06 info）。
 */
export interface UnitLengthScope {
  /** header 区最终生效的 `L:`（含 §8.5 缺省推断的结果）；无法确定时为 `undefined`。 */
  readonly header: Rational | undefined;
  readonly entries: readonly UnitLengthEntry[];
  /** 查询某个 AST 行下标处生效的单位音长。 */
  unitLengthAtLine(lineIndex: number): Rational | undefined;
  /** 查询某个 `SourceRef`（AstPath 字符串）处生效的单位音长；非行路径时退回 header 值。 */
  unitLengthAt(origin: SourceRef): Rational | undefined;
}

export function createUnitLengthScope(
  header: Rational | undefined,
  entries: readonly UnitLengthEntry[],
): UnitLengthScope {
  // 文档位置序：header 的值在所有 body 条目之前生效。
  const ordered = [...entries].sort((a, b) => a.lineIndex - b.lineIndex);

  const unitLengthAtLine = (lineIndex: number): Rational | undefined => {
    let current = header;
    for (const entry of ordered) {
      if (entry.lineIndex > lineIndex) {
        break;
      }
      current = entry.unitLength;
    }
    return current;
  };

  const unitLengthAt = (origin: SourceRef): Rational | undefined => {
    const parsed = parseAstPath(origin);
    if (parsed === null || parsed.kind !== 'line') {
      return header;
    }
    return unitLengthAtLine(parsed.line);
  };

  return { header, entries: ordered, unitLengthAtLine, unitLengthAt };
}
