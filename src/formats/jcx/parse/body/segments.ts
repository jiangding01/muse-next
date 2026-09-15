/**
 * Parse 层 —— 正文段落归属（M1.6 T5；spec §9.1–§9.5、§8.13，方案 v1.1 §2 / §5 T5）。
 *
 * 职责边界：
 * - 只决定「每个 bodyLine / inlineFieldLine.trailing / w: 行属于哪个 VoiceId、按什么
 *   顺序」，不扫描 token、不产出事件——事件扫描是 T6 的事；
 * - 与 `lexer/lexModes.ts` 的正文词法模式状态机**语义一致但实现独立**：lexer 只决定
 *   「这一行该用模式 A 还是模式 B 切词」，本模块决定「这一行归哪个声部」。两者都要
 *   识别 `[V:n]` / body 区 `V:` 行，但互不调用、互不共享状态；
 * - `T4`（`voice.ts`）已经把全部显式声明的 `V:` 行建成 `Voice`；本模块只在遇到
 *   **未声明** 的 id 时才新建（隐式声部），其余情况只做归属，不改变已建声部的属性。
 *
 * 三种归属策略（互斥，按文档级判定一次，spec §9.4 第 2 段「两种策略都必须支持」
 * 的前提是「用了 `[V:...]`」；没用的文件走 §9.4 单样本推断；两者都没有的退化情形
 * 不在 spec 内，取「隐式建一个声部吞下全部正文」的最保守读法）：
 *
 * 1. **inline**（全文出现过 `[V:...]`）：`[V:id]` 是唯一切换信号；id 未声明则隐式建声部。
 *    `[V:...]` 之前若有正文（spec §9.2 未保证不会发生），无法归属，跳过（不丢诊断，
 *    因为「归属未知」本身不是错误，只是超出 spec 覆盖范围）。
 * 2. **orderly**（全文无 `[V:...]`，但描述头/正文声明过至少 1 个 `V:`）：spec §9.4
 *    INFERRED —— 声明顺序 = 段落顺序。第一段（第一条 body 区 `V:` 行之前，若存在）
 *    归第 1 个声明的声部（懒选 `declarationOrder[0]`，见 `ensureOrderlyCurrent`）；
 *    此后每条 body 区 `V:` 行按**该行自身的 id**切换「当前声部」（见 `advanceOrderly`
 *    的注释，说明它与 lexer 的位置法在语料上等价、且没有越界分叉）。只有声明 ≥2
 *    个声部时才真正存在「顺序」这个待推断信息，故只在这种情况下发
 *    `jcx.parse.voice.segment-by-order`（onceKeyed，方案 §2）——单声部文件的正文
 *    只有一种可能归属，不构成推断。
 * 3. **implicitSingle**（全文既无 `[V:...]` 也无任何 `V:` 声明）：隐式建一个声部
 *    （原始 id 记为 `'1'`），吞下全部正文，发 `jcx.parse.voice.implicit`。
 *
 * 诊断一览（全部 `jcx.parse.*`）：
 * | code | severity | 触发 |
 * | --- | --- | --- |
 * | `jcx.parse.voice.implicit` | warning | `[V:id]` 引用未声明 id，或全文无任何 `V:` 声明 |
 * | `jcx.parse.voice.segment-by-order` | warning | 无 `[V:...]` 且声明 ≥2 个声部时的顺序推断（onceKeyed，§9.4） |
 * | `jcx.parse.inline-field.unsupported` | warning | `V` 之外的 inline field（如 `[K:...]`，spec §9.5 UNVERIFIED） |
 */

import type {
  JcxAstDocument,
  JcxAstNodeBase,
  JcxBodyLineNode,
  JcxFieldLineNode,
  JcxInlineFieldLineNode,
} from '../../ast';
import type { IgnoredField, Voice, VoiceId } from '../../../../domain';
import { voiceId } from '../../../../domain';
import type { ParseContext } from '../header';
import { reportParse } from '../diagnostics';
import { originOf } from '../origin';
import type { VoiceRegistry } from '../voice';
import { splitVoiceAttributes } from '../voice';

