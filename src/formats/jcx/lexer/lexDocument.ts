/**
 * JCX Lexer —— 文档行切分 + §13.3 行分类 + 行级 token 化（M1.4 方案 §7 T3/T4）。
 *
 * T3 范围：`splitLines` 行切分（保留每行原始 eol）。
 * T4 范围：`lexDocument` 按 docs/JCX_SPEC.md §13.3 的**不可交换优先级**对每行分类，
 *          并切出该行的 token 序列。
 * 当前范围：body 行的正文段经 `lexBody` 分发，固定走模式 A（pitch）；
 * 按 voice style 选择模式是 T7 的职责。
 *
 * 行尾规则（docs/JCX_SPEC.md §5.1 / §5.2 / §5.11）：
 * - 只有 `\n` 会触发切行；`\r\n` 作为一个整体 eol 保留。
 * - 孤立的 `\r`（不紧跟 `\n`）不是行尾，留在 `content` 内部。
 * - 末行若无换行符，`eol === ''`；`hasTrailingNewline` 反映这一点。
 *
 * 分类优先级（§13.3，本实现按此顺序短路）：
 *   1. 处于 `%%begintext`…`%%endtext` 之间          → textBlockContent（§11.3）
 *   2. `%%begintext` / `%%endtext` 本身              → textBlockBegin / textBlockEnd（§10.3/§10.4）
 *   3. 整行为空或纯空白                              → blank（§5.4）
 *   4. 行首 `%%`（允许其后空白）                     → directive（§5.7, §10）
 *   5. 行首 `%`                                      → magicHeader（仅首行，§7.3）否则 comment（§5.6）
 *   6. `^[A-Za-z]:`                                  → field（§8.0）
 *   7. `^\[[A-Za-z]:`（容忍异常空格）                → inlineField（§9.1）
 *   8. `^[A-Za-z]：`（全角冒号）                      → raw（§8.0 / §29.4）
 *   9. 其余                                          → body（§13）
 *
 * 说明：§13.3 把 blank 排在 `%%` 之前、text block 之后，本实现与之等价 ——
 * text block 内的空行按 §11.3 第 1/2 条仍是内容行，故 blank 判定必须在 text block 之后。
 */

import { createPositionTracker } from './sourceSpan';
import type { SourcePosition, SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxLexLine, JcxLineKind, JcxPlainToken, JcxToken } from './token';
import { lexBody } from './lexBody';

/** 无附属字段的 plain kind（T1 `JcxPlainToken['kind']` 派生），不含 rest/fieldKey 等需要附属字段的 kind。 */
type PlainTokenKind = JcxPlainToken['kind'];

export type JcxEol = '' | '\n' | '\r\n';

export interface RawLine {
  /** 0-based 行下标。 */
  readonly index: number;
  /** 行内容起点位置（不含任何 BOM）。 */
  readonly start: SourcePosition;
  /** 行内容，不含行尾符（孤立 `\r` 除外，它留在 content 内）。 */
  readonly content: string;
  /** 该行的行尾符；末行无换行时为 `''`。 */
  readonly eol: JcxEol;
  /** 覆盖 `content + eol` 的完整 span。 */
  readonly span: SourceSpan;
}

const WS = /[ \t]/;

/**
 * 判断文本是否以换行符结尾（§5.2）。
 *
 * 空文本视为「无末尾换行」——空文本本身不含任何字节，谈不上「以换行结尾」，
 * 且与下方 `splitLines('')` 返回 0 行的决定保持一致（见该函数注释）。
 */
export function hasTrailingNewline(text: string): boolean {
  return text.length > 0 && text.endsWith('\n');
}

