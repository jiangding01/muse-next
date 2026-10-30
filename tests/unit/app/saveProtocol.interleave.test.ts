/**
 * M3 T4 B3a-2：保存协议级交错测试——真实 main（`registerOpenIpc` + `saveIpc` + B1 管线，内存 fs）+ 真实保存控制器 + 真实 Open
 * 控制器 + 真实 store；Open 与保存共用一把准入租约（`fileIntentGate`）与一本 R20 账本（`rejectLedger`）。
 *
 * - 保存控制器的桥由本文件提供：`requestSaveTarget` / `saveDocument` / `activateDocument` 都经 `h.invoke` 打到真实 main，
 *   可以照常投递、让 main 执行但扣留应答（hold-reply）、扣留请求稍后投递（hold-request）；
 * - 账本的 reject 可切换为「丢失」（永不 settle），其超时定时器与保存控制器的定时器都是可控替身（记录任务、手动触发）；
 * - 合同：B3 清单 r0 §3.2–§3.6，r0.1 勘误 §1–§3；H-5 `trustAfterSaveAsFailure`；授权硬门「阶段 2 之前重新核对」。
 * - 每个用例都断言 store 一致性（`storeConsistencyProblems` 为空），`afterEach` 检查无未处理 rejection 并复位 store。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { PENDING_TTL_MS } from '../../../src/main/open/openCoordinator';
import { isFileOperationBusy, isSourceDirty } from '../../../src/editor/session/derive';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';
import { IPC } from '../../../src/shared/ipc';
import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import { createOpenAdmission } from '../../../src/renderer/app/editor/openEntry';
import type { EditorNotice } from '../../../src/renderer/app/editor/editorTransitions';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import { prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { createRejectLedger } from '../../../src/renderer/app/save/rejectLedger';
import { createSaveController } from '../../../src/renderer/app/save/saveController';
import type { SaveMessage } from '../../../src/renderer/app/save/saveMessages';
import { MAX_SAVE_ACTIVATION_ATTEMPTS, SAVE_ACTIVATION_TIMEOUT_MS } from '../../../src/renderer/app/save/saveTransaction';
import { applyEditorStep, commitSession, publishSaveView, storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';
import { createHarness, mainFrameEvent, REJECT } from '../main/openIpcHarness';
import { P, setup } from '../main/saveTestKit';
import { resetRendererStore, rig, settle } from './openProtocolRig';

const A = P('docs', 'a.jcx');
const NEW = P('docs', 'new.jcx');
const OTHER = P('docs', 'other.jcx');
const A_TEXT = 'X:1\nT:a\n';
const WRITE_CALLS = ['openExclusive', 'handle.writeAll', 'renameSync', 'linkSync', 'unlinkSync', 'removeFile'];

type Policy = 'deliver' | 'hold-reply' | 'hold-request';
type SaveChannel = 'request' | 'save' | 'activate';

interface WireCall {
  readonly channel: SaveChannel;
  readonly payload: unknown;
  processed(): boolean;
  release(): void;
  deliver(): Promise<void>;
}

interface Timer {
  readonly delay: number;
  readonly task: () => void;
  cancelled: boolean;
  fired: boolean;
}

const CHANNELS: Record<SaveChannel, string> = { request: IPC.requestSaveTarget, save: IPC.saveDocument, activate: IPC.activateDocument };

function world() {
  const disk = setup('linux');
  disk.writeFile(A, A_TEXT);
  const h = createHarness({ fs: disk.readFs, writeFs: disk.writeFs });
  const { sender } = h.window(1);
  const gate = createFileIntentGate();
  const rejects = { lost: false, sent: 0 };
  const ledgerTimers: Timer[] = [];
  const ledger = createRejectLedger({
    reject: (ticket) => {
      rejects.sent += 1;
      return rejects.lost ? new Promise(() => undefined) : h.invoke(REJECT, mainFrameEvent(sender), { capabilityId: ticket.capabilityId, documentId: ticket.documentId });
    },
    schedule: (delay, task) => {
      const timer: Timer = { delay, task, cancelled: false, fired: false };
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
      editor: {
        gate: () => ({ dirty: false, composing: false }),
        beforeCommit: () => undefined,
        setReplacementPending: () => undefined,
        notify: (notice: EditorNotice) => notices.push(notice.kind),
      },
    },
  });

  const calls: WireCall[] = [];
  const policies: Record<SaveChannel, Policy[]> = { request: [], save: [], activate: [] };
  function controlled(channel: SaveChannel, payload: unknown): Promise<never> {
    return new Promise<never>((resolve, reject) => {
      const policy = policies[channel].shift() ?? 'deliver';
      let processed = false;
      let outcome: { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown } | null = null;
      const process = async (): Promise<void> => {
        try {
          outcome = { ok: true, value: await h.invoke(CHANNELS[channel], mainFrameEvent(sender), payload) };
        } catch (error) {
          outcome = { ok: false, error };
        }
        processed = true;
      };
      const release = (): void => {
        if (outcome === null) throw new Error('reply not available yet');
        if (outcome.ok) Reflect.apply(resolve, undefined, [outcome.value]);
        else reject(outcome.error);
      };
      const call: WireCall = {
        channel,
        payload,
        processed: () => processed,
        release,
        deliver: async () => {
          await process();
          release();
        },
      };
      calls.push(call);
      if (policy === 'deliver') void call.deliver();
      else if (policy === 'hold-reply') void process();
    });
  }

  const timers: Timer[] = [];
  const messages: SaveMessage[] = [];
  const reported: string[] = [];
  const save = createSaveController({
    gate,
    ledger,
    bridge: () => ({
      requestSaveTarget: (request) => controlled('request', request),
      saveDocument: (request) => controlled('save', request),
      activateDocument: (ticket: DocumentActivationTicket) => controlled('activate', { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
    }),
    ime: createImeSession(),
    blur: () => undefined,
    flushParse: () => undefined,
    refreshParse: () => undefined,
    saveEnabled: () => true,
    schedule: (delay, task) => {
      const timer: Timer = { delay, task, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    report: (error) => reported.push(error instanceof Error ? error.message : String(error)),
    publish: (message) => {
      messages.push(message);
      publishSaveView({ message });
    },
  });

  const lastDialog = (): number => h.dialogParents.length - 1;
  return {
    disk,
    h,
    gate,
    ledger,
    rejects,
    notices,
    r,
    save,
    calls,
    policies,
    timers,
    messages,
    reported,
    callsOf: (channel: SaveChannel) => calls.filter((call) => call.channel === channel),
    lastMessage: (): SaveMessage | undefined => messages.at(-1),
    resolveLastDialog: (path: string | null): void => {
      h.resolveDialog(lastDialog(), path);
    },
    writes: (): number => disk.calls.filter((call) => WRITE_CALLS.includes(call)).length,
    committed: (): unknown => h.handle.currentState().owners.get(1)?.committed,
    /** 让最早一个尚未到期、未取消的激活定时器到期。 */
    expireActivation(): void {
      const timer = timers.find((t) => t.delay === SAVE_ACTIVATION_TIMEOUT_MS && !t.cancelled && !t.fired);
      if (timer === undefined) throw new Error('no pending activation timer');
      timer.fired = true;
      timer.task();
    },
    /** 让账本中所有未取消的 reject 尝试超时。 */
    expireLedger(): void {
      for (const timer of ledgerTimers) {
        if (!timer.cancelled && !timer.fired) {
          timer.fired = true;
          timer.task();
        }
      }
    },
  };
}

