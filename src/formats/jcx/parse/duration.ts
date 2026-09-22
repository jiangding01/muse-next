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
import type { Meter, Rational, SourceRef, VoiceId } from '../../../domain';
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

/**
 * 一条 body 区 `L:` 的生效起点。`lineIndex` 是 AST 行下标（0-based），即 `AstPath` 的行号。
 *
 * `voiceId` 缺省（`undefined`）表示这条 `L:` 是 **global binding**：header 的
 * `L:` 恒为 global；body 区出现在任何声部上下文之前的 `L:` 也是 global（spec
 * §8.5 U06 裁决第 3 点）。有 `voiceId` 的条目只对该声部生效。
 */
export interface UnitLengthEntry {
  readonly lineIndex: number;
  readonly unitLength: Rational;
  /** `L:` 的值原文（如 `1/8`）：事实字段，序列化时直接写回，不由 `unitLength` 反拼。 */
  readonly raw: string;
  readonly origin: SourceRef;
  readonly voiceId?: VoiceId;
}

/**
 * 位置敏感、按声部作用域的单位音长查询（spec §8.5 U06 已裁决）。
 *
 * 作用域规则（U06 裁决，2026-09-22）：body `L:` 只作用于它所在的声部，从该行起
 * 生效直到被同一声部后续的 `L:` 覆盖（CONFIRMED：语料自洽 + Muse Pro 原版渲染
 * 对照）；同一声部被 `[V:n]` 交错成多段时按声部持续到后续段（INFERRED，语料
 * 无样本区分「按声部持续」与「按段重置」，两者在全部语料上结果相同）。出现在
 * 任何声部上下文之前的 `L:`（无归属）与 header 的 `L:` 一律按 global 处理，对
 * 其后所有声部生效直到被覆盖——因此每次查询都取「该声部条目 ∪ global 条目中
 * 行号 ≤ origin 的最近一条」。
 */
export interface UnitLengthScope {
  /** header 区最终生效的 `L:`（含 §8.5 缺省推断的结果）；无法确定时为 `undefined`。 */
  readonly header: Rational | undefined;
  readonly entries: readonly UnitLengthEntry[];
  /** 查询某个 AST 行下标 + 声部处生效的单位音长；`voiceId` 省略时只看 global 条目。 */
  unitLengthAtLine(lineIndex: number, voiceId?: VoiceId): Rational | undefined;
  /** 查询某个 AST 行下标 + 声部处生效的 body 区 `L:` 条目；仍由 header 生效时为 `undefined`。 */
  entryAtLine(lineIndex: number, voiceId?: VoiceId): UnitLengthEntry | undefined;
  /** 查询某个 `SourceRef`（AstPath 字符串）+ 声部处生效的单位音长；非行路径时退回 header 值。 */
  unitLengthAt(origin: SourceRef, voiceId?: VoiceId): Rational | undefined;
}

export function createUnitLengthScope(
  header: Rational | undefined,
  entries: readonly UnitLengthEntry[],
): UnitLengthScope {
  // 文档位置序：header 的值在所有 body 条目之前生效。
  const ordered = [...entries].sort((a, b) => a.lineIndex - b.lineIndex);

  // 该声部条目 ∪ global 条目；`ordered` 已按 lineIndex 升序，过滤后仍保持有序。
  const applicable = (voiceId: VoiceId | undefined): readonly UnitLengthEntry[] =>
    ordered.filter((entry) => entry.voiceId === undefined || entry.voiceId === voiceId);

  const entryAtLine = (lineIndex: number, voiceId?: VoiceId): UnitLengthEntry | undefined => {
    let current: UnitLengthEntry | undefined;
    for (const entry of applicable(voiceId)) {
      if (entry.lineIndex > lineIndex) {
        break;
      }
      current = entry;
    }
    return current;
  };

  const unitLengthAtLine = (lineIndex: number, voiceId?: VoiceId): Rational | undefined => {
    const entry = entryAtLine(lineIndex, voiceId);
    return entry === undefined ? header : entry.unitLength;
  };

  const unitLengthAt = (origin: SourceRef, voiceId?: VoiceId): Rational | undefined => {
    const parsed = parseAstPath(origin);
    if (parsed === null || parsed.kind !== 'line') {
      return header;
    }
    return unitLengthAtLine(parsed.line, voiceId);
  };

  return { header, entries: ordered, unitLengthAtLine, entryAtLine, unitLengthAt };
}

// ---------------------------------------------------------------------------
// 时值形态解析（T6；spec §16.1 / §26.5）
// ---------------------------------------------------------------------------

/** §16.1 的五种形态，外加 `N/M`。顺序即优先级，`//` 必须先于 `/N` 与 `/`。 */
const DURATION_FORMS: readonly { readonly re: RegExp; readonly of: (m: RegExpExecArray) => readonly [number, number] }[] = [
  { re: /^(\d+)\/(\d+)$/, of: (m) => [Number(m[1]), Number(m[2])] },
  { re: /^(\d+)\/$/, of: (m) => [Number(m[1]), 2] },
  { re: /^(\d+)$/, of: (m) => [Number(m[1]), 1] },
  { re: /^\/\/$/, of: () => [1, 4] },
  { re: /^\/(\d+)$/, of: (m) => [1, Number(m[1])] },
  { re: /^\/$/, of: () => [1, 2] },
];

