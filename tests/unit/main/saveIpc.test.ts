/**
 * M3 T4 B2：保存 IPC 端到端（`registerOpenIpc` + `saveIpc` + B1 管线，内存 fs）。
 *
 * 覆盖：普通 Save 与 A9 刷新（M53）、Save As 新文件 / 同一文件 / demo（R9）、R19 分叉（T-H7 的 main 侧）、F1 物理对话框所有权
 * （同窗口 reload、窗口销毁、窗口实例替换）、T-OP-1（IPC 层）、提交前后的故障注入（T-CS）、载荷校验（T-H7-9、M20）与 busy。
 */

import { describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/main/document/fingerprint';
import type { WriteFileSystem } from '../../../src/main/document/writeFileSystemPort';
import { IPC } from '../../../src/shared/ipc';
import type { InvokeEventLike } from '../../../src/main/ipc/registerOpenIpc';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN, REJECT } from './openIpcHarness';
import type { FakeSender, FakeWindow, Harness, HarnessOptions } from './openIpcHarness';
import { bytesOf, P, setup } from './saveTestKit';
import type { FakeWriteFs } from './fakeWriteFileSystem';

const REQUEST = IPC.requestSaveTarget;
const SAVE = IPC.saveDocument;
const A = P('docs', 'a.jcx');
const B = P('docs', 'b.jcx');
const NEW = P('docs', 'new.jcx');
const A_TEXT = 'X:1\nT:a\n';
const CROSS = { isMainFrame: true, isSameDocument: false } as const;

interface Ticket {
  readonly capabilityId: string;
  readonly documentId: number;
}

function world(options: HarnessOptions = {}): { disk: FakeWriteFs; h: Harness; ev: InvokeEventLike<FakeSender>; sender: FakeSender } {
  const disk = setup('linux');
  disk.writeFile(A, A_TEXT);
  disk.writeFile(B, 'X:1\nT:b\n');
  const h = createHarness({ fs: disk.readFs, writeFs: disk.writeFs, ...options });
  const { sender } = h.window(1);
  return { disk, h, ev: mainFrameEvent(sender), sender };
}

function ticketOf(reply: unknown): Ticket {
  const r = reply as { kind?: string; document?: { documentId: number; file: { capability: { id: string } } } };
  if (r.kind !== 'opened' || r.document === undefined) throw new Error(`expected opened, got ${JSON.stringify(reply)}`);
  return { capabilityId: r.document.file.capability.id, documentId: r.document.documentId };
}

/** 发起请求；若它弹出了新对话框，以 `path` 结束它。 */
async function withDialog(h: Harness, start: () => Promise<unknown>, path: string | null): Promise<unknown> {
  const before = h.dialogParents.length;
  const pending = start();
  if (h.dialogParents.length > before) h.resolveDialog(h.dialogParents.length - 1, path);
  return await pending;
}

async function openActive(h: Harness, ev: InvokeEventLike<FakeSender>, path: string): Promise<Ticket> {
  const ticket = ticketOf(await withDialog(h, () => h.invoke(OPEN, ev, DIALOG), path));
  expect(await h.invoke(ACTIVATE, ev, ticket)).toEqual({ ok: true });
  return ticket;
}

const requestTarget = (h: Harness, ev: InvokeEventLike<FakeSender>, source: string | null, path: string | null, encoding = 'utf-8'): Promise<unknown> =>
  withDialog(h, () => h.invoke(REQUEST, ev, { suggestedName: 'new.jcx', encoding, sourceCapabilityId: source }), path);

const granted = (reply: unknown): string => {
  const r = reply as { kind?: string; capabilityId?: string };
  if (r.kind !== 'granted' || r.capabilityId === undefined) throw new Error(`expected granted, got ${JSON.stringify(reply)}`);
  return r.capabilityId;
};

const save = (h: Harness, ev: InvokeEventLike<FakeSender>, ticket: Ticket, source: string): Promise<unknown> =>
  h.invoke(SAVE, ev, { capabilityId: ticket.capabilityId, documentId: ticket.documentId, source, encoding: 'utf-8' });

