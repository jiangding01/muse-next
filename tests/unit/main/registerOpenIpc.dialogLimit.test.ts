/**
 * M3 T1b-2a 补强：进程内物理原生对话框数量上限（用户裁决：最多 2 个尚未 settle 的 `chooseOpenPath`）。
 *
 * 钉死：上限 busy 不进入协调器（不占代次、不作废 pending）；计数只在选择器 resolve / reject 时释放；reload、
 * 渲染进程退出、窗口销毁、逻辑锁释放都不释放它；跨窗口累计；两个对话框都结束后恢复。逻辑锁（`dialogOpen`）与
 * 物理计数是两个独立状态。
 */

import { describe, expect, it } from 'vitest';

import { MAX_PENDING_NATIVE_DIALOGS } from '../../../src/main/ipc/registerOpenIpc';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN } from './openIpcHarness';
import type { Harness } from './openIpcHarness';

const BUSY = { kind: 'rejected', reason: 'busy' };
const CROSS_DOCUMENT = { isMainFrame: true, isSameDocument: false } as const;

function seqOf(h: Harness, ownerId: number): number | undefined {
  return h.handle.currentState().owners.get(ownerId)?.latestRequestSeq;
}

describe('物理对话框上限 = 2', () => {
  it('上限常量为 2', () => {
    expect(MAX_PENDING_NATIVE_DIALOGS).toBe(2);
  });

  it('正常完成与取消都释放计数，之后可以继续 Open', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    h.resolveDialog(0, '/docs/a.jcx');
    await first;
    expect(h.handle.pendingNativeDialogs()).toBe(0);
    const second = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(1, null);
    expect(await second).toEqual({ kind: 'canceled' });
    expect(h.handle.pendingNativeDialogs()).toBe(0);
  });

  it('选择器抛错也释放计数', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.failDialog(0, new Error('crashed'));
    await pending;
    expect(h.handle.pendingNativeDialogs()).toBe(0);
  });

  it('跨窗口累计：两个窗口各有一个悬挂对话框时，第三个窗口的 Open → busy，且不进入协调器', async () => {
    const h = createHarness();
    void h.invoke(OPEN, mainFrameEvent(h.window(1).sender), DIALOG);
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    const three = h.window(3).sender;
    const before = h.handle.currentState();
    expect(await h.invoke(OPEN, mainFrameEvent(three), DIALOG)).toEqual(BUSY);
    expect(h.handle.currentState()).toBe(before);
    expect(seqOf(h, 3)).toBe(0);
    expect(h.dialogParents).toHaveLength(2);
  });

  it('上限 busy 不作废已有的 pending 候选、不占代次', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    const opened = h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    await opened;
    const pendingBefore = [...h.handle.currentState().table.keys()];
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    void h.invoke(OPEN, mainFrameEvent(h.window(3).sender), DIALOG);
    expect(await h.invoke(OPEN, mainFrameEvent(one), DIALOG)).toEqual(BUSY);
    expect([...h.handle.currentState().table.keys()]).toEqual(pendingBefore);
    expect(seqOf(h, 1)).toBe(1);
    h.expectConsistent();
  });

  it('reload 与渲染进程退出释放逻辑锁但不释放物理计数', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.handle.handleNavigationCommitted(1);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleRendererGone(1);
    expect(h.handle.pendingNativeDialogs()).toBe(2);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
  });

  it('重复 reload 不释放物理计数；悬挂对话框之一结束后恢复一个名额', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    for (let i = 0; i < 5; i += 1) h.handle.handleNavigation(1, CROSS_DOCUMENT);
    expect(h.handle.pendingNativeDialogs()).toBe(2);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    h.resolveDialog(0, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(3);
  });

  it('窗口销毁不释放物理计数；它的对话框结束后才释放', async () => {
    const h = createHarness();
    const doomed = h.invoke(OPEN, mainFrameEvent(h.window(1).sender), DIALOG);
    h.handle.disposeWindow(1);
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    const three = h.window(3).sender;
    expect(await h.invoke(OPEN, mainFrameEvent(three), DIALOG)).toEqual(BUSY);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(await doomed).toEqual({ kind: 'rejected', reason: 'superseded' });
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    void h.invoke(OPEN, mainFrameEvent(three), DIALOG);
    expect(h.dialogParents).toHaveLength(3);
    h.expectConsistent();
  });

  it('两个对话框都结束后完全恢复：新 Open 正常打开并激活', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const a = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    const b = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.handle.handleNavigation(1, CROSS_DOCUMENT);
    h.resolveDialog(0, '/docs/a.jcx');
    h.failDialog(1, new Error('gone'));
    await Promise.all([a, b]);
    expect(h.handle.pendingNativeDialogs()).toBe(0);
    const fresh = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(2, '/docs/b.jcx');
    const reply = await fresh;
    if (typeof reply !== 'object' || reply === null || !('kind' in reply) || reply.kind !== 'opened' || !('document' in reply)) {
      throw new Error('expected opened');
    }
    const { document } = reply;
    if (typeof document !== 'object' || document === null || !('documentId' in document) || !('file' in document)) throw new Error('bad');
    const { file } = document;
    if (typeof file !== 'object' || file === null || !('capability' in file)) throw new Error('bad');
    const { capability } = file;
    if (typeof capability !== 'object' || capability === null || !('id' in capability)) throw new Error('bad');
    const { id } = capability;
    const { documentId } = document;
    if (typeof id !== 'string' || typeof documentId !== 'number') throw new Error('bad');
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), { capabilityId: id, documentId })).toEqual({ ok: true });
    h.expectConsistent();
  });

  it('选择器同步抛错：回复 read-failed、计数为 0、逻辑锁已释放，可以再次 Open', async () => {
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
    expect(h.handle.pendingNativeDialogs()).toBe(0);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(false);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual({ kind: 'canceled' });
  });

  it('达到上限时，未鉴权的调用仍得到 Request rejected（不向未鉴权方暴露对话框状态）', async () => {
    const h = createHarness();
    const one = h.window(1).sender;
    void h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    expect(h.handle.pendingNativeDialogs()).toBe(2);
    const stranger = { id: 99, destroyed: false, mainFrame: { url: one.mainFrame.url }, isDestroyed: () => false };
    await expect(h.invoke(OPEN, { sender: stranger, senderFrame: stranger.mainFrame }, DIALOG)).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(OPEN, { sender: one, senderFrame: { url: one.mainFrame.url } }, DIALOG)).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(OPEN, mainFrameEvent(one), { intent: 'dialog', path: '/x' })).rejects.toThrow(/^Request rejected$/);
  });

  it('只有选择器 settle 才释放：选择器结束、文件读取仍在进行时，名额已经归还', async () => {
    let release: (path: string) => void = () => undefined;
    let realpathCalls = 0;
    const base = createHarness().fs;
    const h = createHarness({
      fs: {
        ...base,
        // 只让第一次 realpath 悬挂（读取前解析）；读后复核照常委托。
        realpath: (path) => {
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
    await Promise.resolve();
    await Promise.resolve();
    expect(h.handle.pendingNativeDialogs()).toBe(0);
    void h.invoke(OPEN, mainFrameEvent(h.window(2).sender), DIALOG);
    void h.invoke(OPEN, mainFrameEvent(h.window(3).sender), DIALOG);
    expect(h.dialogParents).toHaveLength(3);
    release('/docs/a.jcx');
    await pending;
  });

  it('逻辑锁 busy 与物理上限 busy 互不混淆：同窗口对话框显示中 → busy 且计数不变', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual(BUSY);
    expect(h.handle.pendingNativeDialogs()).toBe(1);
    expect(h.handle.currentState().owners.get(1)?.dialogOpen).toBe(true);
  });
});
