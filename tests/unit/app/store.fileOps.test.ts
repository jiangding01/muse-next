/**
 * M3 T4 B3a-1：store 的文件操作检查点写入（`beginFileOperation` / `settleSave` / `settleSaveAs` / `finishFileOperation`）。
 *
 * 全部以 store 当前会话为底、按 documentId 与 op 对象引用 CAS；只写会话（begin 另结束合并组；Save As 成功与失败收尾另写授权）；
 * 每步之后一致性检查为空（含 `file === null ⇔ none`）。性质测试：任意交错下检查点只取成功接受的捕获值。
 * 真正的保存主链路尚不存在（B3a-2），这里直接驱动写入函数作为它的测试替身。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isSourceDirty } from '../../../src/editor/session/derive';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import {
  applyEditorStep,
  beginFileOperation,
  commitSession,
  finishFileOperation,
  settleSave,
  settleSaveAs,
  storeConsistencyProblems,
  useMuseAppStore,
} from '../../../src/renderer/app/store';
import { createPrng } from '../editor/prng';

const FACTS = {
  file: { capability: { id: 'cap-new' }, displayName: 'new.jcx', displayPath: '/new.jcx' },
  writeEncoding: 'utf-8',
  byteBom: 'none',
  encodingRoundTrip: 'exact',
} as const;

function fileSession(documentId = 5) {
  const result = prepareCandidate({
    documentId,
    source: 'X:1\nT:save\nK:G\nGABc|\n',
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: `cap-${String(documentId)}` }, displayName: 's.jcx', displayPath: '/s.jcx' },
  });
  if (!result.ok) throw new Error('prepare failed');
  return result.candidate.session;
}

function type(text = 'z'): void {
  const { session, history, selection } = useMuseAppStore.getState();
  const base: EditorCore = { session, history, selection };
  const end = session.projection.view.length;
  const caret = sourceSelectionFromView(session, { start: end, end });
  if (caret === null) throw new Error('selection');
  const step = applySourceInput(base, { viewPatch: { start: end, end, text }, selection: caret, coalesce: { kind: 'insert', timestamp: 1_000 }, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  const written = applyEditorStep(step.core, base);
  if (!written.ok) throw new Error(written.reason);
}

const consistent = (): void => {
  expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
};

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('store —— 文件操作检查点', () => {
  it('begin：捕获当前 source，fileOp 为新建对象，同一次 set 结束历史合并组；已有操作 → file-op-busy', () => {
    commitSession(fileSession(), 'trusted');
    type();
    expect(useMuseAppStore.getState().history.open).not.toBeNull();
    let notifications = 0;
    const unsubscribe = useMuseAppStore.subscribe(() => {
      notifications += 1;
    });
    const begun = beginFileOperation('save');
    unsubscribe();
    if (!begun.ok) throw new Error(begun.reason);
    const state = useMuseAppStore.getState();
    expect(notifications).toBe(1);
    expect(state.session.fileOp).toBe(begun.op);
    expect(begun.capturedSource).toBe(state.session.source);
    expect(state.history.open).toBeNull();
    expect(beginFileOperation('saveAs')).toEqual({ ok: false, reason: 'file-op-busy' });
    consistent();
  });

  it('settleSave：检查点前移到捕获值；保存期间继续输入仍 dirty（M18）', () => {
    commitSession(fileSession(), 'trusted');
    type('a');
    const begun = beginFileOperation('save');
    if (!begun.ok) throw new Error(begun.reason);
    type('b');
    expect(settleSave(begun.documentId, begun.op, begun.capturedSource)).toEqual({ ok: true });
    const { session } = useMuseAppStore.getState();
    expect(session.saved.source).toBe(begun.capturedSource);
    expect(session.fileOp).toBeNull();
    expect(isSourceDirty(session)).toBe(true);
    consistent();
  });

  it('settleSaveAs（demo）：文件事实、检查点与 trusted 同次写入；一致性成立', () => {
    commitSession(createDemoSession(), 'none');
    type();
    const begun = beginFileOperation('saveAs');
    if (!begun.ok) throw new Error(begun.reason);
    expect(settleSaveAs(begun.documentId, begun.op, begun.capturedSource, FACTS)).toEqual({ ok: true });
    const state = useMuseAppStore.getState();
    expect(state.session.file).toEqual(FACTS.file);
    expect(state.capabilityTrust).toBe('trusted');
    expect(isSourceDirty(state.session)).toBe(false);
    consistent();
  });

  it('finishFileOperation：只清 fileOp，检查点不前移；downgrade 只把 trusted 降为 unverified，demo 保持 none（H-5）', () => {
    commitSession(fileSession(), 'trusted');
    type();
    const begun = beginFileOperation('saveAs');
    if (!begun.ok) throw new Error(begun.reason);
    expect(finishFileOperation(begun.documentId, begun.op, true)).toEqual({ ok: true });
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
    expect(isSourceDirty(useMuseAppStore.getState().session)).toBe(true);
    consistent();
    commitSession(createDemoSession(), 'none');
    const demo = beginFileOperation('saveAs');
    if (!demo.ok) throw new Error(demo.reason);
    expect(finishFileOperation(demo.documentId, demo.op, true)).toEqual({ ok: true });
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    consistent();
  });

  it('CAS：旧操作 / 结构相同的伪造 op / 文档已替换 / 种类不符都被拒，且零写入', () => {
    commitSession(fileSession(), 'trusted');
    const first = beginFileOperation('save');
    if (!first.ok) throw new Error(first.reason);
    expect(finishFileOperation(first.documentId, first.op, false)).toEqual({ ok: true });
    const second = beginFileOperation('save');
    if (!second.ok) throw new Error(second.reason);
    const before = useMuseAppStore.getState();
    expect(settleSave(first.documentId, first.op, first.capturedSource)).toEqual({ ok: false, reason: 'not-current-operation' });
    expect(settleSave(second.documentId, { kind: 'save' }, second.capturedSource)).toEqual({ ok: false, reason: 'not-current-operation' });
    expect(settleSaveAs(second.documentId, second.op, second.capturedSource, FACTS)).toEqual({ ok: false, reason: 'kind-mismatch' });
    expect(finishFileOperation(second.documentId + 1, second.op, true)).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(useMuseAppStore.getState()).toBe(before);
    commitSession(fileSession(6), 'trusted');
    expect(settleSave(second.documentId, second.op, second.capturedSource)).toEqual({ ok: false, reason: 'document-mismatch' });
  });
});

describe('store —— 性质：任意交错下检查点只取成功接受的捕获值', () => {
  it('随机的输入 / 开始 / 成功 / 失败 / 迟到结果序列', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const prng = createPrng(seed);
      commitSession(fileSession(), 'trusted');
      let expectedSaved = useMuseAppStore.getState().session.saved.source;
      let current: { op: object; documentId: number; capturedSource: string } | null = null;
      const stale: { op: object; documentId: number; capturedSource: string }[] = [];
      for (let step = 0; step < 30; step += 1) {
        const where = `seed ${String(seed)}, step ${String(step)}`;
        const action = prng.int(5);
        if (action === 0) type(prng.pick(['a', 'b']));
        else if (action === 1 && current === null) {
          const begun = beginFileOperation('save');
          if (!begun.ok) throw new Error(begun.reason);
          current = begun;
        } else if (action === 2 && current !== null) {
          expect(settleSave(current.documentId, current.op as never, current.capturedSource).ok, where).toBe(true);
          expectedSaved = current.capturedSource;
          stale.push(current);
          current = null;
        } else if (action === 3 && current !== null) {
          expect(finishFileOperation(current.documentId, current.op as never, prng.int(2) === 0).ok, where).toBe(true);
          stale.push(current);
          current = null;
        } else if (action === 4 && stale.length > 0) {
          const late = prng.pick(stale);
          expect(settleSave(late.documentId, late.op as never, 'LATE').ok, where).toBe(false);
        }
        const { session } = useMuseAppStore.getState();
        expect(session.saved.source, where).toBe(expectedSaved);
        expect(session.fileOp, where).toBe(current?.op ?? null);
        expect(storeConsistencyProblems(useMuseAppStore.getState()), where).toEqual([]);
      }
    }
  });
});
