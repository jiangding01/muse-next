/**
 * M3 T4 B3a-1：Open 接入共享准入租约与 R20 账本——真实 main（`registerOpenIpc`）+ 真实 Open 控制器 + 真实 store。
 *
 * - 追加硬门 2：Open 的租约从送达门开始持续到事务所有终态效果处理完成（提交、取消、异常），迟到回调不触碰之后的持有者；
 * - L-1 / L-6：租约被占用（保存主链路尚不存在，用独立替身直接持有租约）时 Open 同步拒绝、不弹对话框；
 * - T-H7-7 / T-H7-8（Open 部分，端到端）：激活应答丢失 + reject 丢失 → main committed 停在新候选；下一次 Open 被送达门拦下
 *   （不弹对话框）；reject 送达后 main 回退锚点（A2），Open 恢复。账本 `{ ok: true }` 只表示 main 已处理，不代表锚点收敛。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import { createOpenAdmission } from '../../../src/renderer/app/editor/openEntry';
import type { EditorNotice } from '../../../src/renderer/app/editor/editorTransitions';
import { createRejectLedger } from '../../../src/renderer/app/save/rejectLedger';
import { isFileOperationBusy } from '../../../src/editor/session/derive';
import { beginFileOperation, commitSession, finishFileOperation, publishOpenView, useMuseAppStore } from '../../../src/renderer/app/store';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { createHarness, mainFrameEvent, REJECT } from '../main/openIpcHarness';
import { commitDocument, openPath, resetRendererStore, rig, settle } from './openProtocolRig';

function world(options: { readonly reported?: string[]; readonly setReplacementPending?: (pending: boolean) => void } = {}) {
  const h = createHarness();
  const { sender } = h.window(1);
  const gate = createFileIntentGate();
  const rejects = { lost: false, sent: 0 };
  const ledgerTimers: { task: () => void; cancelled: boolean }[] = [];
  const ledger = createRejectLedger({
    reject: (ticket) => {
      rejects.sent += 1;
      return rejects.lost ? new Promise(() => undefined) : h.invoke(REJECT, mainFrameEvent(sender), ticket);
    },
    schedule: (_delay, task) => {
      const timer = { task, cancelled: false };
      ledgerTimers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const notices: string[] = [];
  const admission = createOpenAdmission({
    gate,
    ledger,
    document: () => {
      const { session } = useMuseAppStore.getState();
      return { documentId: session.documentId, fileBusy: isFileOperationBusy(session) };
    },
  });
  const r = rig({
    h,
    deps: {
      ledger,
      admission,
      ...(options.reported === undefined ? {} : { report: (error: unknown) => options.reported?.push(error instanceof Error ? error.message : String(error)) }),
      editor: {
        gate: () => ({ dirty: false, composing: false }),
        beforeCommit: () => undefined,
        setReplacementPending: options.setReplacementPending ?? (() => undefined),
        notify: (notice: EditorNotice) => notices.push(notice.kind),
      },
    },
  });
  const expireLedgerAttempts = (): void => {
    for (const timer of ledgerTimers) if (!timer.cancelled) timer.task();
  };
  const committed = (): unknown => h.handle.currentState().owners.get(1)?.committed;
  return { h, r, gate, ledger, rejects, notices, expireLedgerAttempts, committed };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  resetRendererStore();
  expect(unhandled).toEqual([]);
});

describe('Open × 准入租约：持续到事务的全部终态效果之后（追加硬门 2）', () => {
  it('提交：requesting / activating 期间持有 open 租约，提交完成回到 idle 后释放', async () => {
    const w = world();
    w.r.controller.open();
    expect(w.gate.current()).toMatchObject({ kind: 'open' });
    await settle();
    w.r.resolveNextDialog('/docs/a.jcx');
    await settle();
    expect(w.r.commits()).toBe(1);
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.gate.current()).toBeNull();
  });

  it('取消：对话框取消回到 idle 后释放；失败（解码失败）同样释放', async () => {
    const w = world();
    await openPath(w.r, '/docs/missing.jcx');
    expect(w.gate.current()).toBeNull();
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog(null);
    await settle();
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.gate.current()).toBeNull();
  });

  it('终态效果（提交写入、失败提示）执行期间仍持有 open 租约，效果全部执行完才释放', async () => {
    const h = createHarness();
    h.window(1);
    const gate = createFileIntentGate();
    const ledger = createRejectLedger({ reject: () => Promise.resolve({ ok: true }) });
    const admission = createOpenAdmission({ gate, ledger, document: () => ({ documentId: useMuseAppStore.getState().session.documentId, fileBusy: false }) });
    const during: string[] = [];
    const r = rig({
      h,
      deps: {
        ledger,
        admission,
        commit: (session, trust) => {
          during.push(`commit:${gate.current()?.kind ?? 'none'}`);
          commitSession(session, trust);
        },
        publish: (view) => {
          if (view.phase === 'idle') during.push(`idle-view:${gate.current()?.kind ?? 'none'}`);
          publishOpenView(view);
        },
      },
    });
    await openPath(r, '/docs/a.jcx');
    await openPath(r, '/docs/missing.jcx');
    // 提交写入时租约仍在；回到 idle 的视图发布时租约已释放（视图说 idle 时新的 Open 可以立即获取）。
    expect(during).toEqual(['commit:open', 'idle-view:none', 'idle-view:none']);
  });

  it('异常：提交写入 store 抛错（commit-failed）→ fail closed 终态之后释放', async () => {
    const h = createHarness();
    h.window(1);
    const gate = createFileIntentGate();
    const ledger = createRejectLedger({ reject: () => Promise.resolve({ ok: true }) });
    const admission = createOpenAdmission({ gate, ledger, document: () => ({ documentId: useMuseAppStore.getState().session.documentId, fileBusy: false }) });
    const r = rig({
      h,
      deps: {
        ledger,
        admission,
        report: () => undefined,
        commit: () => {
          throw new Error('store write failed');
        },
      },
    });
    await openPath(r, '/docs/a.jcx');
    expect(r.controller.state().phase).toBe('idle');
    expect(gate.current()).toBeNull();
  });

  it('迟到回调：Open 不确定并释放租约后，另一项操作持有租约；旧激活应答迟到不提交、不释放它的租约', async () => {
    const w = world();
    await commitDocument(w.r, '/docs/a.jcx');
    w.r.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog('/docs/b.jcx');
    await settle();
    const base = w.r.timers.length - 1; // 本次 Open 的第一个激活定时器（之前 commitDocument 的定时器已取消）
    for (let i = 0; i < 3; i += 1) {
      // L-6：激活重试中（activating / uncertain）租约仍由 Open 持有，另一项文件操作获取失败。
      expect(['activating', 'uncertain']).toContain(w.r.controller.state().phase);
      expect(w.gate.current()).toMatchObject({ kind: 'open' });
      expect(w.gate.tryAcquire('save', useMuseAppStore.getState().session.documentId)).toBeNull();
      w.r.fire(base + i);
      await settle();
    }
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.gate.current()).toBeNull();
    const standIn = w.gate.tryAcquire('save', useMuseAppStore.getState().session.documentId);
    const commitsBefore = w.r.commits();
    for (const call of w.r.callsOf('activate')) if (call.processed()) call.release();
    await settle();
    expect(w.r.commits()).toBe(commitsBefore);
    expect(w.gate.current()).toBe(standIn);
  });
});

describe('Open × 终态清理替换标志抛错不泄漏租约（B3a-1 STOP 裁决 §2）', () => {
  /**
   * 每次清除替换标志（false）都抛错：fail-closed 收束的再次派发同样清理失败，因此租约只能靠终态 finally 释放
   * （只抛一次时，收束派发的第二次清理会成功，测不出泄漏）。
   */
  function alwaysThrowing(): { readonly setReplacementPending: (pending: boolean) => void; readonly thrown: () => number } {
    let thrown = 0;
    return {
      setReplacementPending: (pending) => {
        if (!pending) {
          thrown += 1;
          throw new Error('replacement flag cleanup failed');
        }
      },
      thrown: () => thrown,
    };
  }

  it('取消之后清理抛错：租约仍释放；后续 Open 重新获得租约并正常提交', async () => {
    const reported: string[] = [];
    const flag = alwaysThrowing();
    const w = world({ reported, setReplacementPending: flag.setReplacementPending });
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog(null);
    await settle();
    expect(flag.thrown()).toBeGreaterThan(0);
    expect(reported).toContain('replacement flag cleanup failed');
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.gate.current()).toBeNull();
    // 清理仍然失败（标志未恢复）：后续 Open 照常获取租约、提交，终态之后再次释放。
    w.r.controller.open();
    expect(w.gate.current()).toMatchObject({ kind: 'open' });
    await settle();
    w.r.resolveNextDialog('/docs/a.jcx');
    await settle();
    expect(w.r.commits()).toBe(1);
    expect(w.gate.current()).toBeNull();
  });

  it('激活失败（三次应答丢失）之后清理抛错：租约仍释放，候选照常被 reject；后续 Open 重新获得租约', async () => {
    const reported: string[] = [];
    const flag = alwaysThrowing();
    const w = world({ reported, setReplacementPending: flag.setReplacementPending });
    w.r.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog('/docs/b.jcx');
    await settle();
    const base = w.r.timers.length - 1;
    for (let i = 0; i < 3; i += 1) {
      w.r.fire(base + i);
      await settle();
    }
    expect(flag.thrown()).toBeGreaterThan(0);
    expect(reported).toContain('replacement flag cleanup failed');
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.gate.current()).toBeNull();
    expect(w.rejects.sent).toBe(1);
    expect(w.ledger.pending()).toBe(0);
    w.r.controller.open();
    expect(w.gate.current()).toMatchObject({ kind: 'open' });
    await settle();
    w.r.resolveNextDialog(null);
    await settle();
    expect(w.gate.current()).toBeNull();
  });
});