const saveAs = (h: Harness, ev: InvokeEventLike<FakeSender>, target: string, documentId: number, sourceCapabilityId: string | null, source: string): Promise<unknown> =>
  h.invoke(SAVE, ev, { capabilityId: target, documentId, source, encoding: 'utf-8', sourceCapabilityId });

describe('普通 Save（经 IPC）', () => {
  it('saved；目标逐字节更新；锚点指纹刷新（M53），连续第二次 Save 不误报外部修改', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    expect(await save(h, ev, a, 'X:1\nT:a2\n')).toMatchObject({ outcome: 'saved', ticket: null, writeEncoding: 'utf-8' });
    expect(disk.text(A)).toBe('X:1\nT:a2\n');
    expect(h.handle.authorize(1, a.capabilityId)?.lastKnownDiskFingerprint).toBe(sha256Hex(bytesOf('X:1\nT:a2\n')));
    expect(await save(h, ev, a, 'X:1\nT:a3\n')).toMatchObject({ outcome: 'saved' });
    expect(disk.text(A)).toBe('X:1\nT:a3\n');
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
    h.expectConsistent();
  });

  it('外部修改 → not-committed / file-modified-on-disk，外部内容保留', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    disk.modifyInPlace(A, 'X:1\nT:external\n');
    expect(await save(h, ev, a, 'X:1\nT:mine\n')).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(disk.text(A)).toBe('X:1\nT:external\n');
  });

  it('墓碑 token / 跨窗口 / documentId / 编码不符 → 对应错误码，写 port 零调用', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const b = await openActive(h, ev, B);
    const calls = disk.calls.length;
    expect(await save(h, ev, a, 'x')).toMatchObject({ outcome: 'not-committed', error: { code: 'capability-invalid' } });
    expect(await h.invoke(SAVE, ev, { capabilityId: b.capabilityId, documentId: 99, source: 'x', encoding: 'utf-8' })).toMatchObject({ error: { code: 'document-mismatch' } });
    expect(await h.invoke(SAVE, ev, { capabilityId: b.capabilityId, documentId: b.documentId, source: 'x', encoding: 'gb18030' })).toMatchObject({ error: { code: 'encoding-mismatch' } });
    const other = mainFrameEvent(h.window(2).sender);
    expect(await save(h, other, b, 'x')).toMatchObject({ error: { code: 'capability-invalid' } });
    expect(disk.calls.length).toBe(calls);
  });
});

