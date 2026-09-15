/**
 * Parse 层 —— 描述头归一化（M1.6 T3；spec §8、§29.1，方案 v1.1 §1.4 / §2）。
 *
 * 职责边界：
 * - 只消费 `fieldLine` 节点，按 `region` 分 header / body 两套规则（spec §8.13）；
 * - `V:` / `w:` **不在这里解析**，只把节点引用透传给 T4（声部属性）与 T8（歌词）；
 * - 值的形态解析全部委托给 `keyMeter.ts` / `duration.ts`，本文件只负责
 *   「哪条赢、哪条被忽略、发什么诊断」。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.field.overridden` | info | header 内 `L:/M:/K:/Q:/X:` 多条，后者赢（§8.12） |
 * | `jcx.parse.field.ignored-in-body` | warning | body 内 `T:/C:/I:/M:/K:/Q:/X:`（§8.13，U10） |
 * | `jcx.parse.meter.unparsed` | info | `M:C` / `C\|` / 复合拍号等（§8.4 DOC-ONLY / UNVERIFIED） |
 * | `jcx.parse.tempo.unparsed` | info | `Q:` 非 `<分数>=<整数>`（§8.6 UNVERIFIED） |
 * | `jcx.parse.ref-number.unparsed` | info | `X:` 非正整数（§8.1 不赋结构语义，故不升 warning） |
 * | `jcx.parse.unit-length.unparsed` | warning | `L:` 值形态不符，按缺席处理（§8.5） |
 * | `jcx.parse.unit-length.body-scope` | info | body 内 `L:`，作用域歧义 U06（§8.5） |
 * | `jcx.parse.unit-length.defaulted` | info | 无 `L:`，按文档规则由 `M:` 推断（§8.5） |
 * | `jcx.parse.unit-length.unresolved` | warning | 无 `L:` 且 `M:` 无数值，E1 不兜底 |
 *
 * `K:` 值解析失败**不发诊断**：spec §8.7 明确「解析失败不报错」。
 * 未知字母字段也不在这里发诊断——lexer 已发 `jcx.field.unknown`（方案 §2）。
 */

import type { JcxAstDocument, JcxFieldLineNode } from '../ast';
import { documentPath, parseAstPath } from '../ast';
import type { DiagnosticBag } from '../lexer/diagnostics';
import { KNOWN_FIELD_KEYS } from '../lexer/lineVocabulary';
import type { SourceSpan } from '../lexer/sourceSpan';
import type {
  IgnoredField,
  KeySignature,
  Meter,
  Rational,
  Tempo,
  UnknownField,
} from '../../../domain';
import type { OnceKeyedReporter } from './diagnostics';
import { reportParse } from './diagnostics';
import { parseKey, parseMeter, parseTempo } from './keyMeter';
import type { UnitLengthEntry, UnitLengthScope } from './duration';
import { createUnitLengthScope, parseUnitLength, resolveDefaultUnitLength } from './duration';
import { originOf } from './origin';

/** parse 各阶段共享的上下文（同一个 bag 与同一个「每文档一次」作用域）。 */
export interface ParseContext {
  readonly bag: DiagnosticBag;
  readonly once: OnceKeyedReporter;
}

export interface HeaderNormalization {
  readonly titles: readonly string[];
  readonly credits: readonly string[];
  readonly notes: readonly string[];
  readonly refNumber?: number;
  readonly meter?: Meter;
  readonly unitLength?: Rational;
  readonly tempo?: Tempo;
  readonly key?: KeySignature;
  readonly unknownFields: readonly UnknownField[];
  readonly ignoredFields: readonly IgnoredField[];
  /** T6 查询「某位置的 unitLength」的唯一入口。 */
  readonly unitLengthScope: UnitLengthScope;
  /** 留给 T4 的 `V:` 字段行（不含内联 `[V:n]`，那是 T5 的事）。 */
  readonly voiceFields: readonly JcxFieldLineNode[];
  /** 留给 T8 的 `w:` 字段行，按文档顺序。 */
  readonly lyricFields: readonly JcxFieldLineNode[];
}

/** §8.12 覆盖型字段（`X:` 一并按覆盖处理：语料无重复样本，取「后者赢」与其余覆盖型一致）。 */
const OVERRIDING_KEYS: readonly string[] = ['L', 'M', 'K', 'Q', 'X'];

/** §8.13：出现在 body 区即被忽略的字段（`L:` 有专门作用域规则，`V:`/`w:` 合法）。 */
const BODY_IGNORED_KEYS: readonly string[] = ['T', 'C', 'I', 'M', 'K', 'Q', 'X'];

