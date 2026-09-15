/**
 * JCX Lexer —— diagnostics 收集器（M1.4 方案 §5）。
 *
 * 铁律：收集器永不抛异常；Lexer 阶段不产生 `error` 级（留给 Parser）。
 */

import type { SourceSpan } from './sourceSpan';

export type JcxSeverity = 'error' | 'warning' | 'info';

/**
 * Lexer 阶段的 code：**封闭字面量联合**，新增必须改本文件（M1.4 方案 §5 / §3）。
 */
export type JcxLexerDiagnosticCode =
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
  | 'jcx.inline-field.trailing-body'
  /** §26.4：TAB 拨弦前缀未紧跟音符 / 音符组，无法确证其前缀身份。 */
  | 'jcx.tab.dangling-stroke-prefix';

/**
 * Parse 阶段的 code：形态固定为 `jcx.parse.<area>.<problem>`（M1.6 方案 v1.1 §4）。
 * 用模板字面量而非枚举，避免每个 parse 子任务都回头改 lexer 文件。
 */
export type JcxParseDiagnosticCode = `jcx.parse.${string}`;

/**
 * Serialize 阶段的 code：形态固定为 `jcx.serialize.<area>.<problem>`
 * （M1.7 方案 v1.1 §2，如 `jcx.serialize.unencodable-replaced`）。
 */
export type JcxSerializeDiagnosticCode = `jcx.serialize.${string}`;

export type JcxDiagnosticCode =
  | JcxLexerDiagnosticCode
  | JcxParseDiagnosticCode
  | JcxSerializeDiagnosticCode;

export interface JcxDiagnostic {
  readonly code: JcxDiagnosticCode;
  readonly severity: JcxSeverity;
  readonly message: string;
  readonly span: SourceSpan;
  /**
   * 关联的 AST 节点路径（`AstPath` 的字符串形式），由 parse 层写入；lexer 阶段恒缺省。
   * 故意声明为 `string` 而不 import `AstPath`：lexer 不得反向依赖 ast 层。
   */
  readonly path?: string;
}

export interface DiagnosticBag {
  add(diagnostic: JcxDiagnostic): void;
  report(
    code: JcxDiagnosticCode,
    severity: JcxSeverity,
    message: string,
    span: SourceSpan,
    path?: string,
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
    path?: string,
  ): void => {
    add({ code, severity, message, span, ...(path === undefined ? {} : { path }) });
  };

  const list = (): readonly JcxDiagnostic[] => items.slice();

  const hasSeverity = (severity: JcxSeverity): boolean =>
    items.some((item) => item.severity === severity);

  return { add, report, list, hasSeverity };
}
