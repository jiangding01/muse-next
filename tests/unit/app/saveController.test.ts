/**
 * M3 T4 B3a-2：保存控制器（`src/renderer/app/save/saveController.ts`）——替身桥 + 真实 store + 真实租约与账本。
 *
 * - 准入：首个 await 之前同步获取共享租约；被占用（另一项文件操作 / 进行中）同步拒绝；终态效果全部执行完才释放。
 * - R5（勘误 §3，T-M3-1…6）：先订阅再 blur；blur 中同步结束组字立即继续；等待窗口内的异步结束被捕获；超时拒绝且不 discard；
 *   所有路径解除订阅。
 * - 每个 await 恢复后复核租约与文档身份；送达门之后同步复核源能力与账本；M18；三态结果；Save As 激活重试与 D4；
 *   回调异常 fail closed；beforeunload 读取完整保存租约（含尚未建立 fileOp 的准入期）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isSourceDirty } from '../../../src/editor/session/derive';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import type { ImeView } from '../../../src/renderer/app/editor/imeMachine';
import { createDemoSession, prepareCandidate } from '../../../src/renderer/app/editor/sessionFactory';
import { museUnloadReason, unloadReasonFor } from '../../../src/renderer/app/editor/unloadBlocker';
import { createFileIntentGate, museFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import { createRejectLedger } from '../../../src/renderer/app/save/rejectLedger';
import { createSaveController } from '../../../src/renderer/app/save/saveController';
import type { SaveMessage } from '../../../src/renderer/app/save/saveMessages';
import { IME_SETTLE_TIMEOUT_MS, SAVE_ACTIVATION_TIMEOUT_MS } from '../../../src/renderer/app/save/saveTransaction';
import { applyEditorStep, beginFileOperation, commitSession, finishFileOperation, storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function fileSession(documentId = 5, capability = `cap-${String(documentId)}`, source = 'X:1\nT:save\nK:G\nGABc|\n') {
  const result = prepareCandidate({
    documentId,
    source,
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: { capability: { id: capability }, displayName: 's.jcx', displayPath: '/s.jcx' },
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

const SAVED = { outcome: 'saved', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', displayName: 's.jcx', displayPath: '/s.jcx', ticket: null } as const;

function world(options: { composing?: boolean; blurEnds?: boolean; saveEnabled?: boolean } = {}) {
  const gate = createFileIntentGate();
  const rejects: DocumentActivationTicket[] = [];
  const rejectReplies: Deferred<unknown>[] = [];
  let rejectsLost = false;
  const ledger = createRejectLedger({
    reject: (ticket) => {
      rejects.push(ticket);
      if (!rejectsLost) return Promise.resolve({ ok: true });
      const d = deferred<unknown>();
      rejectReplies.push(d);
      return d.promise;
    },
  });
  const timers: { delay: number; task: () => void; cancelled: boolean }[] = [];
  const calls: { channel: string; payload: unknown; reply: Deferred<unknown> }[] = [];
  const call = (channel: string) => (payload: unknown): Promise<never> => {
    const reply = deferred<unknown>();
    calls.push({ channel, payload, reply });
    return reply.promise as Promise<never>;
  };
  let view: ImeView = options.composing === true ? 'composing' : 'idle';
  const listeners = new Set<(view: ImeView) => void>();
  const order: string[] = [];
  const setView = (next: ImeView): void => {
    view = next;
    for (const listener of [...listeners]) listener(next);
  };
  const messages: SaveMessage[] = [];
  const reports: string[] = [];
  const leaseAtPublish: (string | null)[] = [];
  const controller = createSaveController({
    gate,
    ledger,
    bridge: () => ({ requestSaveTarget: call('target'), saveDocument: call('save'), activateDocument: call('activate') }),
    ime: {
      view: () => view,
      subscribe: (listener) => {
        order.push('subscribe');
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    blur: () => {
      order.push('blur');
      if (options.blurEnds === true) setView('settled');
    },
    flushParse: () => {
      order.push('flush-parse');
    },
    refreshParse: () => {
      order.push('refresh-parse');
    },
    saveEnabled: () => options.saveEnabled ?? true,
    schedule: (delay, task) => {
      const timer = { delay, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    report: (error) => reports.push(error instanceof Error ? error.message : String(error)),
    publish: (message) => {
      messages.push(message);
      leaseAtPublish.push(gate.current()?.kind ?? null);
    },
  });
  const pending = (channel: string) => calls.filter((c) => c.channel === channel);
  const fire = (delay: number): void => {
    // 先取快照：触发中新排程的定时器（例如下一次激活尝试）留到下一次 fire。
    for (const timer of [...timers]) if (timer.delay === delay && !timer.cancelled) {
      timer.cancelled = true;
      timer.task();
    }
  };
  return {
    gate,
    ledger,
    rejects,
    rejectReplies,
    loseRejects: (lost: boolean) => {
      rejectsLost = lost;
    },
    timers,
    calls,
    pending,
    fire,
    controller,
    setView,
    listeners,
    order,
    messages,
    reports,
    leaseAtPublish,
    kinds: () => messages.map((m) => m.kind),
  };
}

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
  commitSession(fileSession(), 'trusted');
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  commitSession(createDemoSession(), 'none');
  expect(unhandled).toEqual([]);
});

const consistent = (): void => {
  expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
};

describe('saveController —— 准入（H-B3-1）', () => {
  it('首个 await 之前同步获取 save 租约；同一帧的第二次 Save / Save As 同步拒绝（busy），只有一次写入', async () => {
    const w = world();
    type();
    w.controller.save();
    expect(w.gate.current()).toMatchObject({ kind: 'save', documentId: 5 });
    w.controller.save();
    w.controller.saveAs();
    expect(w.kinds()).toEqual(['busy', 'busy']);
    await settle();
    expect(w.pending('save')).toHaveLength(1);
    w.pending('save')[0]?.reply.resolve(SAVED);
    await settle();
    expect(w.gate.current()).toBeNull();
    expect(isSourceDirty(useMuseAppStore.getState().session)).toBe(false);
    consistent();
  });

  it('租约被另一项文件操作（Open 替身）占用 / 会话上已有 fileOp → 同步 busy，不等待、不发 IPC', async () => {
    const w = world();
    type();
    const open = w.gate.tryAcquire('open', 5);
    w.controller.save();
    expect(w.kinds()).toEqual(['busy']);
    if (open !== null) w.gate.release(open);
    const begun = beginFileOperation('save');
    if (!begun.ok) throw new Error(begun.reason);
    w.controller.saveAs();
    expect(w.kinds()).toEqual(['busy', 'busy']);
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.gate.current()).toBeNull();
    finishFileOperation(begun.documentId, begun.op, false);
  });

  it('终态的全部效果（含提示）执行完之后才释放租约', async () => {
    const w = world();
    type();
    w.controller.save();
    await settle();
    w.pending('save')[0]?.reply.resolve(SAVED);
    await settle();
    expect(w.kinds()).toEqual(['saved']);
    expect(w.leaseAtPublish).toEqual(['save']);
    expect(w.gate.current()).toBeNull();
  });

  it('R10：本平台未开放普通 Save → 无操作并释放租约；Save As 照常进入对话框', async () => {
    const w = world({ saveEnabled: false });
    type();
    w.controller.save();
    expect(w.gate.current()).toBeNull();
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.messages).toEqual([]);
    w.controller.saveAs();
    await settle();
    expect(w.pending('target')).toHaveLength(1);
  });
});

describe('saveController —— R5 有界等待（勘误 §3，T-M3-1…6）', () => {
  it('T-M3-4：先订阅再 blur；blur 同步结束组字 → 立即继续，不排程超时；之后 flush("blur")；订阅已解除', async () => {
    const w = world({ composing: true, blurEnds: true });
    type();
    w.controller.save();
    await settle();
    expect(w.order).toEqual(['subscribe', 'blur', 'flush-parse']);
    expect(w.timers.filter((t) => t.delay === IME_SETTLE_TIMEOUT_MS)).toEqual([]);
    expect(w.listeners.size).toBe(0);
    expect(w.pending('save')).toHaveLength(1);
  });

  it('T-M3-1：等待窗口内异步结束组字被本次保存捕获；视图保持 composing 的通知不结束等待（committing 到 composing 的映射由 imeSession.subscribe 测试钉住）', async () => {
    const w = world({ composing: true });
    type();
    w.controller.save();
    await settle();
    expect(w.pending('save')).toHaveLength(0);
    expect(w.listeners.size).toBe(1);
    w.setView('composing'); // 例如进入 committing：对外视图仍为 composing，不结束等待
    await settle();
    expect(w.pending('save')).toHaveLength(0);
    w.setView('settled');
    await settle();
    expect(w.pending('save')).toHaveLength(1);
    expect(w.listeners.size).toBe(0);
    expect(w.timers.find((t) => t.delay === IME_SETTLE_TIMEOUT_MS)?.cancelled).toBe(true);
  });

  it('T-M3-2 / T-M3-6：500 ms 超时 → 拒绝（ime-timeout），文本保留、不 discard、不发 IPC；T-M3-5：订阅解除，租约释放', async () => {
    const w = world({ composing: true });
    type('q');
    const before = useMuseAppStore.getState().session.source;
    w.controller.save();
    await settle();
    w.fire(IME_SETTLE_TIMEOUT_MS);
    await settle();
    expect(w.kinds()).toEqual(['ime-timeout']);
    expect(useMuseAppStore.getState().session.source).toBe(before);
    expect(w.calls).toEqual([]);
    expect(w.listeners.size).toBe(0);
    expect(w.gate.current()).toBeNull();
  });

  it('T-M3-5：blur 抛错（异常路径）同样解除订阅并 fail closed', async () => {
    const w = world({ composing: true });
    const throwing = createSaveController({
      gate: w.gate,
      ledger: w.ledger,
      bridge: () => {
        throw new Error('no bridge');
      },
      ime: { view: () => 'composing', subscribe: (listener) => {
        w.listeners.add(listener);
        return () => {
          w.listeners.delete(listener);
        };
      } },
      blur: () => {
        throw new Error('blur failed');
      },
      flushParse: () => undefined,
      refreshParse: () => undefined,
      saveEnabled: () => true,
      schedule: () => () => undefined,
      report: (error) => w.reports.push(error instanceof Error ? error.message : String(error)),
      publish: (message) => w.messages.push(message),
    });
    type();
    throwing.save();
    await settle();
    expect(w.listeners.size).toBe(0);
    expect(w.reports).toContain('blur failed');
    expect(w.kinds()).toEqual(['changed']);
    expect(w.gate.current()).toBeNull();
  });
});

describe('saveController —— 送达门与 await 恢复后的复核（H-B3-2、勘误 §1.3）', () => {
  it('账本有未送达的 reject → 先重发；仍未送达 → reject-pending，不发 saveDocument、不建立 fileOp', async () => {
    const w = world();
    type();
    w.loseRejects(true);
    w.ledger.send({ capabilityId: 'old', documentId: 1 });
    w.controller.save();
    await settle();
    w.rejectReplies.at(-1)?.reject(new Error('lost'));
    await settle();
    expect(w.kinds()).toEqual(['reject-pending']);
    expect(w.pending('save')).toEqual([]);
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
    expect(w.gate.current()).toBeNull();
    w.loseRejects(false);
    w.controller.save();
    await settle();
    expect(w.pending('save')).toHaveLength(1);
  });

  it('R-1（保存侧）：flush 报告 delivered 但最终核对时账本仍非空 → reject-pending，不写入', async () => {
    type();
    const gate = createFileIntentGate();
    const messages: SaveMessage[] = [];
    const saves: unknown[] = [];
    const controller = createSaveController({
      gate,
      ledger: { send: () => undefined, flush: () => Promise.resolve('delivered'), pending: () => 1 },
      bridge: () => ({
        requestSaveTarget: () => new Promise(() => undefined),
        saveDocument: (payload) => {
          saves.push(payload);
          return new Promise(() => undefined);
        },
        activateDocument: () => new Promise(() => undefined),
      }),
      ime: { view: () => 'idle', subscribe: () => () => undefined },
      blur: () => undefined,
      flushParse: () => undefined,
      refreshParse: () => undefined,
      saveEnabled: () => true,
      schedule: () => () => undefined,
      report: () => undefined,
      publish: (message) => messages.push(message),
    });
    controller.save();
    await settle();
    expect(messages.map((m) => m.kind)).toEqual(['reject-pending']);
    expect(saves).toEqual([]);
    expect(gate.current()).toBeNull();
  });

  it('等待期间文档被替换 → changed，不写入；源能力被替换（documentId 相同）→ 送达门拒绝', async () => {
    const w = world({ composing: true });
    type();
    w.controller.save();
    await settle();
    commitSession(fileSession(6), 'trusted');
    w.setView('settled');
    await settle();
    expect(w.kinds()).toEqual(['changed']);
    expect(w.calls).toEqual([]);
    expect(w.gate.current()).toBeNull();

    const v = world({ composing: true });
    commitSession(fileSession(5), 'trusted');
    type();
    v.controller.save();
    await settle();
    commitSession(fileSession(5, 'cap-other'), 'trusted');
    type();
    v.setView('settled');
    await settle();
    // 文档号未变、源能力已变：送达门最终核对不通过 → 送达门文案（勘误 §2.1）。
    expect(v.kinds()).toEqual(['reject-pending']);
    expect(v.calls).toEqual([]);
  });

  it('Save As：对话框返回之前账本出现未送达的 reject → 阶段 2 之前重新核对 → reject-pending，不写入', async () => {
    const w = world();
    w.controller.saveAs();
    await settle();
    expect(w.pending('target')).toHaveLength(1);
    w.loseRejects(true);
    w.ledger.send({ capabilityId: 'late', documentId: 5 });
    w.pending('target')[0]?.reply.resolve({ kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false });
    await settle();
    w.rejectReplies.at(-1)?.reject(new Error('lost'));
    await settle();
    expect(w.kinds()).toEqual(['reject-pending']);
    expect(w.pending('save')).toEqual([]);
    expect(w.gate.current()).toBeNull();
  });

  it('预检：不可编码字符（孤立代理）→ 拒绝并给出行列，不发 IPC', async () => {
    commitSession(fileSession(5, 'cap-5', 'X:1\nT:\ud800\n'), 'trusted');
    type();
    const w = world();
    w.controller.save();
    await settle();
    expect(w.messages).toEqual([{ kind: 'unencodable', line: 2, column: 2, encoding: 'utf-8' }]);
    expect(w.calls).toEqual([]);
  });
});

describe('saveController —— 结果回写（CAS、M18、三态）', () => {
  it('M18：保存进行中继续输入 → 检查点取捕获值，完成后仍 dirty；请求载荷是捕获的 source 与会话编码', async () => {
    const w = world();
    type('a');
    const captured = useMuseAppStore.getState().session.source;
    w.controller.save();
    await settle();
    expect(w.pending('save')[0]?.payload).toEqual({ capabilityId: 'cap-5', documentId: 5, source: captured, encoding: 'utf-8' });
    type('b');
    w.pending('save')[0]?.reply.resolve(SAVED);
    await settle();
    const { session } = useMuseAppStore.getState();
    expect(session.saved.source).toBe(captured);
    expect(isSourceDirty(session)).toBe(true);
    expect(session.fileOp).toBeNull();
    consistent();
  });

  it('committed-unconfirmed（普通 Save）→ 检查点前移并降级为 unverified；not-committed → 只结束操作，检查点不动', async () => {
    const w = world();
    type();
    w.controller.save();
    await settle();
    w.pending('save')[0]?.reply.resolve({ ...SAVED, outcome: 'committed-unconfirmed' });
    await settle();
    expect(useMuseAppStore.getState().capabilityTrust).toBe('unverified');
    expect(isSourceDirty(useMuseAppStore.getState().session)).toBe(false);
    consistent();
    type();
    const savedBefore = useMuseAppStore.getState().session.saved;
    w.controller.save();
    await settle();
    w.pending('save')[1]?.reply.resolve({ outcome: 'not-committed', error: { code: 'write-failed', message: 'x' } });
    await settle();
    expect(useMuseAppStore.getState().session.saved).toBe(savedBefore);
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
    expect(w.messages.at(-1)).toEqual({ kind: 'failed', code: 'write-failed' });
  });

  it('saveDocument 抛错 / 应答畸形 → 结果未知：结束操作、仍 dirty、不降级；租约释放', async () => {
    for (const fail of ['throw', 'malformed'] as const) {
      commitSession(fileSession(), 'trusted');
      type();
      const w = world();
      w.controller.save();
      await settle();
      if (fail === 'throw') w.pending('save')[0]?.reply.reject(new Error('ipc failed'));
      else w.pending('save')[0]?.reply.resolve({ outcome: 'saved' });
      await settle();
      expect(w.kinds(), fail).toEqual(['result-unknown']);
      expect(isSourceDirty(useMuseAppStore.getState().session), fail).toBe(true);
      expect(useMuseAppStore.getState().capabilityTrust, fail).toBe('trusted');
      expect(w.gate.current(), fail).toBeNull();
      consistent();
    }
  });
});

describe('saveController —— Save As 激活（D1 / D4、H-5）', () => {
  async function toActivation(w: ReturnType<typeof world>): Promise<void> {
    w.controller.saveAs();
    await settle();
    w.pending('target')[0]?.reply.resolve({ kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false });
    await settle();
    w.pending('save')[0]?.reply.resolve({ ...SAVED, displayName: 'n.jcx', displayPath: '/n.jcx', ticket: { capabilityId: 'cap-n', documentId: 0 } });
    await settle();
  }

  it('D1（demo）：激活 ok → 文件事实、检查点与 trusted 同次写入；阶段 2 载荷带 sourceCapabilityId = null', async () => {
    commitSession(createDemoSession(), 'none');
    type();
    const w = world();
    await toActivation(w);
    expect(w.pending('save')[0]?.payload).toMatchObject({ capabilityId: 'G', documentId: 0, encoding: 'utf-8', sourceCapabilityId: null });
    // B3-L6：激活进行中（含重试）租约仍由本次 Save As 持有，另一项文件操作获取失败。
    expect(w.gate.current()).toMatchObject({ kind: 'saveAs' });
    expect(w.gate.tryAcquire('open', 0)).toBeNull();
    w.fire(SAVE_ACTIVATION_TIMEOUT_MS);
    await settle();
    expect(w.gate.current()).toMatchObject({ kind: 'saveAs' });
    w.pending('activate')[0]?.reply.resolve({ ok: true });
    await settle();
    const state = useMuseAppStore.getState();
    expect(state.session.file).toEqual({ capability: { id: 'cap-n' }, displayName: 'n.jcx', displayPath: '/n.jcx' });
    expect(state.capabilityTrust).toBe('trusted');
    expect(isSourceDirty(state.session)).toBe(false);
    expect(w.kinds()).toEqual(['saved-as']);
    // Q4：切换成功之后同版本静默重解析一次。
    expect(w.order.filter((step) => step === 'refresh-parse')).toEqual(['refresh-parse']);
    consistent();
  });

  it('D4（demo）：三次超时 → reject 入账、trust 仍 none、file 仍 null（H-5）；F4（已打开文件）→ unverified', async () => {
    for (const demo of [true, false]) {
      commitSession(demo ? createDemoSession() : fileSession(), demo ? 'none' : 'trusted');
      type();
      const w = world();
      await toActivation(w);
      for (let i = 0; i < 3; i += 1) {
        w.fire(SAVE_ACTIVATION_TIMEOUT_MS);
        await settle();
      }
      expect(w.pending('activate')).toHaveLength(3);
      expect(w.rejects).toEqual([{ capabilityId: 'cap-n', documentId: 0 }]);
      const state = useMuseAppStore.getState();
      expect(state.capabilityTrust).toBe(demo ? 'none' : 'unverified');
      expect(state.session.file === null).toBe(demo);
      expect(state.session.fileOp).toBeNull();
      expect(w.kinds()).toEqual(['save-as-not-switched']);
      expect(w.order).not.toContain('refresh-parse');
      consistent();
      // 迟到的 ok 不提交会话、不改授权。
      w.pending('activate')[0]?.reply.resolve({ ok: true });
      await settle();
      expect(useMuseAppStore.getState().session.file === null).toBe(demo);
    }
  });

  it('D2：激活 ok 但会话在此前被替换（CAS 失败）→ 经账本 reject，不写会话', async () => {
    commitSession(createDemoSession(), 'none');
    type();
    const w = world();
    await toActivation(w);
    // 激活应答到达之前换成同 documentId 的新会话对象：fileOp 不再是本次的 op，store CAS 拒绝。
    commitSession(createDemoSession(), 'none');
    w.pending('activate')[0]?.reply.resolve({ ok: true });
    await settle();
    expect(useMuseAppStore.getState().session.file).toBeNull();
    expect(w.rejects).toEqual([{ capabilityId: 'cap-n', documentId: 0 }]);
    expect(w.kinds()).toEqual(['saved-as', 'save-as-not-switched']);
    expect(w.gate.current()).toBeNull();
  });
});

describe('beforeunload 读取完整保存租约（Gate B3a-1 追加硬门 4）', () => {
  it('准入期（持有 save 租约、尚未建立 fileOp）即阻止；open 租约不算保存；fileOp 保存中同样阻止', () => {
    commitSession(createDemoSession(), 'none');
    expect(museUnloadReason()).toBeNull();
    const lease = museFileIntentGate.tryAcquire('saveAs', 0);
    if (lease === null) throw new Error('acquire failed');
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
    expect(museUnloadReason()).toBe('saving');
    museFileIntentGate.release(lease);
    const open = museFileIntentGate.tryAcquire('open', 0);
    expect(museUnloadReason()).toBeNull();
    if (open !== null) museFileIntentGate.release(open);
    const begun = beginFileOperation('save');
    if (!begun.ok) throw new Error(begun.reason);
    expect(museUnloadReason()).toBe('saving');
    finishFileOperation(begun.documentId, begun.op, false);
    expect(unloadReasonFor(true, 'composing', true)).toBe('saving');
    expect(unloadReasonFor(true, 'composing')).toBe('dirty');
  });
});

describe('saveController —— 每个 await 点的「租约被替换 / 文档被替换」注入（勘误 §1.3 / §1.5，审查 M-1）', () => {
  type Point = 'ime' | 'gate' | 'dialog' | 'ime-after-dialog' | 'gate-after-dialog' | 'save-reply' | 'save-as-reply' | 'activation-reply' | 'activation-timeout';
  const GRANTED = { kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false } as const;
  const TICKET = { capabilityId: 'cap-n', documentId: 0 } as const;
  const SAVED_AS = { ...SAVED, displayName: 'n.jcx', displayPath: '/n.jcx', ticket: TICKET } as const;
  const POINTS: readonly Point[] = ['ime', 'gate', 'dialog', 'ime-after-dialog', 'gate-after-dialog', 'save-reply', 'save-as-reply', 'activation-reply', 'activation-timeout'];
  const PRE_WRITE: readonly Point[] = ['ime', 'gate', 'dialog', 'ime-after-dialog', 'gate-after-dialog'];

  /** 走到 point 处的 await（尚未恢复），返回恢复动作。普通 Save 用已打开文件，Save As 用 demo（H-5 下授权不变）。 */
  async function reach(point: Point): Promise<{ w: ReturnType<typeof world>; resume: () => void }> {
    const plain = point === 'ime' || point === 'gate' || point === 'save-reply';
    commitSession(plain ? fileSession() : createDemoSession(), plain ? 'trusted' : 'none');
    type();
    const w = world({ composing: point === 'ime' || point === 'ime-after-dialog' });
    if (point === 'gate') {
      w.loseRejects(true);
      w.ledger.send({ capabilityId: 'old', documentId: 1 });
    }
    if (plain) w.controller.save();
    else w.controller.saveAs();
    await settle();
    if (point === 'ime') return { w, resume: () => w.setView('settled') };
    if (point === 'gate') return { w, resume: () => w.rejectReplies[0]?.resolve({ ok: true }) };
    if (point === 'save-reply') return { w, resume: () => w.pending('save')[0]?.reply.resolve(SAVED) };
    if (point === 'ime-after-dialog') {
      w.setView('settled');
      await settle();
      w.setView('composing');
    }
    if (point === 'dialog') return { w, resume: () => w.pending('target')[0]?.reply.resolve(GRANTED) };
    if (point === 'gate-after-dialog') {
      w.loseRejects(true);
      w.ledger.send({ capabilityId: 'late', documentId: 0 });
    }
    w.pending('target')[0]?.reply.resolve(GRANTED);
    await settle();
    if (point === 'ime-after-dialog') return { w, resume: () => w.setView('settled') };
    if (point === 'gate-after-dialog') return { w, resume: () => w.rejectReplies.at(-1)?.resolve({ ok: true }) };
    if (point === 'save-as-reply') return { w, resume: () => w.pending('save')[0]?.reply.resolve(SAVED_AS) };
    w.pending('save')[0]?.reply.resolve(SAVED_AS);
    await settle();
    if (point === 'activation-reply') return { w, resume: () => w.pending('activate')[0]?.reply.resolve({ ok: true }) };
    return { w, resume: () => w.fire(SAVE_ACTIVATION_TIMEOUT_MS) };
  }

  const expected = (point: Point): string => (PRE_WRITE.includes(point) ? 'changed' : point.startsWith('activation') ? 'save-as-not-switched' : 'result-not-applied');

  for (const point of POINTS) {
    for (const inject of ['lease', 'document'] as const) {
      it(`${point}：${inject === 'lease' ? '租约被替换' : '文档被替换'} → 恢复后 fail closed，不再发 IPC、不写会话内容`, async () => {
        const { w, resume } = await reach(point);
        expect(w.messages, 'not yet finished').toEqual([]);
        const callsBefore = w.calls.length;
        let standIn = null;
        if (inject === 'lease') {
          const mine = w.gate.current();
          if (mine === null) throw new Error('no lease');
          w.gate.release(mine);
          standIn = w.gate.tryAcquire('open', mine.documentId);
        } else {
          commitSession(fileSession(9), 'trusted');
        }
        const base = useMuseAppStore.getState();
        resume();
        await settle();
        expect(w.kinds()).toEqual([expected(point)]);
        expect(w.calls.length, 'no further save / dialog / activation IPC').toBe(callsBefore);
        const after = useMuseAppStore.getState();
        if (inject === 'document') {
          expect(after.session, 'replacing session untouched').toBe(base.session);
          expect(after.capabilityTrust).toBe(base.capabilityTrust);
          expect(w.gate.current()).toBeNull();
        } else {
          expect([after.session.source, after.session.saved, after.session.file, after.capabilityTrust]).toEqual([
            base.session.source,
            base.session.saved,
            base.session.file,
            base.capabilityTrust,
          ]);
          expect(after.session.fileOp, 'own op ended by reference').toBeNull();
          expect(w.gate.current(), 'the stand-in lease is not released').toBe(standIn);
        }
        // 越过提交点（Save As 已写入）或激活中：候选经账本 reject。
        expect(w.rejects.some((ticket) => ticket.capabilityId === TICKET.capabilityId)).toBe(point === 'save-as-reply' || point.startsWith('activation'));
        expect(storeConsistencyProblems(after)).toEqual([]);
      });
    }
  }
});