/**
 * 按行尾切分文本，逐行记录其原始行尾符与 span。
 *
 * 关键决定（docs/JCX_SPEC.md §5.4 / §5.11，方案 §7 T3 要求写明依据）：
 *
 * - **空文本 → 0 行**，而不是 1 行空行。理由：`RawLine` 代表「文本中确实存在的一行」，
 *   空文本没有任何字节可归属为一行；这与 `hasTrailingNewline('') === false`、
 *   `flattenTokens([]) → []`、`rawOf([]) === ''` 的既有约定一致（见 token.ts 测试），
 *   且避免凭空产生一个 span 长度为 0、无法对应任何源字节的「幽灵行」。
 * - **文本恰好以换行符结尾时，不会在末尾再多切出一个空行。**
 *   例如 `'a\n'` 只产生 1 行（`content: 'a', eol: '\n'`），而不是
 *   `['a\n', '']` 两行——那个假想的「第二行」不对应任何字符，是 `String.split('\n')`
 *   风格 API 的常见陷阱。换行符本身作为上一行的 `eol` 记录，不需要再造一行来承载它。
 *   仅当文本以换行符结尾但整体只有换行符本身（如 `'\n'`）时，产生 1 行
 *   （`content: '', eol: '\n'`），因为这一个换行符确实归属某一行的 eol。
 * - 孤立 `\r`（后面不是 `\n`）不识别为行尾，留在 `content` 内部，交由更上层
 *   （或 T4 的分类逻辑）决定如何处理。
 */
export function splitLines(text: string): RawLine[] {
  const lines: RawLine[] = [];
  if (text.length === 0) {
    return lines;
  }

  const tracker = createPositionTracker(text);
  let searchFrom = 0;
  let index = 0;

  while (searchFrom < text.length) {
    const start = tracker.current();
    const nlIndex = text.indexOf('\n', searchFrom);

    if (nlIndex === -1) {
      // 末行，无换行符。
      const content = text.slice(searchFrom);
      const end = tracker.advance(content.length);
      lines.push({ index, start, content, eol: '', span: { start, end } });
      break;
    }

    const isCrlf = nlIndex > searchFrom && text[nlIndex - 1] === '\r';
    const contentEnd = isCrlf ? nlIndex - 1 : nlIndex;
    const content = text.slice(searchFrom, contentEnd);
    const eol: JcxEol = isCrlf ? '\r\n' : '\n';

    tracker.advance(content.length);
    const end = tracker.advance(eol.length);
    lines.push({ index, start, content, eol, span: { start, end } });

    searchFrom = nlIndex + 1;
    index += 1;
  }

  return lines;
}


const BOM = '﻿';

/**
 * §8 登记的 information field 字母（10 个）。
 *
 * 取自 docs/JCX_SPEC.md §8.1–§8.10。不在此表中的单字母字段按 §29.1 处理：
 * 仍然按字段行分类并完整保留，但发 `jcx.field.unknown` warning。
 */
export const KNOWN_FIELD_KEYS: readonly string[] = [
  'X',
  'T',
  'C',
  'M',
  'L',
  'Q',
  'K',
  'I',
  'V',
  'w',
];

/** §10.1–§10.6：语料中实际出现的 6 个指令。 */
const CORPUS_DIRECTIVE_NAMES: readonly string[] = [
  'gchord',
  'showfinger',
  'begintext',
  'endtext',
  'skip',
  'indent',
];

/**
 * §10.7：help 记载但语料未出现的 DOCUMENTATION-ONLY 指令清单（67 个）。
 *
 * 按 §29.2「§10.7 清单中的指令……不发 diagnostic」的要求，它们与 §10.1–§10.6
 * 一起构成「已知指令名」集合；只有集合外的名字才发 `jcx.directive.unknown`。
 */
