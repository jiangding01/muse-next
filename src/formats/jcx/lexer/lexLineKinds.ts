/**
 * JCX Lexer —— 各行类别的 token 化（M1.4 方案 §7 T4，docs/JCX_SPEC.md §13.3）。
 *
 * 从 `lexDocument.ts` 拆出（T7 批次 C，纯移动、不改行为）。
 *
 * 本文件收纳「已经知道这一行是什么类别之后，怎么把它切成 token」的全部规则，
 * 外加它们依赖的 KNOWN_* 白名单与行首判别正则。**分类顺序本身**（§13.3 的
 * 不可交换优先级）留在 `lexDocument.ts` 的 `lexLineContent` 里，两者职责分明：
 * 这里是「怎么切」，那里是「先看谁」。
 */

import type { SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxLineKind } from './token';
import type { ModeState, VoicePrescan } from './lexModes';
import { resolveMode } from './lexModes';
import { ZERO_SPAN } from './tokenBuilder';
import type { TokenBuilder } from './tokenBuilder';
import { KNOWN_DIRECTIVE_NAMES, KNOWN_FIELD_KEYS } from './lineVocabulary';

export { KNOWN_DIRECTIVE_NAMES, KNOWN_FIELD_KEYS } from './lineVocabulary';

const WS = /[ \t]/;

const KNOWN_FIELD_KEY_SET = new Set(KNOWN_FIELD_KEYS);
const KNOWN_DIRECTIVE_NAME_SET = new Set(KNOWN_DIRECTIVE_NAMES);

/** §7.1 / §7.4：整行必须恰好是 `%MUSE<版本串>`（行尾空白已先行剥离）。 */
const MAGIC_HEADER_RE = /^%MUSE\w+$/;
/** §5.7：`%%` 后允许空白，指令名字符集同 §10。 */
export const DIRECTIVE_RE = /^%%([ \t]*)([A-Za-z0-9_-]*)/;
/** §8.0：单字母 + 半角冒号。 */
export const FIELD_RE = /^([A-Za-z]):/;
/** §8.0：全角冒号 → 未知行（§29.4）。 */
export const FULLWIDTH_COLON_FIELD_RE = /^[A-Za-z]：/;
/** §9.1 + §9.5：`[` `字母` `:` `值` `]`，容忍 `[ V:1]` / `[V :1]` 这类异常空格。 */
export const INLINE_FIELD_RE = /^\[([ \t]*)([A-Za-z])([ \t]*):([ \t]*)([^\]]*)\]/;
export function leadingWhitespaceLength(text: string): number {
  let i = 0;
  while (i < text.length && WS.test(text[i] as string)) {
    i += 1;
  }
  return i;
}

export function trailingWhitespaceStart(text: string, floor: number): number {
  let i = text.length;
  while (i > floor && WS.test(text[i - 1] as string)) {
    i -= 1;
  }
  return i;
}

export function isBlankText(text: string): boolean {
  return text.length === 0 || leadingWhitespaceLength(text) === text.length;
}

/**
 * 对单行 `content`（已剥离 BOM 与 eol）切出
 * `[leading whitespace?] [content-as-raw] [trailing whitespace?]` 三段。
 *
 * 纯空白（含空字符串）视为空行，交由调用方决定 `blank` 分支。
 */
export function splitContentTokens(builder: TokenBuilder, content: string): boolean {
  if (isBlankText(content)) {
    builder.push('whitespace', content);
    return true;
  }

  const leadingEnd = leadingWhitespaceLength(content);
  const trailingStart = trailingWhitespaceStart(content, leadingEnd);

  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.push('raw', content.slice(leadingEnd, trailingStart));
  builder.push('whitespace', content.slice(trailingStart));
  return false;
}

/** 行分类过程中需要跨行携带的状态（§11.3 文本块 + §13.2 模式状态机）。 */
export interface LineContext {
  /** 是否处于 `%%begintext`…`%%endtext` 之间。 */
  inTextBlock: boolean;
  /** 未闭合时用于定位 diagnostic 的 `%%begintext` 行 span。 */
  textBlockBeginSpan: SourceSpan | null;
  /** §13.2：`V:` 预扫描表（全文一次，随文档不变）。 */
  readonly prescan: VoicePrescan;
  /** §13.2：正文词法模式状态机的可变状态。 */
  readonly modeState: ModeState;
}

/** §5.6 / §7.3：`%` 开头的行 —— 仅首行的整行 `%MUSE<ver>` 是 magic header。 */
export function lexPercentLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  isFirstLine: boolean,
): JcxLineKind {
  const trailingStart = trailingWhitespaceStart(content, leadingEnd);
  const body = content.slice(leadingEnd, trailingStart);

  if (isFirstLine && MAGIC_HEADER_RE.test(body)) {
    builder.push('whitespace', content.slice(0, leadingEnd));
    builder.push('magicHeader', body);
    builder.push('whitespace', content.slice(trailingStart));
    return 'magicHeader';
  }

  // §5.6：注释内容原样保留到行尾（行尾空白也属于注释原文）。
  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.push('comment', content.slice(leadingEnd));
  return 'comment';
}

