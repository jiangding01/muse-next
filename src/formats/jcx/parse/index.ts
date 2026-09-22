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
import type { DomainIndex, IgnoredField, Score, Voice } from '../../../domain';
import type { HeaderNormalization, ParseContext } from './header';
import { buildDomainIndex } from './buildIndex';
import type { DirectivesNormalization } from './directives';
import { collectDirectives } from './directives';
import { onceKeyed } from './diagnostics';
import { parseHeader } from './header';
import type { UnitLengthEntry, UnitLengthScope } from './duration';
import { createUnitLengthScope } from './duration';
import type { VoiceRegistry } from './voice';
import { parseVoices } from './voice';
import type { SegmentsResult, UnitLengthBinding, VoiceSegment } from './body/segments';
import { assignSegments } from './body/segments';
import type { ScanByVoice, ScanResult } from './body/scan';
import { scanSegments } from './body/scan';
import { pairMarkers } from './body/pairing';
import { alignLyrics } from './body/lyrics';
import { collectUnitLengthChanges } from './body/unitLength';

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
export type { DirectivesNormalization } from './directives';
export { collectDirectives } from './directives';
export { parseGChordValue } from './gchord';
export type {
  SplitVoiceAttributes,
  VoiceAttributeToken,
  VoiceParseResult,
  VoiceRegistry,
} from './voice';
export { parseVoices, splitVoiceAttributes } from './voice';
export type { SegmentsResult, SegmentUnit, UnitLengthBinding, VoiceSegment } from './body/segments';
export { assignSegments } from './body/segments';
export type { ScanByVoice, ScanMarker, ScanMarkerAnchor, ScanMarkerKind, ScanResult } from './body/scan';
export { scanSegments } from './body/scan';
export type { PairingResult } from './body/pairing';
export { pairMarkers } from './body/pairing';
export { alignLyrics } from './body/lyrics';
export { collectUnitLengthChanges } from './body/unitLength';
export { parseDurationRaw, parseTabDurationRaw, resolveDuration, scaleByUnitLength } from './duration';

/** `parseHeader` / `parseVoices` 共享的上下文，额外携带声部注册表与 T5 段落归属结果供后续阶段（T6）复用。 */
interface DocumentParseContext extends ParseContext {
  voiceRegistry: VoiceRegistry | undefined;
  segments: readonly VoiceSegment[];
  /** T6 扫描出的事件流与并列 marker 列表；marker 留给 T7 配对，不进 `Voice.events`。 */
  scan: ScanByVoice;
}

export interface ParseResult {
  readonly score: Score;
  readonly diagnostics: readonly JcxDiagnostic[];
  readonly index: DomainIndex;
}

/**
 * 由已归一化的描述头拼出 Score。
 *
 * `voices` 传入时已带上 T8 对齐好的 `lyricLines`；其余字段由 T3–T7（描述头 / 声部 / 正文）与
 * T9（`%%` 指令、gchord、text block）填满。
 */
function buildScore(
  header: HeaderNormalization,
  voices: readonly Voice[],
  extraIgnoredFields: readonly IgnoredField[],
  directives: DirectivesNormalization,
): Score {
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
    chordShapes: directives.chordShapes,
    directives: directives.directives,
    ...(directives.showFinger === undefined ? {} : { showFinger: directives.showFinger }),
    textBlocks: directives.textBlocks,
    unknownFields: header.unknownFields,
    ignoredFields: [...header.ignoredFields, ...extraIgnoredFields],
    origin: documentPath(),
  };
}

/**
 * 把 T3（`header.bodyUnitLengths`，只有行号 + 值）与 T5（`unitLengthBindings`，
 * 每行的声部归属）按 `lineIndex` 拼成带 `voiceId` 的 `UnitLengthEntry`。两者的
 * 合法行号集合恒相等（T5 只在 `validBodyUnitLengthLines` 里的行才产出 binding），
 * 故这里退回原条目（保持 global）只是防御性兜底，不代表已知会触发的路径。
 */
