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
import type { DomainIndex, Score, Voice } from '../../../domain';
import type { HeaderNormalization, ParseContext } from './header';
import { buildDomainIndex } from './buildIndex';
import { onceKeyed } from './diagnostics';
import { parseHeader } from './header';
import type { VoiceRegistry } from './voice';
import { parseVoices } from './voice';

export type { HasAstPath } from './origin';
export { originOf, originsOf } from './origin';
export type { OnceKeyedReporter } from './diagnostics';
export { onceKeyed, reportParse } from './diagnostics';
export type { HeaderNormalization, ParseContext } from './header';
export { parseHeader } from './header';
export { meterRatio, parseKey, parseMeter, parseTempo } from './keyMeter';
export type { UnitLengthEntry, UnitLengthScope } from './duration';
export {
  createUnitLengthScope,
  parseUnitLength,
  resolveDefaultUnitLength,
} from './duration';
export { buildDomainIndex } from './buildIndex';
export type {
  SplitVoiceAttributes,
  VoiceAttributeToken,
  VoiceParseResult,
  VoiceRegistry,
} from './voice';
export { parseVoices, splitVoiceAttributes } from './voice';

/** `parseHeader` / `parseVoices` 共享的上下文，额外携带声部注册表供后续阶段（T5）复用。 */
interface DocumentParseContext extends ParseContext {
  voiceRegistry: VoiceRegistry | undefined;
}

export interface ParseResult {
  readonly score: Score;
  readonly diagnostics: readonly JcxDiagnostic[];
  readonly index: DomainIndex;
}

/**
 * 由已归一化的描述头拼出 Score。
 *
 * voices / chordShapes / directives / textBlocks 仍为空：分别是 T4–T8 与 T9 的产出，
 * 此处不放 stub，避免死代码。
 */
function buildScore(header: HeaderNormalization, voices: readonly Voice[]): Score {
  return {
    titles: header.titles,
    credits: header.credits,
    notes: header.notes,
    ...(header.refNumber === undefined ? {} : { refNumber: header.refNumber }),
    ...(header.meter === undefined ? {} : { meter: header.meter }),
    ...(header.unitLength === undefined ? {} : { unitLength: header.unitLength }),
    ...(header.tempo === undefined ? {} : { tempo: header.tempo }),
    ...(header.key === undefined ? {} : { key: header.key }),
    voices,
    chordShapes: [],
    directives: [],
    textBlocks: [],
    unknownFields: header.unknownFields,
    ignoredFields: header.ignoredFields,
    origin: documentPath(),
  };
}

/**
 * 把 Lossless AST 归一化为 Domain `Score`。
 *
 * 当前进度：T3 描述头、T4 声部属性已接入；事件 / 配对 / 歌词仍待 T5–T8。
 */
export function parseJcxDocument(ast: JcxAstDocument): ParseResult {
  const bag = createDiagnosticBag();
  // 各阶段共享同一个 bag 与同一个「每文档一次」去重作用域。
  const ctx: DocumentParseContext = { bag, once: onceKeyed(bag), voiceRegistry: undefined };

  const header = parseHeader(ast, ctx);
  const { voices, registry } = parseVoices(header.voiceFields, ctx);
  // 供 T5（`[V:n]` 与 §9.4 段落归属）复用，避免重新扫描 header.voiceFields。
  ctx.voiceRegistry = registry;
  // T6 用 header.unitLengthScope；T8 用 header.lyricFields。此处刻意不放 stub 函数，避免死代码。
  const score = buildScore(header, voices);

  return {
    score,
    diagnostics: [...ast.diagnostics, ...bag.list()],
    index: buildDomainIndex(score),
  };
}
