/**
 * JCX 格式层 —— 统一对外入口（M1.6 方案 v1.1 §5 T10a）。
 *
 * 应用层（renderer/store、M1.7 序列化、编辑器）应从本模块导入，而不是深入
 * `lexer/` `ast/` `parse/` 各子目录——那些导出仍然存在，服务于本层内部与单元
 * 测试，但不构成对外契约。
 *
 * 管线：`lexJcx → buildAst → parseJcxDocument`，一次性版本见 `loadJcx`。
 */

export type { LoadResult } from './loadJcx';
export { loadJcx } from './loadJcx';

export type { JcxLexResult, JcxLexOptions, JcxEncoding } from './lexer';
export { lexJcx } from './lexer';

export type { JcxAstDocument } from './ast';
export { buildAst, printAst } from './ast';

export type { ParseResult } from './parse';
export { parseJcxDocument } from './parse';

export type {
  JcxUnencodableStrategy,
  PreserveOptions,
  CanonicalOptions,
  SerializeResult,
} from './serialize';
export { serializeJcx } from './serialize';

export type {
  JcxSeverity,
  JcxDiagnosticCode,
  JcxDiagnostic,
} from './lexer/diagnostics';

export type { DomainIndex, Score, Voice } from '../../domain';