describe('Save As（经 IPC）', () => {
  it('新文件：granted → saved + ticket → 激活后旧能力不再授权（M21），旧 active 转墓碑', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const reply = await requestTarget(h, ev, a.capabilityId, NEW);
    expect(reply).toMatchObject({ kind: 'granted', displayName: 'new.jcx', displayPath: NEW, sameAsCurrent: false });
    expect(h.saveDefaults).toEqual([P('docs', 'new.jcx')]);
    const result = (await saveAs(h, ev, granted(reply), a.documentId, a.capabilityId, 'X:1\nT:new\n')) as { outcome: string; ticket: Ticket | null };
    expect(result).toMatchObject({ outcome: 'saved', displayName: 'new.jcx' });
    expect(disk.text(NEW)).toBe('X:1\nT:new\n');
    expect(disk.text(A)).toBe(A_TEXT);
    if (result.ticket === null) throw new Error('missing ticket');
    expect(result.ticket.documentId).toBe(a.documentId);
    expect(await h.invoke(ACTIVATE, ev, result.ticket)).toEqual({ ok: true });
    expect(h.handle.authorize(1, a.capabilityId)).toBeNull();
    expect(h.handle.currentState().table.get(a.capabilityId)?.purpose).toBe('tombstone');
    expect(h.handle.authorize(1, result.ticket.capabilityId)?.realpath).toBe(NEW);
    h.expectConsistent();
  });

  it('选原文件：sameAsCurrent = true；写回后锚点记录刷新', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const reply = await requestTarget(h, ev, a.capabilityId, A);
    expect(reply).toMatchObject({ kind: 'granted', sameAsCurrent: true });
    expect(await saveAs(h, ev, granted(reply), a.documentId, a.capabilityId, 'X:1\nT:same\n')).toMatchObject({ outcome: 'saved' });
    expect(disk.text(A)).toBe('X:1\nT:same\n');
    expect(h.handle.authorize(1, a.capabilityId)?.lastKnownDiskFingerprint).toBe(sha256Hex(bytesOf('X:1\nT:same\n')));
  });

  it('demo（没有锚点）：source null 授予；ticket documentId 为 0，可激活（R9）', async () => {
    const { h, ev } = world();
    const reply = await requestTarget(h, ev, null, NEW);
    const result = (await saveAs(h, ev, granted(reply), 0, null, 'X:1\n')) as { ticket: Ticket | null };
    expect(result.ticket?.documentId).toBe(0);
    if (result.ticket === null) throw new Error('missing ticket');
    expect(await h.invoke(ACTIVATE, ev, result.ticket)).toEqual({ ok: true });
  });

  it('取消 → canceled，不登记；悬空符号链接 → not-a-regular-file（M42）', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    expect(await requestTarget(h, ev, a.capabilityId, null)).toEqual({ kind: 'canceled' });
    disk.symlink(P('docs', 'dangling.jcx'), P('docs', 'missing.jcx'));
    expect(await requestTarget(h, ev, a.capabilityId, P('docs', 'dangling.jcx'))).toMatchObject({ kind: 'refused', error: { code: 'not-a-regular-file' } });
    expect([...h.handle.currentState().table.values()].some((r) => r.purpose === 'save-target')).toBe(false);
  });
});

describe('R19（T-H7 的 main 侧：绕过 renderer 直接调用 IPC）', () => {
  it('激活应答丢失 + reject 丢失：renderer 仍持 a、main committed = N → Save As 两阶段都 source-mismatch；a 字节不变；reject 送达后恢复', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const first = (await saveAs(h, ev, granted(await requestTarget(h, ev, a.capabilityId, NEW)), a.documentId, a.capabilityId, 'X:1\nT:n\n')) as { ticket: Ticket };
    // main 已激活 N（应答「丢失」）；renderer 放弃并发出的 reject 也「丢失」。
    expect(await h.invoke(ACTIVATE, ev, first.ticket)).toEqual({ ok: true });
    const dialogs = h.dialogParents.length;
    expect(await requestTarget(h, ev, a.capabilityId, A)).toMatchObject({ kind: 'refused', error: { code: 'source-mismatch' } });
    expect(h.dialogParents.length).toBe(dialogs);
    expect(disk.text(A)).toBe(A_TEXT);
    // reject 送达：A2 回退到 a（墓碑），R19 重新成立。
    expect(await h.invoke(REJECT, ev, first.ticket)).toEqual({ ok: true });
    expect(await requestTarget(h, ev, a.capabilityId, A)).toMatchObject({ kind: 'granted', sameAsCurrent: true });
  });

  it('M66：阶段 1 正确、阶段 2 换成另一个 token → source-mismatch，G 被消费，写 port 零写入', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const target = granted(await requestTarget(h, ev, a.capabilityId, NEW));
    expect(await saveAs(h, ev, target, a.documentId, 'other-token', 'x')).toMatchObject({ outcome: 'not-committed', error: { code: 'source-mismatch' } });
    expect(disk.exists(NEW)).toBe(false);
    expect(await saveAs(h, ev, target, a.documentId, a.capabilityId, 'x')).toMatchObject({ error: { code: 'capability-invalid' } });
  });
});

