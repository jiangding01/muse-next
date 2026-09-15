/**
 * Parse 层 diagnostics 工具（M1.6 方案 v1.1 §4）。
 *
 * 约定：
 * - code 形态恒为 `jcx.parse.<area>.<problem>`（类型层由 `JcxParseDiagnosticCode` 约束）；
 * - `path` 写 AstPath 字符串，用 `originOf(node)` 取；
 * - `error` 级只留给「Domain 结构不可用」，语料预期 0 条（方案 §2 末）。
 */

import type {
  DiagnosticBag,
  JcxParseDiagnosticCode,
  JcxSeverity,
} from '../lexer/diagnostics';
import type { SourceSpan } from '../lexer/sourceSpan';
import type { SourceRef } from '../../../domain';

/**
 * 记录一条 parse 级 diagnostic。相对 `bag.report` 的收窄：code 必须是 parse 形态，
 * 且 `path` 为必填——parse 层每条诊断都能指到一个 AST 节点。
 */
export function reportParse(
  bag: DiagnosticBag,
  code: JcxParseDiagnosticCode,
  severity: JcxSeverity,
  message: string,
  span: SourceSpan,
  path: SourceRef,
): void {
  bag.report(code, severity, message, span, path);
}

/**
 * 「每文档一次」去重器：`Z` / `@` / `play=` / 歌词对齐这类 info 只在首次出现时上报，
 * 后续同 key 的调用被静默丢弃（方案 §2）。
 *
 * 每次调用 `onceKeyed` 得到一个**独立**的去重作用域，所以一次 `parseJcxDocument`
 * 只创建一个，跨文档不会互相污染。
 */
export interface OnceKeyedReporter {
  /** 首次上报返回 `true`；已上报过同 key 时不写入 bag，返回 `false`。 */
  reportOnce(
    key: string,
    code: JcxParseDiagnosticCode,
    severity: JcxSeverity,
    message: string,
    span: SourceSpan,
    path: SourceRef,
  ): boolean;
  /** 该 key 是否已上报过（不产生副作用）。 */
  seen(key: string): boolean;
}

export function onceKeyed(bag: DiagnosticBag): OnceKeyedReporter {
  const emitted = new Set<string>();

  const seen = (key: string): boolean => emitted.has(key);

  const reportOnce = (
    key: string,
    code: JcxParseDiagnosticCode,
    severity: JcxSeverity,
    message: string,
    span: SourceSpan,
    path: SourceRef,
  ): boolean => {
    if (emitted.has(key)) {
      return false;
    }
    emitted.add(key);
    reportParse(bag, code, severity, message, span, path);
    return true;
  };

  return { reportOnce, seen };
}
