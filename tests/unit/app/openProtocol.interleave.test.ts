/**
 * M3 T1c-2：Open 协议级交错测试（T1c Preflight r2 §9.2 (a)–(i)；(j) 与 busy 的两个来源见 `openProtocol.demoBusy.test.ts`）。
 *
 * main 侧是**真实的** `registerOpenIpc`（`tests/unit/main/openIpcHarness.ts` 的可控 fake 依赖），renderer 侧是真实的
 * Open 控制器 + 真实 store；中间的假桥可以：照常投递、让 main 执行但扣留应答（hold-reply）、扣留请求稍后再投递（hold-request）。
 * 因此「main 已经激活、renderer 没收到应答」「reject 未送达」「导航开始后旧授权已失效」都是 main 的真实状态，而不是 mock 出来的 `{ ok: true }`。
 * M3 T3a（r3a 复核 H-1）：控制器在各环节抛错时按事务阶段 fail closed——main 中的真实授权状态、renderer 会话与信任、替换标志、无未处理拒绝。
 */


import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAX_ACTIVATION_ATTEMPTS } from '../../../src/renderer/app/editor/openTransaction';
import type { OpenControllerDeps, OpenEditorGate } from '../../../src/renderer/app/editor/openController';
import { commitSession, storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';
import { commitDocument, navigationStart, openPath, resetRendererStore, rig, settle } from './openProtocolRig';

afterEach(resetRendererStore);

describe('Open 交错 —— 激活应答丢失与重试', () => {
  it('(a) main 已激活但应答丢失：renderer 不提前提交；同票重试得到 ok 后只提交一次；A 已被吊销', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    const committedA = r.renderer().documentId;
    r.policies.activate.push('hold-reply');
    await openPath(r, '/docs/b.jcx');
    const [first] = r.callsOf('activate').slice(-1);
    expect(first?.processed()).toBe(true);
    expect(r.authorized(a)).toBe(false);
    expect(r.renderer()).toMatchObject({ documentId: committedA, trust: 'trusted' });
    const commitsBefore = r.commits();
    r.fire(r.timers.length - 1);
    await settle();
    expect(r.commits()).toBe(commitsBefore + 1);
    const { capability, documentId, trust } = r.renderer();
    expect(trust).toBe('trusted');
    expect(documentId).not.toBe(committedA);
    expect(r.authorized(capability)).toBe(true);
    expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
    r.h.expectConsistent();
  });

  it('(b)(c) 全部重试的应答都丢失、reject 也未送达：保留 A 并降为 unverified；main 中 B 仍为 active；送达后 B 被吊销；迟到 ok 不提交', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    const committedA = r.renderer().documentId;
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) r.policies.activate.push('hold-reply');
    r.policies.reject.push('hold-request');
    await openPath(r, '/docs/b.jcx');
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) {
      r.fire(r.timers.length - 1);
      await settle();
    }
    expect(r.renderer()).toMatchObject({ documentId: committedA, capability: a, trust: 'unverified' });
    const rejects = r.callsOf('reject');
    expect(rejects).toHaveLength(1);
    const ticket = rejects[0]?.payload;
    const bToken = typeof ticket === 'object' && ticket !== null && 'capabilityId' in ticket ? String(ticket.capabilityId) : null;
    // renderer 已发出 reject，但 main 还没收到：B 仍是 active，A 早已被吊销——renderer 不能据「已发 reject」推断任何东西。
    expect(r.authorized(bToken)).toBe(true);
    expect(r.authorized(a)).toBe(false);
    const commits = r.commits();
    for (const call of r.callsOf('activate').slice(-MAX_ACTIVATION_ATTEMPTS)) call.release();
    await settle();
    expect(r.commits()).toBe(commits);
    await rejects[0]?.deliver();
    await settle();
    expect(r.authorized(bToken)).toBe(false);
    expect(r.renderer()).toMatchObject({ documentId: committedA, trust: 'unverified' });
    r.h.expectConsistent();
  });

  it('(d) 上一事务迟到的 reject 在新事务 C 激活之后才送达：C 不受影响', async () => {
    const r = rig();
    await commitDocument(r, '/docs/a.jcx');
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) r.policies.activate.push('hold-reply');
    r.policies.reject.push('hold-request');
    await openPath(r, '/docs/b.jcx');
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) {
      r.fire(r.timers.length - 1);
      await settle();
    }
    const c = await commitDocument(r, '/docs/a.jcx');
    await r.callsOf('reject')[0]?.deliver();
    await settle();
    expect(r.authorized(c)).toBe(true);
    expect(r.renderer()).toMatchObject({ capability: c, trust: 'trusted' });
    r.h.expectConsistent();
  });

  it('(h) 第 1 次尝试超时、它的迟到应答在第 2 次尝试期间到达：只提交一次', async () => {
    const r = rig();
    r.policies.activate.push('hold-reply', 'hold-reply');
    await openPath(r, '/docs/a.jcx');
    r.fire(r.timers.length - 1);
    await settle();
    const [first, second] = r.callsOf('activate');
    first?.release();
    await settle();
    expect(r.commits()).toBe(1);
    second?.release();
    await settle();
    expect(r.commits()).toBe(1);
    expect(r.authorized(r.renderer().capability)).toBe(true);
  });
});

