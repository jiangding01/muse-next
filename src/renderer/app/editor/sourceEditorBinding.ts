/**
 * 源码面板 textarea 的绑定层（M3 T3c；方案 §9.1、§8.2；Preflight r0 §3–§4、r1 §2 / §5 / §7、r1.1 §1、勘误 E-1 / E-3）。
 *
 * - 非受控 textarea：`SourceInspector` 只通过 `bindSourceEditor` ref 回调交出元素；DOM 永远不是真相，写回由 `editorWriteBack` 订阅 store 完成。
 * - beforeinput 是唯一的补丁入口：可取消输入**第一步** `preventDefault()`，再由 `inputPlan` 生成 view 补丁，在**同一个同步段**内
 *   读取基线 → `applySourceInput` → `applyEditorStep(core, base)`（CAS-1）；写入被拒不重试、不重算（CAS-4），DOM 由写回层对齐到 store。
 * - 输入法：compositionstart 捕获基线；组字期间不改会话、不入历史、不解析；compositionend 先比较前置条件与 DOM，再经提交过渡态与一次性授权
 *   写入恰好一个事务（r1.1 §1）；之后进入诊断窗口（Q8-B′：不吸收任何输入，只记录 `ime-trailing-suspect`）。
 * - 即时防线：非组字状态下出现绕过 beforeinput 的 DOM 改动（无障碍注入、失焦时的合成注入等，已实测存在）→ 整体回滚并提示。
 * - 选区：`selectionchange` / `keyup` / `pointerup` / `focus` 时由 `selectionSync` 电平触发同步（三对象 CAS + 有界收束）。
 * - 平台门控（Q9-A）：未开放平台上所有可取消输入在 `preventDefault` 后拒绝并提示，不进入输入法状态机、不建任何事务。
 * - 生命周期：每次 attach 递增代际；所有处理器与延迟任务按代际 / 会话号校验，旧 attachment、旧组字会话与旧异步任务不改变新状态。
 *   StrictMode 的 attach → detach → attach 只留下一组监听与一个 store 订阅。
 */

import { isSourceDirty } from '../../../editor/session/derive';
import type { DocumentSession } from '../../../editor/session/types';
import { reportEditorError } from '../fatalError';
import { applyEditorStep, publishEditorView, setEditorSelection, useMuseAppStore } from '../store';
import type { StoreWriteResult } from '../store';
import { museEditorController } from './editorController';
import type { EditorController } from './editorController';
import { sourceEditingEnabledOn, sourceEditingPlatform } from './editingPlatform';
import { applySourceInput, sourceSelectionFromView } from './editorTransitions';
import type { EditorCore, EditorNoticeKind, EditorStepFailure } from './editorTransitions';
import { createWriteBack } from './editorWriteBack';
import type { TextareaLike, WriteBack, WriteBackState } from './editorWriteBack';
import { expectedViewAfter } from './imeMachine';
import type { SettledFacts, TrailingSuspect } from './imeMachine';
import { museImeSession } from './imeSession';
import type { ImeSession } from './imeSession';
import { normalizeNewlines, planInput } from './inputPlan';
import { museParseController } from './parseController';
import type { ParseController } from './parseController';
import { createSelectionSync } from './selectionSync';
import type { SelectionSync } from './selectionSync';

type Listener = (event: unknown) => void;

/** 绑定所需的元素能力（结构类型；`HTMLTextAreaElement` 满足）。 */
export interface SourceTextareaLike extends TextareaLike {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
  blur(): void;
  readonly ownerDocument: {
    readonly activeElement: unknown;
    addEventListener(type: string, listener: Listener): void;
    removeEventListener(type: string, listener: Listener): void;
  };
}

export interface SourceEditorBindingDeps {
  readonly read: () => EditorCore;
  readonly apply: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  readonly writeSelection: (core: EditorCore, base: EditorCore) => StoreWriteResult;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ime: ImeSession;
  readonly controller: Pick<EditorController, 'undo' | 'redo' | 'replacementPending'>;
  readonly parse: Pick<ParseController, 'sourceChanged' | 'flush' | 'compositionStart' | 'compositionEnd'>;
  readonly notify: (kind: EditorNoticeKind) => void;
  readonly clearNotice: (kind: EditorNoticeKind) => void;
  readonly report: (error: unknown, context: string) => void;
  readonly diagnostic: (record: TrailingSuspect) => void;
  readonly defer: (task: () => void) => void;
  readonly post: (task: () => void) => void;
  readonly editingEnabled: () => boolean;
}

