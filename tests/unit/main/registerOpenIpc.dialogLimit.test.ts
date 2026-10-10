/**
 * M3 T1b-2a′：原生对话框的物理所有权（T1b-2b preflight 裁决 Q1）。
 *
 * 钉死：每个登记的窗口实例同时最多一个尚未 settle 的 `chooseOpenPath`；同窗口 busy 不进入协调器（不占代次、不作废 pending）；
 * 所有权只在选择器 resolve / reject 时释放，reload、渲染进程退出、窗口销毁、逻辑锁释放都不释放它；所有权按窗口实例登记，
 * 旧实例的迟到 settle 不会清掉同一 ownerId 新实例的记录；窗口销毁后仍未 settle 的操作计为 orphaned，且不影响其它窗口；
 * 没有进程级准入上限。逻辑锁（`dialogOpen`）与物理所有权是两个独立状态。
 */

import { describe, expect, it } from 'vitest';

import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN } from './openIpcHarness';
import type { FakeSender, FakeWindow, Harness } from './openIpcHarness';

const BUSY = { kind: 'rejected', reason: 'busy' };
const SUPERSEDED = { kind: 'rejected', reason: 'superseded' };
const CROSS_DOCUMENT = { isMainFrame: true, isSameDocument: false } as const;

function seqOf(h: Harness, ownerId: number): number | undefined {
  return h.handle.currentState().owners.get(ownerId)?.latestRequestSeq;
}

function counts(h: Harness): { pending: number; orphaned: number } {
  return { pending: h.handle.pendingNativeDialogs(), orphaned: h.handle.orphanedNativeDialogs() };
}

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