describe('saveController —— 终态效果隔离、未知错误码、unsafe 改用 UTF-8（审查 LOW-3 / LOW-5 / LOW-6）', () => {
  it('LOW-3：reject 入账抛错不跳过结束操作与提示；fileOp 不残留，租约释放', async () => {
    commitSession(createDemoSession(), 'none');
    type();
    const gate = createFileIntentGate();
    const calls: { channel: string; reply: Deferred<unknown> }[] = [];
    const call = (channel: string) => (): Promise<never> => {
      const reply = deferred<unknown>();
      calls.push({ channel, reply });
      return reply.promise as Promise<never>;
    };
    const timers: (() => void)[] = [];
    const messages: SaveMessage[] = [];
    const reports: string[] = [];
    const controller = createSaveController({
      gate,
      ledger: {
        send: () => {
          throw new Error('ledger broken');
        },
        flush: () => Promise.resolve('delivered'),
        pending: () => 0,
      },
      bridge: () => ({ requestSaveTarget: call('target'), saveDocument: call('save'), activateDocument: call('activate') }),
      ime: { view: () => 'idle', subscribe: () => () => undefined },
      blur: () => undefined,
      flushParse: () => undefined,
      refreshParse: () => undefined,
      saveEnabled: () => true,
      schedule: (_delay, task) => {
        timers.push(task);
        return () => undefined;
      },
      report: (error) => reports.push(error instanceof Error ? error.message : String(error)),
      publish: (message) => messages.push(message),
    });
    controller.saveAs();
    await settle();
    calls.find((c) => c.channel === 'target')?.reply.resolve({ kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false });
    await settle();
    calls.find((c) => c.channel === 'save')?.reply.resolve({ ...SAVED, ticket: { capabilityId: 'cap-n', documentId: 0 } });
    await settle();
    for (let i = 0; i < 3; i += 1) {
      timers.at(-1)?.();
      await settle();
    }
    expect(reports).toContain('ledger broken');
    expect(messages.map((m) => m.kind)).toEqual(['save-as-not-switched']);
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
    expect(gate.current()).toBeNull();
  });

  it('LOW-5：未知错误码有兜底文案（不为 undefined）', async () => {
    const { saveErrorText, saveMessageText } = await import('../../../src/renderer/app/save/saveMessages');
    expect(saveErrorText('from-a-newer-main' as never)).toBe('保存失败，未能保存。');
    expect(saveMessageText({ kind: 'failed', code: 'from-a-newer-main' as never })).toBe('保存失败，未能保存。');
  });

  it('LOW-6（Q-B3-9）：unsafe 文档的 Save As 两阶段都以 UTF-8 请求，切换成功的提示说明改用 UTF-8', async () => {
    const prepared = prepareCandidate({
      documentId: 5,
      source: 'X:1\nT:unsafe\n',
      writeEncoding: 'gb18030',
      byteBom: 'none',
      encodingRoundTrip: 'unsafe',
      file: { capability: { id: 'cap-5' }, displayName: 's.jcx', displayPath: '/s.jcx' },
    });
    if (!prepared.ok) throw new Error('prepare failed');
    commitSession(prepared.candidate.session, 'trusted');
    const w = world();
    w.controller.saveAs();
    await settle();
    expect(w.pending('target')[0]?.payload).toMatchObject({ encoding: 'utf-8', sourceCapabilityId: 'cap-5' });
    w.pending('target')[0]?.reply.resolve({ kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false });
    await settle();
    expect(w.pending('save')[0]?.payload).toMatchObject({ encoding: 'utf-8', sourceCapabilityId: 'cap-5' });
    w.pending('save')[0]?.reply.resolve({ ...SAVED, displayName: 'n.jcx', displayPath: '/n.jcx', ticket: { capabilityId: 'cap-n', documentId: 5 } });
    await settle();
    w.pending('activate')[0]?.reply.resolve({ ok: true });
    await settle();
    expect(w.messages).toEqual([{ kind: 'saved-as-utf8', displayName: 'n.jcx' }]);
    expect(useMuseAppStore.getState().session.writeEncoding).toBe('utf-8');
  });
});

