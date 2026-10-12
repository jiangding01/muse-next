/**
 * M3 T1c-2：Open 事务适配层（`src/renderer/app/editor/openController.ts`）。
 *
 * 用可控的假桥（每次调用一个可手动结束的 Promise）与手动定时器证明：Open 不设超时；每次激活单独计时，超时 / invoke 抛错 /
 * 畸形应答进入同票重试；重叠的未 settle 尝试与迟到应答只会提交一次；预算耗尽后尽力发 reject（不等待、不依赖其结果）；
 * 同步抛错的桥按失败处理；控制器不依赖任何组件生命周期（组件卸载后事务照常收束到 store）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { ACTIVATION_TIMEOUT_MS, MAX_ACTIVATION_ATTEMPTS } from '../../../src/renderer/app/editor/openTransaction';
import { createOpenController } from '../../../src/renderer/app/editor/openController';
import type { OpenControllerDeps } from '../../../src/renderer/app/editor/openController';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { commitSession, downgradeCapabilityTrust, publishOpenView, storeConsistencyProblems, useMuseAppStore } from '../../../src/renderer/app/store';
import type { OpenView } from '../../../src/renderer/app/store';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface Call extends Pending {
  readonly ticket: DocumentActivationTicket | null;
}

/** 可手动结束的调用；`resolve` 接受任意值（反例需要注入畸形应答），经 `Reflect.apply` 交给 Promise，不做类型断言。 */
function pending(calls: Call[], ticket: DocumentActivationTicket | null): Promise<never> {
  return new Promise<never>((resolve, reject) => {
    calls.push({ resolve: (value) => Reflect.apply(resolve, undefined, [value]), reject, ticket });
  });
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const DOCUMENT = {
  documentId: 4,
  source: 'X:1\nT:ctl\nK:C\nCDEF|\n',
  writeEncoding: 'utf-8',
  byteBom: 'none',
  encodingRoundTrip: 'exact',
  file: { capability: { id: 'cap-4' }, displayName: 'c.jcx', displayPath: '/c.jcx' },
};
const TICKET = { capabilityId: 'cap-4', documentId: 4 };

function fixture(overrides: Partial<OpenControllerDeps> = {}) {
  const opens: Call[] = [];
  const activations: Call[] = [];
  const rejects: Call[] = [];
  const timers: { delay: number; task: () => void; cancelled: boolean }[] = [];
  const commits: { documentId: number; trust: string }[] = [];
  const views: OpenView[] = [];
  let downgrades = 0;
  const controller = createOpenController({
    bridge: () => ({
      openDocument: () => pending(opens, null),
      activateDocument: (ticket) => pending(activations, ticket),
      rejectDocument: (ticket) => pending(rejects, ticket),
    }),
    schedule: (delay, task) => {
      const timer = { delay, task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    commit: (session, trust) => commits.push({ documentId: session.documentId, trust }),
    downgradeTrust: () => {
      downgrades += 1;
    },
    publish: (view) => views.push(view),
    ...overrides,
  });
  const fire = (index: number): void => {
    const timer = timers[index];
    if (timer === undefined) throw new Error(`no timer #${String(index)}`);
    if (!timer.cancelled) timer.task();
  };
  const at = (list: Call[], index: number): Call => {
    const call = list[index];
    if (call === undefined) throw new Error(`no call #${String(index)}`);
    return call;
  };
  return {
    controller,
    opens,
    activations,
    rejects,
    timers,
    commits,
    views,
    downgrades: () => downgrades,
    fire,
    open: (index: number) => at(opens, index),
    activation: (index: number) => at(activations, index),
  };
}

async function toActivation(f: ReturnType<typeof fixture>): Promise<void> {
  f.controller.open();
  f.open(0).resolve({ kind: 'opened', document: DOCUMENT });
  await flush();
}

describe('openController —— 正常路径与 Open 不设超时', () => {
  it('opened → 激活 ok：只提交一次（trusted），视图依次为 requesting / activating / idle', async () => {
    const f = fixture();
    await toActivation(f);
    expect(f.activations.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.timers.map((t) => t.delay)).toEqual([ACTIVATION_TIMEOUT_MS]);
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toEqual([{ documentId: 4, trust: 'trusted' }]);
    expect(f.views.map((v) => v.phase)).toEqual(['requesting', 'activating', 'idle']);
    expect(f.timers[0]?.cancelled).toBe(true);
    expect(f.downgrades()).toBe(0);
  });

  it('Open 阶段不建定时器（用户可以长时间停留在原生对话框中）；重入不再次调用 openDocument', async () => {
    const f = fixture();
    f.controller.open();
    f.controller.open();
    await flush();
    expect(f.opens).toHaveLength(1);
    expect(f.timers).toHaveLength(0);
    expect(f.controller.state().phase).toBe('requesting');
  });
});

describe('openController —— 激活不确定（保守 R1）', () => {
  it('超时 → 同票重试 → 成功：只提交一次；第一次尝试的迟到 ok 不再提交', async () => {
    const f = fixture();
    await toActivation(f);
    f.fire(0);
    expect(f.activations.map((c) => c.ticket)).toEqual([TICKET, TICKET]);
    expect(f.controller.state().phase).toBe('uncertain');
    f.activation(1).resolve({ ok: true });
    await flush();
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toHaveLength(1);
  });

  it('第一次尝试超时后，它的迟到 ok 在重试进行中到达：提交一次，重试的应答随后被忽略', async () => {
    const f = fixture();
    await toActivation(f);
    f.fire(0);
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toHaveLength(1);
    f.activation(1).resolve({ ok: true });
    await flush();
    expect(f.commits).toHaveLength(1);
  });

  it('invoke 抛错立即重试；已取消的定时器不会再推进预算', async () => {
    const f = fixture();
    await toActivation(f);
    f.activation(0).reject(new Error('ipc broke'));
    await flush();
    expect(f.activations).toHaveLength(2);
    f.fire(0);
    expect(f.activations).toHaveLength(2);
    expect(f.controller.state().attempt).toBe(2);
  });

  it('畸形激活应答按不确定处理（不提交，进入重试）', async () => {
    const f = fixture();
    await toActivation(f);
    f.activation(0).resolve({ ok: 'yes' });
    await flush();
    expect(f.commits).toHaveLength(0);
    expect(f.activations).toHaveLength(2);
  });

  it(`${String(MAX_ACTIVATION_ATTEMPTS)} 次都超时：不提交、降级、发一次 reject（不等待其结果）；之后迟到的 ok 不提交`, async () => {
    const f = fixture();
    await toActivation(f);
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) f.fire(i);
    expect(f.activations).toHaveLength(MAX_ACTIVATION_ATTEMPTS);
    expect(f.rejects.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.downgrades()).toBe(1);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: 'activation-unresolved' } });
    for (const call of f.activations) call.resolve({ ok: true });
    await flush();
    expect(f.commits).toHaveLength(0);
    // reject 永不 settle 或失败都不影响任何状态。
    f.rejects[0]?.reject(new Error('lost'));
    await flush();
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: 'activation-unresolved' } });
  });
});

