/**
 * Parse 层 —— 声部属性归一化（M1.6 T4；spec §12，方案 v1.1 §1.4 / §2）。
 *
 * 职责边界：
 * - `splitVoiceAttributes` 是唯一允许对 `V:` fieldValue 原文做字符扫描的地方
 *   （方案 v1.1 决策 B）；此后所有阶段只消费其结构化输出，不重扫源码；
 * - 别名归一化只发生在本层（spec §12.3），AST 上的 `V:` 原文保持不变；
 * - 未识别 key=value（含 `play=`，spec §12.2 UNVERIFIED）与 `gchords=`（布尔字面值
 *   编码全文未定义，解析即自行发明语义）一律进 `unknownAttributes`，不猜别名、
 *   不提升为布尔行为（方案 §0 固定审查项第 1 条）。
 *
 * 诊断一览（全部 `jcx.parse.voice.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.voice.attribute-unparsed` | warning | 孤立 token / 空 key / 引号未闭合 / 数值属性解析失败 |
 * | `jcx.parse.voice.unverified-attribute` | info | 落入 unknownAttributes 的 key 首次出现（onceKeyed，按 key 区分） |
 * | `jcx.parse.voice.redeclared` | info | 同 id `V:` 重复声明（spec §8.12 INFERRED，属性级后者覆盖） |
 */

import type { JcxFieldLineNode } from '../ast';
import type { SourceSpan } from '../lexer/sourceSpan';
import type { SourceRef, Voice, VoiceId } from '../../../domain';
import { voiceId } from '../../../domain';
import type { ParseContext } from './header';
import { reportParse } from './diagnostics';
import { originOf } from './origin';

/** 单个属性 token 的结构化切分结果（方案决策 B）。 */
export interface VoiceAttributeToken {
  readonly key: string;
  readonly value: string;
  readonly quoted: boolean;
}

export interface SplitVoiceAttributes {
  readonly id: string;
  readonly attrs: readonly VoiceAttributeToken[];
  /** 无 `=` 的孤立 token，或引号未闭合等不合法片段的原文。 */
  readonly unparsed: readonly string[];
}

function isSpace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * 从 `V:` 的 fieldValue 原文切出 id 与属性列表（spec §12.1 / §12.4）。
 *
 * 规则：id 是首个空白前的串；属性形态为 `key=value`，value 可用双引号包裹
 * （含空格与中文），未引号则到下一个空白为止；无 `=` 的孤立 token 与引号未闭合
 * 等不合法片段进 `unparsed`，交给调用方决定诊断与归属。
 *
 * 不重扫 AST 之外的源码，只接受 fieldValue 叶子的 raw（lexer 已按 §8.0 修剪首尾空白）。
 */
export function splitVoiceAttributes(fieldValueRaw: string): SplitVoiceAttributes {
  const s = fieldValueRaw;
  const len = s.length;
  let i = 0;

  const takeToken = (from: number): string => {
    let k = from;
    while (k < len && !isSpace(s[k])) {
      k++;
    }
    return s.slice(from, k);
  };
  const skipSpace = (): void => {
    while (i < len && isSpace(s[i])) {
      i++;
    }
  };

  skipSpace();
  const id = takeToken(i);
  i += id.length;

  const attrs: VoiceAttributeToken[] = [];
  const unparsed: string[] = [];

  for (;;) {
    skipSpace();
    if (i >= len) {
      break;
    }
    const tokenStart = i;
    let j = i;
    while (j < len && s[j] !== '=' && !isSpace(s[j])) {
      j++;
    }

    if (j >= len || s[j] !== '=' || j === tokenStart) {
      // 后一个条件覆盖空 key（如 `=x`）：不产生 key === '' 的属性，整个 token 计为 unparsed。
      const token = takeToken(tokenStart);
      unparsed.push(token);
      i = tokenStart + token.length;
      continue;
    }

    const key = s.slice(tokenStart, j);
    const valueStart = j + 1;
    if (valueStart < len && s[valueStart] === '"') {
      const closeIndex = s.indexOf('"', valueStart + 1);
      if (closeIndex !== -1) {
        attrs.push({ key, value: s.slice(valueStart + 1, closeIndex), quoted: true });
        i = closeIndex + 1;
        continue;
      }
      // 引号未闭合：不合法片段，整个 token（到下一个空白）计为 unparsed。
      const token = takeToken(tokenStart);
      unparsed.push(token);
      i = tokenStart + token.length;
      continue;
    }

    const value = takeToken(valueStart);
    attrs.push({ key, value, quoted: false });
    i = valueStart + value.length;
  }

  return { id, attrs, unparsed };
}