const DOC_ONLY_DIRECTIVE_NAMES: readonly string[] = [
  // 和弦图 / 吉他类（10）
  'showstroke',
  'showpattern',
  'showcheck',
  'showname',
  'chordgridwidth',
  'chordgridheight',
  'gchordspace',
  'tabstemheight',
  'tabstringsep',
  'tab_btextspace',
  // 字体类（12）
  'composerfont',
  'titlefont',
  'subtitlefont',
  'vocalfont',
  'voicefont',
  'textfont',
  'jianpufont',
  'tabfont',
  'gchordfont',
  'barnumberfont',
  'barlabelfont',
  'tempofont',
  // 页面 / 排版类（19）
  'pageheight',
  'pagewidth',
  'leftmargin',
  'topmargin',
  'botmargin',
  'staffwidth',
  'scale',
  'systemsep',
  'sysstaffsep',
  'strictness1',
  'barsperstaff',
  'barnumbers',
  'composerspace',
  'continueall',
  'titlespace',
  'titleleft',
  'subtitlespace',
  'vocalspace',
  'textspace',
  // V2.70 简谱排版参数（22）
  'jpbeamspace',
  'jpbeamthickness',
  'jpbeamnotespace',
  'jpoctavedotspace',
  'jpoctavedotsize',
  'jprhythmdotsize',
  'jprhythmdotspace',
  'jprhythmdotxshift',
  'jprhythmdotyshift',
  'jpbarlength',
  'jpbaryshift',
  'jphighoctavenotespace',
  'jplowoctavenotespace',
  'jplowoctavebeamspace',
  'jpextendthickness',
  'jpgracescale',
  'jpgraceyshift',
  'jpaccscale',
  'jpkeysigxshift',
  'jpkeysigyshift',
  'jpkeysigwidth',
  'jpwedgeyshift',
  // 五线谱 / 页面开关（4）
  'staffwedgeyshift',
  'staffwedgespread',
  'showkeymeter',
  'showpagenumber',
];

/** §10 + §10.7：已知指令名全集（73 个），集合外的名字发 `jcx.directive.unknown`。 */
export const KNOWN_DIRECTIVE_NAMES: readonly string[] = [
  ...CORPUS_DIRECTIVE_NAMES,
  ...DOC_ONLY_DIRECTIVE_NAMES,
];

const KNOWN_FIELD_KEY_SET = new Set(KNOWN_FIELD_KEYS);
const KNOWN_DIRECTIVE_NAME_SET = new Set(KNOWN_DIRECTIVE_NAMES);

/** §7.1 / §7.4：整行必须恰好是 `%MUSE<版本串>`（行尾空白已先行剥离）。 */
const MAGIC_HEADER_RE = /^%MUSE\w+$/;
/** §5.7：`%%` 后允许空白，指令名字符集同 §10。 */
const DIRECTIVE_RE = /^%%([ \t]*)([A-Za-z0-9_-]*)/;
/** §8.0：单字母 + 半角冒号。 */
const FIELD_RE = /^([A-Za-z]):/;
/** §8.0：全角冒号 → 未知行（§29.4）。 */
const FULLWIDTH_COLON_FIELD_RE = /^[A-Za-z]：/;
/** §9.1 + §9.5：`[` `字母` `:` `值` `]`，容忍 `[ V:1]` / `[V :1]` 这类异常空格。 */
const INLINE_FIELD_RE = /^\[([ \t]*)([A-Za-z])([ \t]*):([ \t]*)([^\]]*)\]/;

const ZERO_POSITION: SourcePosition = { offset: 0, line: 1, column: 0 };
/** 占位 span：`TokenBuilder.pushToken` 一律用游标重算 span，此值不会外泄。 */
const ZERO_SPAN: SourceSpan = { start: ZERO_POSITION, end: ZERO_POSITION };

interface TokenBuilder {
  /** 仅接受无附属字段的 plain kind，直接构造合法 `JcxPlainToken`，无需强转。 */
  push(kind: PlainTokenKind, raw: string): void;
  /** 需要附属字段（如 rest、fieldKey）的 token 由调用方自行构造完整对象后传入。 */
  pushToken(token: JcxToken): void;
  /** §13：正文段按模式 A 细分（T5）；span 由 body lexer 依当前游标位置直接算出。 */
  pushBody(content: string, bag: DiagnosticBag): void;
}

function createTokenBuilder(
  tracker: ReturnType<typeof createPositionTracker>,
  tokens: JcxToken[],
): TokenBuilder {
  const commit = (token: JcxToken): void => {
    tokens.push(token);
  };

  return {
    push(kind, raw) {
      if (raw.length === 0) {
        return;
      }
      const start = tracker.current();
      const end = tracker.advance(raw.length);
      commit({ kind, raw, span: { start, end } });
    },
    pushToken(token) {
      if (token.raw.length === 0) {
        return;
      }
      const start = tracker.current();
      const end = tracker.advance(token.raw.length);
      commit({ ...token, span: { start, end } });
    },
    pushBody(content, bag) {
      if (content.length === 0) {
        return;
      }
      for (const token of lexBody(content, tracker.current(), bag, 'pitch')) {
        commit(token);
      }
      tracker.advance(content.length);
    },
  };
}