describe('saveController.saveWithin（M3 T4 B3b：守卫的保存分支）', () => {
  it('复用 Open 已持有的租约（不另取、结束时不释放）；SaveResult 在全部终态效果之后给出（M25：fileOp 已清除才算 clean）', async () => {
    const w = world();
    type();
    const open = w.gate.tryAcquire('open', 5);
    if (open === null) throw new Error('acquire failed');
    let result: unknown = null;
    void w.controller.saveWithin(open).then((r) => (result = r));
    await settle();
    expect(w.gate.current()).toBe(open);
    expect(w.pending('save')).toHaveLength(1);
    w.pending('save')[0]?.reply.resolve(SAVED);
    await settle();
    expect(result).toEqual({ ok: true, clean: true });
    expect(w.gate.current()).toBe(open);
    expect(useMuseAppStore.getState().session.fileOp).toBeNull();
  });

  it('租约不是本次 Open 的（save 租约 / 已不持有 / 文档号不符）→ ok: false，不发 IPC、不动租约', async () => {
    const w = world();
    type();
    const save = w.gate.tryAcquire('save', 5);
    if (save === null) throw new Error('acquire failed');
    expect(await w.controller.saveWithin(save)).toEqual({ ok: false, clean: false });
    w.gate.release(save);
    const open = w.gate.tryAcquire('open', 5);
    if (open === null) throw new Error('acquire failed');
    w.gate.release(open);
    expect(await w.controller.saveWithin(open)).toEqual({ ok: false, clean: false });
    const other = w.gate.tryAcquire('open', 99);
    if (other === null) throw new Error('acquire failed');
    expect(await w.controller.saveWithin(other)).toEqual({ ok: false, clean: false });
    expect(w.calls).toEqual([]);
    expect(w.gate.current()).toBe(other);
  });

  it('失败 / 未确认 → ok: false；保存期间继续输入 → ok: true、clean: false；clean 文档 → nothing-to-save 也是 ok 且 clean', async () => {
    const outcomes: unknown[] = [];
    for (const reply of [
      { outcome: 'not-committed', error: { code: 'write-failed', message: 'x' } },
      { ...SAVED, outcome: 'committed-unconfirmed' },
      SAVED,
    ] as const) {
      commitSession(fileSession(), 'trusted');
      type();
      const w = world();
      const open = w.gate.tryAcquire('open', 5);
      if (open === null) throw new Error('acquire failed');
      const pendingResult = w.controller.saveWithin(open);
      await settle();
      if (reply === SAVED) type('more');
      w.pending('save')[0]?.reply.resolve(reply);
      outcomes.push(await pendingResult);
      expect(w.gate.current()).toBe(open);
    }
    expect(outcomes).toEqual([
      { ok: false, clean: false },
      { ok: false, clean: false },
      { ok: true, clean: false },
    ]);
    commitSession(fileSession(), 'trusted');
    const w = world();
    const open = w.gate.tryAcquire('open', 5);
    if (open === null) throw new Error('acquire failed');
    expect(await w.controller.saveWithin(open)).toEqual({ ok: true, clean: true });
    expect(w.calls).toEqual([]);
  });

  it('未命名文档：保存转为 Save As（对话框），切换成功后 clean；结果同样只在激活与会话切换之后给出', async () => {
    commitSession(createDemoSession(), 'none');
    type();
    const w = world();
    const open = w.gate.tryAcquire('open', 0);
    if (open === null) throw new Error('acquire failed');
    let result: unknown = null;
    void w.controller.saveWithin(open).then((r) => (result = r));
    await settle();
    w.pending('target')[0]?.reply.resolve({ kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false });
    await settle();
    w.pending('save')[0]?.reply.resolve({ ...SAVED, displayName: 'n.jcx', displayPath: '/n.jcx', ticket: { capabilityId: 'cap-n', documentId: 0 } });
    await settle();
    expect(result).toBeNull();
    w.pending('activate')[0]?.reply.resolve({ ok: true });
    await settle();
    expect(result).toEqual({ ok: true, clean: true });
    expect(w.gate.current()).toBe(open);
  });
});