/** spec §12.3：归一化只发生在本层；AST 保留原始拼写。
 * `volume` 全称自身是 UNVERIFIED 的第三套别名（spec §12.3 末段），不接受。 */
const ALIASES: Readonly<Record<string, string>> = {
  name: 'name', nm: 'name',
  sname: 'sname', snm: 'sname',
  instrument: 'instrument', ins: 'instrument',
  volumn: 'volume', vol: 'volume',
  bracket: 'bracket', brk: 'bracket',
  brace: 'brace', brc: 'brace',
  staves: 'staves', stv: 'staves',
  space: 'space', spc: 'space',
  gchords: 'gchords', gch: 'gchords',
  style: 'style',
  clef: 'clef',
};

function parseIntegerAttr(raw: string): number | undefined {
  if (!/^-?\d+$/.test(raw)) {
    return undefined;
  }
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

interface VoiceBuilderState {
  readonly id: VoiceId;
  name: string | undefined;
  sname: string | undefined;
  style: string | undefined;
  instrument: number | undefined;
  volume: number | undefined;
  bracket: number | undefined;
  brace: number | undefined;
  staves: number | undefined;
  space: string | undefined;
  clef: string | undefined;
  readonly unknownAttributes: Map<string, string>;
  readonly origins: SourceRef[];
}

function createState(id: VoiceId): VoiceBuilderState {
  return {
    id, name: undefined, sname: undefined, style: undefined,
    instrument: undefined, volume: undefined, bracket: undefined,
    brace: undefined, staves: undefined, space: undefined, clef: undefined,
    unknownAttributes: new Map<string, string>(), origins: [],
  };
}

/** 数值 / 字符串归一化 key 的落位函数，用查表取代 switch（都不需要 `as`）。 */
const NUMERIC_SETTERS: Readonly<Record<string, (s: VoiceBuilderState, v: number) => void>> = {
  instrument: (s, v) => { s.instrument = v; },
  volume: (s, v) => { s.volume = v; },
  bracket: (s, v) => { s.bracket = v; },
  brace: (s, v) => { s.brace = v; },
  staves: (s, v) => { s.staves = v; },
};
const STRING_SETTERS: Readonly<Record<string, (s: VoiceBuilderState, v: string) => void>> = {
  name: (s, v) => { s.name = v; },
  sname: (s, v) => { s.sname = v; },
  style: (s, v) => { s.style = v; },
  clef: (s, v) => { s.clef = v; },
  space: (s, v) => { s.space = v; },
};

function finalize(state: VoiceBuilderState): Voice {
  return {
    id: state.id,
    ...(state.name === undefined ? {} : { name: state.name }),
    ...(state.sname === undefined ? {} : { sname: state.sname }),
    ...(state.style === undefined ? {} : { style: state.style }),
    ...(state.instrument === undefined ? {} : { instrument: state.instrument }),
    ...(state.volume === undefined ? {} : { volume: state.volume }),
    ...(state.bracket === undefined ? {} : { bracket: state.bracket }),
    ...(state.brace === undefined ? {} : { brace: state.brace }),
    ...(state.staves === undefined ? {} : { staves: state.staves }),
    ...(state.space === undefined ? {} : { space: state.space }),
    ...(state.clef === undefined ? {} : { clef: state.clef }),
    unknownAttributes: Array.from(state.unknownAttributes, ([key, value]) => ({ key, value })),
    events: [], ties: [], slurs: [], tuplets: [], tabRelations: [], lyricLines: [],
    origins: state.origins,
  };
}

/** `fieldValue` 叶子的 raw 与 span；缺失（不应发生，V: 行恒有 fieldValue）时退回整行 span。 */
function fieldValueLeaf(node: JcxFieldLineNode): { raw: string; span: SourceSpan } {
  for (const child of node.children) {
    if (child.token.kind === 'fieldValue') {
      return { raw: child.raw, span: child.span };
    }
  }
  return { raw: '', span: node.span };
}

export interface VoiceRegistry {
  /** JCX 原始 id 字符串 → VoiceId，供 T5 的 `[V:n]` 使用。 */
  readonly idIndex: ReadonlyMap<string, VoiceId>;
  /** 声明顺序（首次出现顺序）的 VoiceId 列表，供 T5 §9.4 段落归属使用。 */
  readonly declarationOrder: readonly VoiceId[];
}

export interface VoiceParseResult {
  readonly voices: readonly Voice[];
  readonly registry: VoiceRegistry;
}

function applyUnparsed(state: VoiceBuilderState, tokens: readonly string[], span: SourceSpan, node: JcxFieldLineNode, ctx: ParseContext): void {
  for (const token of tokens) {
    reportParse(
      ctx.bag, 'jcx.parse.voice.attribute-unparsed', 'warning',
      `声部属性片段 ${JSON.stringify(token)} 不是合法的 key=value（spec §12.1）`,
      span, originOf(node),
    );
    state.unknownAttributes.set(token, '');
  }
}

/** 方案 v1.1 §2：落入 unknownAttributes 的每个 key（含 play=、gchords=）一次性发 info。 */
function reportUnverifiedOnce(ctx: ParseContext, key: string, span: SourceSpan, node: JcxFieldLineNode): void {
  ctx.once.reportOnce(
    `voice.unverified-attribute:${key}`, 'jcx.parse.voice.unverified-attribute', 'info',
    `${key}= 未被识别为已归一化的声部属性（spec §12.2/§12.3），只保留在 unknownAttributes 中，不提升为字段`,
    span, originOf(node),
  );
}

function applyAttr(
  state: VoiceBuilderState,
  attr: VoiceAttributeToken,
  span: SourceSpan,
  node: JcxFieldLineNode,
  ctx: ParseContext,
): void {
  const normalized = ALIASES[attr.key];

  if (normalized === undefined) {
    // 真正未识别的 key（含 'play'，spec §12.2 UNVERIFIED）。
    state.unknownAttributes.set(attr.key, attr.value);
    reportUnverifiedOnce(ctx, attr.key, span, node);
    return;
  }

  if (normalized === 'gchords') {
    // 布尔字面值编码全文未定义，同样归入 unknownAttributes 并发一次性 info。
    state.unknownAttributes.set('gchords', attr.value);
    reportUnverifiedOnce(ctx, 'gchords', span, node);
    return;
  }

  const numericSetter = NUMERIC_SETTERS[normalized];
  if (numericSetter !== undefined) {
    const parsed = parseIntegerAttr(attr.value);
    if (parsed === undefined) {
      reportParse(
        ctx.bag, 'jcx.parse.voice.attribute-unparsed', 'warning',
        `声部属性 ${normalized}=${JSON.stringify(attr.value)} 不是整数（spec §12.2）`,
        span, originOf(node),
      );
      state.unknownAttributes.set(normalized, attr.value);
      return;
    }
    numericSetter(state, parsed);
    return;
  }

  // 剩余的归一化 key 全是字符串直通：name / sname / style / clef / space。
  const stringSetter = STRING_SETTERS[normalized];
  if (stringSetter !== undefined) {
    stringSetter(state, attr.value);
  }
}

/**
 * 解析全部 `V:` 行（header 与 body 区都算声明；body 区声明是 T5 §9.4 段落归属的
 * 输入，本函数只建 Voice，不做归属）。
 *
 * 同 id 重复：属性级后者覆盖（后者未写的属性保留前者），`origins` 累加，
 * 发 info `jcx.parse.voice.redeclared`。
 */
export function parseVoices(
  voiceFields: readonly JcxFieldLineNode[],
  ctx: ParseContext,
): VoiceParseResult {
  const states = new Map<string, VoiceBuilderState>();
  const order: string[] = [];

  for (const node of voiceFields) {
    const { raw, span } = fieldValueLeaf(node);
    const { id: jcxId, attrs, unparsed } = splitVoiceAttributes(raw);

    let state = states.get(jcxId);
    if (state === undefined) {
      state = createState(voiceId(order.length + 1));
      states.set(jcxId, state);
      order.push(jcxId);
    } else {
      reportParse(
        ctx.bag, 'jcx.parse.voice.redeclared', 'info',
        `声部 id ${JSON.stringify(jcxId)} 重复声明，属性级后者覆盖前者（spec §8.12 INFERRED）`,
        span, originOf(node),
      );
    }
    state.origins.push(originOf(node));

    applyUnparsed(state, unparsed, span, node, ctx);
    for (const attr of attrs) {
      applyAttr(state, attr, span, node, ctx);
    }
  }

  const voices: Voice[] = [];
  const idIndex = new Map<string, VoiceId>();
  const declarationOrder: VoiceId[] = [];
  for (const jcxId of order) {
    const state = states.get(jcxId);
    if (state === undefined) {
      continue;
    }
    voices.push(finalize(state));
    idIndex.set(jcxId, state.id);
    declarationOrder.push(state.id);
  }

  return { voices, registry: { idIndex, declarationOrder } };
}