/**
 * `fromParts` 的吞异常包装：`den === 0`（如 `C/0`）与越界输入一律降级为 `undefined`，
 * 不向上抛——parse 层「永不抛异常」的契约优先于「越界必须可见」。
 */
function safeRational(num: number, den: number): Rational | undefined {
  if (!Number.isSafeInteger(num) || !Number.isSafeInteger(den) || den === 0) {
    return undefined;
  }
  return fromParts(num, den);
}

/** `safeMul` 的交叉约分用；与 `domain/rational.ts` 内部的同名函数同实现，不跨层复用私有函数。 */
function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

/**
 * `domain.mul` 的吞异常版本：越界返回 `undefined` 而不是抛 `RangeError`。
 *
 * 约分步骤与 `domain/rational.ts` 的 `mul` 完全一致（交叉约分后再构造），因此
 * **不会**把 `mul` 本能算出的结果误判为越界；只是把 `mul` 会抛异常的那些输入
 * 降级成 `undefined`，交由调用方发 diagnostic——parse 层「永不抛异常」的契约。
 */
export function safeMul(a: Rational, b: Rational): Rational | undefined {
  const g1 = gcd(a.num, b.den);
  const g2 = gcd(b.num, a.den);
  const safeG1 = g1 === 0 ? 1 : g1;
  const safeG2 = g2 === 0 ? 1 : g2;
  return safeRational((a.num / safeG1) * (b.num / safeG2), (a.den / safeG2) * (b.den / safeG1));
}

/**
 * 把 pitch 模式的时值原文解析成「单位音长的倍数」（spec §16.1）。
 *
 * `N` → N、`N/` → N/2、`/N` → 1/N、`/` → 1/2、`//` → 1/4、`N/M` → N/M。
 * 形态不符返回 `undefined`（lexer 的 `DURATION_RE` 已保证形态，实际不应发生）。
 */
export function parseDurationRaw(raw: string): Rational | undefined {
  for (const form of DURATION_FORMS) {
    const match = form.re.exec(raw);
    if (match !== null) {
      const [num, den] = form.of(match);
      return safeRational(num, den);
    }
  }
  return undefined;
}

/**
 * TAB 模式的时值（spec §26.5）：分隔符本身携带语义，必须与数值一起看。
 *
 * 逐条对照 §26.5 的 `tab-note = [stroke] string-letter fret [ ("*"|"/") duration-value ]`：
 * - `*N` → N 倍单位音长（§26.5 表：`a1*2` = 2 倍；`*3/2` 为同表的 DOC-ONLY 附点形态）；
 * - `/N` → 1/N（§26.5 表：`a1/2` = 1/2）；`/` 单独出现 → 1/2（§16.1 的 `/` 简写，
 *   §26.5 只写「用 `/` 分隔」而未单列该简写，故此处依据是 §16.1 + §26.9 的形态共享）；
 * - `//` → 1/4：**§26.5 未直接定义**，依据是 §16.1 的 `//` = 1/4 加上 §16.1 语料印证行
 *   明确把 `ax//`（TAB 中的 `//`）列为同一形态。
 *
 * 无法归入以上形态（如 `*` 后无数值、`//` 后又跟数值）时返回 `undefined`，由调用方发诊断。
 */
export function parseTabDurationRaw(sep: string, value: string): Rational | undefined {
  if (sep === '*') {
    return value === '' ? undefined : parseDurationRaw(value);
  }
  if (sep === '//') {
    return value === '' ? parseDurationRaw('//') : undefined;
  }
  if (sep === '/') {
    return parseDurationRaw(`/${value}`);
  }
  return undefined;
}

/**
 * 倍数 × 单位音长（方案 §1.7 派生行，CONFIRMED §16.1 + §8.5）。
 *
 * 口径：时值原文缺省时倍数隐含为 1，由调用方（`scanPitch.pitchDuration`）直接取
 * `unitLength` 物化，不经过本函数——`durationRaw` 保持缺省，只有 `duration` 被派生。
 *
 * `unitLength` 未知（E1）时返回 `undefined`：只保留 `durationRaw`，不猜时值。
 * 乘法越界同样降级为 `undefined`，不抛。
 */
export function scaleByUnitLength(
  factor: Rational,
  unitLength: Rational | undefined,
): Rational | undefined {
  if (unitLength === undefined) {
    return undefined;
  }
  return safeRational(factor.num * unitLength.num, factor.den * unitLength.den);
}

/**
 * T6 的统一出口：`factor` 已由 `parseDurationRaw` / `parseTabDurationRaw` 得出。
 *
 * - `factor === undefined` 且原文非空 → warning `jcx.parse.duration.unparsed`
 *   （lexer 已保证形态，触发即说明 lexer 与本表脱节，故取 warning 而非静默）；
 * - `unitLength` 未知 → 返回 `undefined`（E1，不再重复发诊断，header 已发过一次）。
 */
export function resolveDuration(
  factor: Rational | undefined,
  raw: string,
  unitLength: Rational | undefined,
  bag: DiagnosticBag,
  span: SourceSpan,
  path: SourceRef,
): Rational | undefined {
  if (factor === undefined) {
    reportParse(
      bag,
      'jcx.parse.duration.unparsed',
      'warning',
      `时值原文 ${JSON.stringify(raw)} 不符合 spec §16.1 / §26.5 的任何形态，只保留 durationRaw`,
      span,
      path,
    );
    return undefined;
  }
  return scaleByUnitLength(factor, unitLength);
}