type World = ReturnType<typeof world>;

/** 经真实 Open 控制器打开并提交 path，返回它的 capability。 */
async function openFile(w: World, path: string): Promise<string> {
  w.r.controller.open();
  await settle();
  w.resolveLastDialog(path);
  await settle();
  const { session, capabilityTrust } = useMuseAppStore.getState();
  expect(capabilityTrust).toBe('trusted');
  if (session.file === null) throw new Error('nothing committed');
  return session.file.capability.id;
}

/** 发起 Save As 并在对话框中选中 path。 */
async function saveAsTo(w: World, path: string | null): Promise<void> {
  w.save.saveAs();
  await settle();
  w.resolveLastDialog(path);
  await settle();
}

/** 在文末输入（同 `store.fileOps.test.ts` 的 `type()`）。 */
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

function fileSession(documentId: number) {
  const result = prepareCandidate({
    documentId,
    source: 'X:1\nT:other\n',
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: `cap-${String(documentId)}` }, displayName: 'o.jcx', displayPath: '/o.jcx' },
  });
  if (!result.ok) throw new Error('prepare failed');
  return result.candidate.session;
}

const consistent = (): void => {
  expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
};

/** 订阅 store：记录每次写入后的一致性问题与 fileOp 是否出现过。 */
function watchStore(): { readonly problems: string[][]; readonly fileOpSeen: () => boolean; readonly stop: () => void; readonly states: { file: boolean; trust: string }[] } {
  const problems: string[][] = [];
  const states: { file: boolean; trust: string }[] = [];
  let fileOpSeen = false;
  const stop = useMuseAppStore.subscribe((state) => {
    problems.push(storeConsistencyProblems(state));
    states.push({ file: state.session.file !== null, trust: state.capabilityTrust });
    if (state.session.fileOp !== null) fileOpSeen = true;
  });
  return { problems, states, fileOpSeen: () => fileOpSeen, stop };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(async () => {
  await settle();
  process.off('unhandledRejection', onUnhandled);
  resetRendererStore();
  publishSaveView({ message: null });
  expect(unhandled).toEqual([]);
});

describe('Save As 激活与会话迁移（H-5，D1–D4 / F3–F4）', () => {
  it('T-H5-1：demo Save As 新文件 → 激活 ok → 同一次 store 写入中 file ≠ null 且 trusted，clean；提示 saved-as', async () => {
    const w = world();
    const before = useMuseAppStore.getState().session;
    const watch = watchStore();
    await saveAsTo(w, NEW);
    watch.stop();
    const { session, capabilityTrust } = useMuseAppStore.getState();
    // 每次 store 写入之后一致性都成立；file 第一次出现的那次写入里 trust 已是 trusted（同次切换）。
    for (const problems of watch.problems) expect(problems).toEqual([]);
    expect(watch.states.find((s) => s.file)).toEqual({ file: true, trust: 'trusted' });
    expect(session.file?.displayName).toBe('new.jcx');
    expect(capabilityTrust).toBe('trusted');
    expect(isSourceDirty(session)).toBe(false);
    expect(session.fileOp).toBeNull();
    expect(session.documentId).toBe(before.documentId);
    // 候选票据的 documentId 等于会话自身的 documentId。
    expect(w.callsOf('activate')[0]?.payload).toMatchObject({ documentId: before.documentId });
    expect(w.disk.text(NEW)).toBe(before.source);
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'new.jcx' });
    expect(w.gate.current()).toBeNull();
    expect(w.ledger.pending()).toBe(0);
    consistent();
    w.h.expectConsistent();
  });

  it('T-H5-2（D3）：main 在激活前使票据失效 → 激活明确失败；trust 仍 none、file 仍 null，失败行字段不变、fileOp 清空', async () => {
    const w = world();
    const before = useMuseAppStore.getState();
    w.policies.activate.push('hold-request');
    await saveAsTo(w, NEW);
    const [activation] = w.callsOf('activate');
    if (activation === undefined) throw new Error('no activation');
    expect(useMuseAppStore.getState().session.fileOp).not.toBeNull(); // fileOp 一直保持到激活结束
    w.h.clock += PENDING_TTL_MS + 1; // 候选过期：main 将以 capability-invalid 明确拒绝
    await activation.deliver();
    await settle();
    const after = useMuseAppStore.getState();
    expect(after.capabilityTrust).toBe('none');
    expect(after.session.file).toBeNull();
    expect(after.session.source).toBe(before.session.source);
    expect(after.session.sourceVersion).toBe(before.session.sourceVersion);
    expect(after.session.saved).toBe(before.session.saved);
    expect(after.session.parsed).toBe(before.session.parsed);
    expect(after.history).toBe(before.history);
    expect(after.selection).toBe(before.selection);
    expect(after.session.fileOp).toBeNull();
    expect(w.lastMessage()).toEqual({ kind: 'save-as-not-switched', displayName: 'new.jcx' });
    expect(w.rejects.sent).toBe(0); // 明确失败不 reject（D3）
    expect(w.gate.current()).toBeNull();
    consistent();
  });

  it('T-H5-3（D4）：三次激活都超时 → trust 仍 none；reject 入账并送达；再次 Save As 同一路径（已存在目标）→ D1 成功', async () => {
    const w = world();
    const before = useMuseAppStore.getState().session;
    const initial = w.committed();
    w.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    await saveAsTo(w, NEW);
    for (let i = 0; i < MAX_SAVE_ACTIVATION_ATTEMPTS; i += 1) {
      expect(w.save.state().phase).toBe('activating');
      expect(w.gate.current()).toMatchObject({ kind: 'saveAs' });
      w.expireActivation();
      await settle();
    }
    expect(w.save.state().phase).toBe('idle');
    expect(w.callsOf('activate')).toHaveLength(3);
    let state = useMuseAppStore.getState();
    expect(state.capabilityTrust).toBe('none');
    expect(state.session.file).toBeNull();
    expect(state.session.saved).toBe(before.saved);
    expect(state.session.fileOp).toBeNull();
    expect(w.lastMessage()).toEqual({ kind: 'save-as-not-switched', displayName: 'new.jcx' });
    expect(w.rejects.sent).toBe(1);
    expect(w.ledger.pending()).toBe(0);
    expect(w.committed()).toEqual(initial); // reject 送达：main 回退到 Save As 之前的锚点
    expect(w.gate.current()).toBeNull();
    consistent();
    // 再次 Save As，选同一路径（此时已存在）→ D1。
    expect(w.disk.exists(NEW)).toBe(true);
    await saveAsTo(w, NEW);
    state = useMuseAppStore.getState();
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'new.jcx' });
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.session.file?.displayName).toBe('new.jcx');
    expect(isSourceDirty(state.session)).toBe(false);
    expect(w.gate.current()).toBeNull();
    consistent();
    w.h.expectConsistent();
  });

  it('T-H5-4（D4 + reject 丢失）：main committed = 候选；demo Save As 先重发 reject，仍丢失 → reject-pending、不弹框、写 port 零调用；恢复后 Save As 成功', async () => {
    const w = world();
    const initial = w.committed();
    w.rejects.lost = true;
    w.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    await saveAsTo(w, NEW);
    for (let i = 0; i < MAX_SAVE_ACTIVATION_ATTEMPTS; i += 1) {
      w.expireActivation();
      await settle();
    }
    const candidate = w.callsOf('activate')[0]?.payload as { capabilityId: string };
    expect(w.committed()).toEqual({ kind: 'record', token: candidate.capabilityId });
    expect(w.ledger.pending()).toBe(1);
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    w.expireLedger(); // 首次尝试超时（条目保留）
    await settle();
    const sent = w.rejects.sent;
    const dialogs = w.h.dialogParents.length;
    const writes = w.writes();
    const saves = w.callsOf('save').length;
    w.save.saveAs();
    await settle();
    expect(w.rejects.sent).toBe(sent + 1); // 送达门先重发
    w.expireLedger();
    await settle();
    expect(w.lastMessage()).toEqual({ kind: 'reject-pending' });
    expect(w.h.dialogParents.length).toBe(dialogs);
    expect(w.writes()).toBe(writes);
    expect(w.callsOf('save').length).toBe(saves);
    expect(w.committed()).toEqual({ kind: 'record', token: candidate.capabilityId });
    expect(w.gate.current()).toBeNull();
    consistent();
    // 恢复 reject：送达门送达 → main A2 回退；Save As 进入对话框并成功。
    w.rejects.lost = false;
    await saveAsTo(w, OTHER);
    expect(w.ledger.pending()).toBe(0);
    expect(w.h.dialogParents.length).toBe(dialogs + 1);
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'other.jcx' });
    const state = useMuseAppStore.getState();
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.session.file?.displayName).toBe('other.jcx');
    expect(w.committed()).not.toEqual(initial);
    consistent();
    w.h.expectConsistent();
  });

  it('T-H5-5（F3）：已打开 A，Save As 新文件激活明确失败 → trust unverified、file 仍为 A；随后普通 Save 成功并 clean', async () => {
    const w = world();
    const a = await openFile(w, A);
    type('q');
    const before = useMuseAppStore.getState();
    w.policies.activate.push('hold-request');
    await saveAsTo(w, NEW);
    const [activation] = w.callsOf('activate');
    if (activation === undefined) throw new Error('no activation');
    w.h.clock += PENDING_TTL_MS + 1;
    await activation.deliver();
    await settle();
    let state = useMuseAppStore.getState();
    expect(state.capabilityTrust).toBe('unverified');
    expect(state.session.file?.capability.id).toBe(a);
    expect(state.session.source).toBe(before.session.source);
    expect(state.session.sourceVersion).toBe(before.session.sourceVersion);
    expect(state.session.saved).toBe(before.session.saved);
    expect(state.session.parsed).toBe(before.session.parsed);
    expect(state.selection).toBe(before.selection);
    expect(state.history.undo).toBe(before.history.undo);
    expect(state.session.fileOp).toBeNull();
    expect(w.lastMessage()).toEqual({ kind: 'save-as-not-switched', displayName: 'new.jcx' });
    consistent();
    // 普通 Save：main 中旧能力 A 仍 active（候选从未激活）→ 成功。
    w.save.save();
    await settle();
    state = useMuseAppStore.getState();
    expect(w.lastMessage()).toEqual({ kind: 'saved', displayName: 'a.jcx' });
    expect(isSourceDirty(state.session)).toBe(false);
    expect(w.disk.text(A)).toBe(state.session.source);
    expect(state.capabilityTrust).toBe('unverified');
    expect(w.gate.current()).toBeNull();
    consistent();
  });

  it('T-H5-6（F4）：激活三次超时（main 已激活候选）→ reject → 锚点回到旧墓碑；普通 Save → capability-invalid；Save As 其它文件 → 成功', async () => {
    const w = world();
    const a = await openFile(w, A);
    type('q');
    w.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    await saveAsTo(w, NEW);
    for (let i = 0; i < MAX_SAVE_ACTIVATION_ATTEMPTS; i += 1) {
      w.expireActivation();
      await settle();
    }
    let state = useMuseAppStore.getState();
    expect(state.capabilityTrust).toBe('unverified');
    expect(state.session.file?.capability.id).toBe(a);
    expect(w.lastMessage()).toEqual({ kind: 'save-as-not-switched', displayName: 'new.jcx' });
    expect(w.ledger.pending()).toBe(0);
    expect(w.committed()).toEqual({ kind: 'record', token: a });
    expect(w.h.handle.currentState().table.get(a)?.purpose).toBe('tombstone');
    consistent();
    // 普通 Save：A 已是墓碑 → capability-invalid；文档仍 dirty。
    const textA = w.disk.text(A);
    w.save.save();
    await settle();
    expect(w.lastMessage()).toEqual({ kind: 'failed', code: 'capability-invalid' });
    expect(w.disk.text(A)).toBe(textA);
    state = useMuseAppStore.getState();
    expect(isSourceDirty(state.session)).toBe(true);
    expect(state.session.fileOp).toBeNull();
    consistent();
    // Save As 到其它文件：R19 的锚点就是 A（墓碑）→ 成功并切换。
    await saveAsTo(w, OTHER);
    state = useMuseAppStore.getState();
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'other.jcx' });
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.session.file?.displayName).toBe('other.jcx');
    expect(isSourceDirty(state.session)).toBe(false);
    expect(w.gate.current()).toBeNull();
    consistent();
    w.h.expectConsistent();
  });
});