describe('F1：物理对话框所有权与逻辑操作锁', () => {
  it('同窗口 reload：旧 Save As 对话框未返回时，新页面的 Save As / 普通 Save / Open 都 busy；旧对话框返回后不登记、不释放新锁；之后重试成功', async () => {
    const { h, ev, sender } = world();
    const a = await openActive(h, ev, A);
    const old = h.invoke(REQUEST, ev, { suggestedName: 'x.jcx', encoding: 'utf-8', sourceCapabilityId: a.capabilityId });
    const oldDialog = h.dialogParents.length - 1;
    h.handle.handleNavigation(1, CROSS);
    h.handle.handleNavigationCommitted(1);
    const fresh = mainFrameEvent(sender);
    expect(await h.invoke(REQUEST, fresh, { suggestedName: 'y.jcx', encoding: 'utf-8', sourceCapabilityId: null })).toMatchObject({ kind: 'refused', error: { code: 'busy' } });
    expect(await save(h, fresh, a, 'x')).toMatchObject({ outcome: 'not-committed', error: { code: 'busy' } });
    expect(await h.invoke(OPEN, fresh, DIALOG)).toEqual({ kind: 'rejected', reason: 'busy' });
    h.resolveDialog(oldDialog, NEW);
    expect(await old).toMatchObject({ kind: 'refused', error: { code: 'capability-invalid' } });
    expect([...h.handle.currentState().table.values()].some((r) => r.purpose === 'save-target')).toBe(false);
    expect(h.handle.pendingNativeDialogs()).toBe(0);
    expect(await requestTarget(h, fresh, null, NEW)).toMatchObject({ kind: 'granted' });
    h.expectConsistent();
  });

  it('T-OP-4：旧对话框返回时新页面正持有自己的 Save As 逻辑锁（另一窗口实例）——旧回调不登记、不释放新锁', async () => {
    const windows = new Map<number, FakeWindow>();
    const { h, ev, sender } = world({ windowForSender: (s) => windows.get(s.id) ?? null });
    windows.set(1, h.window(1).window);
    const a = await openActive(h, ev, A);
    const old = h.invoke(REQUEST, ev, { suggestedName: 'x.jcx', encoding: 'utf-8', sourceCapabilityId: a.capabilityId });
    const oldDialog = h.dialogParents.length - 1;
    // 窗口实例替换：同一 ownerId 登记新实例（旧实例的物理所有权不阻塞新实例）。
    h.handle.disposeWindow(1);
    const replacement: FakeWindow = { name: 'window-1-b' };
    windows.set(1, replacement);
    h.handle.attachWindow(1, replacement);
    const fresh = mainFrameEvent(sender);
    const mine = h.invoke(REQUEST, fresh, { suggestedName: 'y.jcx', encoding: 'utf-8', sourceCapabilityId: null });
    const myDialog = h.dialogParents.length - 1;
    expect(h.dialogParents[myDialog]).toBe(replacement);
    const held = h.handle.currentState().owners.get(1)?.saveOperation;
    expect(held?.kind).toBe('save-as-dialog');
    h.resolveDialog(oldDialog, NEW);
    expect(await old).toMatchObject({ kind: 'refused', error: { code: 'capability-invalid' } });
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toEqual(held);
    expect([...h.handle.currentState().table.values()].some((r) => r.purpose === 'save-target')).toBe(false);
    h.resolveDialog(myDialog, NEW);
    expect(await mine).toMatchObject({ kind: 'granted' });
    h.expectConsistent();
  });

  it('T-OP-5：窗口销毁后旧对话框返回 → 不登记、不抛出、无残留', async () => {
    const { h, ev } = world();
    const old = h.invoke(REQUEST, ev, { suggestedName: 'x.jcx', encoding: 'utf-8', sourceCapabilityId: null });
    const index = h.dialogParents.length - 1;
    h.handle.disposeWindow(1);
    h.resolveDialog(index, NEW);
    expect(await old).toMatchObject({ kind: 'refused', error: { code: 'capability-invalid' } });
    expect(h.handle.currentState().table.size).toBe(0);
    expect(h.handle.pendingNativeDialogs()).toBe(0);
  });

  it('Open 对话框打开时保存两条通道都 busy；F2：busy 之前已消费 G', async () => {
    const { h, ev } = world();
    const target = granted(await requestTarget(h, ev, null, NEW));
    const opening = h.invoke(OPEN, ev, DIALOG);
    expect(await saveAs(h, ev, target, 0, null, 'x')).toMatchObject({ error: { code: 'busy' } });
    expect(h.handle.currentState().table.has(target)).toBe(false);
    h.resolveDialog(h.dialogParents.length - 1, null);
    await opening;
  });
});

