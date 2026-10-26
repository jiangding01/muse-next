/**
 * M3 T1c-2：renderer store（`src/renderer/app/store.ts`；用户裁决 Q8）。
 *
 * - 正例：demo 初始化与每次 `commitSession` 后，`score / index / diagnostics` 都是 `session.parsed.load` 中的同一批对象；
 *   授权状态与文件引用一致（demo 恒为 none）。
 * - 反例：用另一次解析的结果写派生字段、快照属于别的文档或已过期时，一致性检查器报错。
 * - 降级只从 trusted 到 unverified；纯 UI 状态（zoom、Open 视图）与会话互不影响。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { createHistory } from '../../../src/editor/history/history';
import { isParseStale } from '../../../src/editor/session/derive';
import { acceptParsedSnapshot } from '../../../src/editor/session/reducer';
import { applySourceInput, changeSelection, redoStep, sourceSelectionFromView, undoStep } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import {
  applyEditorStep,
  commitSession,
  downgradeCapabilityTrust,
  publishEditorView,
  publishOpenView,
  publishParsedSession,
  setEditorSelection,
  storeConsistencyProblems,
  useMuseAppStore,
} from '../../../src/renderer/app/store';
import type { StoreWriteResult } from '../../../src/renderer/app/store';

function candidateSession(documentId = 5) {
  const result = prepareCandidate({
    documentId,
    source: 'X:1\nT:store\nK:G\nGABc|\n',
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: `cap-${String(documentId)}` }, displayName: 's.jcx', displayPath: '/s.jcx' },
  });
  if (!result.ok) throw new Error('prepare failed');
  return result.candidate.session;
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
  publishOpenView({ phase: 'idle', notice: null });
  useMuseAppStore.getState().setZoom(1);
});

describe('store —— demo 初始化', () => {
  it('初始状态：demo 会话、trust none、派生字段与解析快照同源', () => {
    const state = useMuseAppStore.getState();
    expect(state.session.documentId).toBe(0);
    expect(state.session.file).toBeNull();
    expect(state.capabilityTrust).toBe('none');
    expect(storeConsistencyProblems(state)).toEqual([]);
    expect(state.score).toBe(state.session.parsed?.load.score);
    expect(state.open).toEqual({ phase: 'idle', notice: null });
  });
});

describe('store —— commitSession', () => {
  it('一次 set 同时替换会话、授权与派生字段（订阅者只收到一次通知）', () => {
    const session = candidateSession();
    let notifications = 0;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      notifications += 1;
    });
    commitSession(session, 'trusted');
    unsubscribe();
    const state = useMuseAppStore.getState();
    expect(notifications).toBe(1);
    expect(state.session).toBe(session);
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.index).toBe(session.parsed?.load.index);
    expect(state.diagnostics).toBe(session.parsed?.load.diagnostics);
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('反例：派生字段来自另一次解析 / 快照属于别的文档 / 授权与文件不符时，一致性检查器报错', () => {
    const session = candidateSession();
    commitSession(session, 'trusted');
    const state = useMuseAppStore.getState();
    const other = loadJcx(session.source);
    expect(storeConsistencyProblems({ ...state, score: other.score })).toContain('score is not session.parsed.load.score');
    expect(storeConsistencyProblems({ ...state, index: other.index })).toContain('index is not session.parsed.load.index');
    expect(storeConsistencyProblems({ ...state, diagnostics: other.diagnostics })).toContain('diagnostics is not session.parsed.load.diagnostics');
    const parsed = session.parsed;
    if (parsed === null) throw new Error('no snapshot');
    expect(storeConsistencyProblems({ ...state, session: { ...session, parsed: { ...parsed, documentId: 99 } } })).toContain(
      'parsed snapshot belongs to another document',
    );
    // M3 T3a（用户裁决 Q1 / S2）：stale 是合法状态（编辑后谱面保留旧快照）；快照来自未来版本才是错误。
    expect(storeConsistencyProblems({ ...state, session: { ...session, parsed: { ...parsed, sourceVersion: session.sourceVersion + 1 } } })).toContain(
      'parsed snapshot is from a future version',
    );
    expect(storeConsistencyProblems({ ...state, capabilityTrust: 'none' })).toContain('capability trust does not match the file reference');
    expect(storeConsistencyProblems({ ...state, session: createDemoSession() })).toContain('score is not session.parsed.load.score');
  });
});

describe('store —— 授权降级与纯 UI 状态', () => {
  it('降级只从 trusted 到 unverified；demo 的 none 与已降级的状态不变', () => {
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    commitSession(candidateSession(), 'trusted');
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
    downgradeCapabilityTrust();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
  });

  it('降级与 Open 视图不改动会话与派生字段', () => {
    commitSession(candidateSession(), 'trusted');
    const before = useMuseAppStore.getState();
    downgradeCapabilityTrust();
    publishOpenView({ phase: 'activating', notice: { kind: 'busy' } });
    const after = useMuseAppStore.getState();
    expect([after.session, after.score, after.index, after.diagnostics]).toEqual([before.session, before.score, before.index, before.diagnostics]);
    expect(after.session).toBe(before.session);
  });

  it('zoom 与会话互不影响', () => {
    const session = useMuseAppStore.getState().session;
    useMuseAppStore.getState().setZoom(1.25);
    expect(useMuseAppStore.getState().session).toBe(session);
    commitSession(candidateSession(), 'trusted');
    expect(useMuseAppStore.getState().zoom).toBe(1.25);
  });
});

/** 当前 store 的核心三元组。 */
function currentCore(): EditorCore {
  const { session, history, selection } = useMuseAppStore.getState();
  return { session, history, selection };
}