describe('R20 送达门（T-H7-8，保存部分）', () => {
  it('账本非空且 reject 丢失：普通 Save 与 Save As 都 reject-pending，不弹框、saveDocument 零调用、写盘零变化；恢复后继续', async () => {
    const w = world();
    await openFile(w, A);
    type('q');
    w.rejects.lost = true;
    w.ledger.send({ capabilityId: 'token-900', documentId: 1 });
    expect(w.ledger.pending()).toBe(1);
    const dialogs = w.h.dialogParents.length;
    const writes = w.writes();
    for (const run of [() => w.save.save(), () => w.save.saveAs()]) {
      run();
      await settle();
      w.expireLedger();
      await settle();
      expect(w.lastMessage()).toEqual({ kind: 'reject-pending' });
      expect(w.h.dialogParents.length).toBe(dialogs);
      expect(w.callsOf('save')).toHaveLength(0);
      expect(w.callsOf('request')).toHaveLength(0);
      expect(w.writes()).toBe(writes);
      expect(w.gate.current()).toBeNull();
      expect(useMuseAppStore.getState().session.fileOp).toBeNull();
      consistent();
    }
    // 恢复：普通 Save 送达后保存成功。
    w.rejects.lost = false;
    w.save.save();
    await settle();
    expect(w.ledger.pending()).toBe(0);
    expect(w.lastMessage()).toEqual({ kind: 'saved', displayName: 'a.jcx' });
    expect(isSourceDirty(useMuseAppStore.getState().session)).toBe(false);
    // Save As 同样继续。
    await saveAsTo(w, NEW);
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'new.jcx' });
    expect(w.gate.current()).toBeNull();
    consistent();
  });
});