/** 一个正文行 / 行内尾随正文 / 歌词行被归属到某个声部的最小单位。 */
/**
 * `w:` 行能绑定的「上一行音符」：可能是一条独立正文行，也可能是 `[V:x] CDE` 这种
 * inline 字段行的同行尾随正文（P2 修复：后者此前从未被记录，导致紧跟其后的 `w:`
 * 绑不到任何目标，或错误绑到更早的一条独立正文行）。判别联合而非裸节点联合，
 * 是为了让 `lyrics.ts` 定位可唱事件时不必对节点形状做鸭子类型判断——`kind` 已经
 * 明确告诉调用方这是哪一种，且两个分支各自的 `line` 字段类型精确。
 */
export type LyricTarget =
  | { readonly kind: 'bodyLine'; readonly line: JcxBodyLineNode }
  | { readonly kind: 'inlineTrailing'; readonly line: JcxInlineFieldLineNode };

export type SegmentUnit =
  | { readonly kind: 'bodyLine'; readonly node: JcxBodyLineNode }
  | { readonly kind: 'trailing'; readonly node: JcxInlineFieldLineNode }
  | { readonly kind: 'lyric'; readonly node: JcxFieldLineNode; readonly target: LyricTarget | undefined };

export interface VoiceSegment {
  readonly voiceId: VoiceId;
  readonly unit: SegmentUnit;
}

export interface SegmentsResult {
  /**
   * T4 产出的声部列表 + 本阶段隐式创建的声部。隐式声部在被首次触发的那一刻
   * （`[V:id]` 引用未声明 id，或首次需要「无任何声明」兜底）以 append-only 的
   * 方式追加到列表末尾，不重排——因此 `VoiceId` 的数字序就是它进入本列表的
   * 顺序：T4 已声明的排在前面，T5 隐式创建的按被发现的先后排在后面。
   */
  readonly voices: readonly Voice[];
  /** 按文档顺序排列的全部归属结果，供 T6 流式消费。 */
  readonly segments: readonly VoiceSegment[];
  /** `V` 之外的 inline field（spec §9.5），并入 `Score.ignoredFields`。 */
  readonly ignoredFields: readonly IgnoredField[];
}

type Mode = 'inline' | 'orderly' | 'implicitSingle';

/** `inlineFieldLine` / `V:` fieldLine 的取值叶子；两者都在 `children` 里放一个同名 kind 的通用 token 叶子。 */
function leafRaw(children: readonly { readonly token: { readonly kind: string }; readonly raw: string }[], kind: string): string {
  for (const child of children) {
    if (child.token.kind === kind) {
      return child.raw;
    }
  }
  return '';
}

interface WalkState {
  readonly voices: Voice[];
  readonly idIndex: Map<string, VoiceId>;
  readonly segments: VoiceSegment[];
  readonly ignoredFields: IgnoredField[];
  currentVoiceId: VoiceId | undefined;
  lastLyricTarget: LyricTarget | undefined;
  lastLyricTargetVoiceId: VoiceId | undefined;
}

/**
 * 隐式创建一个声部：style 等属性全部留空，origins 只有触发它的这一处引用。
 * 新声部的 id 恒为 `voiceId(state.voices.length + 1)`，并 `push` 到 `state.voices`
 * 末尾——append-only，绝不插到已有声部中间，见 `SegmentsResult.voices` 的说明。
 */
function createImplicitVoice(state: WalkState, node: JcxAstNodeBase, ctx: ParseContext, rawId: string): VoiceId {
  const id = voiceId(state.voices.length + 1);
  state.voices.push({
    id,
    unknownAttributes: [],
    events: [],
    ties: [],
    slurs: [],
    tuplets: [],
    tabRelations: [],
    brokenRhythms: [],
    unitLengthChanges: [],
    lyricLines: [],
    origins: [originOf(node)],
  });
  reportParse(
    ctx.bag,
    'jcx.parse.voice.implicit',
    'warning',
    `声部 ${JSON.stringify(rawId)} 未声明，隐式创建为 ${id}（spec §9 INFERRED）`,
    node.span,
    originOf(node),
  );
  return id;
}