describe('Open × 每个 await 恢复之后复核租约与文档号（勘误 §1.3）', () => {
  it('对话框期间租约被替换（注入）→ open 应答恢复后 fail closed：不激活、不提交，pending 候选被撤回，不释放别人的租约', async () => {
    const reported: string[] = [];
    const w = world({ reported });
    w.r.controller.open();
    const mine = w.gate.current();
    if (mine === null) throw new Error('no lease');
    await settle();
    w.gate.release(mine);
    const intruder = w.gate.tryAcquire('save', useMuseAppStore.getState().session.documentId);
    const before = useMuseAppStore.getState().session;
    w.r.resolveNextDialog('/docs/a.jcx');
    await settle();
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.r.callsOf('activate')).toHaveLength(0);
    expect(w.r.commits()).toBe(0);
    expect(useMuseAppStore.getState().session).toBe(before);
    expect(w.ledger.pending()).toBe(0); // 已撤回 main 中 pending 的候选（reject 已送达）
    expect(w.h.handle.currentState().owners.get(1)?.candidates.size ?? 0).toBe(0);
    expect(w.gate.current()).toBe(intruder);
    expect(reported).toEqual(['file intent lease lost']);
  });

  it('激活等待期间文档被替换（注入）→ 激活应答恢复后 fail closed：不提交，reject 候选并降级', async () => {
    const reported: string[] = [];
    const w = world({ reported });
    await commitDocument(w.r, '/docs/a.jcx');
    w.r.policies.activate.push('hold-reply');
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog('/docs/b.jcx');
    await settle();
    const commitsBefore = w.r.commits();
    commitSession(createDemoSession(), 'none'); // 注入：会话被替换（documentId 改变）
    const replaced = useMuseAppStore.getState().session;
    w.r.callsOf('activate').at(-1)?.release();
    await settle();
    expect(w.r.controller.state().phase).toBe('idle');
    expect(w.r.commits()).toBe(commitsBefore);
    expect(useMuseAppStore.getState().session).toBe(replaced);
    expect(w.rejects.sent).toBeGreaterThan(0);
    expect(w.ledger.pending()).toBe(0);
    expect(w.gate.current()).toBeNull();
    expect(reported).toEqual(['file intent lease lost']);
    expect(w.notices).toEqual([]);
    expect(w.r.controller.state().notice).toEqual({ kind: 'activation-unresolved' });
  });
});