export interface SourceEditorBinding {
  /** React ref 回调：元素 → attach；null → detach。 */
  bind(element: SourceTextareaLike | null): void;
  /** 诊断与测试。 */
  generation(): number;
  writeBack(): WriteBack;
  selectionSync(): SelectionSync;
}

interface InputEventLike {
  readonly inputType: string;
  readonly data: string | null;
  readonly dataTransfer: { getData(format: string): string } | null;
  readonly cancelable: boolean;
  readonly timeStamp: number;
  preventDefault(): void;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function inputEventOf(event: unknown): InputEventLike | null {
  if (!isRecord(event) || typeof event.inputType !== 'string' || typeof event.preventDefault !== 'function') return null;
  const dataTransfer = event.dataTransfer;
  const getData = isRecord(dataTransfer) ? dataTransfer.getData : undefined;
  const transfer = typeof getData === 'function' ? { getData: (format: string): string => String(Reflect.apply(getData, dataTransfer, [format])) } : null;
  const prevent = event.preventDefault;
  return {
    inputType: event.inputType,
    data: typeof event.data === 'string' ? event.data : null,
    dataTransfer: transfer,
    cancelable: event.cancelable === true,
    timeStamp: typeof event.timeStamp === 'number' ? event.timeStamp : Number.NaN,
    preventDefault: () => {
      Reflect.apply(prevent, event, []);
    },
  };
}

const compositionDataOf = (event: unknown): string => (isRecord(event) && typeof event.data === 'string' ? event.data : '');

const keyIsComposing = (event: unknown): boolean => isRecord(event) && event.isComposing === true;

function stepNotice(reason: EditorStepFailure): EditorNoticeKind {
  switch (reason) {
    case 'view-range-out-of-range':
    case 'view-text-contains-cr':
    case 'touches-protected-prefix':
    case 'creates-leading-feff':
    case 'splits-crlf':
    case 'merges-cr-lf':
      return 'input-rejected';
    default:
      return 'edit-conflict';
  }
}

export function createSourceEditorBinding(deps: SourceEditorBindingDeps): SourceEditorBinding {
  let element: SourceTextareaLike | null = null;
  let generation = 0;
  let eventSeq = 0;
  let detachListeners: (() => void) | null = null;

  const writeBack = createWriteBack({
    read: (): WriteBackState => {
      const { session, selection } = deps.read();
      return { session, selection };
    },
    subscribe: deps.subscribe,
    ime: deps.ime,
    notify: deps.notify,
    clearNotice: deps.clearNotice,
    report: deps.report,
    defer: deps.defer,
    post: deps.post,
    gateReadOnly: () => !deps.editingEnabled(),
    eventSeq: () => eventSeq,
  });

  const selectionSync = createSelectionSync({
    read: deps.read,
    write: deps.writeSelection,
    textarea: () => element,
    canSync: () => {
      const ime = deps.ime.view();
      return element !== null && (ime === 'idle' || ime === 'settled') && !deps.controller.replacementPending() && !writeBack.isBroken();
    },
    generation: () => generation,
    post: deps.post,
    realign: () => {
      writeBack.reconcile({ force: true });
    },
    resolveToStore: () => {
      writeBack.applyStoreSelection();
    },
    diagnostic: () => undefined,
  });

  const viewOf = (session: DocumentSession): string => session.projection.view;

  function settledFacts(ta: SourceTextareaLike): SettledFacts {
    return { versionAfter: deps.read().session.sourceVersion, caretView: ta.selectionEnd, endSeq: eventSeq };
  }

  function rollback(notice: EditorNoticeKind | null): void {
    writeBack.reconcile({ force: true, rollback: true });
    if (notice !== null) deps.notify(notice);
  }

  function recordDiagnosis(ta: SourceTextareaLike, input: InputEventLike): void {
    const state = deps.ime.state();
    if (state.kind !== 'settled') return;
    const record = deps.ime.diagnose({
      inputType: input.inputType,
      cancelable: input.cancelable,
      data: input.data,
      caretAtCommitEnd: ta.selectionStart === ta.selectionEnd && ta.selectionEnd === state.caretView,
      version: deps.read().session.sourceVersion,
      eventSeq,
    });
    if (record !== null) deps.diagnostic(record);
  }

  function handleBeforeInput(ta: SourceTextareaLike, input: InputEventLike): void {
    if (input.inputType === 'insertCompositionText') return;
    if (input.cancelable) input.preventDefault();
    try {
      recordDiagnosis(ta, input);
      if (!input.cancelable) return;
      if (!deps.editingEnabled()) return deps.notify('source-readonly-platform');
      if (writeBack.isBroken()) return deps.notify('edit-out-of-sync');
      if (deps.controller.replacementPending()) return deps.notify('command-ignored-replacing');
      if (deps.ime.view() === 'composing' || deps.ime.view() === 'discarded') return rollback(null);
      const base = deps.read();
      const view = viewOf(base.session);
      if (ta.value !== view) return rollback('input-reverted');
      const plan = planInput({
        inputType: input.inputType,
        data: input.data,
        dataTransferText: input.dataTransfer === null ? null : input.dataTransfer.getData('text/plain'),
        selection: { start: ta.selectionStart, end: ta.selectionEnd },
        view,
      });
      switch (plan.kind) {
        case 'history':
          deps.controller[plan.command]('beforeinput');
          return;
        case 'noop':
        case 'composition':
          return;
        case 'reject':
          return deps.notify(plan.reason === 'unsupported' ? 'input-unsupported' : 'input-rejected');
        case 'patch': {
          const selection = sourceSelectionFromView(base.session, { start: ta.selectionStart, end: ta.selectionEnd });
          if (selection === null) return rollback('input-rejected');
          const coalesce = plan.coalesce === null ? null : { kind: plan.coalesce, timestamp: input.timeStamp };
          const step = applySourceInput(base, { viewPatch: plan.viewPatch, selection, coalesce, label: plan.label });
          if (!step.ok) return deps.notify(stepNotice(step.reason));
          const written = deps.apply(step.core, base);
          if (!written.ok) return rollback('edit-conflict');
          if (step.changed) deps.parse.sourceChanged();
          else writeBack.reconcile();
          return;
        }
      }
    } catch (error) {
      writeBack.reconcile({ force: true, rollback: true });
      deps.report(error, 'beforeinput');
    }
  }

  function handleCompositionStart(ta: SourceTextareaLike): void {
    // 未开放平台不进入输入法状态机；随后的 compositionend 按孤立 end 回滚 DOM。
    if (!deps.editingEnabled()) return;
    const { session } = deps.read();
    const replacing = deps.controller.replacementPending();
    const state = deps.ime.start({
      documentId: session.documentId,
      version: session.sourceVersion,
      view: viewOf(session),
      base: { start: ta.selectionStart, end: ta.selectionEnd },
      replacing,
    });
    if (state.kind === 'discarded' && replacing) deps.notify('command-ignored-replacing');
    selectionSync.invalidate();
    deps.parse.compositionStart();
  }

  function scheduleSettledExit(id: number): void {
    const gen = generation;
    deps.post(() => {
      if (gen === generation) deps.ime.exitSettled(id);
    });
  }

  /** compositionend：先结束解析调度的组字暂停；无论提交与否，进入诊断窗口后都投递一次有界退出（审查 LOW-2）。 */
  function handleCompositionEnd(ta: SourceTextareaLike, data: string): void {
    deps.parse.compositionEnd();
    try {
      endComposition(ta, data);
    } finally {
      const after = deps.ime.state();
      if (after.kind === 'settled') scheduleSettledExit(after.id);
    }
  }

  /**
   * 写入抛错（例如某个先于写回层的 store 订阅者抛错）时，授权可能未被消费：按 store 实际状态收束，避免停在 committing（审查 LOW-1）。
   * store 已是授权的结果 → 按授权结果消费；否则 → 中止为 rolled-back。随后整体对齐 DOM。
   */
  function settleAfterThrow(ta: SourceTextareaLike, token: number): void {
    const auth = deps.ime.authorization();
    if (auth === null || auth.token !== token) return;
    const { session } = deps.read();
    const applied = session.documentId === auth.documentId && session.sourceVersion === auth.authorizedVersion && viewOf(session) === auth.expectedView;
    if (applied) deps.ime.consumeCommit(token, settledFacts(ta));
    else deps.ime.abortCommit(token, settledFacts(ta));
    writeBack.reconcile({ force: true, rollback: true });
  }

  function endComposition(ta: SourceTextareaLike, data: string): void {
    const state = deps.ime.state();
    const base = deps.read();
    if (state.kind !== 'composing') {
      deps.ime.endWithoutCommit('rolled-back', base.session.documentId, settledFacts(ta));
      if (ta.value !== viewOf(base.session)) writeBack.reconcile({ force: true, rollback: true });
      return;
    }
    const expected = expectedViewAfter(state, data);
    const preconditions =
      base.session.documentId === state.documentId &&
      base.session.sourceVersion === state.versionAtStart &&
      viewOf(base.session) === state.viewAtStart &&
      ta.value === expected &&
      deps.editingEnabled() &&
      !writeBack.isBroken() &&
      !deps.controller.replacementPending();
    if (!preconditions) {
      deps.ime.endWithoutCommit('rolled-back', base.session.documentId, settledFacts(ta));
      rollback('ime-not-applied');
      return;
    }
    const text = normalizeNewlines(data);
    // 取消：没有组字结果且 DOM 已恢复原文。同文本替换（例如选中 b 再组字得到 b）不是取消，按无变化事务处理（Q7 折叠选区）。
    if (text === '' && expected === state.viewAtStart) {
      deps.ime.endWithoutCommit('canceled', base.session.documentId, settledFacts(ta));
      return;
    }
    const selection = sourceSelectionFromView(base.session, state.base);
    const step = selection === null ? null : applySourceInput(base, { viewPatch: { start: state.base.start, end: state.base.end, text }, selection, coalesce: null, label: 'ime' });
    if (step === null || !step.ok) {
      deps.ime.endWithoutCommit('rolled-back', base.session.documentId, settledFacts(ta));
      rollback(step === null ? 'input-rejected' : stepNotice(step.reason));
      return;
    }
    const version = base.session.sourceVersion;
    const token = deps.ime.beginCommit({
      documentId: base.session.documentId,
      authorizedVersion: step.changed ? version + 1 : version,
      expectedView: viewOf(step.core.session),
      outcome: step.changed ? 'committed' : 'unchanged',
      committedText: text,
    });
    if (token === null) return rollback('ime-not-applied');
    let written: StoreWriteResult;
    try {
      written = deps.apply(step.core, base);
    } catch (error) {
      settleAfterThrow(ta, token);
      throw error;
    }
    if (!written.ok) {
      // 写入被拒（CAS）。若同步段内的重入写入已使写回层把授权结束为 committed-unverified，此处更正为 rolled-back：本次提交并未进入 store。
      if (!deps.ime.abortCommit(token, settledFacts(ta))) deps.ime.endWithoutCommit('rolled-back', base.session.documentId, settledFacts(ta));
      rollback('ime-not-applied');
      return;
    }
    if (deps.ime.authorization()?.token === token) {
      deps.ime.consumeCommit(token, settledFacts(ta));
      writeBack.reconcile();
    }
    if (step.changed) deps.parse.sourceChanged();
  }

  function handleInput(ta: SourceTextareaLike): void {
    const ime = deps.ime.view();
    if (ime === 'composing' || ime === 'discarded') return;
    if (ta.value !== viewOf(deps.read().session)) rollback('input-reverted');
  }

  function handleKeyDown(event: unknown): void {
    const state = deps.ime.state();
    if (!keyIsComposing(event) && (state.kind === 'composing' || state.kind === 'discarded')) {
      deps.ime.stuckExit();
      // compositionend 不会再来：同时结束解析调度的组字暂停，否则之后的编辑永远不计时、flush 一律被忽略（审查 MEDIUM-1）。
      deps.parse.compositionEnd();
      writeBack.reconcile({ force: true, rollback: true });
      return;
    }
    if (state.kind === 'settled') deps.ime.exitSettled();
  }

  function handleBlur(): void {
    if (deps.ime.view() === 'composing' || deps.controller.replacementPending()) return;
    deps.parse.flush('blur');
  }

  function attach(ta: SourceTextareaLike): void {
    generation += 1;
    const gen = generation;
    element = ta;
    const live = (): boolean => gen === generation && element === ta;
    const guarded =
      (handler: (event: unknown) => void): Listener =>
      (event) => {
        if (!live()) return;
        eventSeq += 1;
        try {
          handler(event);
        } catch (error) {
          deps.report(error, 'source-editor-event');
        }
      };
    const listeners: [string, Listener][] = [
      [
        'beforeinput',
        guarded((event) => {
          const input = inputEventOf(event);
          if (input !== null) handleBeforeInput(ta, input);
        }),
      ],
      ['input', guarded(() => handleInput(ta))],
      ['compositionstart', guarded(() => handleCompositionStart(ta))],
      ['compositionend', guarded((event) => handleCompositionEnd(ta, compositionDataOf(event)))],
      ['keydown', guarded(handleKeyDown)],
      ['pointerdown', guarded(() => deps.ime.exitSettled())],
      ['keyup', guarded(() => selectionSync.sync())],
      ['pointerup', guarded(() => selectionSync.sync())],
      ['focus', guarded(() => selectionSync.sync())],
      ['blur', guarded(handleBlur)],
    ];
    const onSelectionChange = guarded(() => {
      if (ta.ownerDocument.activeElement === ta) selectionSync.sync();
    });
    for (const [type, listener] of listeners) ta.addEventListener(type, listener);
    ta.ownerDocument.addEventListener('selectionchange', onSelectionChange);
    detachListeners = () => {
      for (const [type, listener] of listeners) ta.removeEventListener(type, listener);
      ta.ownerDocument.removeEventListener('selectionchange', onSelectionChange);
    };
    writeBack.attach(ta);
  }

  function detach(): void {
    detachListeners?.();
    detachListeners = null;
    if (element === null) return;
    generation += 1;
    element = null;
    const ime = deps.ime.view();
    if (ime === 'composing' || ime === 'discarded') deps.parse.compositionEnd();
    deps.ime.discard('detach');
    selectionSync.invalidate();
    writeBack.detach();
  }

  return {
    bind: (next) => {
      if (next === element) return;
      detach();
      if (next !== null) attach(next);
    },
    generation: () => generation,
    writeBack: () => writeBack,
    selectionSync: () => selectionSync,
  };
}

/** 平台门控：启动后首次读取时计算并冻结（UA-CH 平台，回退 `navigator.platform`）。 */
let editingEnabledCache: boolean | null = null;

function platformHint(): string | null {
  const nav = globalThis.navigator;
  if (nav === undefined) return null;
  const data: unknown = Reflect.get(nav, 'userAgentData');
  const platform = isRecord(data) && typeof data.platform === 'string' && data.platform !== '' ? data.platform : null;
  return platform ?? (typeof nav.platform === 'string' ? nav.platform : null);
}

export function sourceEditingEnabled(): boolean {
  if (editingEnabledCache === null) editingEnabledCache = sourceEditingEnabledOn(sourceEditingPlatform(platformHint()));
  return editingEnabledCache;
}

const RECENT_DIAGNOSTICS_LIMIT = 50;
const recentDiagnostics: TrailingSuspect[] = [];

/** 最近的 `ime-trailing-suspect` 诊断（SP-IME-I 取证用，开发者工具中可读）。 */
export function recentImeDiagnostics(): readonly TrailingSuspect[] {
  return recentDiagnostics;
}

function postTask(task: () => void): void {
  const channel = new MessageChannel();
  channel.port1.onmessage = () => {
    channel.port1.close();
    task();
  };
  channel.port2.postMessage(0);
}

/** 产品使用的模块级绑定。 */
export const museSourceEditorBinding: SourceEditorBinding = createSourceEditorBinding({
  read: () => {
    const { session, history, selection } = useMuseAppStore.getState();
    return { session, history, selection };
  },
  apply: applyEditorStep,
  writeSelection: setEditorSelection,
  subscribe: (listener) => useMuseAppStore.subscribe(() => listener()),
  ime: museImeSession,
  controller: museEditorController,
  parse: museParseController,
  notify: (kind) => publishEditorView({ notice: { kind } }),
  clearNotice: (kind) => {
    if (useMuseAppStore.getState().editor.notice?.kind === kind) publishEditorView({ notice: null });
  },
  report: reportEditorError,
  diagnostic: (record) => {
    recentDiagnostics.push(record);
    if (recentDiagnostics.length > RECENT_DIAGNOSTICS_LIMIT) recentDiagnostics.shift();
    console.info('[muse] ime-trailing-suspect', record, { dirty: isSourceDirty(useMuseAppStore.getState().session) });
  },
  defer: (task) => {
    queueMicrotask(task);
  },
  post: postTask,
  editingEnabled: sourceEditingEnabled,
});

/** `SourceInspector` 的 ref 回调（模块级、按元素去重；StrictMode 的重复挂载只留一组监听）。 */
export function bindSourceEditor(element: SourceTextareaLike | null): void {
  museSourceEditorBinding.bind(element);
}