/** 在 view 末尾插入一个字符，得到新的核心（不写入 store）。 */
/** 以当前 store 状态为基线输入一个字符并写入。 */
function typedOnCurrent(): StoreWriteResult {
  const base = currentCore();
  return applyEditorStep(typedAtEnd(base), base);
}

function typedAtEnd(core: EditorCore, text = 'z'): EditorCore {
  const end = core.session.projection.view.length;
  const selection = sourceSelectionFromView(core.session, { start: end, end });
  if (selection === null) throw new Error('selection');
  const step = applySourceInput(core, { viewPatch: { start: end, end, text }, selection, coalesce: null, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

describe('store —— T3a 原子写入与合法 stale（T3 Preflight r3 §4）', () => {
  it('编辑后 stale 合法：一次通知，版本 +1，快照与派生字段引用不变，一致性检查为空', () => {
    commitSession(candidateSession(), 'trusted');
    const before = useMuseAppStore.getState();
    let notifications = 0;
    let derivedChanges = 0;
    const unsubscribe = useMuseAppStore.subscribe((state, previous) => {
      notifications += 1;
      if (state.score !== previous.score || state.index !== previous.index || state.diagnostics !== previous.diagnostics) derivedChanges += 1;
    });
    expect(typedOnCurrent()).toEqual({ ok: true });
    unsubscribe();
    const after = useMuseAppStore.getState();
    expect(notifications).toBe(1);
    expect(derivedChanges).toBe(0);
    expect(after.session.sourceVersion).toBe(2);
    expect(after.session.parsed).toBe(before.session.parsed);
    expect(isParseStale(after.session)).toBe(true);
    expect(storeConsistencyProblems(after)).toEqual([]);
  });

  it('publishParsedSession：接受当前版本的快照后派生字段更新；跨文档、旧版本、快照版本不符一律拒绝且不写入', () => {
    commitSession(candidateSession(), 'trusted');
    const stale = useMuseAppStore.getState().session;
    typedOnCurrent();
    const edited = useMuseAppStore.getState().session;
    const accepted = acceptParsedSnapshot(edited, { documentId: edited.documentId, sourceVersion: edited.sourceVersion, load: loadJcx(edited.source) });
    if (!accepted.ok) throw new Error('accept');
    expect(publishParsedSession({ ...accepted.session, documentId: 77 })).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(publishParsedSession(stale)).toEqual({ ok: false, reason: 'session-changed' });
    const parsed = accepted.session.parsed;
    if (parsed === null) throw new Error('parsed');
    expect(publishParsedSession({ ...accepted.session, parsed: { ...parsed, sourceVersion: 1 } })).toEqual({ ok: false, reason: 'snapshot-not-current' });
    expect(useMuseAppStore.getState().session).toBe(edited);
    expect(publishParsedSession({ ...accepted.session, saved: { source: 'other' } })).toEqual({ ok: false, reason: 'session-changed' });
    let notifications = 0;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      notifications += 1;
    });
    expect(publishParsedSession(accepted.session)).toEqual({ ok: true });
    unsubscribe();
    expect(notifications).toBe(1);
    const state = useMuseAppStore.getState();
    expect(state.score).toBe(parsed.load.score);
    expect(isParseStale(state.session)).toBe(false);
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('applyEditorStep 拒绝：跨文档、版本回退、换快照、历史未绑定、选中不属于当前版本；被拒时 store 不变', () => {
    commitSession(candidateSession(), 'trusted');
    const base = currentCore();
    const next = typedAtEnd(base);
    const other = candidateSession(9);
    expect(applyEditorStep({ ...next, session: { ...next.session, documentId: 9 } }, base)).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(applyEditorStep({ ...next, session: { ...next.session, parsed: other.parsed } }, base)).toEqual({ ok: false, reason: 'snapshot-replaced' });
    expect(applyEditorStep({ ...next, history: createHistory(base.session) }, base)).toEqual({ ok: false, reason: 'history-unbound' });
    expect(applyEditorStep({ ...next, selection: { ...next.selection, basisVersion: 1 } }, base)).toEqual({ ok: false, reason: 'selection-not-current' });
    expect(useMuseAppStore.getState().session).toBe(base.session);
    expect(applyEditorStep(next, base)).toEqual({ ok: true });
    expect(applyEditorStep(base, next)).toEqual({ ok: false, reason: 'version-regressed' });
    expect(useMuseAppStore.getState().session).toBe(next.session);
  });

  it('applyEditorStep 只接受由当前会话一步得到的结果：同版本的另一份文本、版本跳跃都拒绝（r3a 审查 M-1）', () => {
    commitSession(candidateSession(), 'trusted');
    const base = currentCore();
    const first = typedAtEnd(base, 'z');
    const sibling = typedAtEnd(base, 'y');
    expect(applyEditorStep(first, base)).toEqual({ ok: true });
    expect(applyEditorStep(sibling, first)).toEqual({ ok: false, reason: 'not-derived-from-current' });
    const jump = typedAtEnd(typedAtEnd(first, 'a'), 'b');
    expect(applyEditorStep(jump, first)).toEqual({ ok: false, reason: 'not-derived-from-current' });
    expect(useMuseAppStore.getState().session).toBe(first.session);
  });

  it('applyEditorStep 是对编辑基线的 CAS：旧分支 Y 上再编辑得到的 v3 即使版本恰好 +1，也不能覆盖已提交的 X-v2（r3a 复核 M-1）', () => {
    commitSession(candidateSession(), 'trusted');
    const v1 = currentCore();
    const x2 = typedAtEnd(v1, 'x');
    const y2 = typedAtEnd(v1, 'y');
    expect(applyEditorStep(x2, v1)).toEqual({ ok: true });
    const y3 = typedAtEnd(y2, 'w');
    expect(y3.session.sourceVersion).toBe(x2.session.sourceVersion + 1);
    expect(applyEditorStep(y3, y2)).toEqual({ ok: false, reason: 'base-changed' });
    // 用已不是当前状态的 v1 作基线（会话、历史或选中任一不是当前对象）同样拒绝。
    expect(applyEditorStep(typedAtEnd(x2, 'q'), v1)).toEqual({ ok: false, reason: 'base-changed' });
    expect(applyEditorStep(typedAtEnd(x2, 'q'), { ...x2, history: v1.history })).toEqual({ ok: false, reason: 'base-changed' });
    expect(applyEditorStep(typedAtEnd(x2, 'q'), { ...x2, selection: v1.selection })).toEqual({ ok: false, reason: 'base-changed' });
    // 读取基线之后解析快照被发布（会话换了对象、历史与选中不变）：同样是基线已变，而不是等到「换快照」检查。
    const published = acceptParsedSnapshot(x2.session, { documentId: x2.session.documentId, sourceVersion: x2.session.sourceVersion, load: loadJcx(x2.session.source) });
    if (!published.ok) throw new Error('accept');
    expect(publishParsedSession(published.session)).toEqual({ ok: true });
    expect(applyEditorStep(typedAtEnd(x2, 'q'), x2)).toEqual({ ok: false, reason: 'base-changed' });
    const state = useMuseAppStore.getState();
    expect(state.session).toBe(published.session);
    expect(state.session.source.endsWith('x')).toBe(true);
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('CAS 正例：正常输入、undo、redo、无变化事务以当前状态为基线都被接受；仅选区更新照常', () => {
    commitSession(candidateSession(), 'trusted');
    expect(typedOnCurrent()).toEqual({ ok: true });
    const edited = currentCore();
    const undone = undoStep(edited);
    if (!undone.ok) throw new Error(undone.reason);
    expect(applyEditorStep(undone.core, edited)).toEqual({ ok: true });
    const afterUndo = currentCore();
    const redone = redoStep(afterUndo);
    if (!redone.ok) throw new Error(redone.reason);
    expect(applyEditorStep(redone.core, afterUndo)).toEqual({ ok: true });
    const afterRedo = currentCore();
    const caret = sourceSelectionFromView(afterRedo.session, { start: 0, end: 0 });
    if (caret === null) throw new Error('selection');
    const noop = applySourceInput(afterRedo, { viewPatch: { start: 0, end: 0, text: '' }, selection: caret, coalesce: null, label: 'type' });
    if (!noop.ok) throw new Error(noop.reason);
    expect(noop.core.session).toBe(afterRedo.session);
    expect(applyEditorStep(noop.core, afterRedo)).toEqual({ ok: true });
    const selectionBase = currentCore();
    const moved = changeSelection(selectionBase, caret);
    if (!moved.ok) throw new Error(moved.reason);
    expect(setEditorSelection(moved.core, selectionBase)).toEqual({ ok: true });
    const state = useMuseAppStore.getState();
    expect(state.session.sourceVersion).toBe(4);
    expect(state.selection).toBe(moved.core.selection);
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('setEditorSelection：只换选中与历史；会话不是当前对象时拒绝', () => {
    commitSession(candidateSession(), 'trusted');
    const core = currentCore();
    const selection = sourceSelectionFromView(core.session, { start: 0, end: 1 });
    if (selection === null) throw new Error('selection');
    const changed = changeSelection(core, selection);
    if (!changed.ok) throw new Error(changed.reason);
    expect(setEditorSelection({ ...changed.core, session: { ...core.session } }, core)).toEqual({ ok: false, reason: 'session-changed' });
    let notifications = 0;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      notifications += 1;
    });
    expect(setEditorSelection(changed.core, core)).toEqual({ ok: true });
    unsubscribe();
    expect(notifications).toBe(1);
    expect(useMuseAppStore.getState().selection).toBe(selection);
    expect(useMuseAppStore.getState().session).toBe(core.session);
  });

  it('setEditorSelection 是对选区基线的三对象 CAS（M3 T3c，Q-C1(a)）：基线被取代时拒绝，旧选区不覆盖较新的状态', () => {
    commitSession(candidateSession(), 'trusted');
    const base = currentCore();
    const first = sourceSelectionFromView(base.session, { start: 0, end: 1 });
    const second = sourceSelectionFromView(base.session, { start: 2, end: 3 });
    if (first === null || second === null) throw new Error('selection');
    const older = changeSelection(base, first);
    const newer = changeSelection(base, second);
    if (!older.ok || !newer.ok) throw new Error('change');
    // 较新的选区先写入：以同一基线计算的旧结果随后被拒绝。
    expect(setEditorSelection(newer.core, base)).toEqual({ ok: true });
    expect(setEditorSelection(older.core, base)).toEqual({ ok: false, reason: 'base-changed' });
    expect(useMuseAppStore.getState().selection).toBe(second);
    // 基线中任一对象不是当前对象都算基线已变（历史 / 选中）。
    const now = currentCore();
    const again = changeSelection(now, first);
    if (!again.ok) throw new Error('change');
    expect(setEditorSelection(again.core, { ...now, history: { ...now.history } })).toEqual({ ok: false, reason: 'base-changed' });
    expect(setEditorSelection(again.core, { ...now, selection: base.selection })).toEqual({ ok: false, reason: 'base-changed' });
    // 读取基线后解析快照被发布（会话换了对象、版本不变）：拒绝，由调用方以新鲜状态重算。
    const published = acceptParsedSnapshot(now.session, { documentId: now.session.documentId, sourceVersion: now.session.sourceVersion, load: loadJcx(now.session.source) });
    if (!published.ok) throw new Error('accept');
    expect(publishParsedSession(published.session)).toEqual({ ok: true });
    expect(setEditorSelection(again.core, now)).toEqual({ ok: false, reason: 'base-changed' });
    const fresh = currentCore();
    const recomputed = changeSelection(fresh, sourceSelectionFromView(fresh.session, { start: 0, end: 1 }) ?? first);
    if (!recomputed.ok) throw new Error('change');
    expect(setEditorSelection(recomputed.core, fresh)).toEqual({ ok: true });
    expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
  });

  it('commitSession 重置历史、选中与编辑视图；publishEditorView 不触碰会话', () => {
    commitSession(candidateSession(), 'trusted');
    typedOnCurrent();
    publishEditorView({ notice: { kind: 'reparsed' } });
    const session = useMuseAppStore.getState().session;
    publishEditorView({ composing: true });
    expect(useMuseAppStore.getState().editor).toEqual({ composing: true, notice: { kind: 'reparsed' } });
    expect(useMuseAppStore.getState().session).toBe(session);
    commitSession(candidateSession(6), 'trusted');
    const state = useMuseAppStore.getState();
    expect(state.history.undo).toBeNull();
    expect(state.selection.kind).toBe('none');
    expect(state.editor).toEqual({ composing: false, notice: null });
    expect(storeConsistencyProblems(state)).toEqual([]);
  });

  it('一致性规则反例：历史属于别的文档 / 与会话失去同步 / 合并组矛盾 / 选中不属于当前版本 / 越界 / T3 不允许的 kind / 投影不是当前 source', () => {
    commitSession(candidateSession(), 'trusted');
    const state = useMuseAppStore.getState();
    const { history, selection, session } = state;
    expect(storeConsistencyProblems({ ...state, session: { ...session, parsed: null } })).toEqual(['session has no parsed snapshot']);
    expect(storeConsistencyProblems({ ...state, history: { ...history, documentId: 99 } })).toContain('history belongs to another document');
    expect(storeConsistencyProblems({ ...state, history: { ...history, headVersion: 5 } })).toContain('history is out of sync with the session');
    const open = { kind: 'insert' as const, lastTimestamp: 0, anchor: 0 };
    expect(storeConsistencyProblems({ ...state, history: { ...history, open } })).toContain('history coalescing group is inconsistent');
    expect(storeConsistencyProblems({ ...state, selection: { ...selection, basisVersion: 3 } })).toContain('selection is not on the current version');
    const far = { start: 0, end: session.source.length + 1 };
    expect(storeConsistencyProblems({ ...state, selection: { ...selection, kind: 'source', ranges: [far] } })).toContain('selection is out of range');
    expect(storeConsistencyProblems({ ...state, selection: { ...selection, kind: 'note' } })).toContain('selection kind is not allowed in T3');
    expect(storeConsistencyProblems({ ...state, session: { ...session, projection: { ...session.projection, source: `${session.source} ` } } })).toContain(
      'projection is not built from the session source',
    );
  });
});
