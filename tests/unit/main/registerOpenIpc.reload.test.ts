/**
 * M3 T1b-2a：reload / 渲染进程退出 / 窗口销毁与悬挂对话框（用户裁决：逻辑 Open 锁释放方案），以及 TTL 清理。
 *
 * 原生对话框在 reload 后仍挂在原窗口上、destroy 后可能永不结束（实测）；这里用可控 / 永不 resolve 的 fake 对话框证明：
 * reload 释放逻辑锁，但旧选择器未结束前同窗口 Open 仍 busy（T1b-2a′ 物理所有权，详见 dialogLimit 测试）；
 * 旧请求迟到只会 superseded、不登记能力；旧选择器结束后新页面可以继续 Open；旧 handler 的 finally 不会清掉新请求的锁；
 * 悬挂请求只占用各自的 promise，不影响状态一致性与其它窗口。
 */

import { describe, expect, it } from 'vitest';

import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN } from './openIpcHarness';
import type { Harness } from './openIpcHarness';

const CROSS_DOCUMENT = { isMainFrame: true, isSameDocument: false } as const;
const SUPERSEDED = { kind: 'rejected', reason: 'superseded' };
const BUSY = { kind: 'rejected', reason: 'busy' };

function ticketOf(reply: unknown): { capabilityId: string; documentId: number } {
  if (typeof reply !== 'object' || reply === null || !('kind' in reply) || reply.kind !== 'opened' || !('document' in reply)) {
    throw new Error(`expected opened, got ${JSON.stringify(reply)}`);
  }
  const document = reply.document;
  if (typeof document !== 'object' || document === null || !('documentId' in document) || !('file' in document)) throw new Error('bad document');
  const file = document.file;
  if (typeof file !== 'object' || file === null || !('capability' in file)) throw new Error('bad file');
  const capability = file.capability;
  if (typeof capability !== 'object' || capability === null || !('id' in capability)) throw new Error('bad capability');
  const { id } = capability;
  const { documentId } = document;
  if (typeof id !== 'string' || typeof documentId !== 'number') throw new Error('bad ticket');
  return { capabilityId: id, documentId };
}

function pendingTokens(h: Harness): string[] {
  return [...h.handle.currentState().table.values()].filter((r) => r.state === 'pending').map((r) => r.token);
}

describe('reload 期间对话框仍在显示', () => {
  it('reload 后旧选择器未结束时同窗口 busy；旧对话框迟到返回只得到 superseded，不登记能力；之后新页面可以继续 Open', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.dialogParents).toHaveLength(1);

    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    expect(pendingTokens(h)).toEqual([]);

    const fresh = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await fresh);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: true });
    h.expectConsistent();
  });

  it('旧 handler 的 finally 只释放旧票据：旧请求结束后的新请求持有锁（同实例交错由 dialogLimit 的实例替换用例覆盖）', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    // 新请求的对话框仍在显示：第三个请求必须 busy。
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual({ kind: 'rejected', reason: 'busy' });
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(true);
  });

  it('旧对话框迟到取消 / 抛错同样无副作用', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const canceled = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.resolveDialog(0, null);
    expect(await canceled).toEqual(SUPERSEDED);
    const failed = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.failDialog(1, new Error('gone'));
    expect(await failed).toEqual(SUPERSEDED);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    h.expectConsistent();
  });

  it('重复 reload、对话框悬挂：每次 reload 后同窗口都 busy 且不进入协调器；悬挂请求迟到无副作用，状态始终一致', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const hung = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    for (let i = 0; i < 2; i += 1) {
      h.handle.handleNavigation(1, CROSS_DOCUMENT);
      h.expectConsistent();
      expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    }
    expect(h.handle.currentState().owners.get(1)?.latestRequestSeq).toBe(1);
    expect(h.dialogParents).toHaveLength(1);

    h.resolveDialog(0, '/docs/a.jcx');
    expect(await hung).toEqual(SUPERSEDED);
    const live = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
    expect(h.handle.currentState().owners.get(1)?.generation).toBe(3);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await live);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: true });
    expect(pendingTokens(h)).toEqual([]);
    expect(h.handle.authorize(1, ticket.capabilityId)?.state).toBe('active');
    h.expectConsistent();
  });

  it('导航开始后、提交前旧文档发出的 Open：提交时被作废并释放逻辑锁，旧请求迟到不登记候选，新页面不被锁成 busy', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    const raced = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigationCommitted(1);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    // 旧文档的选择器仍在原窗口上：物理 busy（不是逻辑锁）。
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await raced).toEqual(SUPERSEDED);
    expect(pendingTokens(h)).toEqual([]);
    const fresh = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await fresh);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: true });
    h.expectConsistent();
  });

  it('reload → 旧请求完成 → 新 Open → 再次 reload：新请求的逻辑锁被释放，但其选择器未结束时同窗口仍 busy', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.dialogParents).toHaveLength(2);
    h.expectConsistent();
  });

  it('页内导航与子 frame 导航不 reset；跨文档导航 reset 并作废 active', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const ticket = ticketOf(await pending);
    await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket);
    h.handle.handleNavigation(1, { isMainFrame: true, isSameDocument: true });
    h.handle.handleNavigation(1, { isMainFrame: false, isSameDocument: false });
    expect(h.handle.authorize(1, ticket.capabilityId)?.state).toBe('active');
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(h.handle.authorize(1, ticket.capabilityId)).toBeNull();
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it('渲染进程退出：等同 reload（作废能力并释放逻辑锁）；旧选择器结束前同窗口 busy，结束后可以 Open', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleRendererGone(1);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
  });
});