/** 写 port 包装：第 n 次 openExclusive 停在闸门前，直到测试放行。 */
function gatedWrites(base: WriteFileSystem): { fs: WriteFileSystem; gate(n: number): { reached: Promise<void>; release(): void } } {
  const gates = new Map<number, { reached: () => void; wait: Promise<void>; release: () => void; reachedPromise: Promise<void> }>();
  let count = 0;
  return {
    fs: {
      ...base,
      openExclusive: async (path, mode) => {
        count += 1;
        const gate = gates.get(count);
        if (gate !== undefined) {
          gate.reached();
          await gate.wait;
        }
        return base.openExclusive(path, mode);
      },
    },
    gate(n) {
      let reached: () => void = () => undefined;
      let release: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
      const wait = new Promise<void>((resolve) => (release = resolve));
      gates.set(n, { reached, wait, release, reachedPromise });
      return { reached: reachedPromise, release };
    },
  };
}

describe('T-OP-1（IPC 层）：旧操作不得释放新操作的锁', () => {
  it('Save A 写临时文件中 → A4 → Save As B 持锁写入中 → A 迟到结束 → Save C 得到 busy；B 完成后 D 可保存', async () => {
    const disk = setup('linux');
    disk.writeFile(A, A_TEXT);
    const gated = gatedWrites(disk.writeFs);
    const h = createHarness({ fs: disk.readFs, writeFs: gated.fs });
    const ev = mainFrameEvent(h.window(1).sender);
    const a = await openActive(h, ev, A);
    const gateA = gated.gate(1);
    const saveA = save(h, ev, a, 'X:1\nT:A\n');
    await gateA.reached;
    h.handle.handleNavigation(1, CROSS); // A4：页面仍存活，锁被清理，a 转墓碑但仍是锚点
    const gateB = gated.gate(2);
    const target = granted(await requestTarget(h, ev, a.capabilityId, NEW));
    const saveB = saveAs(h, ev, target, a.documentId, a.capabilityId, 'X:1\nT:B\n');
    await gateB.reached;
    const heldByB = h.handle.currentState().owners.get(1)?.saveOperation;
    expect(heldByB?.kind).toBe('save-as-write');
    gateA.release();
    expect(await saveA).toMatchObject({ outcome: 'not-committed', error: { code: 'capability-invalid' } });
    expect(disk.text(A)).toBe(A_TEXT);
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toEqual(heldByB);
    // Save C：普通 Save 与 Save As 都得到 busy（B 仍持锁）。
    expect(await save(h, ev, a, 'X:1\nT:C\n')).toMatchObject({ outcome: 'not-committed', error: { code: 'busy' } });
    expect(await requestTarget(h, ev, a.capabilityId, NEW)).toMatchObject({ kind: 'refused', error: { code: 'busy' } });
    gateB.release();
    expect(await saveB).toMatchObject({ outcome: 'saved' });
    expect(disk.text(NEW)).toBe('X:1\nT:B\n');
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
    // D：锁已释放，可以再次授予。
    expect(await requestTarget(h, ev, a.capabilityId, NEW)).toMatchObject({ kind: 'granted' });
    h.expectConsistent();
  });
});

