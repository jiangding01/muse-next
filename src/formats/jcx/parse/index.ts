/**
 * JCX Parse 层对外入口（M1.6 方案 v1.1 §1.6）。
 *
 * 分层位置：`LOSSLESS AST → [本层：归一化] → NORMALIZED DOMAIN`。
 * 本层是**唯一**同时 import `ast/` 与 `domain/` 的层；Domain 反过来零 formats 依赖。
 *
 * 契约：
 * - 永不抛异常——与 `buildAst` 一致，结构问题一律降级成 diagnostic；
 * - 不做任何 spec 标 UNVERIFIED 的语义推断（方案 §0-1）；
 * - `diagnostics` 是 `[...ast.diagnostics, ...parseBag.list()]` 的**新数组**，
 *   不与 AST 共享引用。
 */

import type { JcxAstDocument } from '../ast';
import { documentPath } from '../ast';
import { createDiagnosticBag } from '../lexer/diagnostics';
import type { JcxDiagnostic } from '../lexer/diagnostics';
import type { DomainIndex, Score } from '../../../domain';
import { buildDomainIndex } from './buildIndex';

export type { HasAstPath } from './origin';
export { originOf, originsOf } from './origin';
export type { OnceKeyedReporter } from './diagnostics';
export { onceKeyed, reportParse } from './diagnostics';
export { buildDomainIndex } from './buildIndex';

export interface ParseResult {
  readonly score: Score;
  readonly diagnostics: readonly JcxDiagnostic[];
  readonly index: DomainIndex;
}

/** 「空但合法」的 Score：各数组为空，可选字段一律缺省，origin 指向文档根。 */
function emptyScore(): Score {
  return {
    titles: [],
    credits: [],
    notes: [],
    voices: [],
    chordShapes: [],
    directives: [],
    textBlocks: [],
    unknownFields: [],
    ignoredFields: [],
    origin: documentPath(),
  };
}

/**
 * 把 Lossless AST 归一化为 Domain `Score`。
 *
 * 当前为 T2 骨架：只产出空 Score + 空 index，并把 AST 诊断原样带出。
 */
export function parseJcxDocument(ast: JcxAstDocument): ParseResult {
  const bag = createDiagnosticBag();

  // T3 header normalization 在此消费 ast.lines 的 field / directive 行：parseHeader(ast, bag, once)
  // T4/T5 voice 属性与段落归属：parseVoices(...)
  // T6–T8 事件扫描、配对、歌词：parseBody(...)
  // 三个阶段共享同一个 bag 与一个 onceKeyed(bag) 作用域；此处刻意不放 stub 函数，避免死代码。
  const score = emptyScore();

  return {
    score,
    diagnostics: [...ast.diagnostics, ...bag.list()],
    index: buildDomainIndex(score),
  };
}
