/**
 * fixture 矩阵的共用判定逻辑（M1.8 T4，方案 v1.1 §4 T4 / §0a 第 5 条）。
 *
 * `roundtrip.test.ts` / `roundtrip.closure.test.ts` 与
 * `scripts/jcx/fixture-report.ts` 共用本文件——两边都只允许「调用下面的判定
 * 函数 + 断言/打印」，不得各自重新实现一份等价的指标判断逻辑（方案 §6 固定
 * 审查项 10）。本文件只做布尔 / 差异位置判定，不做 IO、不做打印、不做 vitest
 * 断言，也不写死 fixture 总数——`fixtureNames` 是运行时 glob 的结果。
 */

import { loadJcx } from '../../../../src/formats/jcx';
import { firstProjectionDifference } from '../../../../src/formats/jcx/serialize';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import {
  canonicalTrip,
  cleanFixtureNames,
  errorDiagnostics,
  fixtureBytes,
  fixtureNames,
  isOriginalClean,
  malformedFixtureNames,
} from './roundtrip.helpers';
import { closureTrip, firstByteDifference, firstTextByteDifference } from './roundtrip.closure.helpers';

export { fixtureNames, cleanFixtureNames, malformedFixtureNames, isOriginalClean };

/**
 * L2 的唯一豁免（`canonical/body.ts` 文件头「已知限制①」）：值是钉死的差异
 * 路径。单一定义来源——`roundtrip.test.ts` 与 `fixture-report.ts` 都从这里
 * import，不得各自声明一份。
 */
export const L2_KNOWN_LIMITATION: Readonly<Record<string, string>> = {
  'unclosed-chord.jcx': '$.voices[0].events[3].tokenKind',
};

export function isL2KnownLimitation(name: string): boolean {
  return name in L2_KNOWN_LIMITATION;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** L1：原始字节 parse 后无 error 级 diagnostic（与 `isOriginalClean` 同一判据）。 */
export function checkL1(name: string): boolean {
  return isOriginalClean(name);
}

export interface L2Check {
  /** `project(parse(x))` 与 `project(parse(canonical(parse(x))))` 的第一处差异路径；相等时为 `null`。 */
  readonly diffPath: string | null;
  /** 差异是否恰好等于豁免名单里钉死的位置（非豁免 fixture 恒为 `false`）。 */
  readonly matchesKnownLimitation: boolean;
}

/** L2：语义投影是否相等（豁免 fixture 额外报告差异是否落在记录在案的位置）。 */
export function checkL2(name: string): L2Check {
  const trip = canonicalTrip(name);
  const diffPath = firstProjectionDifference(trip.before, trip.after);
  const pinned = L2_KNOWN_LIMITATION[name];
  return {
    diffPath,
    matchesKnownLimitation: pinned !== undefined && diffPath === pinned,
  };
}

/** L3：`preserve` 输出与原字节逐字节相等。 */
export function checkL3(name: string): boolean {
  const original = fixtureBytes(name);
  const result = serializeJcx(loadJcx(original), { mode: 'preserve' });
  return bytesEqual(result.bytes, original);
}

/** 幂等：`canonical(parse(canonical(x))) === canonical(x)`。 */
export function checkIdempotent(name: string): boolean {
  const trip = canonicalTrip(name);
  return trip.canonicalTwice === trip.canonicalText;
}

/** reparse health：canonical 输出重解析后无 error 级 diagnostic，外加错误计数（malformed 组观测用）。 */
export function checkReparseClean(name: string): { readonly ok: boolean; readonly errorCount: number } {
  const trip = canonicalTrip(name);
  const errorCount = errorDiagnostics(trip.reparsedDiagnostics).length;
  return { ok: errorCount === 0, errorCount };
}

export interface ClosureCheck {
  /** 不动点：`canonical(parse(canon1)) === canon1`。 */
  readonly fixedPoint: boolean;
  /** L2 闭包：`project(parse(canon1))` 与 `project(parse(canon2))` 相等。 */
  readonly l2: boolean;
  /** L3 闭包：`preserve(loadJcx(canon1.bytes)).bytes` 与 `canon1.bytes` 相等。 */
  readonly l3: boolean;
  /** reparse clean：`loadJcx(canon1.text).diagnostics` 无 error 级（对全部 fixture 生效，无豁免）。 */
  readonly reparseClean: boolean;
}

/** canonical document closure 四项断言（M1.8 T1，零豁免，见 `roundtrip.closure.test.ts` 文件头）。 */
export function checkClosure(name: string): ClosureCheck {
  const trip = closureTrip(name);
  return {
    fixedPoint: firstTextByteDifference(trip.canon1Text, trip.canon2Text) === null,
    l2: firstProjectionDifference(trip.projectionAfterCanon1, trip.projectionAfterCanon2) === null,
    l3: firstByteDifference(trip.preserveOfCanon1Bytes, trip.canon1Bytes) === null,
    reparseClean: errorDiagnostics(trip.reparsedDiagnostics).length === 0,
  };
}

export function closureAllOk(check: ClosureCheck): boolean {
  return check.fixedPoint && check.l2 && check.l3 && check.reparseClean;
}

export interface FixtureRow {
  readonly name: string;
  readonly isClean: boolean;
  readonly l1Ok: boolean;
  readonly l2: L2Check;
  readonly l3Ok: boolean;
  readonly idempotentOk: boolean;
  readonly reparseClean: { readonly ok: boolean; readonly errorCount: number };
  readonly closure: ClosureCheck;
}

/** 单个 fixture 的完整矩阵行——report 脚本与测试都基于这一个结构算数字。 */
export function computeFixtureRow(name: string): FixtureRow {
  return {
    name,
    isClean: isOriginalClean(name),
    l1Ok: checkL1(name),
    l2: checkL2(name),
    l3Ok: checkL3(name),
    idempotentOk: checkIdempotent(name),
    reparseClean: checkReparseClean(name),
    closure: checkClosure(name),
  };
}

/** 全体 fixture 的矩阵行（运行时 glob，行数不写死）。 */
export function computeFixtureMatrix(): readonly FixtureRow[] {
  return fixtureNames.map((name) => computeFixtureRow(name));
}