describe('Open 交错 —— 导航开始（页面代次重置）', () => {
  it('(e) main 已回复 opened、renderer 尚未收到时导航开始：激活得到 invalid，降为 unverified；A 已在 main 被吊销', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    r.policies.open.push('hold-reply');
    r.controller.open();
    await settle();
    r.resolveNextDialog('/docs/b.jcx');
    await settle();
    navigationStart(r);
    r.callsOf('open').slice(-1)[0]?.release();
    await settle();
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expect(useMuseAppStore.getState().open.notice).toEqual({ kind: 'activation-invalid' });
    expect(r.authorized(a)).toBe(false);
    expect(r.commits()).toBe(1);
  });

  it('(f) 激活请求发出后、main 处理前导航开始：invalid → unverified，不提交', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    r.policies.activate.push('hold-request');
    await openPath(r, '/docs/b.jcx');
    navigationStart(r);
    await r.callsOf('activate').slice(-1)[0]?.deliver();
    await settle();
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expect(r.commits()).toBe(1);
  });

  it('(g) 导航开始但未提交（被中止）：A 被静默吊销而 renderer 仍为 trusted（已接受风险，trusted 不是授权证明）；重新 Open 后收敛为唯一 active', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    navigationStart(r);
    expect(r.authorized(a)).toBe(false);
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'trusted' });
    const b = await commitDocument(r, '/docs/b.jcx');
    expect(r.authorized(b)).toBe(true);
    expect([...r.h.handle.currentState().table.values()].filter((record) => record.state === 'active').map((record) => record.token)).toEqual([b]);
    r.h.expectConsistent();
  });

  it('(i) 对话框期间页面代次被重置：open 回复 superseded，降为 unverified，不提交', async () => {
    const r = rig();
    const a = await commitDocument(r, '/docs/a.jcx');
    r.controller.open();
    await settle();
    navigationStart(r);
    r.resolveNextDialog('/docs/b.jcx');
    await settle();
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expect(useMuseAppStore.getState().open.notice).toEqual({ kind: 'superseded' });
    expect(r.commits()).toBe(1);
  });
});

/**
 * 可在指定环节抛错的编辑器门控、报告收集，以及注入它们（和 `extra`）的 rig（r3a 复核 H-1）。
 * `arm.gateAt` 指第几次 gate() 调用抛错：一次 Open 中 +1 为 open() 入口，+2 为 open 应答，+3 为激活应答。
 */
function failing(extra: Partial<OpenControllerDeps> = {}) {
  const pendings: boolean[] = [];
  const reports: string[] = [];
  const arm = { gateAt: -1, beforeCommit: false };
  let gates = 0;
  const editor: OpenEditorGate = {
    gate: () => {
      gates += 1;
      if (gates === arm.gateAt) throw new Error('gate exploded');
      return { dirty: false, composing: false };
    },
    beforeCommit: () => {
      if (arm.beforeCommit) throw new Error('beforeCommit exploded');
    },
    setReplacementPending: (pending) => pendings.push(pending),
    notify: () => undefined,
  };
  const report = (_error: unknown, context: string): void => {
    reports.push(context);
  };
  const r = rig({ deps: { editor, report, ...extra } });
  return { r, pendings, reports, arm, gateCallsSoFar: () => gates };
}

type Failing = ReturnType<typeof failing>;

const tokenOf = (payload: unknown): string | null =>
  typeof payload === 'object' && payload !== null && 'capabilityId' in payload ? String(payload.capabilityId) : null;

/** 事务已终结并清除替换标志，视图为 idle 与给定提示。 */
function expectFinished(f: Failing, notice: string | null): void {
  expect(f.r.controller.state().phase).toBe('idle');
  expect(useMuseAppStore.getState().open).toEqual({ phase: 'idle', notice: notice === null ? null : { kind: notice } });
  expect(f.pendings.at(-1)).toBe(false);
}