const ZERO_SPAN: SourceSpan = {
  start: { offset: 0, line: 1, column: 0 },
  end: { offset: 0, line: 1, column: 0 },
};

/** `fieldValue` token 的 raw；缺失（如 `T:` 后无内容）时为空串。行尾空白已由 lexer 切成独立 token。 */
function fieldValue(node: JcxFieldLineNode): string {
  for (const child of node.children) {
    if (child.token.kind === 'fieldValue') {
      return child.raw;
    }
  }
  return '';
}

/**
 * `AstPath` 的行下标（`L12` → 12），交给 `parseAstPath` 解析而不是自己写正则——
 * path 形态的唯一真相源在 `ast/astPath.ts`。行节点必然是行路径，`null` 分支
 * 仅为类型收窄兜底（退回 0 即「文档最前」，不影响既有条目的相对顺序）。
 */
function lineIndexOf(node: JcxFieldLineNode): number {
  const parsed = parseAstPath(node.path);
  return parsed === null || parsed.kind !== 'line' ? 0 : parsed.line;
}

interface HeaderState {
  readonly titles: string[];
  readonly credits: string[];
  readonly notes: string[];
  readonly unknownFields: UnknownField[];
  readonly ignoredFields: IgnoredField[];
  readonly voiceFields: JcxFieldLineNode[];
  readonly lyricFields: JcxFieldLineNode[];
  readonly bodyUnitLengths: UnitLengthEntry[];
  readonly seenOverriding: Set<string>;
  refNumber: number | undefined;
  meter: Meter | undefined;
  tempo: Tempo | undefined;
  key: KeySignature | undefined;
  headerUnitLength: Rational | undefined;
  headerUnitLengthSeen: boolean;
  anchor: JcxFieldLineNode | undefined;
}

function createState(): HeaderState {
  return {
    titles: [], credits: [], notes: [],
    unknownFields: [], ignoredFields: [],
    voiceFields: [], lyricFields: [],
    bodyUnitLengths: [], seenOverriding: new Set<string>(),
    refNumber: undefined, meter: undefined, tempo: undefined, key: undefined,
    headerUnitLength: undefined, headerUnitLengthSeen: false, anchor: undefined,
  };
}

/** §8.12：同一覆盖型字段第二次及以后出现时发 info，值仍由后者赢。 */
function noteOverride(state: HeaderState, node: JcxFieldLineNode, bag: DiagnosticBag): void {
  if (!OVERRIDING_KEYS.includes(node.key)) {
    return;
  }
  if (state.seenOverriding.has(node.key)) {
    reportParse(
      bag,
      'jcx.parse.field.overridden',
      'info',
      `描述头内多条 ${node.key}:，按文档位置序由后者覆盖前者（spec §8.12）`,
      node.span,
      originOf(node),
    );
  }
  state.seenOverriding.add(node.key);
}

function applyHeaderField(state: HeaderState, node: JcxFieldLineNode, bag: DiagnosticBag): void {
  const raw = fieldValue(node);
  noteOverride(state, node, bag);

  switch (node.key) {
    case 'T':
      state.titles.push(raw);
      return;
    case 'C':
      state.credits.push(raw);
      return;
    case 'I':
      state.notes.push(raw);
      return;
    case 'X': {
      const parsed = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
      if (Number.isSafeInteger(parsed)) {
        state.refNumber = parsed;
        return;
      }
      // §8.1：`X:` 不参与任何结构语义，值丢失不影响 Domain 可用性，故取 info。
      reportParse(
        bag,
        'jcx.parse.ref-number.unparsed',
        'info',
        `X: 的值 ${JSON.stringify(raw)} 不是正整数，按 spec §8.1 不赋予结构语义，refNumber 留空`,
        node.span,
        originOf(node),
      );
      return;
    }
    case 'M': {
      const meter = parseMeter(raw);
      state.meter = meter;
      if (meter.kind === 'raw') {
        reportParse(
          bag,
          'jcx.parse.meter.unparsed',
          'info',
          `M: 的值 ${JSON.stringify(raw)} 不是 <整数>/<整数>（如 C / C| 属 DOC-ONLY，spec §8.4），只保留 raw`,
          node.span,
          originOf(node),
        );
      }
      return;
    }
    case 'Q': {
      const tempo = parseTempo(raw);
      state.tempo = tempo;
      if (tempo.bpm === undefined) {
        reportParse(
          bag,
          'jcx.parse.tempo.unparsed',
          'info',
          `Q: 的值 ${JSON.stringify(raw)} 不是 <分数>=<整数>（spec §8.6 之外的形态均 UNVERIFIED），只保留 raw`,
          node.span,
          originOf(node),
        );
      }
      return;
    }
    case 'K':
      // §8.7：mode / clef / 行内 `%` 文本留在 raw，解析失败不报错。
      state.key = parseKey(raw);
      return;
    case 'L': {
      state.headerUnitLengthSeen = true;
      const parsed = parseUnitLength(raw);
      if (parsed === undefined) {
        reportParse(
          bag,
          'jcx.parse.unit-length.unparsed',
          'warning',
          `L: 的值 ${JSON.stringify(raw)} 不是 <整数>/<整数>，按缺席处理（spec §8.5）`,
          node.span,
          originOf(node),
        );
        state.headerUnitLengthSeen = false;
        return;
      }
      state.headerUnitLength = parsed;
      return;
    }
    default:
      return;
  }
}