describe('授权硬门：Save As 阶段 2 之前重新核对（不复用阶段 1 之前的结果）', () => {
  it('对话框打开期间账本新增一条丢失的 reject → granted 之后不发阶段 2；reject-pending；fileOp 从未建立；租约释放', async () => {
    const w = world();
    const watch = watchStore();
    w.save.saveAs();
    await settle();
    expect(w.save.state().phase).toBe('choosing');
    expect(w.ledger.pending()).toBe(0); // 阶段 1 之前的送达门是通过的
    w.rejects.lost = true;
    w.ledger.send({ capabilityId: 'token-900', documentId: 0 });
    w.resolveLastDialog(NEW);
    await settle();
    w.expireLedger();
    await settle();
    watch.stop();
    expect(w.callsOf('request')).toHaveLength(1);
    expect(w.callsOf('save')).toHaveLength(0);
    expect(w.lastMessage()).toEqual({ kind: 'reject-pending' });
    expect(watch.fileOpSeen()).toBe(false);
    expect(w.gate.current()).toBeNull();
    expect(w.disk.exists(NEW)).toBe(false);
    expect(w.writes()).toBe(0);
    for (const problems of watch.problems) expect(problems).toEqual([]);
    consistent();
  });

  it('await 恢复后复核：对话框打开期间会话被替换（documentId 改变）→ 不发阶段 2；changed；租约释放', async () => {
    const w = world();
    w.save.saveAs();
    await settle();
    expect(w.save.state().phase).toBe('choosing');
    const replaced = fileSession(77);
    commitSession(replaced, 'trusted');
    w.resolveLastDialog(NEW);
    await settle();
    expect(w.callsOf('save')).toHaveLength(0);
    expect(w.lastMessage()).toEqual({ kind: 'changed' });
    expect(w.gate.current()).toBeNull();
    expect(w.save.state().phase).toBe('idle');
    expect(useMuseAppStore.getState().session).toBe(replaced);
    expect(w.disk.exists(NEW)).toBe(false);
    consistent();
  });
});