/** 让已 settle 的选择器后续步骤（finally、管线）跑完。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('物理所有权 —— 同一窗口实例最多一个未 settle 的选择器', () => {
  it('同窗口 pending → reload → 第二次 Open busy：不进入协调器、不占代次、不作废 pending、不弹新对话框', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.handle.handleNavigationCommitted(1);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    const before = h.handle.currentState();
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.handle.currentState()).toBe(before);
    expect(seqOf(h, 1)).toBe(1);
    expect(h.dialogParents).toHaveLength(1);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
    h.expectConsistent();
  });

  it('重复 reload、导航提交、渲染进程退出之后仍然 busy', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    for (let i = 0; i < 5; i += 1) {
      h.handle.handleNavigation(1, CROSS_DOCUMENT);
      h.handle.handleNavigationCommitted(1);
      expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    }
    h.handle.handleRendererGone(1);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.dialogParents).toHaveLength(1);
    expect(seqOf(h, 1)).toBe(1);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
    h.expectConsistent();
  });

  it.each([
    ['选中文件', (h: Harness) => h.resolveDialog(0, '/docs/a.jcx')],
    ['取消', (h: Harness) => h.resolveDialog(0, null)],
    ['异步 reject', (h: Harness) => h.failDialog(0, new Error('gone'))],
  ])('原选择器 settle（%s）后同窗口恢复：迟到结果 superseded，新 Open 正常打开并激活', async (_label, settleFirst) => {
    const h = createHarness();
    const { sender } = h.window(1);
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    settleFirst(h);
    expect(await old).toEqual(SUPERSEDED);
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    const fresh = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await fresh);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), ticket)).toEqual({ ok: true });
    h.expectConsistent();
  });

  it('选择器同步抛错：回复 read-failed、所有权与逻辑锁都已释放、可以再次 Open', async () => {
    let calls = 0;
    const h = createHarness({
      chooseOpenPath: () => {
        calls += 1;
        if (calls === 1) throw new Error('synchronous failure at /Users/secret');
        return Promise.resolve(null);
      },
    });
    const { sender } = h.window(1);
    const reply = await h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(reply).toMatchObject({ kind: 'failed', error: { code: 'read-failed' } });
    expect(JSON.stringify(reply)).not.toContain('secret');
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual({ kind: 'canceled' });
  });

  it('逻辑锁 busy 与物理 busy 互不混淆：同窗口对话框显示中 → busy，记录不变', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(true);
  });
});

describe('物理所有权 —— 窗口之间互不影响，没有进程级上限', () => {
  it('三十二个窗口各自同时 Open：都弹出对话框，父窗口各不相同；各自 busy 只影响自己', async () => {
    const h = createHarness();
    const ids = Array.from({ length: 32 }, (_, i) => i + 1);
    const senders = ids.map((id) => h.window(id).sender);
    for (const sender of senders) void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents.map((w) => w.name)).toEqual(ids.map((id) => `window-${String(id)}`));
    expect(counts(h)).toEqual({ pending: 32, orphaned: 0 });
    h.handle.handleNavigation(3, CROSS_DOCUMENT);
    expect(await h.invoke(OPEN, mainFrameEvent(senders[2] as FakeSender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(1, null);
    await drain();
    void h.invoke(OPEN, mainFrameEvent(senders[1] as FakeSender), DIALOG);
    expect(h.dialogParents).toHaveLength(33);
    expect(h.dialogParents[32]?.name).toBe('window-2');
    h.expectConsistent();
  });

  it('上限之外的窗口 Open 不作废其它窗口已有的 pending 候选', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    const opened = h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    await opened;
    const pendingBefore = [...h.handle.currentState().table.keys()];
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    void h.invoke(OPEN, mainFrameEvent(h.window(3).sender), DIALOG);
    expect([...h.handle.currentState().table.keys()]).toEqual(pendingBefore);
    expect(seqOf(h, 1)).toBe(1);
    h.expectConsistent();
  });

  it('物理 busy（reload 后旧选择器未结束）不作废任何 pending 候选、不占代次', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    const opened = h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const ticket = ticketOf(await opened);
    const two = h.window(2).sender;
    void h.invoke(OPEN, mainFrameEvent(two), DIALOG);
    h.handle.handleNavigation(2, CROSS_DOCUMENT);
    const before = h.handle.currentState();
    expect(await h.invoke(OPEN, mainFrameEvent(two), DIALOG)).toEqual(BUSY);
    expect(h.handle.currentState()).toBe(before);
    expect(seqOf(h, 2)).toBe(1);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(one), ticket)).toEqual({ ok: true });
    h.expectConsistent();
  });
});

describe('物理所有权 —— 窗口销毁与孤儿', () => {
  it('窗口销毁且选择器不 settle：记为 orphaned，不释放；其它窗口照常 Open；迟到 settle 后 orphaned 归零且不登记能力', async () => {
    const h = createHarness();
    const doomed = h.invoke(OPEN, mainFrameEvent(h.window(1).sender), DIALOG);
    h.handle.disposeWindow(1);
    h.handle.disposeWindow(1);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 1 });
    const two = h.window(2).sender;
    const other = h.invoke(OPEN, mainFrameEvent(two), DIALOG);
    expect(h.dialogParents.map((w) => w.name)).toEqual(['window-1', 'window-2']);
    expect(counts(h)).toEqual({ pending: 2, orphaned: 1 });
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await other);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(two), ticket)).toEqual({ ok: true });

    h.resolveDialog(0, '/docs/a.jcx');
    expect(await doomed).toEqual(SUPERSEDED);
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    expect([...h.handle.currentState().table.values()].map((r) => r.ownerId)).toEqual([2]);
    h.expectConsistent();
  });

  it('多个窗口带着悬挂的选择器销毁：orphaned 精确计数，仍在登记的窗口不受影响', async () => {
    const h = createHarness();
    for (const id of [1, 2, 3]) void h.invoke(OPEN, mainFrameEvent(h.window(id).sender), DIALOG);
    h.handle.disposeWindow(1);
    h.handle.disposeWindow(3);
    expect(counts(h)).toEqual({ pending: 3, orphaned: 2 });
    void h.invoke(OPEN, mainFrameEvent(h.window(4).sender), DIALOG);
    expect(counts(h)).toEqual({ pending: 4, orphaned: 2 });
    h.failDialog(2, new Error('gone'));
    await drain();
    expect(counts(h)).toEqual({ pending: 3, orphaned: 1 });
    h.expectConsistent();
  });
});

describe('物理所有权 —— 同 ownerId 重复登记与窗口实例替换', () => {
  it('窗口销毁后用同一实例对象重新登记：所有权记录仍在（dispose 不释放），Open busy', async () => {
    const h = createHarness();
    const { sender, window } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.disposeWindow(1);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 1 });
    h.handle.attachWindow(1, window);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
    const before = h.handle.currentState();
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.handle.currentState()).toBe(before);
    expect(h.dialogParents).toHaveLength(1);
  });

  it.each([
    ['取消', (h: Harness) => h.resolveDialog(0, null)],
    ['异步 reject', (h: Harness) => h.failDialog(0, new Error('gone'))],
  ])('销毁后同 ownerId 登记新实例：旧选择器迟到%s不进入协调器，新请求的元数据原样不变', async (_label, settleOld) => {
    const current: { window: FakeWindow | null } = { window: null };
    const h = createHarness({ windowForSender: () => current.window });
    const first = h.window(1);
    current.window = first.window;
    const old = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    h.handle.disposeWindow(1);
    const next = { name: 'window-1-next' };
    current.window = next;
    h.handle.attachWindow(1, next);
    const fresh = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    const meta = h.handle.currentState().owners.get(1);
    settleOld(h);
    expect(await old).toEqual(SUPERSEDED);
    expect(h.handle.currentState().owners.get(1)).toBe(meta);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await fresh);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(first.sender), ticket)).toEqual({ ok: true });
    h.expectConsistent();
  });

  it('销毁后同 ownerId 登记新实例：旧选择器迟到 settle 不清新请求的逻辑锁、不消费其票据、不登记候选', async () => {
    const current: { window: FakeWindow | null } = { window: null };
    const h = createHarness({ windowForSender: () => current.window });
    const first = h.window(1);
    current.window = first.window;
    const old = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    h.handle.disposeWindow(1);
    const next = { name: 'window-1-next' };
    current.window = next;
    h.handle.attachWindow(1, next);
    const fresh = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    const meta = h.handle.currentState().owners.get(1);
    expect(meta).toMatchObject({ latestRequestSeq: 1, generation: 1, dialogOpen: true, inFlightSeq: 1 });
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    expect(h.handle.currentState().owners.get(1)).toBe(meta);
    expect(h.handle.currentState().table.size).toBe(0);
    expect(await h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(1, '/docs/b.jcx');
    const ticket = ticketOf(await fresh);
    expect(await h.invoke(ACTIVATE, mainFrameEvent(first.sender), ticket)).toEqual({ ok: true });
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    h.expectConsistent();
  });

  it('选择器已结束、读取阶段窗口被销毁并重新登记新实例：迟到的读取结果 superseded，不影响新请求', async () => {
    let release: (path: string) => void = () => undefined;
    let realpathCalls = 0;
    const base = createHarness().fs;
    const current: { window: FakeWindow | null } = { window: null };
    const h = createHarness({
      windowForSender: () => current.window,
      fs: {
        ...base,
        realpath: (path: string) => {
          realpathCalls += 1;
          if (realpathCalls > 1) return base.realpath(path);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const first = h.window(1);
    current.window = first.window;
    const old = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    await drain();
    h.handle.disposeWindow(1);
    const next = { name: 'window-1-next' };
    current.window = next;
    h.handle.attachWindow(1, next);
    const fresh = h.invoke(OPEN, mainFrameEvent(first.sender), DIALOG);
    const meta = h.handle.currentState().owners.get(1);
    release('/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    expect(h.handle.currentState().owners.get(1)).toBe(meta);
    h.resolveDialog(1, null);
    expect(await fresh).toEqual({ kind: 'canceled' });
    h.expectConsistent();
  });

  /** 一个 sender，`windowForSender` 返回当前替换后的实例。 */
  function replaceableHarness(): { h: Harness; sender: FakeSender; replace(name: string): FakeWindow } {
    const current: { window: FakeWindow | null } = { window: null };
    const h = createHarness({ windowForSender: () => current.window });
    const created = h.window(1);
    current.window = created.window;
    return {
      h,
      sender: created.sender,
      replace(name) {
        const window = { name };
        current.window = window;
        h.handle.attachWindow(1, window);
        return window;
      },
    };
  }

  it('同一实例重复登记：记录保留，reload 后仍 busy', async () => {
    const h = createHarness();
    const { sender, window } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.attachWindow(1, window);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
  });

  it('同 ownerId 替换为新实例：旧操作计为 orphaned；新实例在逻辑锁释放后可以 Open', async () => {
    const { h, sender, replace } = replaceableHarness();
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    const next = replace('window-1-next');
    expect(counts(h)).toEqual({ pending: 1, orphaned: 1 });
    // 逻辑锁仍属于旧请求（同一 ownerId）：新实例先得到逻辑 busy。
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toEqual([{ name: 'window-1' }, next]);
    expect(counts(h)).toEqual({ pending: 2, orphaned: 1 });
  });

  it('旧实例的迟到 settle 不清掉新实例的记录，也不释放新请求的逻辑锁', async () => {
    const { h, sender, replace } = replaceableHarness();
    const old = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    replace('window-1-next');
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    const fresh = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await old).toEqual(SUPERSEDED);
    expect(counts(h)).toEqual({ pending: 1, orphaned: 0 });
    // 新实例的选择器仍在显示：物理与逻辑都必须继续 busy。
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(true);
    // 新请求的票据仍登记着：reload 能释放它的逻辑锁（物理所有权仍在新实例上）。
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(1, null);
    expect(await fresh).toEqual(SUPERSEDED);
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(3);
    h.expectConsistent();
  });
});