/** spec §9.4：只在「无 [V:...] 且声明 ≥2 个声部」时才真的存在待推断的顺序。 */
function warnSegmentByOrder(ctx: ParseContext, node: JcxAstNodeBase): void {
  ctx.once.reportOnce(
    'voice.segment-by-order',
    'jcx.parse.voice.segment-by-order',
    'warning',
    '文件没有使用 [V:n] 切分声部，按描述头 V: 的声明顺序把正文段落依次归属到各声部（spec §9.4 INFERRED，单样本）',
    node.span,
    originOf(node),
  );
}

/** orderly 模式下确保 `currentVoiceId` 已选定：懒选第 1 个声明的声部（对应「第一段归第一个声部」）。 */
function ensureOrderlyCurrent(
  state: WalkState,
  registry: VoiceRegistry,
  warnEnabled: boolean,
  ctx: ParseContext,
  node: JcxAstNodeBase,
): void {
  if (state.currentVoiceId !== undefined) {
    return;
  }
  state.currentVoiceId = registry.declarationOrder[0];
  if (warnEnabled) {
    warnSegmentByOrder(ctx, node);
  }
}

/**
 * body 区 `V:` 行：orderly 模式下按**该行自身的 id**切换「当前声部」。
 *
 * 与 `lexer/lexModes.ts`（`resolveMode` 的 `'field'` 分支，约 L337–349）的一致性
 * 依据：lexModes 优先用「声明顺序位置」`prescan.order[segmentIndex]`，只有该位置
 * 越界（body 区 `V:` 行数多于 prescan 认定的声部数，例如同一 id 反复出现在 body）
 * 时才退回该行的字面 id。Parse 层没有这个「位置优先、越界才退回」的必要：T4 处理
 * `header.voiceFields` 时已经把全部 `V:` 行（不分 header / body、也不管是否重复
 * 声明）都注册进了 `VoiceRegistry.idIndex`，所以**总是**按字面 id 查表既更简单，
 * 也不存在「声明数 < body 区 `V:` 行数」导致的越界分叉——这条 id 查找路径一定命中。
 * 两种实现在语料上给出相同结果（11 个文件里唯一触发本规则的 `corpus#08`，9 个
 * 声部的 id 与声明顺序完全一致，位置法与 id 法算出同一答案）。
 *
 * `id === undefined` 分支理论上不可达（上段已论证），保留只是恪守「永不抛异常」的
 * 契约，不代表这是一条已知会被触发的路径。
 */
function advanceOrderly(
  state: WalkState,
  warnEnabled: boolean,
  ctx: ParseContext,
  node: JcxFieldLineNode,
): void {
  const raw = leafRaw(node.children, 'fieldValue');
  const { id: rawId } = splitVoiceAttributes(raw);
  let id = state.idIndex.get(rawId);
  if (id === undefined) {
    id = createImplicitVoice(state, node, ctx, rawId);
    state.idIndex.set(rawId, id);
  }
  state.currentVoiceId = id;
  if (warnEnabled) {
    warnSegmentByOrder(ctx, node);
  }
}

function pushBodyLine(state: WalkState, id: VoiceId, node: JcxBodyLineNode): void {
  state.segments.push({ voiceId: id, unit: { kind: 'bodyLine', node } });
  state.lastLyricTarget = { kind: 'bodyLine', line: node };
  state.lastLyricTargetVoiceId = id;
}