function bindUnitLengthVoiceIds(
  entries: readonly UnitLengthEntry[],
  bindings: readonly UnitLengthBinding[],
): readonly UnitLengthEntry[] {
  const byLine = new Map(bindings.map((binding) => [binding.lineIndex, binding.voiceId] as const));
  return entries.map((entry) => {
    const voiceId = byLine.get(entry.lineIndex);
    return voiceId === undefined ? entry : { ...entry, voiceId };
  });
}

/**
 * 把 Lossless AST 归一化为 Domain `Score`。
 *
 * 当前进度：T3 描述头、T4 声部属性、T5 段落归属、T6 事件扫描、T7 marker 配对、
 * T8 歌词对齐、T9 指令 / gchord / text block 均已接入。
 */
export function parseJcxDocument(ast: JcxAstDocument): ParseResult {
  const bag = createDiagnosticBag();
  // 各阶段共享同一个 bag 与同一个「每文档一次」去重作用域。
  const ctx: DocumentParseContext = {
    bag,
    once: onceKeyed(bag),
    voiceRegistry: undefined,
    segments: [],
    scan: new Map(),
  };

  const header = parseHeader(ast, ctx);
  const { voices: declaredVoices, registry } = parseVoices(header.voiceFields, ctx);
  // 供 T6（事件扫描）与后续阶段复用，避免重新扫描 header.voiceFields。
  ctx.voiceRegistry = registry;
  const validBodyUnitLengthLines = new Set(header.bodyUnitLengths.map((entry) => entry.lineIndex));
  const segmentsResult: SegmentsResult = assignSegments(
    ast,
    registry,
    declaredVoices,
    ctx,
    validBodyUnitLengthLines,
  );
  // T5 可能因未声明 id / 无任何声明而隐式追加声部，Score.voices 必须反映最终列表。
  ctx.segments = segmentsResult.segments;
  // body `L:` 按声部作用域装配（spec §8.5 U06 已裁决）：T3 的值 + T5 的归属。
  const unitLengthScope: UnitLengthScope = createUnitLengthScope(
    header.unitLength,
    bindUnitLengthVoiceIds(header.bodyUnitLengths, segmentsResult.unitLengthBindings),
  );
  // T6：扫描事件流；marker 挂在 ctx 上供 T7 配对，不进 Score（方案 §0-5）。
  const scan = scanSegments(segmentsResult.segments, unitLengthScope, ctx);
  ctx.scan = scan;
  // T7：消费 marker，产出四类 relation 与 broken rhythm 改写后的事件流。
  const empty: ScanResult = { events: [], markers: [] };
  const voices = segmentsResult.voices.map((voice) => {
    const paired = pairMarkers(scan.get(voice.id) ?? empty, voice.id, ctx);
    return {
      ...voice,
      events: paired.events,
      ties: paired.ties,
      slurs: paired.slurs,
      tuplets: paired.tuplets,
      tabRelations: paired.tabRelations,
      brokenRhythms: paired.brokenRhythms,
      // body 区 `L:` 落到本声部事件序列上的生效位置（M1.7 T0，按声部作用域）。
      unitLengthChanges: collectUnitLengthChanges(paired.events, unitLengthScope, voice.id),
    };
  });
  // T9：`%%` 指令、gchord 和弦图与 text block（与正文扫描互不依赖）。
  const directives = collectDirectives(ast, ctx);
  // T8：用 T5 归属好的 `lyric` 段落单元 + T6 扫描出的事件流对齐歌词，不重新扫描 AST。
  const lyricsByVoice = alignLyrics(segmentsResult.segments, scan, ctx);
  const voicesWithLyrics = voices.map((voice) => ({
    ...voice,
    lyricLines: lyricsByVoice.get(voice.id) ?? voice.lyricLines,
  }));
  const score = buildScore(header, voicesWithLyrics, segmentsResult.ignoredFields, directives);

  return {
    score,
    diagnostics: [...ast.diagnostics, ...bag.list()],
    index: buildDomainIndex(score),
  };
}