describe('提交事实与三态（T-CS，真实 B1 管线）', () => {
  it('T-CS-3：rename 本身失败 → not-committed；目标不变，临时文件已清理', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    disk.fail('renameSync', 'EACCES');
    expect(await save(h, ev, a, 'X:1\nT:x\n')).toMatchObject({ outcome: 'not-committed', error: { code: 'permission-denied' } });
    expect(disk.text(A)).toBe(A_TEXT);
    expect(disk.list(P('docs')).sort()).toEqual(['a.jcx', 'b.jcx']);
  });

  it('T-CS-7：A9 签发候选 token 时抛出 → committed-unconfirmed、无 ticket；状态与 A9 之前一致（不刷新、不登记）', async () => {
    let issued = 0;
    const { disk, h, ev } = world({
      issueToken: () => {
        issued += 1;
        if (issued === 3) throw new Error('token source failed');
        return `token-${String(issued)}`;
      },
    });
    const a = await openActive(h, ev, A);
    const reply = await requestTarget(h, ev, a.capabilityId, A);
    const before = h.handle.currentState().table.get(a.capabilityId);
    const result = await saveAs(h, ev, granted(reply), a.documentId, a.capabilityId, 'X:1\nT:committed\n');
    expect(result).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
    expect(disk.text(A)).toBe('X:1\nT:committed\n');
    expect(h.handle.currentState().table.get(a.capabilityId)).toBe(before);
    expect([...h.handle.currentState().table.values()].filter((r) => r.purpose === 'open' && r.state === 'pending')).toEqual([]);
    expect(h.saveEvents).toContain('settle-failed');
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
    h.expectConsistent();
  });

  it('T-CS-10：提交之后发生 A4 → committed-unconfirmed；墓碑事实刷新（M53），不登记 pending（M38）', async () => {
    const { disk, h, ev } = world();
    const a = await openActive(h, ev, A);
    const reply = await requestTarget(h, ev, a.capabilityId, A);
    disk.before('syncDirectory', () => h.handle.handleNavigation(1, CROSS));
    const result = await saveAs(h, ev, granted(reply), a.documentId, a.capabilityId, 'X:1\nT:late\n');
    expect(result).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
    const record = h.handle.currentState().table.get(a.capabilityId);
    expect(record?.purpose).toBe('tombstone');
    expect(record?.purpose === 'tombstone' ? record.lastKnownDiskFingerprint : null).toBe(sha256Hex(bytesOf('X:1\nT:late\n')));
    expect([...h.handle.currentState().table.values()].some((r) => r.purpose === 'open' && r.state === 'pending')).toBe(false);
    h.expectConsistent();
  });
});

describe('载荷校验与 M20（T-H7-9）', () => {
  it('非法载荷 → Request rejected，状态零修改；多余的路径字段不能换来写权限', async () => {
    const { h, ev } = world();
    const a = await openActive(h, ev, A);
    const before = h.handle.currentState();
    const bad: unknown[] = [
      { capabilityId: a.capabilityId, documentId: a.documentId, source: 'x', encoding: 'utf-8', path: NEW },
      { capabilityId: a.capabilityId, documentId: a.documentId, source: 'x', encoding: 'utf-8', displayPath: NEW },
      { capabilityId: a.capabilityId, documentId: a.documentId, source: 'x' },
      { capabilityId: a.capabilityId, documentId: -1, source: 'x', encoding: 'utf-8' },
      { capabilityId: a.capabilityId, documentId: a.documentId, source: 'x', encoding: 'utf-16' },
    ];
    for (const payload of bad) await expect(h.invoke(SAVE, ev, payload)).rejects.toThrow(/^Request rejected$/);
    for (const payload of [{ suggestedName: 'x', encoding: 'utf-8' }, { suggestedName: 'x', encoding: 'utf-8', sourceCapabilityId: '../a' }, { suggestedName: 1, encoding: 'utf-8', sourceCapabilityId: null }]) {
      await expect(h.invoke(REQUEST, ev, payload)).rejects.toThrow(/^Request rejected$/);
    }
    expect(h.handle.currentState()).toBe(before);
  });
});
