/**
 * Parse 层 —— body `L:` 的声部归属 + 跨段持续诊断（从 `segments.ts` 拆出，保持
 * 该文件 ≤350 行；spec §8.5 U06 已裁决，2026-09-22）。
 *
 * `header.ts` 只收集 body `L:` 行的「行号 + 值」（`HeaderNormalization.bodyUnitLengths`），
 * 不知道、也不猜它属于哪个声部——归属唯一真源是 `segments.ts` 已有的 inline /
 * orderly / implicitSingle walk：`assignSegments` 在遍历时顺带调用本模块，记下
 * 每条 body `L:` 行**当时**的 `currentVoiceId`（`undefined` 表示尚无声部上下文，
 * 即 global binding），产出 `UnitLengthBinding[]`。调用方（`parse/index.ts`）
 * 再把这些 binding 的 lineIndex 与 `bodyUnitLengths` 的 lineIndex 一一对上，拼成
 * 带 `voiceId` 的 `UnitLengthEntry`，交给 `duration.ts` 的 `createUnitLengthScope`
 * 装配。本模块自身不知道 `segments.ts` 的 `WalkState` 长什么样，只接受调用方显式
 * 传入的 `currentVoiceId` 与一小块专属状态（`UnitLengthBindingState`），不复制
 * `segments.ts` 的声部状态机。
 *
 * 语义（用户裁决）：
 * 1. body `L:` 只作用于它所在的声部，从该行起生效到该声部结束，不泄漏到其它声部；
 * 2. 同一声部被 `[V:n]` 交错成多段时按声部持续到后续段（INFERRED，语料无样本）；
 * 3. 出现在任何声部上下文之前的 body `L:`（`currentVoiceId === undefined`）
 *    仍是 global binding，对其后所有声部生效直到被覆盖；无 `V:` 的单声部文件
 *    （implicitSingle）不受影响。
 *
 * 诊断（`jcx.parse.unit-length.body-scope`，全部 info）：每条合法的 body `L:` 行
 * 发一条（不分 global / 声部）；**只在真正发生跨段持续时**（该声部在此 `L:` 之后
 * 被再次切回，即真的"续"上了）额外按声部各发一次，用 onceKeyed 保证每个声部只发
 * 一次，message 写明 INFERRED（规则 2）。
 */

import type { JcxAstNodeBase, JcxFieldLineNode } from '../../ast';
import { parseAstPath } from '../../ast';
import type { VoiceId } from '../../../../domain';
import type { ParseContext } from '../header';
import { reportParse } from '../diagnostics';
import { originOf } from '../origin';

/**
 * 一条 body `L:` 行的声部归属结果。`voiceId === undefined` 表示 global binding
 * （该行出现在任何声部上下文之前）。
 */
export interface UnitLengthBinding {
  readonly lineIndex: number;
  readonly voiceId: VoiceId | undefined;
}

/** `assignSegments` 遍历期间随手维护的一小块状态，专属于 body `L:` 归属。 */
export interface UnitLengthBindingState {
  readonly unitLengthBindings: UnitLengthBinding[];
  /** 已经至少推入过一段 bodyLine/trailing 的声部：用于判断"重新切回"是否构成跨段持续。 */
  readonly voiceHasSegment: Set<VoiceId>;
  /** 已经绑定过至少一条 body `L:` 的声部。 */
  readonly voiceHasLBinding: Set<VoiceId>;
}

export function createUnitLengthBindingState(): UnitLengthBindingState {
  return {
    unitLengthBindings: [],
    voiceHasSegment: new Set<VoiceId>(),
    voiceHasLBinding: new Set<VoiceId>(),
  };
}

/** `fieldLine` 节点的 AST 行下标；镜像 `header.ts` 的同名小函数，各自维护、不跨层共享私有实现。 */
function lineIndexOf(node: JcxFieldLineNode): number {
  const parsed = parseAstPath(node.path);
  return parsed === null || parsed.kind !== 'line' ? 0 : parsed.line;
}

/**
 * body `L:` 跨段持续（spec §8.5 U06 裁决第 2 点，INFERRED）：切换到 `id` 时，若该
 * 声部此前已经出过段（`voiceHasSegment`）且已绑定过 body `L:`（`voiceHasLBinding`），
 * 说明这次切回让之前那条 `L:` 真的"跨段"续上了，按声部发一次 info（onceKeyed）。
 * 只在真正的切换（`currentVoiceId !== id`）时调用；同声部内的重复调用（如无意义地
 * 重复出现同 id 的 `[V:id]`）不算切换，不在此判断范围。
 */
export function noteCrossSegmentContinuationIfResumed(
  bindingState: UnitLengthBindingState,
  ctx: ParseContext,
  currentVoiceId: VoiceId | undefined,
  id: VoiceId,
  node: JcxAstNodeBase,
): void {
  if (currentVoiceId === id) {
    return;
  }
  if (!bindingState.voiceHasSegment.has(id) || !bindingState.voiceHasLBinding.has(id)) {
    return;
  }
  ctx.once.reportOnce(
    `voice.unit-length.cross-segment:${id}`,
    'jcx.parse.unit-length.body-scope',
    'info',
    `声部 ${id} 此前绑定的 body L: 跨段持续生效到本段（spec §8.5 U06 裁决第 2 点，INFERRED：语料无样本区分「按声部持续」与「按段重置」）`,
    node.span,
    originOf(node),
  );
}

/**
 * 处理一条 body 区 `L:` 行：只在它是合法值（`validBodyUnitLengthLines` 里）时才
 * 归属到 `currentVoiceId`（`undefined` 即 global）并发 body-scope info；形态不符
 * 的 `L:` 已由 `header.ts` 发过 `unit-length.unparsed` warning，这里静默跳过。
 */
export function bindBodyUnitLength(
  bindingState: UnitLengthBindingState,
  ctx: ParseContext,
  currentVoiceId: VoiceId | undefined,
  validBodyUnitLengthLines: ReadonlySet<number>,
  line: JcxFieldLineNode,
): void {
  const lineIndex = lineIndexOf(line);
  if (!validBodyUnitLengthLines.has(lineIndex)) {
    return;
  }
  bindingState.unitLengthBindings.push({ lineIndex, voiceId: currentVoiceId });
  if (currentVoiceId !== undefined) {
    bindingState.voiceHasLBinding.add(currentVoiceId);
  }
  const scopeText = currentVoiceId === undefined ? '全局（尚无声部上下文）' : `声部 ${currentVoiceId}`;
  reportParse(
    ctx.bag,
    'jcx.parse.unit-length.body-scope',
    'info',
    `body L: 按所在声部作用域生效（spec §8.5 / U06 已裁决），本条归属：${scopeText}`,
    line.span,
    originOf(line),
  );
}
