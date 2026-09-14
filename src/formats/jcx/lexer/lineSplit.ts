/**
 * JCX Lexer —— 文档行切分（M1.4 方案 §7 T3）。
 *
 * 从 `lexDocument.ts` 拆出（T7 批次 C，纯移动、不改行为）：行切分是纯字符串
 * 操作，与行分类、token 化没有任何耦合，独立成文件后 `lexDocument.ts` 只剩
 * 「主循环 + 分类分派」。
 *
 * 行尾规则（docs/JCX_SPEC.md §5.1 / §5.2 / §5.11）：
 * - 只有 `\n` 会触发切行；`\r\n` 作为一个整体 eol 保留。
 * - 孤立的 `\r`（不紧跟 `\n`）不是行尾，留在 `content` 内部。
 * - 末行若无换行符，`eol === ''`；`hasTrailingNewline` 反映这一点。
 */

import { createPositionTracker } from './sourceSpan';
import type { SourcePosition, SourceSpan } from './sourceSpan';

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

