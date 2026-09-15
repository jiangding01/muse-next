/**
 * Parse 层 —— 正文叶子的值对象与 marker 识别（M1.6 T6；spec §15、§23、§25）。
 *
 * 从 `scan.ts` 分出来的纯函数集合：不持有状态、不产出事件，只做
 * 「一枚叶子原文 → 一个 Domain 值对象 / 一个 marker 判定」的翻译。
 */

import type { JcxBodyNode } from '../../ast';
import type { ChordSymbol, Decoration, Rest, SourceRef } from '../../../../domain';
import type { SourceSpan } from '../../lexer/sourceSpan';
import type { ParseContext } from '../header';

/** 交给 T7 配对的语法标记；本层只识别形态，不解释语义（方案 §0-5）。 */
export type ScanMarkerKind =
  | 'tie'
  | 'slurOpen'
  | 'slurClose'
  | 'tupletStart'
  | 'brokenRhythm'
  | 'tabRelation'
  | 'strokePrefix';

/** AST 叶子 kind → marker kind；表外的 kind 一律不是 marker。 */
const MARKER_KINDS: ReadonlyMap<string, ScanMarkerKind> = new Map<string, ScanMarkerKind>([
  ['tie', 'tie'],
  ['slurOpen', 'slurOpen'],
  ['slurClose', 'slurClose'],
  ['tupletStart', 'tupletStart'],
  ['brokenRhythm', 'brokenRhythm'],
  ['tabRelation', 'tabRelation'],
  ['strokePrefix', 'strokePrefix'],
]);

export function markerKindOf(kind: string): ScanMarkerKind | undefined {
  return MARKER_KINDS.get(kind);
}

/**
 * marker 的锚点：T7 据此配对，**无需重扫 AST**。
 *
 * - `event`：顶层 marker，`beforeEventIndex` 是它之后**下一个**事件的下标；marker 位于
 *   事件流末尾时等于 `events.length`；
 * - `member`：组合事件（chord / grace / tabGroup）**内部**成员之间的 marker，
 *   `eventIndex` 指向该组合事件，`beforeMemberIndex` 是它之后下一个 member 的下标，
 *   位于组末尾时等于 `members.length`。`[C-C]`、`{a1-S-a3}` 走这一支。
 */
export type ScanMarkerAnchor =
  | { readonly anchor: 'event'; readonly beforeEventIndex: number }
  | { readonly anchor: 'member'; readonly eventIndex: number; readonly beforeMemberIndex: number };

export type ScanMarker = {
  readonly kind: ScanMarkerKind;
  readonly raw: string;
  readonly origin: SourceRef;
  /** T7 的 diagnostic 要指到 marker 本身（而不是它两端的事件），故随 marker 一并带出。 */
  readonly span: SourceSpan;
} & ScanMarkerAnchor;

/** 组内 marker：`eventIndex` 要等组合事件推入后才知道，故先只记 member 下标。 */
export interface PendingMemberMarker {
  readonly kind: ScanMarkerKind;
  readonly raw: string;
  readonly origin: SourceRef;
  readonly span: SourceSpan;
  readonly beforeMemberIndex: number;
}

/** §23：simple 只留名字；complex 用 lexer 的 `parts?` best-effort 拆参数，失败只留 raw。 */
export function buildDecoration(raw: string, parts: readonly string[] | undefined): Decoration {
  const inner = raw.startsWith('!') && raw.endsWith('!') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  if (!inner.startsWith('@') && !inner.startsWith('$')) {
    return { form: 'simple', name: inner };
  }
  if (parts === undefined) {
    // 拆解失败：不猜参数，`payloadRaw` 退化为整段内容原文（§23.2 规范要求保留 raw）。
    return { form: 'complex', payloadRaw: inner, raw };
  }
  let x: number | undefined;
  let y: number | undefined;
  let font: string | undefined;
  let size: number | undefined;
  let payloadRaw = '';
  for (const part of parts) {
    const match = /^([@$][a-zA-Z])'([^']*)'$/.exec(part);
    if (match === null) {
      payloadRaw += part;
      continue;
    }
    const value = match[2] ?? '';
    const numeric = /^-?\d+$/.test(value) ? Number(value) : undefined;
    switch (match[1]) {
      case '@x':
        x = numeric;
        break;
      case '@y':
        y = numeric;
        break;
      case '$f':
        font = value;
        break;
      case '$s':
        size = numeric;
        break;
      default:
        payloadRaw += part;
    }
  }
  return {
    form: 'complex',
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(font === undefined ? {} : { font }),
    ...(size === undefined ? {} : { size }),
    payloadRaw,
    raw,
  };
}

/** §25：`""` 为空占位（必须与「无和弦」区分），`^` 前缀为只显示文字（§25.2/§25.3）。 */
export function buildChordSymbol(raw: string): ChordSymbol {
  const inner = raw.length >= 2 ? raw.slice(1, -1) : '';
  return { raw, empty: inner === '', displayOnly: inner.startsWith('^') };
}

/** §15.2 / §15.3：两种休止的语义未验证，首次出现各发一次 info，不赋任何行为。 */
export function reportRestVariant(ctx: ParseContext, rest: Rest, node: JcxBodyNode): void {
  if (rest.variant === 'Z') {
    ctx.once.reportOnce(
      'rest.uppercase-z',
      'jcx.parse.rest.uppercase-z',
      'info',
      "休止符 'Z' 的语义 UNVERIFIED（spec §15.2）：只保留 variant 与时值，不实现 ABC 的多小节休止",
      node.span,
      node.path,
    );
  } else if (rest.variant === '@') {
    ctx.once.reportOnce(
      'rest.hidden',
      'jcx.parse.rest.hidden',
      'info',
      "休止符 '@' 为 DOC-ONLY（spec §15.3，语料 0 次）：按普通休止占时，不实现隐藏行为",
      node.span,
      node.path,
    );
  }
}

