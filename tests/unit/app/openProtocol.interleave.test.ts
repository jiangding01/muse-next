/**
 * M3 T1c-2：Open 协议级交错测试（T1c Preflight r2 §9.2 (a)–(i)；(j) 与 busy 的两个来源见 `openProtocol.demoBusy.test.ts`）。
 *
 * main 侧是**真实的** `registerOpenIpc`（`tests/unit/main/openIpcHarness.ts` 的可控 fake 依赖），renderer 侧是真实的
 * Open 控制器 + 真实 store；中间的假桥可以：照常投递、让 main 执行但扣留应答（hold-reply）、扣留请求稍后再投递（hold-request）。
 * 因此「main 已经激活、renderer 没收到应答」「reject 未送达」「导航开始后旧授权已失效」都是 main 的真实状态，而不是 mock 出来的 `{ ok: true }`。
 */


import { afterEach, describe, expect, it } from 'vitest';

import { MAX_ACTIVATION_ATTEMPTS } from '../../../src/renderer/app/editor/openTransaction';
import { storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';
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
