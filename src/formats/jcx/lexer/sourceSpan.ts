/**
 * JCX Lexer —— source span 基座（HANDOFF §35）。
 *
 * 约定：
 * - `offset`：自文本起点的 UTF-16 code unit 偏移（BOM 占 1 个 code unit）。
 * - `line`：1-based 行号，仅 `\n` 触发换行（CRLF 中的 `\r` 归属上一行）。
 * - `column`：0-based 列号，单位同样是 UTF-16 code unit（代理对占 2）。
 */

export interface SourcePosition {
  readonly offset: number;
  readonly line: number;
  readonly column: number;
}

export interface SourceSpan {
  readonly start: SourcePosition;
  readonly end: SourcePosition;
}

export interface PositionTracker {
  /** 当前游标位置的快照。 */
  current(): SourcePosition;
  /** 前进 `count` 个 code unit，返回前进后的位置快照。 */
  advance(count: number): SourcePosition;
  /** 以 `start` 为起点、当前游标为终点构造 span。 */
  spanFrom(start: SourcePosition): SourceSpan;
}

const LF = '\n';

export function createPositionTracker(text: string): PositionTracker {
  let offset = 0;
  let line = 1;
  let column = 0;

  const current = (): SourcePosition => ({ offset, line, column });

  const advance = (count: number): SourcePosition => {
    if (!Number.isFinite(count) || count <= 0) {
      return current();
    }
    const limit = Math.min(offset + Math.floor(count), text.length);
    while (offset < limit) {
      if (text[offset] === LF) {
        line += 1;
        column = 0;
      } else {
        column += 1;
      }
      offset += 1;
    }
    return current();
  };

  const spanFrom = (start: SourcePosition): SourceSpan => ({ start, end: current() });

  return { current, advance, spanFrom };
}

/** 便捷函数：按绝对 offset 区间计算 span（会从文本开头扫描一次）。 */
export function spanOf(text: string, startOffset: number, endOffset: number): SourceSpan {
  const tracker = createPositionTracker(text);
  const start = tracker.advance(startOffset);
  const end = tracker.advance(Math.max(0, endOffset - startOffset));
  return { start, end };
}

/** 便捷函数：零宽 span（用于「缺失内容」类 diagnostic）。 */
export function emptySpanAt(position: SourcePosition): SourceSpan {
  return { start: position, end: position };
}
