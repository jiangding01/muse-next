/**
 * JCX Lexer —— 对外唯一入口（M1.4 方案 §1）。
 *
 * 当前仅提供类型契约与 stub；实现由 T3–T7 逐步补齐。
 */

export type {
  SourcePosition,
  SourceSpan,
  PositionTracker,
} from './sourceSpan';
export { createPositionTracker, spanOf, emptySpanAt } from './sourceSpan';

export type {
  JcxTokenKind,
  JcxLineTokenKind,
  JcxPitchTokenKind,
  JcxTabTokenKind,
  JcxToken,
  JcxPlainToken,
  JcxRestToken,
  JcxDecorationComplexToken,
  JcxFieldKeyToken,
  JcxDirectiveNameToken,
  JcxInlineFieldKeyToken,
  JcxLineKind,
  JcxLexLine,
} from './token';
export { flattenTokens, rawOf } from './token';

export type {
  JcxSeverity,
  JcxDiagnosticCode,
  JcxDiagnostic,
  DiagnosticBag,
} from './diagnostics';
export { createDiagnosticBag } from './diagnostics';

import type { JcxLexLine } from './token';
import type { JcxDiagnostic } from './diagnostics';

export type { JcxEncoding } from '../encoding/types';
import type { JcxEncoding } from '../encoding/types';

export interface JcxLexResult {
  readonly encoding: JcxEncoding;
  readonly hasBom: boolean;
  readonly hasTrailingNewline: boolean;
  readonly lines: readonly JcxLexLine[];
  readonly diagnostics: readonly JcxDiagnostic[];
}

export interface JcxLexOptions {
  /** 字节输入时的解码结果覆盖；文本输入时用于声明来源编码。 */
  readonly encoding?: JcxEncoding;
}

export function lexJcx(_source: string | Uint8Array, _options?: JcxLexOptions): JcxLexResult {
  throw new Error('lexJcx: not implemented (M1.4 T3-T7)');
}