describe('窗口销毁', () => {
  it('对话框显示期间销毁：迟到结果不登记能力、不回复 opened；之后该 sender 的请求被拒绝；其它窗口不受影响', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    const two = h.window(2).sender;
    const otherPending = h.invoke(OPEN, mainFrameEvent(two), DIALOG);
    h.resolveDialog(0, '/docs/b.jcx');
    const otherTicket = ticketOf(await otherPending);
    await h.invoke(ACTIVATE, mainFrameEvent(two), otherTicket);

    const doomed = h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.handle.disposeWindow(1);
    h.handle.disposeWindow(1);
    h.resolveDialog(1, '/docs/a.jcx');
    expect(await doomed).toEqual(SUPERSEDED);
    expect(h.handle.currentState().owners.has(1)).toBe(false);
    expect([...h.handle.currentState().table.values()].map((r) => r.ownerId)).toEqual([2]);
    await expect(h.invoke(OPEN, mainFrameEvent(one), DIALOG)).rejects.toThrow(/^Request rejected$/);
    expect(h.handle.authorize(2, otherTicket.capabilityId)?.state).toBe('active');
    h.expectConsistent();
  });

  it('对话框永不结束 + 窗口销毁：owner 被移除，状态一致', () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.disposeWindow(1);
    expect(h.handle.currentState().owners.size).toBe(0);
    expect(h.handle.currentState().table.size).toBe(0);
    h.expectConsistent();
  });
});

describe('pending TTL（120 s）', () => {
  it('登记时排程 120 s 清理；到期前可激活', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const ticket = ticketOf(await pending);
    expect(h.timers.map((t) => t.delay)).toEqual([120_000]);
    h.clock += 119_999;
    h.runDueTimers();
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: true });
  });

  it('到期后定时器清理候选，迟到确认被拒绝（fail closed）', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const ticket = ticketOf(await pending);
    h.clock += 120_000;
    h.runDueTimers();
    expect(pendingTokens(h)).toEqual([]);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: false, code: 'capability-invalid' });
    h.expectConsistent();
  });

  it('定时器触发时基于最新状态清理：不会回滚之后发生的激活与替换', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const a = ticketOf(await first);
    await h.invoke(ACTIVATE, mainFrameEvent(sender), a);
    const second = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(1, '/docs/b.jcx');
    const b = ticketOf(await second);
    await h.invoke(ACTIVATE, mainFrameEvent(sender), b);
    h.clock += 120_000;
    h.runDueTimers();
    expect(h.handle.authorize(1, b.capabilityId)?.state).toBe('active');
    expect(h.handle.authorize(1, a.capabilityId)).toBeNull();
    h.expectConsistent();
  });

  it('定时器触发时时钟异常（非有限值）：不抛出、状态不变，激活仍 fail closed', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    await pending;
    const before = h.handle.currentState();
    h.clock = Number.POSITIVE_INFINITY;
    expect(() => h.runDueTimers()).not.toThrow();
    expect(h.handle.currentState()).toBe(before);
  });

  it('即使定时器没有运行，激活也按时钟判定过期', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const ticket = ticketOf(await pending);
    h.clock += 120_000;
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: false, code: 'capability-invalid' });
  });
});
