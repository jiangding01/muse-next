/**
 * JCX 一站式加载入口（M1.6 方案 v1.1 §5 T10a）。
 *
 * `loadJcx` 把 `lexJcx → buildAst → parseJcxDocument` 三步串成一次调用，
 * 供 M1.7 序列化与编辑器等下游使用者直接拿到三层结果，而不必各自重新拼装
 * 这条固定管线。
 *
 * `LoadResult` 选择 `ParseResult & { lex; ast }`（而不是只暴露
 * score/diagnostics/index、把 lex/ast 扔进可选字段）：三层结果都是**同一次
 * 调用产出的不可变快照**，没有谁比谁更「附属」——`ParseResult.diagnostics`
 * 本身就已经把 `ast.diagnostics` 并入，下游若要单独定位某条诊断属于哪一层
 * （比如编辑器要在 AST 视图里高亮某个节点），需要同时持有 `lex`/`ast`；做成
 * 必选字段可以让类型系统保证这一点，不必在使用处处理「可能是 undefined」。
 * `ParseResult` 的既有形状保持只有这一处定义（`parse/index.ts`），本文件不
 * 重复声明。
 *
 * **异常契约**：与 `lexJcx` 完全一致——本函数本身永不抛异常，唯一可能逸出的
 * 异常是字节输入时 `decodeJcx` 抛出的 `JcxEncodingError`（UTF-16 BOM，
 * 不受支持的编码；见 `encoding/decodeJcx.ts` 与 `lexer/index.ts` 顶部注释）。
 * 字符串输入不经过解码，因此绝无异常。
 */

import { buildAst } from './ast';
import type { JcxAstDocument } from './ast';
import type { JcxLexOptions, JcxLexResult } from './lexer';
import { lexJcx } from './lexer';
import type { ParseResult } from './parse';
import { parseJcxDocument } from './parse';

export interface LoadResult extends ParseResult {
  readonly lex: JcxLexResult;
  readonly ast: JcxAstDocument;
}

/**
 * 加载一个 JCX 文档（字符串输入）。
 *
 * `options.sourceEncoding` 只作为 `lex.encoding` 的来源标注，不影响解析本身
 * （字符串输入不经过 `decodeJcx`）。
 */
export function loadJcx(input: string, options?: JcxLexOptions): LoadResult;
/**
 * 加载一个 JCX 文档（字节输入）。
 *
 * 先经 `decodeJcx` 做编码检测；不接受 `options`——编码必须始终采用检测结果，
 * 与 `lexJcx` 的字节重载一致。
 */
export function loadJcx(input: Uint8Array): LoadResult;
export function loadJcx(input: string | Uint8Array, options?: JcxLexOptions): LoadResult {
  const lex = typeof input === 'string' ? lexJcx(input, options) : lexJcx(input);
  const ast = buildAst(lex);
  const parsed = parseJcxDocument(ast);
  return { ...parsed, lex, ast };
}
