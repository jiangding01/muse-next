/**
 * M3 T1c-2：Open 协议级交错测试（续）——(j) 从 demo 出发的失败路径，以及 main `busy` 的两个来源（物理对话框、协调器逻辑锁）。
 * 装配见 `openProtocolRig.ts`（真实 `registerOpenIpc` + 真实控制器与 store）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MAX_ACTIVATION_ATTEMPTS } from '../../../src/renderer/app/editor/openTransaction';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { commitSession, useMuseAppStore } from '../../../src/renderer/app/store';
import { createHarness } from '../main/openIpcHarness';
import type { FakeWindow } from '../main/openIpcHarness';
import { navigationStart, openPath, resetRendererStore, rig, settle } from './openProtocolRig';

afterEach(resetRendererStore);

describe('Open 交错 —— demo 与 busy', () => {
  it('(j) 从 demo 出发的所有失败路径：会话保持 demo，trust 恒为 none', async () => {
    const r = rig();
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) r.policies.activate.push('hold-reply');
    await openPath(r, '/docs/a.jcx');
    for (let i = 0; i < MAX_ACTIVATION_ATTEMPTS; i += 1) {
      r.fire(r.timers.length - 1);
      await settle();
    }
    expect(r.renderer()).toEqual({ documentId: 0, trust: 'none', capability: null });
    r.policies.activate.push('hold-request');
    await openPath(r, '/docs/b.jcx');
    navigationStart(r);
    await r.callsOf('activate').slice(-1)[0]?.deliver();
    await settle();
    expect(r.renderer()).toEqual({ documentId: 0, trust: 'none', capability: null });
    r.controller.open();
    await settle();
    navigationStart(r);
    r.resolveNextDialog('/docs/a.jcx');
    await settle();
    expect(r.renderer()).toEqual({ documentId: 0, trust: 'none', capability: null });
    expect(r.commits()).toBe(0);
  });

  it('busy（物理对话框）：刷新前的对话框仍未结束，新页面的 Open 收到 busy；只提示，不降级、不改会话', async () => {
    const h = createHarness();
    const oldPage = rig({ h, deps: { commit: () => undefined, downgradeTrust: () => undefined, publish: () => undefined } });
    oldPage.controller.open();
    await settle();
    h.handle.handleNavigation(1, { isMainFrame: true, isSameDocument: false });
    h.handle.handleNavigationCommitted(1);
    commitSession(createDemoSession(), 'none');
    const newPage = rig({ h });
    const before = useMuseAppStore.getState().session;
    newPage.controller.open();
    await settle();
    // 来源是物理对话框：逻辑锁已随页面代次释放，未结束的对话框仍属于当前窗口实例（不是孤儿）。
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect([h.handle.pendingNativeDialogs(), h.handle.orphanedNativeDialogs()]).toEqual([1, 0]);
    expect(useMuseAppStore.getState().open.notice).toEqual({ kind: 'busy' });
    expect(useMuseAppStore.getState().session).toBe(before);
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    h.resolveDialog(0, null);
    await settle();
  });

  it('busy（协调器逻辑锁）：窗口实例被替换、旧实例的对话框未结束时 Open 收到 busy；提示与物理来源相同，不降级、不改会话', async () => {
    const replaced: { current: FakeWindow | null } = { current: null };
    const h = createHarness({ windowForSender: (sender) => (sender.id === 1 ? replaced.current : null) });
    const first = h.window(1);
    replaced.current = first.window;
    const oldInstance = rig({ h, deps: { commit: () => undefined, downgradeTrust: () => undefined, publish: () => undefined } });
    oldInstance.controller.open();
    await settle();
    const newWindow: FakeWindow = { name: 'window-1-replaced' };
    h.handle.attachWindow(1, newWindow);
    replaced.current = newWindow;
    // 来源是协调器逻辑锁：旧实例的对话框已成孤儿（不占新实例的物理所有权），但该 owner 的 dialogOpen 仍为 true。
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(true);
    expect([h.handle.pendingNativeDialogs(), h.handle.orphanedNativeDialogs()]).toEqual([1, 1]);
    const r = rig({ h });
    const before = useMuseAppStore.getState().session;
    r.controller.open();
    await settle();
    expect(useMuseAppStore.getState().open.notice).toEqual({ kind: 'busy' });
    expect(useMuseAppStore.getState().session).toBe(before);
    expect(useMuseAppStore.getState().capabilityTrust).toBe('none');
    h.resolveDialog(0, null);
    await settle();
  });
});
