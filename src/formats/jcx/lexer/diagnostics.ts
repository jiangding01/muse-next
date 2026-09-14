/**
 * JCX Lexer —— diagnostics 收集器（M1.4 方案 §5）。
 *
 * 铁律：收集器永不抛异常；Lexer 阶段不产生 `error` 级（留给 Parser）。
 */

import type { SourceSpan } from './sourceSpan';

export type JcxSeverity = 'error' | 'warning' | 'info';

/**
 * 已收录方案 §5 / §3 提到的 code；后续任务可按需追加成员。
 */
export type JcxDiagnosticCode =
  | 'jcx.voice.unknown-style'
  | 'jcx.directive.unknown'
  | 'jcx.field.unknown'
  /** §8.0 / §29.4：字段形态的行使用了全角冒号 `：`，按未知行保留。 */
  | 'jcx.field.fullwidth-colon'
  | 'jcx.body.unknown-token'
  | 'jcx.textblock.unterminated'
  | 'jcx.inline-field.odd-whitespace'
  | 'jcx.rest.hidden'
  | 'jcx.rest.uppercase-z'
  | 'jcx.voice.segment-by-order'
  | 'jcx.inline-field.trailing-body';

export interface JcxDiagnostic {
  readonly code: JcxDiagnosticCode;
  readonly severity: JcxSeverity;
  readonly message: string;
  readonly span: SourceSpan;
}

export interface DiagnosticBag {
  add(diagnostic: JcxDiagnostic): void;
  report(
    code: JcxDiagnosticCode,
    severity: JcxSeverity,
    message: string,
    span: SourceSpan,
  ): void;
  list(): readonly JcxDiagnostic[];
  hasSeverity(severity: JcxSeverity): boolean;
}

export function createDiagnosticBag(): DiagnosticBag {
  const items: JcxDiagnostic[] = [];

  const add = (diagnostic: JcxDiagnostic): void => {
    items.push(diagnostic);
  };

  const report = (
    code: JcxDiagnosticCode,
    severity: JcxSeverity,
    message: string,
    span: SourceSpan,
  ): void => {
    add({ code, severity, message, span });
  };

  const list = (): readonly JcxDiagnostic[] => items.slice();

  const hasSeverity = (severity: JcxSeverity): boolean =>
    items.some((item) => item.severity === severity);

  return { add, report, list, hasSeverity };
}