describe('Open 交错 —— 控制器异常 fail closed（r3a 复核 H-1）', () => {
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
    expect(unhandled).toEqual([]);
  });

  it.each([
    ['beforeCommit 抛错', (f: Failing) => (f.arm.beforeCommit = true)],
    ['读取 dirty 抛错', (f: Failing) => (f.arm.gateAt = f.gateCallsSoFar() + 3)],
  ])('情形 2：激活成功后%s（main 已激活 B）→ reject B、A 降级，提示 activation-unresolved，只报告一次；随后可再次 Open', async (_label, arm) => {
    const f = failing();
    const { r } = f;
    const a = await commitDocument(r, '/docs/a.jcx');
    arm(f);
    await openPath(r, '/docs/b.jcx');
    expect(f.reports).toEqual(['open']);
    expect(r.commits()).toBe(1);
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expectFinished(f, 'activation-unresolved');
    const rejects = r.callsOf('reject');
    expect(rejects).toHaveLength(1);
    await settle();
    expect(r.authorized(tokenOf(rejects[0]?.payload))).toBe(false);
    expect(r.authorized(a)).toBe(false);
    expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
    f.arm.gateAt = -1;
    f.arm.beforeCommit = false;
    expect(r.authorized(await commitDocument(r, '/docs/a.jcx'))).toBe(true);
    r.h.expectConsistent();
  });

  /** 提交环节的故障注入：A 正常提交后再打开 B；`before` 写入前抛错，`after` 写入后抛错（订阅者），`notify` 解析调度通知抛错。 */
  async function openBWithCommitFault(fault: 'before' | 'after' | 'notify') {
    const armed = { on: false, notified: 0 };
    const explode = (where: typeof fault): void => {
      if (armed.on && fault === where) throw new Error(`${where} exploded`);
    };
    const f = failing({
      commit: (session, trust) => {
        explode('before');
        commitSession(session, trust);
        explode('after');
      },
      afterCommit: () => {
        armed.notified += 1;
        explode('notify');
      },
    });
    const a = await commitDocument(f.r, '/docs/a.jcx');
    armed.on = true;
    await openPath(f.r, '/docs/b.jcx');
    return { f, a, notified: armed.notified };
  }

  it('情形 2：store 提交抛错且未写入（main 已激活 B，renderer 仍是 A）→ reject B、A 降级，提示 activation-invalid', async () => {
    const { f, a, notified } = await openBWithCommitFault('before');
    expect(f.reports).toEqual(['open-commit']);
    expect(notified).toBe(1);
    expect(f.r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expectFinished(f, 'activation-invalid');
    await settle();
    expect(f.r.authorized(tokenOf(f.r.callsOf('reject')[0]?.payload))).toBe(false);
    expect(storeConsistencyProblems(useMuseAppStore.getState())).toEqual([]);
  });

  it.each([
    ['写入之后订阅者抛错', 'after', 'open-commit'],
    ['随后的解析调度通知抛错', 'notify', 'open-after-commit'],
  ] as const)('情形 3：会话已成功提交、%s → B 保持 trusted 且在 main 中有效，不 reject、不降级，只报告', async (_label, fault, context) => {
    const { f, notified } = await openBWithCommitFault(fault);
    const { capability, trust } = f.r.renderer();
    expect(trust).toBe('trusted');
    expect(f.r.authorized(capability)).toBe(true);
    expect(f.r.callsOf('reject')).toEqual([]);
    expect(f.reports).toEqual([context]);
    expect(notified).toBe(2);
    expectFinished(f, null);
  });

  it('终态效果（降级）抛错：事务已终结，视图仍发布为 idle、替换标志清除、只报告', async () => {
    const f = failing({
      downgradeTrust: () => {
        throw new Error('downgrade exploded');
      },
    });
    await commitDocument(f.r, '/docs/a.jcx');
    f.r.policies.activate.push('hold-request');
    await openPath(f.r, '/docs/b.jcx');
    navigationStart(f.r);
    await f.r.callsOf('activate').at(-1)?.deliver();
    await settle();
    expect(f.reports).toEqual(['open']);
    expectFinished(f, 'activation-invalid');
  });

  it('情形 1：open 应答处理时读取 dirty 抛错（候选尚未激活）→ 只撤回 pending 的 B，不发激活；A 仍 trusted 且有效', async () => {
    const f = failing();
    const { r } = f;
    const a = await commitDocument(r, '/docs/a.jcx');
    const activations = r.callsOf('activate').length;
    f.arm.gateAt = f.gateCallsSoFar() + 2;
    await openPath(r, '/docs/b.jcx');
    expect(r.callsOf('activate')).toHaveLength(activations);
    expect(r.callsOf('reject')).toHaveLength(1);
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'trusted' });
    expect(r.authorized(a)).toBe(true);
    expectFinished(f, 'prepare-failed');
    expect(f.reports).toEqual(['open']);
    r.h.expectConsistent();
  });

  it('情形 2：第 1 次激活超时后安排重试时调度抛错 → fail closed 为 activation-unresolved，不永久挂起', async () => {
    const tasks: (() => void)[] = [];
    let explodeSchedule = false;
    const f = failing({
      schedule: (_delay, task) => {
        if (explodeSchedule) throw new Error('schedule exploded');
        tasks.push(task);
        return () => undefined;
      },
    });
    const { r } = f;
    const a = await commitDocument(r, '/docs/a.jcx');
    r.policies.activate.push('hold-reply');
    await openPath(r, '/docs/b.jcx');
    explodeSchedule = true;
    tasks.at(-1)?.();
    await settle();
    expect(f.reports).toEqual(['open']);
    expect(r.renderer()).toMatchObject({ capability: a, trust: 'unverified' });
    expectFinished(f, 'activation-unresolved');
    expect(r.callsOf('reject')).toHaveLength(1);
    // 被扣留的第 1 次应答迟到：事务已终结，不提交。
    r.callsOf('activate').at(-1)?.release();
    await settle();
    expect(r.renderer().capability).toBe(a);
  });
});
