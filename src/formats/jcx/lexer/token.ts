/**
 * JCX Lexer —— token 总表（M1.4 方案 §2）。
 *
 * 契约：每个 token 必有 `kind` / `raw` / `span`；语义字段一律是附属可选信息，
 * 解析失败不影响 `raw`。无损不变量唯一入口是 `flattenTokens` + `rawOf`。
 */

import type { SourceSpan } from './sourceSpan';

/** 方案 §2.1：顶层 line token。 */
export type JcxLineTokenKind =
  | 'bom'
  | 'eol'
  | 'whitespace'
  | 'blankLine'
  | 'magicHeader'
  | 'comment'
  | 'directivePrefix'
  | 'directiveName'
  | 'directiveValue'
  | 'textBlockBegin'
  | 'textBlockEnd'
  | 'textBlockContent'
  | 'fieldKey'
  | 'fieldColon'
  | 'fieldValue'
  | 'inlineFieldOpen'
  | 'inlineFieldKey'
  | 'inlineFieldColon'
  | 'inlineFieldValue'
  | 'inlineFieldClose'
  | 'raw';

/** 方案 §2.2：body token —— 模式 A（pitch）。 */
export type JcxPitchTokenKind =
  | 'accidental'
  | 'pitchLetter'
  | 'octaveMark'
  | 'duration'
  | 'brokenRhythm'
  | 'rest'
  | 'hiddenRest'
  | 'barline'
  | 'repeatEnding'
  | 'chordOpen'
  | 'chordClose'
  | 'tupletStart'
  | 'slurOpen'
  | 'slurClose'
  | 'tie'
  | 'graceOpen'
  | 'graceClose'
  | 'decorationSimple'
  | 'decorationComplex'
  | 'chordSymbol';

/** 方案 §2.3：body token —— 模式 B（TAB）独有部分。 */
export type JcxTabTokenKind =
  | 'strokePrefix'
  | 'stringLetter'
  | 'fret'
  | 'tabDurSep'
  | 'tabRelation'
  | 'tabGroupOpen'
  | 'tabGroupClose';

export type JcxTokenKind = JcxLineTokenKind | JcxPitchTokenKind | JcxTabTokenKind;

/** 携带附属语义字段的 kind，其余 kind 只有基础三字段。 */
type JcxTokenKindWithExtra =
  | 'rest'
  | 'decorationComplex'
  | 'fieldKey'
  | 'directiveName'
  | 'inlineFieldKey';

interface JcxTokenBase<K extends JcxTokenKind> {
  readonly kind: K;
  readonly raw: string;
  readonly span: SourceSpan;
}

export type JcxPlainToken = JcxTokenBase<Exclude<JcxTokenKind, JcxTokenKindWithExtra>>;

/** §15.1 / §15.2：`z` 与 `Z` 不合并语义，仅记录原字母。 */
export interface JcxRestToken extends JcxTokenBase<'rest'> {
  readonly letter: 'z' | 'Z';
}

/** §23.2：复合装饰整体一个 token，`parts` 是 best-effort 拆解，可缺省。 */
export interface JcxDecorationComplexToken extends JcxTokenBase<'decorationComplex'> {
  readonly parts?: readonly string[];
}

/** §8.0：单字母字段名。 */
export interface JcxFieldKeyToken extends JcxTokenBase<'fieldKey'> {
  readonly key: string;
}

/** §10：`%%` 之后的指令名。 */
export interface JcxDirectiveNameToken extends JcxTokenBase<'directiveName'> {
  readonly name: string;
}

/** §9.1：`[V:1]` 中的字段名。 */
export interface JcxInlineFieldKeyToken extends JcxTokenBase<'inlineFieldKey'> {
  readonly key: string;
}

export type JcxToken =
  | JcxPlainToken
  | JcxRestToken
  | JcxDecorationComplexToken
  | JcxFieldKeyToken
  | JcxDirectiveNameToken
  | JcxInlineFieldKeyToken;

/** 方案 §2.1 的行类别（§13.3 行分类结果）。 */
export type JcxLineKind =
  | 'blank'
  | 'magicHeader'
  | 'comment'
  | 'directive'
  | 'textBlockBegin'
  | 'textBlockEnd'
  | 'textBlockContent'
  | 'field'
  | 'inlineField'
  | 'body'
  | 'raw';

export interface JcxLexLine {
  /** 0-based 行下标（`span.start.line` 是 1-based 行号）。 */
  readonly index: number;
  readonly span: SourceSpan;
  readonly kind: JcxLineKind;
  readonly tokens: readonly JcxToken[];
  /** 仅 body 行有意义；§13.2 模式状态机的结果。 */
  readonly mode?: 'pitch' | 'tab';
}

/** 无损不变量唯一入口：把所有行的 token 按源顺序摊平。 */
export function flattenTokens(lines: readonly JcxLexLine[]): JcxToken[] {
  const result: JcxToken[] = [];
  for (const line of lines) {
    for (const token of line.tokens) {
      result.push(token);
    }
  }
  return result;
}

/** 拼接 token 的 `raw`，用于 §29.5 逐行不变量与全文不变量。 */
export function rawOf(tokens: readonly JcxToken[]): string {
  let out = '';
  for (const token of tokens) {
    out += token.raw;
  }
  return out;
}