describe('租约互斥（L-2 / L-6）', () => {
  it('Save As 对话框打开期间（尚无 fileOp）Open → 同步 open-refused-busy，不弹第二个对话框', async () => {
    const w = world();
    w.save.saveAs();
    await settle();
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
    const dialogs = w.h.dialogParents.length;
    w.r.controller.open();
    expect(w.notices).toEqual(['open-refused-busy']);
    await settle();
    expect(w.h.dialogParents.length).toBe(dialogs);
    expect(w.gate.current()).toMatchObject({ kind: 'saveAs' });
    w.resolveLastDialog(null);
    await settle();
    expect(w.gate.current()).toBeNull();
    consistent();
  });

  it('普通 Save 的 saveDocument 应答扣留期间 Open → 同步 open-refused-busy；应答到达后保存完成', async () => {
    const w = world();
    await openFile(w, A);
    type('q');
    w.policies.save.push('hold-reply');
    w.save.save();
    await settle();
    const [pending] = w.callsOf('save');
    if (pending === undefined) throw new Error('no save');
    expect(pending.processed()).toBe(true);
    const dialogs = w.h.dialogParents.length;
    w.r.controller.open();
    expect(w.notices).toEqual(['open-refused-busy']);
    await settle();
    expect(w.h.dialogParents.length).toBe(dialogs);
    pending.release();
    await settle();
    expect(w.lastMessage()).toEqual({ kind: 'saved', displayName: 'a.jcx' });
    expect(w.gate.current()).toBeNull();
    consistent();
  });

  it('Open 事务进行中（对话框打开）Save / Save As → 同步 busy，不弹对话框、不发 IPC', async () => {
    const w = world();
    await openFile(w, A);
    type('q');
    w.r.controller.open();
    await settle();
    expect(w.gate.current()).toMatchObject({ kind: 'open' });
    const dialogs = w.h.dialogParents.length;
    w.save.save();
    expect(w.lastMessage()).toEqual({ kind: 'busy' });
    w.save.saveAs();
    expect(w.messages.slice(-2)).toEqual([{ kind: 'busy' }, { kind: 'busy' }]);
    await settle();
    expect(w.h.dialogParents.length).toBe(dialogs);
    expect(w.calls).toHaveLength(0);
    w.resolveLastDialog(null);
    await settle();
    expect(w.gate.current()).toBeNull();
    consistent();
  });
});

