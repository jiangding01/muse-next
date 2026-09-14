/**
 * JCX Lexer —— 行内 token 构造器（M1.4 方案 §7 T4）。
 *
 * 从 `lexDocument.ts` 拆出（T7 批次 C，纯移动、不改行为）。
 *
 * 唯一职责：把「一段原文 + 一个 kind」变成带正确 span 的 token，并保证
 * **游标严格按源顺序推进** —— 这是 §29.5 逐行不变量成立的机械保证：
 * 只要每个 token 都由本构造器按顺序产出，raw 拼接必然等于原文。
 */

import type { createPositionTracker } from './sourceSpan';
import type { SourcePosition, SourceSpan } from './sourceSpan';
import type { DiagnosticBag } from './diagnostics';
import type { JcxPlainToken, JcxToken } from './token';
import { lexBody } from './lexBody';
import type { JcxBodyMode } from './lexBody';

/** 无附属字段的 plain kind（T1 `JcxPlainToken['kind']` 派生），不含 rest/fieldKey 等需要附属字段的 kind。 */
export type PlainTokenKind = JcxPlainToken['kind'];

export const ZERO_POSITION: SourcePosition = { offset: 0, line: 1, column: 0 };
/** 占位 span：`TokenBuilder.pushToken` 一律用游标重算 span，此值不会外泄。 */
export const ZERO_SPAN: SourceSpan = { start: ZERO_POSITION, end: ZERO_POSITION };

export interface TokenBuilder {
  /** 仅接受无附属字段的 plain kind，直接构造合法 `JcxPlainToken`，无需强转。 */
  push(kind: PlainTokenKind, raw: string): void;
  /** 需要附属字段（如 rest、fieldKey）的 token 由调用方自行构造完整对象后传入。 */
  pushToken(token: JcxToken): void;
  /** §13：正文段按当前生效模式细分；span 由 body lexer 依当前游标位置直接算出。 */
  pushBody(content: string, bag: DiagnosticBag, mode: JcxBodyMode): void;
  /** 当前游标位置（下一个 token 的起点），用于给 diagnostic 算精确 span。 */
  cursor(): SourcePosition;
  /**
   * 最近一次**实际推入**的 token 的 span；raw 为空被跳过的不计。
   * 用途：把 diagnostic 从「整行」收窄到「引发它的那个 token」（§29 可读性要求）。
   */
  lastSpan(): SourceSpan | null;
}

export function createTokenBuilder(
  tracker: ReturnType<typeof createPositionTracker>,
  tokens: JcxToken[],
): TokenBuilder {
  let lastSpan: SourceSpan | null = null;

  const commit = (token: JcxToken): void => {
    tokens.push(token);
    lastSpan = token.span;
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
    pushBody(content, bag, mode) {
      if (content.length === 0) {
        return;
      }
      for (const token of lexBody(content, tracker.current(), bag, mode)) {
        commit(token);
      }
      tracker.advance(content.length);
    },
    cursor() {
      return tracker.current();
    },
    lastSpan() {
      return lastSpan;
    },
  };
}
