/**
 * JCX Parse 级语料回归 —— 共享不变量与汇总逻辑（M1.6 T10a）。
 *
 * 被 `scripts/jcx/corpus-lex-test.ts`（语料级）与
 * `tests/unit/jcx/parse/invariants.test.ts`（fixture 级）共同复用。纯函数，
 * 不依赖 Node fs、不 throw、不 console——失败用返回值表达。
 *
 * 四条 parse 级断言（方案 §5 T10a 行）：
 *
 *   ① `parseJcxDocument` 无异常 —— 由调用方的 try/catch 负责，本文件不做。
 *   ② `diagnostics` 中无 `error` 级。
 *   ③ `index` 自洽：`eventById` 数 === 全部 voice events 总数；
 *      `relationById` 数 === 五类 relation 总数（含 M1.7 T0 的 brokenRhythm）；`byPath` 每个 key 都能被
 *      `parseAstPath` 成功解析。
 *   ④ 每个 voice 的 `events` 不含 marker kind —— 即 kind 集合 ⊆ 十种
 *      `MusicEvent`（方案 §0-5）。
 *   ⑤ M1.7 T0 的三个事实字段引用自洽：`brokenRhythms.from/to`、
 *      `unitLengthChanges.beforeEventId`、`LyricLine.bodyRange.first/lastEventId`
 *      指向的 `EventId` 都必须存在于**本声部**的事件序列中，且 `bodyRange` 的首
 *      不晚于末。它们是「原位置引用」型事实，指向不存在的事件即为伪造。
 */

import { parseAstPath } from '../../../src/formats/jcx/ast';
import type { JcxAstDocument } from '../../../src/formats/jcx/ast';
import type { JcxDiagnostic, JcxSeverity } from '../../../src/formats/jcx/lexer/diagnostics';
import { parseJcxDocument } from '../../../src/formats/jcx/parse';
import type { DomainIndex, EventId, MusicEvent, Score } from '../../../src/domain';

/** `MusicEvent` 判别联合的全部合法 kind（方案 §1.2）。 */
export const MUSIC_EVENT_KINDS: ReadonlySet<MusicEvent['kind']> = new Set([
  'note',
  'rest',
  'chord',
  'grace',
  'barline',
  'decoration',
  'chordSymbol',
  'tabNote',
  'tabGroup',
  'unknown',
]);

export interface ParseInvariantFailures {
  readonly failures: readonly string[];
}

/** 断言②：`diagnostics` 中无 `error` 级。 */
export function checkNoErrorDiagnostics(diagnostics: readonly JcxDiagnostic[]): string[] {
  const errorCodes = [...new Set(diagnostics.filter((d) => d.severity === 'error').map((d) => d.code))];
  return errorCodes.length === 0
    ? []
    : [`${errorCodes.length} error-level parse diagnostic code(s): ${errorCodes.join(', ')}`];
}

/** 断言③：`index` 自洽（数量匹配 + `byPath` 的每个 key 都能被 `parseAstPath` 解析）。 */
export function checkIndexConsistency(score: Score, index: DomainIndex): string[] {
  const failures: string[] = [];

  const totalEvents = score.voices.reduce((sum, voice) => sum + voice.events.length, 0);
  if (index.eventById.size !== totalEvents) {
    failures.push(`index.eventById.size (${index.eventById.size}) !== total voice events (${totalEvents})`);
  }

  const totalRelations = score.voices.reduce(
    (sum, voice) =>
      sum +
      voice.ties.length +
      voice.slurs.length +
      voice.tuplets.length +
      voice.tabRelations.length +
      voice.brokenRhythms.length,
    0,
  );
  if (index.relationById.size !== totalRelations) {
    failures.push(`index.relationById.size (${index.relationById.size}) !== total relations (${totalRelations})`);
  }

  const unparseablePaths = [...index.byPath.keys()].filter((path) => parseAstPath(path) === null);
  if (unparseablePaths.length > 0) {
    failures.push(
      `index.byPath has ${unparseablePaths.length} SourceRef(s) parseAstPath cannot parse, e.g. ${unparseablePaths[0]}`,
    );
  }

  return failures;
}

/** 断言④：每个 voice 的 `events` kind 集合 ⊆ 十种 `MusicEvent`（不含 marker）。 */
export function checkEventKindsAllowed(score: Score): string[] {
  const offenders: string[] = [];
  for (const voice of score.voices) {
    for (const event of voice.events) {
      if (!MUSIC_EVENT_KINDS.has(event.kind)) {
        offenders.push(`${voice.id}/${event.id}: kind=${String(event.kind)}`);
      }
    }
  }
  return offenders.length === 0
    ? []
    : [`${offenders.length} event(s) with disallowed/marker kind, e.g. ${offenders[0]}`];
}

/**
 * 断言⑤：M1.7 T0 三个事实字段的 `EventId` 引用都落在本声部事件序列内。
 *
 * `bodyRange === null`（目标行零事件 / 无绑定目标）是合法的显式取值，跳过。
 */
export function checkFactualEventRefs(score: Score): string[] {
  const failures: string[] = [];
  for (const voice of score.voices) {
    const order = new Map(voice.events.map((event, index) => [event.id, index]));
    const require = (id: EventId, where: string): number | undefined => {
      const index = order.get(id);
      if (index === undefined) {
        failures.push(`${voice.id}: ${where} references unknown event ${id}`);
      }
      return index;
    };
    for (const broken of voice.brokenRhythms) {
      require(broken.from, `brokenRhythms[${broken.id}].from`);
      require(broken.to, `brokenRhythms[${broken.id}].to`);
    }
    for (const change of voice.unitLengthChanges) {
      require(change.beforeEventId, `unitLengthChanges(${change.raw}).beforeEventId`);
    }
    voice.lyricLines.forEach((line, lineIndex) => {
      const range = line.bodyRange;
      if (range === null) {
        return;
      }
      const first = require(range.firstEventId, `lyricLines[${lineIndex}].bodyRange.firstEventId`);
      const last = require(range.lastEventId, `lyricLines[${lineIndex}].bodyRange.lastEventId`);
      if (first !== undefined && last !== undefined && first > last) {
        failures.push(`${voice.id}: lyricLines[${lineIndex}].bodyRange is inverted (${range.firstEventId} > ${range.lastEventId})`);
      }
    });
  }
  return failures;
}

