/**
 * M3 T4 B3 收口（P0 §10.3 第 210 行，G1）：dirty 文档的 Open 经守卫询问后取消——真实 main（`registerOpenIpc`）+ 真实 Open 控制器
 * + 真实 store。断言 intent 结束、当前文档、授权（能力）与 History 都不变：会话、历史、选中与 capabilityTrust 的对象引用均未变，
 * main 的 committed 锚点不变，没有发出 reject，准入租约已释放。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { isSourceDirty } from '../../../src/editor/session/derive';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createOpenAdmission } from '../../../src/renderer/app/editor/openEntry';
import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import type { GuardOutcome } from '../../../src/renderer/app/guard/guardController';
import { createRejectLedger } from '../../../src/renderer/app/save/rejectLedger';
import { applyEditorStep, useMuseAppStore } from '../../../src/renderer/app/store';
import { createHarness, mainFrameEvent, REJECT } from '../main/openIpcHarness';
import { commitDocument, resetRendererStore, rig, settle } from './openProtocolRig';

function type(text: string): void {
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

afterEach(() => {
  resetRendererStore();
});

describe('Open × 替换守卫取消（P0 §10.3 第 210 行，G1）', () => {
  it('dirty → 询问 → 取消：会话 / History / 选中 / 授权对象都不变，main 锚点不变，没有 reject，租约释放', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const gate = createFileIntentGate();
    let rejects = 0;
    const ledger = createRejectLedger({
      reject: (ticket) => {
        rejects += 1;
        return h.invoke(REJECT, mainFrameEvent(sender), ticket);
      },
    });
    const admission = createOpenAdmission({
      gate,
      ledger,
      document: () => ({ documentId: useMuseAppStore.getState().session.documentId, fileBusy: useMuseAppStore.getState().session.fileOp !== null }),
    });
    const asks: ((outcome: GuardOutcome) => void)[] = [];
    let next = 0;
    const r = rig({
      h,
      deps: {
        ledger,
        admission,
        version: () => ({ documentId: useMuseAppStore.getState().session.documentId, sourceVersion: useMuseAppStore.getState().session.sourceVersion }),
        guard: {
          hasHost: () => true,
          ask: () => {
            next += 1;
            let resolve: (outcome: GuardOutcome) => void = () => undefined;
            const outcome = new Promise<GuardOutcome>((res) => {
              resolve = res;
            });
            asks.push(resolve);
            return { intentId: next, outcome };
          },
        },
        editor: {
          gate: () => ({ dirty: isSourceDirty(useMuseAppStore.getState().session), composing: false }),
          beforeCommit: () => undefined,
          setReplacementPending: () => undefined,
          notify: () => undefined,
        },
      },
    });
    await commitDocument(r, '/docs/a.jcx');
    type('q');
    const before = useMuseAppStore.getState();
    expect(isSourceDirty(before.session)).toBe(true);
    expect(before.history.undo !== null || before.history.open !== null).toBe(true); // 有可撤销的历史
    const committedBefore = h.handle.currentState().owners.get(1)?.committed;
    const dialogs = h.dialogParents.length;
    r.controller.open();
    expect(asks).toHaveLength(1);
    expect(gate.current()).toMatchObject({ kind: 'open' });
    asks[0]?.({ aborted: 'canceled' });
    await settle();
    const after = useMuseAppStore.getState();
    expect(after.session).toBe(before.session);
    expect(after.history).toBe(before.history);
    expect(after.selection).toBe(before.selection);
    expect(after.capabilityTrust).toBe(before.capabilityTrust);
    expect(h.handle.currentState().owners.get(1)?.committed).toEqual(committedBefore);
    expect(h.dialogParents.length).toBe(dialogs);
    expect(rejects).toBe(0);
    expect(gate.current()).toBeNull();
    expect(r.controller.state().phase).toBe('idle');
  });
});