function applyBodyField(state: HeaderState, node: JcxFieldLineNode, bag: DiagnosticBag): void {
  const raw = fieldValue(node);

  if (BODY_IGNORED_KEYS.includes(node.key)) {
    state.ignoredFields.push({ name: node.key, rawValue: raw, origin: originOf(node) });
    reportParse(
      bag,
      'jcx.parse.field.ignored-in-body',
      'warning',
      `${node.key}: 出现在正文区，原版行为未知（spec §8.13 / Appendix A U10），Domain 忽略其影响`,
      node.span,
      originOf(node),
    );
    return;
  }

  if (node.key !== 'L') {
    return;
  }

  const parsed = parseUnitLength(raw);
  if (parsed === undefined) {
    reportParse(
      bag,
      'jcx.parse.unit-length.unparsed',
      'warning',
      `L: 的值 ${JSON.stringify(raw)} 不是 <整数>/<整数>，该条不生效（spec §8.5）`,
      node.span,
      originOf(node),
    );
    return;
  }
  state.bodyUnitLengths.push({
    lineIndex: lineIndexOf(node),
    unitLength: parsed,
    origin: originOf(node),
  });
  reportParse(
    bag,
    'jcx.parse.unit-length.body-scope',
    'info',
    '正文区的 L: 作用域存在歧义（到文件末尾 vs 到下一个 [V:n]，Appendix A U06），本实现按「从该行起生效直到被下一条 L: 覆盖」处理',
    node.span,
    originOf(node),
  );
}

/** 归一化描述头。永不抛异常：任何值形态问题都降级为 raw + diagnostic。 */
export function parseHeader(ast: JcxAstDocument, ctx: ParseContext): HeaderNormalization {
  const state = createState();

  for (const line of ast.lines) {
    if (line.kind !== 'fieldLine') {
      continue;
    }
    if (line.key === 'V') {
      state.voiceFields.push(line);
      continue;
    }
    if (line.key === 'w') {
      state.lyricFields.push(line);
      continue;
    }
    if (!KNOWN_FIELD_KEYS.includes(line.key)) {
      // §29.1：收集但不参与语义；lexer 已发 `jcx.field.unknown`，此处不重复。
      state.unknownFields.push({
        name: line.key,
        rawValue: fieldValue(line),
        origin: originOf(line),
      });
      continue;
    }
    if (line.region === 'header') {
      state.anchor = line;
      applyHeaderField(state, line, ctx.bag);
      continue;
    }
    applyBodyField(state, line, ctx.bag);
  }

  const anchor = state.anchor;
  const headerUnitLength = state.headerUnitLengthSeen
    ? state.headerUnitLength
    : resolveDefaultUnitLength(
        state.meter,
        ctx.bag,
        anchor?.span ?? ZERO_SPAN,
        anchor === undefined ? documentPath() : originOf(anchor),
      );

  return {
    titles: state.titles,
    credits: state.credits,
    notes: state.notes,
    ...(state.refNumber === undefined ? {} : { refNumber: state.refNumber }),
    ...(state.meter === undefined ? {} : { meter: state.meter }),
    ...(headerUnitLength === undefined ? {} : { unitLength: headerUnitLength }),
    ...(state.tempo === undefined ? {} : { tempo: state.tempo }),
    ...(state.key === undefined ? {} : { key: state.key }),
    unknownFields: state.unknownFields,
    ignoredFields: state.ignoredFields,
    unitLengthScope: createUnitLengthScope(headerUnitLength, state.bodyUnitLengths),
    voiceFields: state.voiceFields,
    lyricFields: state.lyricFields,
  };
}
