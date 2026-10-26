/**
 * 输入法组字状态机（M3 T3c；T3c Preflight r1 §3、r1.1 §1 与 §4、r1.1 勘误 E-1 / E-3；用户裁决 Q8-B′；纯逻辑）。
 *
 * - `composing`：组字中；会话不变、不入历史、不解析。基线（文档、版本、view、选区）在 compositionstart 时捕获，compositionend 时只作前置条件比较。
 * - `committing`：compositionend 处理器同步段内的提交过渡态，携带一次性授权（token、文档、授权版本、预期 view、结果）。写回层在 store 同步通知中
 *   核对授权并消费；结果（committed / unchanged）在授权时确定，谁先消费都一样（勘误 E-1）。
 * - `discarded`：Open 提交前、或组字中 store 出现非法变化时进入；其后的 compositionend 只回滚、不提交。
 * - `settled`：组字结束后的**诊断窗口**（Q8-B′）：不吸收、不丢弃任何输入，只按谓词 D1–D3 记录 `ime-trailing-suspect`（勘误 E-3）。
 *   退出：keydown、pointerdown、compositionstart、外部版本 / 文档变化、detach、Open、异步退出回调。
 * - 会话号 `id` 与授权号 `token` 由调用方分配（单调计数，永不复用）；本模块不读时钟、不碰 DOM。
 * - 对外视图：`committing` 视为 `composing`（保守：Open 入口与 beforeunload 在这一瞬间都按组字中处理）。
 */

import type { SourceRange } from '../../../editor/text/types';
import { normalizeNewlines } from './inputPlan';

/** 对外的输入法视图（Open 入口、beforeunload、编辑控制器只读它；T3a 起由 `editorController.ts` 再导出）。 */
export type ImeView = 'idle' | 'composing' | 'discarded' | 'settled';

export type CommitOutcome = 'committed' | 'unchanged';

export type SettledOutcome = CommitOutcome | 'rolled-back' | 'canceled' | 'discarded' | 'committed-unverified';

export interface SettledFacts {
  readonly versionAfter: number;
  /** compositionend 之后 DOM 选区的终点（view 坐标）。 */
  readonly caretView: number;
  /** 绑定层的事件序号（compositionend 时）。 */
  readonly endSeq: number;
}

export type ImeState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'composing';
      readonly id: number;
      readonly documentId: number;
      readonly versionAtStart: number;
      readonly viewAtStart: string;
      readonly base: SourceRange;
    }
  | {
      readonly kind: 'committing';
      readonly id: number;
      readonly token: number;
      readonly documentId: number;
      readonly authorizedVersion: number;
      readonly expectedView: string;
      readonly outcome: CommitOutcome;
      readonly committedText: string;
    }
  | { readonly kind: 'discarded'; readonly id: number }
  | {
      readonly kind: 'settled';
      readonly id: number;
      readonly outcome: SettledOutcome;
      readonly documentId: number;
      readonly versionAfter: number;
      readonly committedText: string;
      readonly caretView: number;
      readonly endSeq: number;
      readonly diagnostics: number;
    };

export const IDLE: ImeState = Object.freeze({ kind: 'idle' });

/** 每个诊断窗口至多记录的条数（D3）。 */
export const MAX_DIAGNOSTICS = 3;

export function imeViewOf(state: ImeState): ImeView {
  switch (state.kind) {
    case 'idle':
      return 'idle';
    case 'composing':
    case 'committing':
      return 'composing';
    case 'discarded':
      return 'discarded';
    case 'settled':
      return 'settled';
  }
}

export interface StartFacts {
  readonly id: number;
  readonly documentId: number;
  readonly version: number;
  readonly view: string;
  readonly base: SourceRange;
  /** Open 事务进行中（`replacementPending`）：新组字直接进入 discarded。 */
  readonly replacing: boolean;
}

/** compositionstart。重复的 start 保留第一次的基线。 */
export function startComposition(state: ImeState, facts: StartFacts): ImeState {
  if (state.kind === 'composing' || state.kind === 'committing') return state;
  if (facts.replacing) return { kind: 'discarded', id: facts.id };
  return {
    kind: 'composing',
    id: facts.id,
    documentId: facts.documentId,
    versionAtStart: facts.version,
    viewAtStart: facts.view,
    base: Object.freeze({ start: facts.base.start, end: facts.base.end }),
  };
}

/** 组字提交后 DOM 应有的 view：开始时的 view 中，基线区间被（规范化后的）组字结果替换。 */
export function expectedViewAfter(state: Extract<ImeState, { kind: 'composing' }>, data: string): string {
  return state.viewAtStart.slice(0, state.base.start) + normalizeNewlines(data) + state.viewAtStart.slice(state.base.end);
}

export interface CommitAuthorization {
  readonly token: number;
  readonly documentId: number;
  readonly authorizedVersion: number;
  readonly expectedView: string;
  readonly outcome: CommitOutcome;
  readonly committedText: string;
}

/** composing → committing（只能由 compositionend 处理器在写入 store 之前调用）。 */
export function beginCommit(state: ImeState, authorization: CommitAuthorization): ImeState {
  if (state.kind !== 'composing') return state;
  return { kind: 'committing', id: state.id, ...authorization };
}

export function authorizationOf(state: ImeState): CommitAuthorization | null {
  if (state.kind !== 'committing') return null;
  const { token, documentId, authorizedVersion, expectedView, outcome, committedText } = state;
  return { token, documentId, authorizedVersion, expectedView, outcome, committedText };
}

function settle(id: number, outcome: SettledOutcome, documentId: number, committedText: string, facts: SettledFacts): ImeState {
  return { kind: 'settled', id, outcome, documentId, committedText, versionAfter: facts.versionAfter, caretView: facts.caretView, endSeq: facts.endSeq, diagnostics: 0 };
}

