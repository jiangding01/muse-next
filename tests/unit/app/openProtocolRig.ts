/**
 * M3 T1c-2：Open 协议级交错测试的公共装配（不是测试文件）。
 *
 * main 侧是**真实的** `registerOpenIpc`（`tests/unit/main/openIpcHarness.ts` 的可控 fake 依赖），renderer 侧是真实的 Open 控制器
 * 与真实 store；中间的假桥可以照常投递、让 main 执行但扣留应答（hold-reply）、扣留请求稍后投递（hold-request）。
 */

import { expect } from 'vitest';

import { createOpenController } from '../../../src/renderer/app/editor/openController';
import type { OpenControllerDeps } from '../../../src/renderer/app/editor/openController';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { commitSession, downgradeCapabilityTrust, publishOpenView, useMuseAppStore } from '../../../src/renderer/app/store';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN, REJECT } from '../main/openIpcHarness';
import type { FakeSender, Harness } from '../main/openIpcHarness';

export type Policy = 'deliver' | 'hold-reply' | 'hold-request';
export type Channel = 'open' | 'activate' | 'reject';

export interface WireCall {
  readonly channel: Channel;
  readonly payload: unknown;
  /** main 是否已经执行（状态已改变）。 */
  processed(): boolean;
  /** 把扣留的应答交给 renderer（hold-reply）。 */
  release(): void;
  /** 投递扣留的请求：main 执行并把应答交给 renderer（hold-request）。 */
  deliver(): Promise<void>;
}

export const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

export interface Rig {
  readonly h: Harness;
  readonly sender: FakeSender;
  readonly calls: WireCall[];
  readonly policies: Record<Channel, Policy[]>;
  readonly timers: { task: () => void; cancelled: boolean }[];
  readonly controller: ReturnType<typeof createOpenController>;
  /** 让第 index 个激活定时器到期。 */
  fire(index: number): void;
  callsOf(channel: Channel): WireCall[];
  /** 当前 renderer 会话的 documentId 与授权状态。 */
  renderer(): { readonly documentId: number; readonly trust: string; readonly capability: string | null };
  authorized(token: string | null): boolean;
  /** 已发生的会话提交次数。 */
  commits(): number;
  /** 让本 harness 中下一个尚未结束的对话框选中 path（对话框按调用顺序编号，同一 harness 的多个 rig 共用编号）。 */
  resolveNextDialog(path: string | null): void;
}

const dialogCounters = new WeakMap<Harness, number>();

const CHANNELS: Record<Channel, string> = { open: OPEN, activate: ACTIVATE, reject: REJECT };

export function rig(options: { readonly h?: Harness; readonly windowId?: number; readonly deps?: Partial<OpenControllerDeps> } = {}): Rig {
  const h = options.h ?? createHarness();
  const { sender } = h.window(options.windowId ?? 1);
  const calls: WireCall[] = [];
  const policies: Record<Channel, Policy[]> = { open: [], activate: [], reject: [] };
  const timers: { task: () => void; cancelled: boolean }[] = [];
  let commits = 0;

  function controlled(channel: Channel, payload: unknown): Promise<never> {
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

  const deps: OpenControllerDeps = {
    bridge: () => ({
      openDocument: () => controlled('open', DIALOG),
      activateDocument: (ticket) => controlled('activate', { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
      rejectDocument: (ticket) => controlled('reject', { capabilityId: ticket.capabilityId, documentId: ticket.documentId }),
    }),
    schedule: (_delay, task) => {
      const timer = { task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    commit: (session, trust) => {
      commits += 1;
      commitSession(session, trust);
    },
    downgradeTrust: downgradeCapabilityTrust,
    publish: publishOpenView,
    ...options.deps,
  };
  const controller = createOpenController(deps);
  return {
    h,
    sender,
    calls,
    policies,
    timers,
    controller,
    fire(index) {
      const timer = timers[index];
      if (timer === undefined) throw new Error(`no timer #${String(index)}`);
      if (!timer.cancelled) timer.task();
    },
    callsOf: (channel) => calls.filter((call) => call.channel === channel),
    renderer() {
      const state = useMuseAppStore.getState();
      return { documentId: state.session.documentId, trust: state.capabilityTrust, capability: state.session.file?.capability.id ?? null };
    },
    authorized: (token) => token !== null && h.handle.authorize(1, token) !== null,
    commits: () => commits,
    resolveNextDialog(path) {
      const index = dialogCounters.get(h) ?? 0;
      dialogCounters.set(h, index + 1);
      h.resolveDialog(index, path);
    },
  };
}


/** 发起 Open，并让第 n 次对话框选中 path（对话框在 harness 中按调用顺序编号）。 */
export async function openPath(r: Rig, path: string): Promise<void> {
  r.controller.open();
  await settle();
  r.resolveNextDialog(path);
  await settle();
}

/** 正常打开并提交一个文档（前置条件），返回它的 capability。 */
export async function commitDocument(r: Rig, path: string): Promise<string> {
  await openPath(r, path);
  const { capability, trust } = r.renderer();
  expect(trust).toBe('trusted');
  if (capability === null) throw new Error('nothing committed');
  return capability;
}

export const navigationStart = (r: Rig): void => {
  r.h.handle.handleNavigation(1, { isMainFrame: true, isSameDocument: false });
};

/** 每个用例之后把 store 恢复为 demo。 */
export function resetRendererStore(): void {
  commitSession(createDemoSession(), 'none');
  publishOpenView({ phase: 'idle', notice: null });
}
