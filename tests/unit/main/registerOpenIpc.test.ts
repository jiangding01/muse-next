/**
 * M3 T1b-2a：`registerOpenIpc` 的 handler 异常边界——注册、同步 sender 校验、父窗口、busy / 取消、
 * 选择器与管线异常不外泄、相对路径、解码失败与编程错误。reload / 悬挂对话框 / 销毁 / TTL 见 `registerOpenIpc.reload.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { registerOpenIpc } from '../../../src/main/ipc/registerOpenIpc';
import type { InvokeEventLike } from '../../../src/main/ipc/registerOpenIpc';
import { ACTIVATE, APP_URL, createHarness, DIALOG, flush, mainFrameEvent, OPEN, REJECT } from './openIpcHarness';
import type { FakeSender } from './openIpcHarness';

const READ_FAILED = { kind: 'failed', error: { code: 'read-failed', message: 'The file could not be read.' } };

function isOpened(value: unknown): value is { kind: 'opened'; document: { documentId: number; file: { capability: { id: string } } } } {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'opened';
}

function ticketOf(reply: unknown): { capabilityId: string; documentId: number } {
  if (!isOpened(reply)) throw new Error(`expected opened, got ${JSON.stringify(reply)}`);
  return { capabilityId: reply.document.file.capability.id, documentId: reply.document.documentId };
}

describe('registerOpenIpc —— 注册', () => {
  it('注册且只注册三个新通道；同一 IPC 上重复注册会失败', () => {
    const handled: string[] = [];
    const ipc = {
      handle(channel: string) {
        if (handled.includes(channel)) throw new Error('duplicate');
        handled.push(channel);
      },
    };
    const deps = {
      ipc,
      windowForSender: () => null,
      pageIdentity: { kind: 'file', url: APP_URL } as const,
      chooseOpenPath: async () => null,
      fs: createHarness().fs,
      platform: 'linux',
      now: () => 0,
      issueToken: () => 't',
      schedule: () => undefined,
    };
    registerOpenIpc(deps);
    expect(handled).toEqual([OPEN, ACTIVATE, REJECT]);
    expect(() => registerOpenIpc(deps)).toThrow('duplicate');
  });
});

describe('registerOpenIpc —— 完整流程与父窗口', () => {
  it('打开对话框绑定发起请求的窗口；pending 不可授权；确认后 active；再次打开并确认才吊销旧能力', async () => {
    const h = createHarness();
    const { sender, window } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toEqual([window]);
    h.resolveDialog(0, '/docs/a.jcx');
    const a = ticketOf(await first);
    expect(h.handle.authorize(1, a.capabilityId)).toBeNull();
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), a)).toEqual({ ok: true });
    expect(h.handle.authorize(1, a.capabilityId)?.realpath).toBe('/docs/a.jcx');

    const second = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(1, '/docs/b.jcx');
    const b = ticketOf(await second);
    expect(h.handle.authorize(1, a.capabilityId)).not.toBeNull();
    expect(await h.invoke(ACTIVATE, mainFrameEvent(sender), b)).toEqual({ ok: true });
    expect(h.handle.authorize(1, a.capabilityId)).toBeNull();
    expect(await h.invoke(REJECT, mainFrameEvent(sender), b)).toEqual({ ok: true });
    expect(h.handle.authorize(1, b.capabilityId)).toBeNull();
    h.expectConsistent();
  });
});

describe('registerOpenIpc —— 同步 sender / payload 校验，零状态修改', () => {
  const variants: readonly (readonly [string, (s: FakeSender) => InvokeEventLike<FakeSender>, unknown])[] = [
    ['未登记窗口的 sender', () => ({ sender: { id: 99, destroyed: false, mainFrame: { url: APP_URL }, isDestroyed: () => false }, senderFrame: { url: APP_URL } }), DIALOG],
    ['子 frame', (s) => ({ sender: s, senderFrame: { url: APP_URL } }), DIALOG],
    ['senderFrame 为 null', (s) => ({ sender: s, senderFrame: null }), DIALOG],
    [
      '主 frame 上的页面来源不符',
      (s) => {
        const mainFrame = { url: 'file:///evil/index.html' };
        return { sender: { ...s, mainFrame }, senderFrame: mainFrame };
      },
      DIALOG,
    ],
    ['多余字段的 payload', (s) => mainFrameEvent(s), { intent: 'dialog', path: '/etc/passwd' }],
    ['非对象 payload', (s) => mainFrameEvent(s), 'dialog'],
  ];

  it.each(variants)('open-document：%s → Request rejected，不弹对话框、不改状态', async (_label, makeEvent, payload) => {
    const h = createHarness();
    const { sender } = h.window(1);
    const before = h.handle.currentState();
    await expect(h.invoke(OPEN, makeEvent(sender), payload)).rejects.toThrow(/^Request rejected$/);
    expect(h.dialogParents).toEqual([]);
    expect(h.handle.currentState()).toBe(before);
  });

  it('同一 id 重新登记以最后一次为准：旧窗口对象不再被接受', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    h.handle.attachWindow(1, { name: 'replacement' });
    await expect(h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).rejects.toThrow(/^Request rejected$/);
  });

  it('已销毁的 sender、fromWebContents 返回其它窗口或抛错 → 拒绝', async () => {
    for (const windowForSender of [() => ({ name: 'other' }), () => { throw new Error('Object has been destroyed'); }]) {
      const h = createHarness({ windowForSender });
      const { sender } = h.window(1);
      await expect(h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).rejects.toThrow(/^Request rejected$/);
    }
    const h = createHarness();
    const { sender } = h.window(1);
    sender.destroyed = true;
    await expect(h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).rejects.toThrow(/^Request rejected$/);
  });

  it('activate / reject：畸形票据与非法 sender → 拒绝且零状态修改', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const before = h.handle.currentState();
    await expect(h.invoke(ACTIVATE, mainFrameEvent(sender), { capabilityId: 'x', documentId: 0 })).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(REJECT, mainFrameEvent(sender), { capabilityId: '../x', documentId: 1 })).rejects.toThrow(/^Request rejected$/);
    await expect(h.invoke(ACTIVATE, { sender, senderFrame: null }, { capabilityId: 'x', documentId: 1 })).rejects.toThrow(/^Request rejected$/);
    expect(h.handle.currentState()).toBe(before);
  });

  it('sender 在第一个 await 之前校验：之后 senderFrame 变为 null（导航）不影响已接受的请求', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    let navigated = false;
    let reads = 0;
    const event: InvokeEventLike<FakeSender> = {
      sender,
      get senderFrame() {
        reads += 1;
        return navigated ? null : sender.mainFrame;
      },
    };
    const pending = h.invoke(OPEN, event, DIALOG);
    // handler 的同步段已经结束；此后 frame 消失（导航），任何延后到 await 之后的校验都会失败。
    navigated = true;
    await Promise.resolve();
    h.resolveDialog(0, '/docs/a.jcx');
    expect(isOpened(await pending)).toBe(true);
    expect(reads).toBe(1);
  });
});

describe('registerOpenIpc —— busy、取消与失败', () => {
  it('对话框显示期间的新请求 → busy，不再弹对话框', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(await h.invoke(OPEN, mainFrameEvent(sender), DIALOG)).toEqual({ kind: 'rejected', reason: 'busy' });
    expect(h.dialogParents).toHaveLength(1);
    h.resolveDialog(0, null);
    expect(await first).toEqual({ kind: 'canceled' });
  });

  it('选择器抛错 → read-failed（固定文案），锁已释放，下一次 Open 被接受', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.failDialog(0, new Error('native dialog crashed at /Users/secret'));
    const reply = await first;
    expect(reply).toEqual(READ_FAILED);
    expect(JSON.stringify(reply)).not.toContain('secret');
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
    h.expectConsistent();
  });

  it('相对路径 → read-failed，不触碰文件系统', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, 'docs/a.jcx');
    expect(await pending).toEqual(READ_FAILED);
    expect(h.fs.calls).toEqual([]);
  });

  it('T1a 管线抛出异常（含路径的原始错误）→ read-failed，原文不外泄，锁已释放', async () => {
    const h = createHarness({
      issueToken: () => {
        throw new Error('token source failed for /Users/secret/a.jcx');
      },
    });
    const { sender } = h.window(1);
    const pending = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const reply = await pending;
    expect(reply).toEqual(READ_FAILED);
    expect(JSON.stringify(reply)).not.toMatch(/secret|token source/);
    void h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    expect(h.dialogParents).toHaveLength(2);
  });

  it('解码失败与文件不存在：结构化错误码，旧 active 保持', async () => {
    const h = createHarness();
    const { sender } = h.window(1);
    const first = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    const a = ticketOf(await first);
    await h.invoke(ACTIVATE, mainFrameEvent(sender), a);
    const decode = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(1, '/docs/utf16.jcx');
    expect(await decode).toMatchObject({ kind: 'failed', error: { code: 'decode-utf16-unsupported' } });
    const missing = h.invoke(OPEN, mainFrameEvent(sender), DIALOG);
    h.resolveDialog(2, '/docs/missing.jcx');
    expect(await missing).toMatchObject({ kind: 'failed', error: { code: 'not-found' } });
    expect(h.handle.authorize(1, a.capabilityId)?.state).toBe('active');
  });

  it('协调器编程错误（token 冲突）→ read-failed，锁已释放，状态仍一致', async () => {
    const h = createHarness({ issueToken: () => 'same-token' });
    const one = h.window(1).sender;
    const two = h.window(2).sender;
    const first = h.invoke(OPEN, mainFrameEvent(one), DIALOG);
    h.resolveDialog(0, '/docs/a.jcx');
    expect(isOpened(await first)).toBe(true);
    const clash = h.invoke(OPEN, mainFrameEvent(two), DIALOG);
    h.resolveDialog(1, '/docs/b.jcx');
    expect(await clash).toEqual(READ_FAILED);
    await flush();
    void h.invoke(OPEN, mainFrameEvent(two), DIALOG);
    expect(h.dialogParents).toHaveLength(3);
    h.expectConsistent();
  });
});
