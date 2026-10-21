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
import type { OpenControllerDeps, OpenEditorGate } from '../../../src/renderer/app/editor/openController';
import type { OpenGate } from '../../../src/renderer/app/editor/editorController';
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

/** 可控的编辑器门控：记录调用顺序与 replacementPending 的变化。 */
function editorGate(initial: { dirty?: boolean; composing?: boolean } = {}) {
  const status = { dirty: initial.dirty ?? false, composing: initial.composing ?? false, pending: false };
  const log: string[] = [];
  const notices: string[] = [];
  const gate: OpenEditorGate = {
    gate: () => {
      log.push('gate');
      return { dirty: status.dirty, composing: status.composing };
    },
    beforeCommit: () => {
      log.push('beforeCommit');
      status.composing = false;
    },
    setReplacementPending: (value) => {
      if (value !== status.pending) log.push(value ? 'pending:on' : 'pending:off');
      status.pending = value;
    },
    notify: (notice) => notices.push(notice.kind),
  };
  return { status, log, notices, gate };
}

describe('openController —— 编辑器门控（M3 T3a，S5 / H3-2）', () => {
  it.each([
    ['dirty', { dirty: true }, 'open-refused-dirty'],
    ['组字中', { composing: true }, 'open-refused-composing'],
  ] as const)('入口：%s 时拒绝 Open，不调用 openDocument、不进入事务', (_name, initial, notice) => {
    const e = editorGate(initial);
    const f = fixture({ editor: e.gate });
    f.controller.open();
    expect(f.opens).toHaveLength(0);
    expect(f.controller.state().phase).toBe('idle');
    expect(e.notices).toEqual([notice]);
    expect(e.status.pending).toBe(false);
  });

  it('replacementPending：事务离开 idle 即置位；提交时仍为真（提交效果中可见）；提交后才清除；提交前先结束组字再读 dirty', async () => {
    const e = editorGate({ composing: false });
    const pendingAtCommit: boolean[] = [];
    const f = fixture({
      editor: e.gate,
      commit: () => {
        pendingAtCommit.push(e.status.pending);
      },
    });
    f.controller.open();
    expect(e.status.pending).toBe(true);
    f.open(0).resolve({ kind: 'opened', document: DOCUMENT });
    await flush();
    expect(e.status.pending).toBe(true);
    e.log.length = 0;
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(pendingAtCommit).toEqual([true]);
    expect(e.log).toEqual(['beforeCommit', 'gate', 'pending:off']);
    expect(e.status.pending).toBe(false);
  });

  it('opened 时已 dirty：丢弃 pending 候选（reject 一次），不激活、不降级，给出编辑器提示', async () => {
    const e = editorGate();
    const f = fixture({ editor: e.gate });
    f.controller.open();
    e.status.dirty = true;
    f.open(0).resolve({ kind: 'opened', document: DOCUMENT });
    await flush();
    expect(f.activations).toHaveLength(0);
    expect(f.rejects.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.downgrades()).toBe(0);
    expect(e.notices).toEqual(['open-candidate-dropped-dirty']);
    expect(e.status.pending).toBe(false);
  });

  it('激活成功时已 dirty（最后防线）：不提交、reject 已激活候选、降级授权，提示沿用 activation-invalid', async () => {
    const e = editorGate();
    const f = fixture({ editor: e.gate });
    await toActivation(f);
    e.status.dirty = true;
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toEqual([]);
    expect(f.rejects.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.downgrades()).toBe(1);
    expect(f.controller.state().notice).toEqual({ kind: 'activation-invalid' });
    expect(e.notices).toEqual(['open-commit-refused-dirty']);
  });

  type Driver = (f: ReturnType<typeof fixture>, e: ReturnType<typeof editorGate>) => Promise<void>;
  const reply = (value: unknown): Driver => async (f) => {
    f.controller.open();
    f.open(0).resolve(value);
    await flush();
  };
  const activated = (value: unknown, dirty = false): Driver => async (f, e) => {
    await toActivation(f);
    e.status.dirty = dirty;
    f.activation(0).resolve(value);
    await flush();
  };
  const TERMINALS: readonly (readonly [string, Driver])[] = [
    ['canceled', reply({ kind: 'canceled' })],
    ['failed', reply({ kind: 'failed', error: { code: 'not-found', message: 'm' } })],
    ['busy', reply({ kind: 'rejected', reason: 'busy' })],
    ['superseded', reply({ kind: 'rejected', reason: 'superseded' })],
    ['prepare-failed', reply({ kind: 'opened', document: { documentId: 4 } })],
    [
      'open-threw',
      async (f) => {
        f.controller.open();
        f.open(0).reject(new Error('boom'));
        await flush();
      },
    ],
    [
      'opened + dirty',
      async (f, e) => {
        f.controller.open();
        e.status.dirty = true;
        f.open(0).resolve({ kind: 'opened', document: DOCUMENT });
        await flush();
      },
    ],
    ['commit', activated({ ok: true })],
    ['commit 时 dirty', activated({ ok: true }, true)],
    ['activation-invalid', activated({ ok: false, code: 'capability-invalid' })],
    ['activation-mismatch', activated({ ok: false, code: 'document-mismatch' })],
    [
      'activation-unresolved',
      async (f) => {
        await toActivation(f);
        for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt += 1) {
          f.fire(attempt);
          await flush();
        }
      },
    ],
  ];

  it.each(TERMINALS)('终态 %s：replacementPending 清除、回到 idle，之后可以再次 Open（全部 12 种终态，r3a 审查 M-3）', async (_name, drive) => {
    const e = editorGate();
    const f = fixture({ editor: e.gate });
    await drive(f, e);
    expect(e.status.pending).toBe(false);
    expect(f.controller.state().phase).toBe('idle');
    e.status.dirty = false;
    const before = f.opens.length;
    f.controller.open();
    expect(f.opens).toHaveLength(before + 1);
  });

  it('失败的激活应答与已终结事务的迟到 ok 都不调用 beforeCommit（T3c 中它会丢弃组字）', async () => {
    const failing = editorGate();
    await activated({ ok: false, code: 'capability-invalid' })(fixture({ editor: failing.gate }), failing);
    expect(failing.log).not.toContain('beforeCommit');
    const late = editorGate();
    const f = fixture({ editor: late.gate });
    await toActivation(f);
    for (let attempt = 0; attempt < MAX_ACTIVATION_ATTEMPTS; attempt += 1) {
      f.fire(attempt);
      await flush();
    }
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toEqual([]);
    expect(late.log).not.toContain('beforeCommit');
  });

  it('未注入门控时等同「从不 dirty、从不组字」：既有协议行为不变', async () => {
    const f = fixture();
    await toActivation(f);
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toHaveLength(1);
  });
});