/** 跑齐 ②–⑤（①由调用方 try/catch 负责），汇总成一份失败列表。 */
export function checkParseInvariants(score: Score, diagnostics: readonly JcxDiagnostic[], index: DomainIndex): string[] {
  return [
    ...checkNoErrorDiagnostics(diagnostics),
    ...checkIndexConsistency(score, index),
    ...checkEventKindsAllowed(score),
    ...checkFactualEventRefs(score),
  ];
}

// ---------------------------------------------------------------------------
// 汇总（观测指标，非失败条件）
// ---------------------------------------------------------------------------

export interface ParseSummary {
  readonly voices: number;
  readonly events: number;
  readonly tieResolved: number;
  readonly tieUnresolved: number;
  readonly slurClosed: number;
  readonly slurUnclosed: number;
  readonly tupletComplete: number;
  readonly tupletIncomplete: number;
  readonly tabRelations: number;
  readonly brokenRhythms: number;
  readonly unitLengthChanges: number;
  readonly lyricLines: number;
  /** 有 `bodyRange` 的歌词行数（用于「除非目标行零事件，否则都应有范围」的观测）。 */
  readonly lyricLinesWithBodyRange: number;
  readonly chordShapes: number;
  readonly directives: number;
  readonly diagnosticsBySeverity: Readonly<Record<JcxSeverity, number>>;
}

/** 按 file 汇总方案要求的 parse 级统计行。 */
export function summarizeParse(score: Score, diagnostics: readonly JcxDiagnostic[]): ParseSummary {
  let events = 0;
  let tieResolved = 0;
  let tieUnresolved = 0;
  let slurClosed = 0;
  let slurUnclosed = 0;
  let tupletComplete = 0;
  let tupletIncomplete = 0;
  let tabRelations = 0;
  let brokenRhythms = 0;
  let unitLengthChanges = 0;
  let lyricLines = 0;
  let lyricLinesWithBodyRange = 0;

  for (const voice of score.voices) {
    events += voice.events.length;
    lyricLines += voice.lyricLines.length;
    lyricLinesWithBodyRange += voice.lyricLines.filter((line) => line.bodyRange !== null).length;
    tabRelations += voice.tabRelations.length;
    brokenRhythms += voice.brokenRhythms.length;
    unitLengthChanges += voice.unitLengthChanges.length;
    for (const tie of voice.ties) {
      if (tie.status === 'resolved') tieResolved += 1;
      else tieUnresolved += 1;
    }
    for (const slur of voice.slurs) {
      if (slur.status === 'closed') slurClosed += 1;
      else slurUnclosed += 1;
    }
    for (const tuplet of voice.tuplets) {
      if (tuplet.status === 'complete') tupletComplete += 1;
      else tupletIncomplete += 1;
    }
  }

  const diagnosticsBySeverity: Record<JcxSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    diagnosticsBySeverity[diagnostic.severity] += 1;
  }

  return {
    voices: score.voices.length,
    events,
    tieResolved,
    tieUnresolved,
    slurClosed,
    slurUnclosed,
    tupletComplete,
    tupletIncomplete,
    tabRelations,
    brokenRhythms,
    unitLengthChanges,
    lyricLines,
    lyricLinesWithBodyRange,
    chordShapes: score.chordShapes.length,
    directives: score.directives.length,
    diagnosticsBySeverity,
  };
}

/** 收集全部 `UnknownEvent` 的 `tokenKind`（未去重，调用方全局聚合）。 */
export function collectUnknownEventTokenKinds(score: Score): string[] {
  const kinds: string[] = [];
  for (const voice of score.voices) {
    for (const event of voice.events) {
      if (event.kind === 'unknown') {
        kinds.push(event.tokenKind);
      }
    }
  }
  return kinds;
}

/** 收集全部 parse 级 diagnostic 的 `code`（未去重，调用方全局聚合成直方图）。 */
export function collectDiagnosticCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

export interface ParseRunResult {
  /** ⑨–⑫ 的失败列表；空数组表示全部通过。 */
  readonly failures: readonly string[];
  /** `undefined` 仅当 `parseJcxDocument` 抛出异常（⑨ 失败）。 */
  readonly summary: ParseSummary | undefined;
  readonly unknownEventTokenKinds: readonly string[];
  readonly diagnosticCodes: readonly string[];
}

/**
 * 跑一份 AST 的完整 parse 级检查（⑨ try/catch + ⑩–⑫ + 汇总），供
 * `corpus-lex-test.ts` 与 fixture 级测试共用，避免两处各写一份 try/catch。
 */
export function runParseChecks(ast: JcxAstDocument): ParseRunResult {
  try {
    const parsed = parseJcxDocument(ast);
    return {
      failures: checkParseInvariants(parsed.score, parsed.diagnostics, parsed.index),
      summary: summarizeParse(parsed.score, parsed.diagnostics),
      unknownEventTokenKinds: collectUnknownEventTokenKinds(parsed.score),
      diagnosticCodes: collectDiagnosticCodes(parsed.diagnostics),
    };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      failures: [`uncaught parse error: ${message}`],
      summary: undefined,
      unknownEventTokenKinds: [],
      diagnosticCodes: [],
    };
  }
}
