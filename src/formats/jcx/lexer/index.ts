/**
 * JCX Lexer —— 对外唯一入口（M1.4 方案 §1）。
 *
 * `lexJcx` 是应用层唯一应当调用的函数：接受源文本或原始字节，返回
 * 词法结果 + diagnostics。下层模块（`lexDocument` / `lexBody*` / `lexModes`）
 * 的导出只服务于单元测试与后续 Parser，不应被 UI 层直接使用。
 *
 * **异常契约**：`lexJcx` 本身永不抛异常 —— 一切异常写法都降级为 raw token +
 * diagnostic（方案 §5）。唯一可能逸出的异常是字节输入时 `decodeJcx` 抛出的
 * `JcxEncodingError`（UTF-16 BOM，§4.3 第 1 条）：那是「这个文件根本不是 JCX
 * 能表达的编码」，属于读文件阶段的失败，不是词法失败，故不吞。字符串输入
 * 不经过解码，因此绝无异常。
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

export type { JcxBodyMode } from './lexBody';
export { lexDocument, splitLines, hasTrailingNewline } from './lexDocument';
export type { RawLine, JcxEol } from './lexDocument';
export { prescanVoices, createModeState, resolveMode } from './lexModes';
export type { VoicePrescan, VoiceStyleInfo, ModeState, ModeEvent } from './lexModes';

import { decodeJcx } from '../encoding/decodeJcx';
import { createDiagnosticBag } from './diagnostics';
import { hasTrailingNewline as textHasTrailingNewline, lexDocument as lexDocumentText } from './lexDocument';

export interface JcxLexResult {
  readonly encoding: JcxEncoding;
  readonly hasBom: boolean;
  readonly hasTrailingNewline: boolean;
  readonly lines: readonly JcxLexLine[];
  readonly diagnostics: readonly JcxDiagnostic[];
}

export interface JcxLexOptions {
  /** 字节输入时的解码结果覆盖；文本输入时用于声明来源编码（缺省 `utf-8`）。 */
  readonly encoding?: JcxEncoding;
}

/** §5.5：BOM 不剥离，文本首字符即 U+FEFF。 */
const BOM = '\uFEFF';

/**
 * 词法分析一个 JCX 文档。
 *
 * - `Uint8Array` 输入：先经 `decodeJcx` 做 §4.3 编码检测（BOM 不剥离）。
 * - `string` 输入：直接词法分析；`encoding` 仅作为来源标注，缺省 `utf-8`。
 *
 * 返回的 `diagnostics` 在 M1.4 阶段不含 `error` 级（方案 §5）。
 */
export function lexJcx(source: string | Uint8Array, options?: JcxLexOptions): JcxLexResult {
  let text: string;
  let encoding: JcxEncoding;
  let hasBom: boolean;

  if (typeof source === 'string') {
    text = source;
    encoding = options?.encoding ?? 'utf-8';
    hasBom = text.startsWith(BOM);
  } else {
    const decoded = decodeJcx(source);
    text = decoded.text;
    encoding = options?.encoding ?? decoded.encoding;
    hasBom = decoded.hasBom;
  }

  const bag = createDiagnosticBag();
  const lines = lexDocumentText(text, bag);

  return {
    encoding,
    hasBom,
    hasTrailingNewline: textHasTrailingNewline(text),
    lines,
    diagnostics: bag.list(),
  };
}