describe('openController —— 打开阶段的失败', () => {
  it('桥同步抛错：按 open 抛错处理（降级，不提交）', async () => {
    const f = fixture({
      bridge: () => {
        throw new Error('bridge missing');
      },
    });
    f.controller.open();
    await flush();
    expect(f.downgrades()).toBe(1);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: 'request-rejected' } });
  });

  it('畸形 open 回复按抛错处理；busy 只提示不降级', async () => {
    const f = fixture();
    f.controller.open();
    f.open(0).resolve({ kind: 'mystery' });
    await flush();
    expect(f.downgrades()).toBe(1);
    f.controller.open();
    f.open(1).resolve({ kind: 'rejected', reason: 'busy' });
    await flush();
    expect(f.downgrades()).toBe(1);
    expect(f.controller.state().notice).toEqual({ kind: 'busy' });
    f.controller.dismissNotice();
    expect(f.controller.state().notice).toBeNull();
  });
});

describe('openController —— 与真实 store 集成、不依赖组件生命周期', () => {
  afterEach(() => {
    commitSession(createDemoSession(), 'none');
    publishOpenView({ phase: 'idle', notice: null });
  });

  it('组件全部退订（卸载）后事务照常收束：store 提交新会话、派生字段一致；重新订阅读到同一状态', async () => {
    const listeners = [useMuseAppStore.subscribe(() => undefined), useMuseAppStore.subscribe(() => undefined)];
    const f = fixture({ commit: commitSession, downgradeTrust: downgradeCapabilityTrust, publish: publishOpenView });
    await toActivation(f);
    expect(useMuseAppStore.getState().open.phase).toBe('activating');
    expect(useMuseAppStore.getState().session.documentId).toBe(0);
    for (const unsubscribe of listeners) unsubscribe();
    f.activation(0).resolve({ ok: true });
    await flush();
    let seen = -1;
    const unsubscribe = useMuseAppStore.subscribe((state) => {
      seen = state.session.documentId;
    });
    const state = useMuseAppStore.getState();
    expect([state.session.documentId, state.capabilityTrust, state.open.phase]).toEqual([4, 'trusted', 'idle']);
    expect(storeConsistencyProblems(state)).toEqual([]);
    publishOpenView({ phase: 'idle', notice: null });
    expect(seen).toBe(4);
    unsubscribe();
  });

  it('激活提交之前当前会话、派生字段与授权都不变', async () => {
    const f = fixture({ commit: commitSession, downgradeTrust: downgradeCapabilityTrust, publish: publishOpenView });
    const before = useMuseAppStore.getState();
    await toActivation(f);
    f.fire(0);
    const during = useMuseAppStore.getState();
    expect([during.session, during.score, during.index, during.diagnostics, during.capabilityTrust]).toEqual([
      before.session,
      before.score,
      before.index,
      before.diagnostics,
      before.capabilityTrust,
    ]);
  });
});