export type TokenStep = { readonly ok: true; readonly state: ImeState } | { readonly ok: false; readonly state: ImeState };

/** 消费授权：committing → settled{ 授权中的结果 }。token 不匹配（已消费或不存在）时状态不变。 */
export function consumeCommit(state: ImeState, token: number, facts: SettledFacts): TokenStep {
  if (state.kind !== 'committing' || state.token !== token) return { ok: false, state };
  return { ok: true, state: settle(state.id, state.outcome, state.documentId, state.committedText, facts) };
}

/** 写入 store 被拒绝（CAS）：committing → settled{ rolled-back }。 */
export function abortCommit(state: ImeState, token: number, facts: SettledFacts): TokenStep {
  if (state.kind !== 'committing' || state.token !== token) return { ok: false, state };
  return { ok: true, state: settle(state.id, 'rolled-back', state.documentId, '', facts) };
}

/** 提交过渡中 store 出现授权之外的变化：committing → settled{ committed-unverified }。 */
export function endCommitUnverified(state: ImeState, token: number, facts: SettledFacts): TokenStep {
  if (state.kind !== 'committing' || state.token !== token) return { ok: false, state };
  return { ok: true, state: settle(state.id, 'committed-unverified', state.documentId, '', facts) };
}

export type EndKind = 'rolled-back' | 'canceled';

/** compositionend 未提交（前置条件不符 / DOM ≠ expected / 补丁被拒 / 取消），或孤立 end、discarded 的 end。 */
export function endWithoutCommit(state: ImeState, kind: EndKind, documentId: number, facts: SettledFacts): ImeState {
  if (state.kind === 'committing') return state;
  const id = state.kind === 'idle' ? -1 : state.id;
  const outcome: SettledOutcome = state.kind === 'discarded' ? 'discarded' : kind;
  return settle(id, outcome, documentId, '', facts);
}

/** Open 提交前 / 组字中 store 非法变化：composing → discarded；其它状态不变（r3 L-B）。 */
export function discardComposition(state: ImeState): ImeState {
  return state.kind === 'composing' ? { kind: 'discarded', id: state.id } : state;
}

/**
 * 卡死出口：组字中（或 discarded）收到 `isComposing === false` 的 keydown → idle（调用方回滚 DOM）。
 * 实测（r0 §5.2 第 7 条）：组字期间所有 keydown 的 `isComposing` 都为 true，组字开始的第一个 keydown 在 compositionstart 之前。
 */
export function stuckExit(state: ImeState): ImeState {
  return state.kind === 'composing' || state.kind === 'discarded' ? IDLE : state;
}

/** settled 的退出（事件或异步回调）。传入 `id` 时只在会话号匹配时退出（迟到回调无操作）。 */
export function exitSettled(state: ImeState, id?: number): ImeState {
  if (state.kind !== 'settled') return state;
  if (id !== undefined && state.id !== id) return state;
  return IDLE;
}

/** store 变化：settled 期间文档或版本不再是提交后的值 → 退出诊断窗口。 */
export function noteStoreChange(state: ImeState, documentId: number, version: number): ImeState {
  if (state.kind !== 'settled') return state;
  return state.documentId === documentId && state.versionAfter === version ? state : IDLE;
}

export const DIAGNOSED_INPUT_TYPES: ReadonlySet<string> = new Set([
  'insertText',
  'insertReplacementText',
  'insertFromComposition',
  'deleteContentBackward',
  'deleteContentForward',
]);

export interface DiagnosisFacts {
  readonly inputType: string;
  readonly cancelable: boolean;
  readonly data: string | null;
  readonly caretAtCommitEnd: boolean;
  readonly version: number;
  readonly eventSeq: number;
}

/** `ime-trailing-suspect` 诊断记录：全部字段都可直接观测（勘误 E-3）。 */
export interface TrailingSuspect {
  readonly imeSessionId: number;
  readonly outcome: SettledOutcome;
  readonly inputType: string;
  readonly dataLength: number;
  readonly dataMatchesCommit: boolean;
  readonly caretAtCommitEnd: boolean;
  readonly versionUnchanged: boolean;
  readonly eventsSinceEnd: number;
}

/**
 * 诊断谓词 D1–D3：只决定是否记录，不影响事件的处理（Q8-B′：没有任何吸收分支）。
 * D1 诊断窗口仍有效（状态为 settled；代际与会话号由调用方校验）；D2 可取消且类型属于尾随提交型；D3 本窗口记录数未满。
 */
export function diagnose(state: ImeState, facts: DiagnosisFacts): { readonly state: ImeState; readonly record: TrailingSuspect | null } {
  if (state.kind !== 'settled') return { state, record: null };
  if (!facts.cancelable || !DIAGNOSED_INPUT_TYPES.has(facts.inputType)) return { state, record: null };
  if (state.diagnostics >= MAX_DIAGNOSTICS) return { state, record: null };
  const data = facts.data === null ? null : normalizeNewlines(facts.data);
  const record: TrailingSuspect = {
    imeSessionId: state.id,
    outcome: state.outcome,
    inputType: facts.inputType,
    dataLength: data === null ? 0 : data.length,
    dataMatchesCommit: data !== null && state.committedText !== '' && data === state.committedText,
    caretAtCommitEnd: facts.caretAtCommitEnd,
    versionUnchanged: facts.version === state.versionAfter,
    eventsSinceEnd: facts.eventSeq - state.endSeq,
  };
  return { state: { ...state, diagnostics: state.diagnostics + 1 }, record };
}