describe('Open × 准入租约：被占用时同步拒绝（L-1 / L-6）', () => {
  it('另一项文件操作（独立替身）持有租约 → open-refused-busy，不弹对话框；释放之后 Open 正常', async () => {
    const w = world();
    const standIn = w.gate.tryAcquire('save', useMuseAppStore.getState().session.documentId);
    if (standIn === null) throw new Error('acquire failed');
    const dialogs = w.h.dialogParents.length;
    w.r.controller.open();
    await settle();
    expect(w.notices).toEqual(['open-refused-busy']);
    expect(w.h.dialogParents.length).toBe(dialogs);
    w.gate.release(standIn);
    await openPath(w.r, '/docs/a.jcx');
    expect(w.r.commits()).toBe(1);
  });

  it('会话上有进行中的文件操作（store fileOp）→ open-refused-busy，不获取租约', async () => {
    const w = world();
    const begun = beginFileOperation('save');
    if (!begun.ok) throw new Error(begun.reason);
    w.r.controller.open();
    expect(w.notices).toEqual(['open-refused-busy']);
    expect(w.gate.current()).toBeNull();
    finishFileOperation(begun.documentId, begun.op, false);
  });
});

describe('Open × R20 送达门（T-H7-7 / T-H7-8，Open 部分）', () => {
  it('激活应答丢失 + reject 丢失：下一次 Open 被拦下（不弹对话框）；reject 送达后锚点回退，Open 恢复', async () => {
    const w = world();
    const x = await commitDocument(w.r, '/docs/a.jcx');
    // 打开 Y：三次激活应答都被扣留（main 已激活 Y），事务不确定 → 尽力 reject Y——这张 reject 也丢失。
    w.rejects.lost = true;
    w.r.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    w.r.controller.open();
    await settle();
    w.r.resolveNextDialog('/docs/b.jcx');
    await settle();
    const base = w.r.timers.length - 1; // 本次 Open 的第一个激活定时器（之前 commitDocument 的定时器已取消）
    for (let i = 0; i < 3; i += 1) {
      w.r.fire(base + i);
      await settle();
    }
    const y = w.r.callsOf('activate').at(-1)?.payload as { capabilityId: string }; // 本次 Open（Y）的激活
    expect(w.committed()).toEqual({ kind: 'record', token: y.capabilityId });
    expect(w.ledger.pending()).toBe(1);
    // T-H7-8：送达门拒绝新的文件操作，不进入对话框。
    w.expireLedgerAttempts();
    await settle();
    const dialogs = w.h.dialogParents.length;
    w.r.controller.open();
    await settle();
    w.expireLedgerAttempts();
    await settle();
    expect(w.notices).toContain('open-refused-reject-pending');
    expect(w.h.dialogParents.length).toBe(dialogs);
    expect(w.gate.current()).toBeNull();
    expect(w.committed()).toEqual({ kind: 'record', token: y.capabilityId });
    // 恢复：reject 送达 → main A2 回退到 X（墓碑）；账本清空；Open 进入对话框。
    w.rejects.lost = false;
    w.r.controller.open();
    await settle();
    expect(w.committed()).toEqual({ kind: 'record', token: x });
    expect(w.ledger.pending()).toBe(0);
    expect(w.h.dialogParents.length).toBe(dialogs + 1);
    w.r.resolveNextDialog(null);
    await settle();
    expect(w.gate.current()).toBeNull();
  });
});