describe('openController —— 异常边界补漏（r3a 复核 H-1；独立审查 L1 / L2 / L4 / L8）', () => {
  afterEach(() => {
    commitSession(createDemoSession(), 'none');
  });
  const quietGate = (overrides: Partial<OpenEditorGate> = {}): OpenEditorGate => ({
    gate: () => ({ dirty: false, composing: false }),
    beforeCommit: () => undefined,
    setReplacementPending: () => undefined,
    notify: () => undefined,
    ...overrides,
  });
  const explode = (what: string) => (): never => {
    throw new Error(`${what} exploded`);
  };

  it('activate 的 invoke 被拒绝、安排重试时调度抛错：fail closed（reject + 降级 + activation-unresolved）', async () => {
    const reports: string[] = [];
    let scheduled = 0;
    const f = fixture({
      report: (_error, context) => reports.push(context),
      schedule: () => {
        scheduled += 1;
        if (scheduled > 1) throw new Error('schedule exploded');
        return () => undefined;
      },
    });
    await toActivation(f);
    f.activation(0).reject(new Error('ipc down'));
    await flush();
    expect(reports).toEqual(['open']);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: 'activation-unresolved' } });
    expect(f.rejects.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.downgrades()).toBe(1);
  });

  it.each([
    ['beforeCommit 抛错', { editor: quietGate({ beforeCommit: explode('beforeCommit') }) }, 'activation-unresolved'],
    ['store 提交抛错', { commit: explode('commit'), committed: () => false }, 'activation-invalid'],
  ] as const)('报告器自身也抛错时，%s 仍 fail closed：reject 候选并降级，不提交', async (_label, deps, notice) => {
    const f = fixture({ report: explode('report'), ...deps });
    await toActivation(f);
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(f.commits).toEqual([]);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: notice } });
    expect(f.rejects.map((c) => c.ticket)).toEqual([TICKET]);
    expect(f.downgrades()).toBe(1);
  });

  it('写入之后订阅者换成同一文档的另一个会话对象再抛错：按已提交处理（以文档号判断），不 reject、不降级', async () => {
    const f = fixture({
      report: () => undefined,
      commit: (session, trust) => {
        commitSession(session, trust);
        commitSession({ ...session }, trust);
        throw new Error('subscriber exploded');
      },
    });
    await toActivation(f);
    f.activation(0).resolve({ ok: true });
    await flush();
    expect(useMuseAppStore.getState().session.documentId).toBe(4);
    expect(f.rejects).toEqual([]);
    expect(f.downgrades()).toBe(0);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: null });
  });

  it('open() 中置位替换标志抛错：不抛给调用方、不挂起（按 open 抛错收束），随后可再次 Open', async () => {
    const reports: string[] = [];
    let armed = true;
    const setReplacementPending = (pending: boolean): void => {
      if (pending && armed) {
        armed = false;
        throw new Error('flag exploded');
      }
    };
    const f = fixture({ editor: quietGate({ setReplacementPending }), report: (_error, context) => reports.push(context) });
    expect(() => f.controller.open()).not.toThrow();
    expect(reports).toEqual(['open']);
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: { kind: 'request-rejected' } });
    expect(f.downgrades()).toBe(1);
    f.controller.open();
    await flush();
    expect(f.opens).toHaveLength(1);
  });

  it('canceled 应答不读取 dirty：门控抛错也不会把它当成异常而降级', async () => {
    let gates = 0;
    const gate = (): OpenGate => {
      gates += 1;
      if (gates > 1) throw new Error('gate exploded');
      return { dirty: false, composing: false };
    };
    const f = fixture({ editor: quietGate({ gate }), report: explode('report') });
    f.controller.open();
    f.open(0).resolve({ kind: 'canceled' });
    await flush();
    expect(f.controller.state()).toMatchObject({ phase: 'idle', notice: null });
    expect(f.downgrades()).toBe(0);
  });
});