function handleInlineFieldLine(state: WalkState, ctx: ParseContext, node: JcxInlineFieldLineNode): void {
  if (node.key !== 'V') {
    // spec §9.5：`V` 之外的 inline field 全文 0 出现，语义 UNVERIFIED，只保留原文。
    const rawValue = leafRaw(node.children, 'inlineFieldValue');
    state.ignoredFields.push({ name: node.key, rawValue, origin: originOf(node) });
    reportParse(
      ctx.bag,
      'jcx.parse.inline-field.unsupported',
      'warning',
      `内联字段 [${node.key}:...] 未实现语义，只保留原文（spec §9.5 UNVERIFIED）`,
      node.span,
      originOf(node),
    );
    return;
  }

  const rawId = leafRaw(node.children, 'inlineFieldValue').trim();
  let id = state.idIndex.get(rawId);
  if (id === undefined) {
    id = createImplicitVoice(state, node, ctx, rawId);
    state.idIndex.set(rawId, id);
  }
  state.currentVoiceId = id;

  if (node.trailing.length > 0) {
    // spec §9.2：help 示例 `[V:1] ABCD|`——同行尾随正文按切换后的声部归属。
    state.segments.push({ voiceId: id, unit: { kind: 'trailing', node } });
    // P2 修复：同行尾随正文本身就是「上一行音符」，`w:` 紧跟其后时应绑定到它，
    // 而不是更早的某条独立正文行（或压根没有目标）。
    state.lastLyricTarget = { kind: 'inlineTrailing', line: node };
    state.lastLyricTargetVoiceId = id;
  }
}

/**
 * 把 Lossless AST 归一化为「每个 body 行 / trailing / w: 行属于哪个声部」的有序列表。
 *
 * 永不抛异常：任何无法归属的行（如 inline 模式下 `[V:...]` 之前出现的正文，spec
 * 未保证不会发生）一律跳过，不产出 segment，也不发诊断——归属未知不等于结构错误。
 */
export function assignSegments(
  ast: JcxAstDocument,
  registry: VoiceRegistry,
  baseVoices: readonly Voice[],
  ctx: ParseContext,
): SegmentsResult {
  const hasInlineVoice = ast.lines.some((line) => line.kind === 'inlineFieldLine' && line.key === 'V');
  const mode: Mode = hasInlineVoice
    ? 'inline'
    : registry.declarationOrder.length > 0
      ? 'orderly'
      : 'implicitSingle';
  const warnEnabled = mode === 'orderly' && registry.declarationOrder.length >= 2;

  const state: WalkState = {
    voices: [...baseVoices],
    idIndex: new Map(registry.idIndex),
    segments: [],
    ignoredFields: [],
    currentVoiceId: undefined,
    lastLyricTarget: undefined,
    lastLyricTargetVoiceId: undefined,
  };

  for (const line of ast.lines) {
    switch (line.kind) {
      case 'bodyLine': {
        if (mode === 'orderly') {
          ensureOrderlyCurrent(state, registry, warnEnabled, ctx, line);
        } else if (mode === 'implicitSingle' && state.currentVoiceId === undefined) {
          state.currentVoiceId = createImplicitVoice(state, line, ctx, '1');
        }
        if (state.currentVoiceId !== undefined) {
          pushBodyLine(state, state.currentVoiceId, line);
        }
        // inline 模式下、首个 [V:...] 之前出现的正文无法归属，静默跳过。
        break;
      }
      case 'inlineFieldLine': {
        handleInlineFieldLine(state, ctx, line);
        break;
      }
      case 'fieldLine': {
        if (line.region !== 'body') {
          break;
        }
        if (line.key === 'V') {
          if (mode === 'orderly') {
            advanceOrderly(state, warnEnabled, ctx, line);
          }
          // inline / implicitSingle：spec §8.13，body 区再出现的 V: 只是声明（T4 已建声部），不切换当前声部。
          break;
        }
        if (line.key === 'w') {
          const owner = state.lastLyricTargetVoiceId ?? state.currentVoiceId;
          if (owner !== undefined) {
            state.segments.push({ voiceId: owner, unit: { kind: 'lyric', node: line, target: state.lastLyricTarget } });
          }
        }
        break;
      }
      default:
        // magicHeaderLine / directiveLine / commentLine / blankLine / rawLine / textBlock：不影响归属。
        break;
    }
  }

  return { voices: state.voices, segments: state.segments, ignoredFields: state.ignoredFields };
}