function leadingWhitespaceLength(text: string): number {
  let i = 0;
  while (i < text.length && WS.test(text[i] as string)) {
    i += 1;
  }
  return i;
}

function trailingWhitespaceStart(text: string, floor: number): number {
  let i = text.length;
  while (i > floor && WS.test(text[i - 1] as string)) {
    i -= 1;
  }
  return i;
}

function isBlankText(text: string): boolean {
  return text.length === 0 || leadingWhitespaceLength(text) === text.length;
}

/**
 * 对单行 `content`（已剥离 BOM 与 eol）切出
 * `[leading whitespace?] [content-as-raw] [trailing whitespace?]` 三段。
 *
 * 纯空白（含空字符串）视为空行，交由调用方决定 `blank` 分支。
 */
function splitContentTokens(builder: TokenBuilder, content: string): boolean {
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

/** 行分类过程中需要跨行携带的状态（§11.3 文本块）。 */
interface LineContext {
  /** 是否处于 `%%begintext`…`%%endtext` 之间。 */
  inTextBlock: boolean;
  /** 未闭合时用于定位 diagnostic 的 `%%begintext` 行 span。 */
  textBlockBeginSpan: SourceSpan | null;
}

/** §5.6 / §7.3：`%` 开头的行 —— 仅首行的整行 `%MUSE<ver>` 是 magic header。 */
function lexPercentLine(
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
function lexDirectiveLine(
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
function lexFieldLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  key: string,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
): JcxLineKind {
  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.pushToken({ kind: 'fieldKey', raw: key, key, span: ZERO_SPAN });
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
      lineSpan,
    );
  }

  return 'field';
}

/** §9.1 / §9.5：行首 `[X:...]` 内联字段。 */
function lexInlineFieldLine(
  builder: TokenBuilder,
  content: string,
  leadingEnd: number,
  match: RegExpExecArray,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
): JcxLineKind {
  const afterOpen = match[1] as string;
  const key = match[2] as string;
  const beforeColon = match[3] as string;
  const afterColon = match[4] as string;
  const value = match[5] as string;

  builder.push('whitespace', content.slice(0, leadingEnd));
  builder.push('inlineFieldOpen', '[');
  builder.push('whitespace', afterOpen);
  builder.pushToken({ kind: 'inlineFieldKey', raw: key, key, span: ZERO_SPAN });
  builder.push('whitespace', beforeColon);
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
      lineSpan,
    );
  }

  const trailing = content.slice(leadingEnd + (match[0] as string).length);
  if (trailing.length > 0) {
    // §9.2：help 示例允许 `[V:1] ABCD|`；本任务先整体作 raw，正文切分留给 T5/T6。
    builder.push('raw', trailing);
    bag.report(
      'jcx.inline-field.trailing-body',
      'info',
      'music content follows an inline field on the same line',
      lineSpan,
    );
  }

  return 'inlineField';
}

/**
 * 单行分类 + token 化，返回该行的 `JcxLineKind`。
 *
 * `content` 已剥离 BOM 与 eol；`builder` 的游标恰好停在 `content` 起点。
 */