describe('saveController.saveWithin —— Save As 取消（P0 §10.3 第 214 行，G3）', () => {
  it('未命名文档的守卫保存转为 Save As、用户取消保存对话框 → SaveResult 不 ok；不发 saveDocument；租约仍由 Open 持有；fileOp 未建立、仍 dirty', async () => {
    commitSession(createDemoSession(), 'none');
    type();
    const w = world();
    const open = w.gate.tryAcquire('open', 0);
    if (open === null) throw new Error('acquire failed');
    const result = w.controller.saveWithin(open);
    await settle();
    w.pending('target')[0]?.reply.resolve({ kind: 'canceled' });
    expect(await result).toEqual({ ok: false, clean: false });
    expect(w.pending('save')).toEqual([]);
    expect(w.gate.current()).toBe(open);
    const { session } = useMuseAppStore.getState();
    expect(session.fileOp).toBeNull();
    expect(isSourceDirty(session)).toBe(true);
  });
});

describe('saveController.saveWithin —— 拒绝时先交付结果（复核 LOW-2，变异 B3b-S6）', () => {
  it('busy 提示抛错也不会让守卫的结果悬而不决', async () => {
    type();
    const gate = createFileIntentGate();
    const controller = createSaveController({
      gate,
      ledger: { send: () => undefined, flush: () => Promise.resolve('delivered'), pending: () => 0 },
      bridge: () => ({ requestSaveTarget: () => new Promise(() => undefined), saveDocument: () => new Promise(() => undefined), activateDocument: () => new Promise(() => undefined) }),
      ime: { view: () => 'idle', subscribe: () => () => undefined },
      blur: () => undefined,
      flushParse: () => undefined,
      refreshParse: () => undefined,
      saveEnabled: () => true,
      schedule: () => () => undefined,
      report: () => undefined,
      publish: () => {
        throw new Error('notice failed');
      },
    });
    const save = gate.tryAcquire('save', 5);
    if (save === null) throw new Error('acquire failed');
    const outcome = await Promise.race([controller.saveWithin(save), new Promise((resolve) => setTimeout(() => resolve('pending'), 50))]);
    expect(outcome).toEqual({ ok: false, clean: false });
  });
});
