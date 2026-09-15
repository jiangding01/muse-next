/**
 * canonical 序列化 —— 诊断工厂（M1.7 T4）。
 *
 * `CanonicalDiagnostic` 的类型定义在 `./voice`（T3），这里只提供构造函数，
 * 避免 body 三个文件各写一份零 span 字面量。`span` 恒为哨兵零值：Domain 里
 * 没有 `SourceSpan`，canonical 方向也没有「源位置」，定位一律以 `path` 为准
 * （见 `voice.ts` 对 `CanonicalDiagnostic.span` 的说明）。
 */

import type { CanonicalDiagnostic } from './voice';

const ZERO_POSITION = { offset: 0, line: 1, column: 0 };
const ZERO_SPAN = { start: ZERO_POSITION, end: ZERO_POSITION };

export function canonicalWarning(
  code: `jcx.serialize.${string}`,
  message: string,
  path?: string,
): CanonicalDiagnostic {
  return {
    code,
    severity: 'warning',
    message,
    span: ZERO_SPAN,
    ...(path === undefined ? {} : { path }),
  };
}