describe('物理所有权 —— 鉴权优先与释放时机', () => {
  it('同窗口物理 busy 时，未鉴权的调用仍得到 Request rejected（不暴露对话框状态）', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    void h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    const stranger = { id: 99, destroyed: false, mainFrame: { url: one.mainFrame.url }, isDestroyed: () => false };
    await expect(h.invoke(OPEN, { sender: stranger, senderFrame: stranger.mainFrame }, DIALOG)).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(OPEN, { sender: one, senderFrame: { url: one.mainFrame.url } }, DIALOG)).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(OPEN, mainFrameEvent(one), { intent: 'dialog', path: '/x' })).rejects.toThrow(/^Request rejected$/);
    one.destroyed = true;
    await expect(h.invoke(OPEN, mainFrameEvent(one), DIALOG)).rejects.toThrow(/^Request rejected$/);
  });

  it('选择器结束、文件读取仍在进行时，同窗口的物理所有权已经归还（只剩逻辑锁）', async () => {
    let release: (path: string) => void = () => undefined;
    let realpathCalls = 0;
    const base = createHarness().fs;
    const h = createHarness({
      fs: {
        ...base,
        // 只让第一次 realpath 悬挂（读取前解析）；读后复核照常委托。
        realpath: (path: string) => {
          realpathCalls += 1;
          if (realpathCalls > 1) return base.realpath(path);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
    });
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    await drain();
    expect(counts(h)).toEqual({ pending: 0, orphaned: 0 });
    // 读取期间 reload：逻辑锁释放后同窗口可以再次弹出对话框（物理所有权不再被读取阶段占用）。
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
    release('/docs/a.jcx');
    expect(await pending).toEqual(SUPERSEDED);
  });
});