function lexLineContent(
  builder: TokenBuilder,
  content: string,
  isFirstLine: boolean,
  lineSpan: SourceSpan,
  bag: DiagnosticBag,
  ctx: LineContext,
): JcxLineKind {
  // 1. §11.3：text block 内容行压过一切其他分类（含 `%`、`%%`、`T:`）。
  if (ctx.inTextBlock) {
    if (content.startsWith('%%')) {
      const rest = DIRECTIVE_RE.exec(content);
      if ((rest?.[2] ?? '') === 'endtext') {
        return lexDirectiveLine(builder, content, 0, lineSpan, bag, ctx);
      }
    }
    // §11.3 第 1 条：禁止 trim，前导空白留在内容 token 内。
    builder.push('textBlockContent', content);
    return 'textBlockContent';
  }

  // 2. §5.4：空行 / 纯空白行。
  if (isBlankText(content)) {
    builder.push('whitespace', content);
    return 'blank';
  }

  const leadingEnd = leadingWhitespaceLength(content);
  const rest = content.slice(leadingEnd);

  // 3. §5.7 / §10：`%%` 指令（含 `%%begintext` / `%%endtext`）。
  if (rest.startsWith('%%')) {
    return lexDirectiveLine(builder, content, leadingEnd, lineSpan, bag, ctx);
  }

  // 4. §5.6 / §7.3：`%` 注释，首行整行 `%MUSE<ver>` 例外为 magic header。
  if (rest.startsWith('%')) {
    return lexPercentLine(builder, content, leadingEnd, isFirstLine);
  }

  // 5. §8.0：单字母字段行（§5.8：允许前导空白，body 中的 ` L: 1/4` 依赖这一条）。
  const fieldMatch = FIELD_RE.exec(rest);
  if (fieldMatch) {
    return lexFieldLine(builder, content, leadingEnd, fieldMatch[1] as string, lineSpan, bag);
  }

  // 6. §9.1 / §9.5：行首内联字段（`^\[[A-Za-z]:`，容忍异常空格）。
  const inlineMatch = INLINE_FIELD_RE.exec(rest);
  if (inlineMatch) {
    return lexInlineFieldLine(builder, content, leadingEnd, inlineMatch, lineSpan, bag);
  }

  // 7. §8.0 / §29.4：全角冒号行按未知行保留原文并发 diagnostic。
  if (FULLWIDTH_COLON_FIELD_RE.test(rest)) {
    bag.report(
      'jcx.field.fullwidth-colon',
      'warning',
      'full-width colon in a field-like line; only half-width ":" is recognized',
      lineSpan,
    );
    splitContentTokens(builder, content);
    return 'raw';
  }

  // 8. §13：其余为正文行。
  // T5 起一律按模式 A（pitch）切分；模式 B 与模式切换分别由 T6 / T7 接管。
  builder.pushBody(content, bag);
  return 'body';
}

/**
 * 行切分 + §13.3 行分类 + 行级 token 化（M1.4 方案 §7 T4）。
 *
 * 契约：
 * - 永不抛异常；所有异常写法一律降级为 raw + diagnostic。
 * - 逐行不变量（§29.5）：`rawOf(line.tokens) === text.slice(line.span)`。
 * - body 行（`kind: 'body'`）的正文段一律按模式 A 切分，`mode: 'pitch'`；T7 接入模式切换后此处改为按声部 style 派发。
 */
export function lexDocument(text: string, bag: DiagnosticBag): JcxLexLine[] {
  const rawLines = splitLines(text);
  const hasBom = text.startsWith(BOM);
  const tracker = createPositionTracker(text);
  const lines: JcxLexLine[] = [];
  const ctx: LineContext = { inTextBlock: false, textBlockBeginSpan: null };

  for (const rawLine of rawLines) {
    const tokens: JcxToken[] = [];
    const builder = createTokenBuilder(tracker, tokens);

    // §7.3：BOM 不单独占一行，magic header 仍以第 0 行（剥 BOM 后的内容）为准。
    const isFirstLine = rawLine.index === 0;
    let content = rawLine.content;
    if (isFirstLine && hasBom) {
      builder.push('bom', content.slice(0, 1));
      content = content.slice(1);
    }

    const kind = lexLineContent(builder, content, isFirstLine, rawLine.span, bag, ctx);
    builder.push('eol', rawLine.eol);

    lines.push(
      kind === 'body'
        ? { index: rawLine.index, span: rawLine.span, kind, tokens, mode: 'pitch' }
        : { index: rawLine.index, span: rawLine.span, kind, tokens },
    );
  }

  if (ctx.inTextBlock) {
    // §11.3 第 4 条：未闭合的 `%%begintext` 延伸到文件末尾，不报错，只发 warning。
    bag.report(
      'jcx.textblock.unterminated',
      'warning',
      "'%%begintext' is not closed by '%%endtext' before end of file",
      ctx.textBlockBeginSpan ?? rawLines[rawLines.length - 1]?.span ?? {
        start: ZERO_POSITION,
        end: ZERO_POSITION,
      },
    );
  }

  return lines;
}