describe('M18：保存期间继续输入', () => {
  it('saveDocument 应答扣留期间继续输入 → 应答到达后检查点等于捕获值、仍 dirty', async () => {
    const w = world();
    await openFile(w, A);
    type('a');
    w.policies.save.push('hold-reply');
    w.save.save();
    await settle();
    const [pending] = w.callsOf('save');
    if (pending === undefined) throw new Error('no save');
    const captured = (pending.payload as { source: string }).source;
    type('b');
    expect(useMuseAppStore.getState().session.source).not.toBe(captured);
    pending.release();
    await settle();
    const { session } = useMuseAppStore.getState();
    expect(w.lastMessage()).toEqual({ kind: 'saved', displayName: 'a.jcx' });
    expect(session.saved.source).toBe(captured);
    expect(isSourceDirty(session)).toBe(true);
    expect(session.fileOp).toBeNull();
    expect(w.disk.text(A)).toBe(captured);
    consistent();
  });
});

describe('§3.6 迟到结果：Save As 自身的激活', () => {
  it('第 1 次激活超时、第 2 次进行中，第 1 次的迟到 ok 到达 → 终结并 D1；之后第 2 次的应答与定时器都被忽略', async () => {
    const w = world();
    w.policies.activate.push('hold-reply', 'hold-reply');
    await saveAsTo(w, NEW);
    w.expireActivation();
    await settle();
    const [first, second] = w.callsOf('activate');
    if (first === undefined || second === undefined) throw new Error('expected two attempts');
    expect(w.save.state()).toMatchObject({ phase: 'activating', attempt: 2 });
    first.release();
    await settle();
    expect(w.save.state().phase).toBe('idle');
    const state = useMuseAppStore.getState();
    expect(state.capabilityTrust).toBe('trusted');
    expect(state.session.file?.displayName).toBe('new.jcx');
    expect(w.lastMessage()).toEqual({ kind: 'saved-as', displayName: 'new.jcx' });
    expect(w.gate.current()).toBeNull();
    const count = w.messages.length;
    const session = state.session;
    second.release();
    for (const timer of w.timers) if (!timer.cancelled && !timer.fired) timer.task();
    await settle();
    expect(w.messages.length).toBe(count);
    expect(useMuseAppStore.getState().session).toBe(session);
    expect(w.callsOf('activate')).toHaveLength(2);
    expect(w.ledger.pending()).toBe(0);
    consistent();
  });

  it('D4 收束之后迟到的 ok 到达 → 不提交会话、不改 trust、账本不被清除', async () => {
    const w = world();
    w.rejects.lost = true;
    w.policies.activate.push('hold-reply', 'hold-reply', 'hold-reply');
    await saveAsTo(w, NEW);
    for (let i = 0; i < MAX_SAVE_ACTIVATION_ATTEMPTS; i += 1) {
      w.expireActivation();
      await settle();
    }
    expect(w.save.state().phase).toBe('idle');
    expect(w.ledger.pending()).toBe(1);
    const before = useMuseAppStore.getState();
    const count = w.messages.length;
    for (const call of w.callsOf('activate')) call.release();
    await settle();
    const after = useMuseAppStore.getState();
    expect(after.session).toBe(before.session);
    expect(after.capabilityTrust).toBe('none');
    expect(after.session.file).toBeNull();
    expect(w.messages.length).toBe(count);
    expect(w.ledger.pending()).toBe(1);
    expect(w.gate.current()).toBeNull();
    consistent();
  });
});