/** §5.7 / §10 / §10.3 / §10.4：`%%` 指令行（含 text block 起止）。 */
export function lexDirectiveLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
  ctx: LineContext,
): JcxLineKind {
  const rest = content.slice(leadingEnd);
  const match = DIRECTIVE_RE.exec(rest);
  // `rest` 必以 `%%` 开头，正则恒匹配；此分支仅为类型收窄。
  const spacing = match?.[1] ?? '';
  const name = match?.[2] ?? '';
  const headLength = 2 + spacing.length + name.length;
  const value = rest.slice(headLength);

  builder.push('whitespace', content.slice(0, leadingEnd));

  if (name === 'begintext' || name === 'endtext') {
    // §11.4：`beginRaw` / `endRaw` 以整体原文（含 `%%` 与其后空白）承载。
    const kind = name === 'begintext' ? 'textBlockBegin' : 'textBlockEnd';
    builder.push(kind, rest.slice(0, headLength));
    builder.push('directiveValue', value);
    if (name === 'begintext') {
      ctx.inTextBlock = true;
      ctx.textBlockBeginSpan = lineSpan;
    } else {
      ctx.inTextBlock = false;
      ctx.textBlockBeginSpan = null;
    }
    return kind;
  }

  builder.push('directivePrefix', '%%');
  builder.push('whitespace', spacing);
  builder.pushToken({ kind: 'directiveName', raw: name, name, span: ZERO_SPAN });
  builder.push('directiveValue', value);

  if (!KNOWN_DIRECTIVE_NAME_SET.has(name)) {
    // §29.2：未知指令只发 info（指令数量多且多为排版参数，warning 会造成噪音）。
    bag.report(
      'jcx.directive.unknown',
      'info',
      name.length === 0
        ? "directive prefix '%%' without a directive name"
        : `unknown directive '%%${name}'`,
      lineSpan,
    );
  }

  return 'directive';
}

/** §8.0：`<字母><半角冒号><值>` 字段行；`fieldValue` 不含行尾空白。 */
export function lexFieldLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  key: string,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
  ctx: LineContext,
): JcxLineKind {
  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.pushToken({ kind: 'fieldKey', raw: key, key, span: ZERO_SPAN });
  // 字段相关的 diagnostic 一律指向 fieldKey token 而非整行（P2-1）。
  const keySpan = builder.lastSpan() ?? lineSpan;
  builder.push('fieldColon', ':');

  const rest = content.slice(leadingEnd + 2);
  const valueLeading = leadingWhitespaceLength(rest);
  const valueEnd = trailingWhitespaceStart(rest, valueLeading);

  builder.push('whitespace', rest.slice(0, valueLeading));
  // §5.6 反例 `K:G % 1 sharps`：值中的 `%` 一律按字面文本处理，不切注释。
  builder.push('fieldValue', rest.slice(valueLeading, valueEnd));
  builder.push('whitespace', rest.slice(valueEnd));

  if (!KNOWN_FIELD_KEY_SET.has(key)) {
    // §29.1：未知字段保留原文 + warning。
    bag.report(
      'jcx.field.unknown',
      'warning',
      `unknown information field '${key}:'`,
      keySpan,
    );
  }

  // §6.2 / §9.4：`K:` 结束 header 区，body 中的 `V:` 推进段落归属（方案 §3 第 4 条）。
  resolveMode(
    ctx.modeState,
    ctx.prescan,
    { type: 'field', key, value: rest.slice(valueLeading, valueEnd), span: keySpan },
    bag,
  );

  return 'field';
}

/** §9.1 / §9.5：行首 `[X:...]` 内联字段。 */
export function lexInlineFieldLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  match: RegExpExecArray,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
  ctx: LineContext,
): JcxLineKind {
  const afterOpen = match[1] as string;
  const key = match[2] as string;
  const beforeColon = match[3] as string;
  const afterColon = match[4] as string;
  const value = match[5] as string;

  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.push('inlineFieldOpen', '[');
  builder.push('whitespace', afterOpen);
  // §9.1 异常空白的 diagnostic 指向那个空白 token 本身（P2-1）；
  // 两处都异常时取第一处 —— 一行一条即可，第二处必与之同类。
  const oddSpan = afterOpen.length > 0 ? builder.lastSpan() : null;
  builder.pushToken({ kind: 'inlineFieldKey', raw: key, key, span: ZERO_SPAN });
  const keySpan = builder.lastSpan() ?? lineSpan;
  builder.push('whitespace', beforeColon);
  const oddSpanFinal = oddSpan ?? (beforeColon.length > 0 ? builder.lastSpan() : null);
  builder.push('inlineFieldColon', ':');
  // §9.1：冒号后的原始空白串必须独立保留（preserve 关键）。
  builder.push('whitespace', afterColon);
  builder.push('inlineFieldValue', value);
  builder.push('inlineFieldClose', ']');

  if (afterOpen.length > 0 || beforeColon.length > 0) {
    // §9.1：`[ V:1]` / `[V :1]` 语料 0 次、help 0 次 → 容忍但必须发 diagnostic。
    bag.report(
      'jcx.inline-field.odd-whitespace',
      'warning',
      `unexpected whitespace inside inline field '[${key}:'`,
      oddSpanFinal ?? keySpan,
    );
  }

  // §9.1 / §13.2：`[V:id]` 是模式切换点；其余 inline field（§9.5）不影响模式。
  if (key === 'V') {
    resolveMode(
      ctx.modeState,
      ctx.prescan,
      { type: 'inlineVoice', id: value.trim(), span: keySpan },
      bag,
    );
  }

  const trailing = content.slice(leadingEnd + (match[0] as string).length);
  if (trailing.length > 0) {
    // §9.2：help 示例 `[V:1] ABCD|` —— 同行余下正文按**切换后**的模式切分（方案 §3 第 7 条）。
    const trailingStart = builder.cursor();
    builder.pushBody(trailing, bag, ctx.modeState.mode);
    bag.report(
      'jcx.inline-field.trailing-body',
      'info',
      'music content follows an inline field on the same line',
      // 指向余下正文本身（起点 = `]` 之后的第一个字符），不是整行。
      { start: trailingStart, end: builder.cursor() },
    );
  }

  return 'inlineField';
}
