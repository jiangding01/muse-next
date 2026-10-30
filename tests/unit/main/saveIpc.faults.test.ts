/**
 * M3 T4 B2：保存 IPC 的错误注入补充（勘误 §3.5 T-CS-1 / 2 / 4 / 8 与阶段 1 兜底；B2 独立审查 MEDIUM-2）。
 * 真实 B1 管线 + 内存 fs；三态只取决于是否越过提交点。
 */

import { describe, expect, it } from 'vitest';

import { IPC } from '../../../src/shared/ipc';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN } from './openIpcHarness';
import type { Harness, HarnessOptions } from './openIpcHarness';
import { P, setup } from './saveTestKit';
import type { FakeWriteFs } from './fakeWriteFileSystem';

const A = P('docs', 'a.jcx');
const NEW = P('docs', 'new.jcx');
const A_TEXT = 'X:1\nT:a\n';

async function opened(options: HarnessOptions = {}): Promise<{ disk: FakeWriteFs; h: Harness; ev: ReturnType<typeof mainFrameEvent>; ticket: { capabilityId: string; documentId: number } }> {
  const disk = setup('linux');
  disk.writeFile(A, A_TEXT);
  const h = createHarness({ fs: disk.readFs, writeFs: disk.writeFs, ...options });
  const ev = mainFrameEvent(h.window(1).sender);
  const pending = h.invoke(OPEN, ev, DIALOG);
  h.resolveDialog(0, A);
  const reply = (await pending) as { document: { documentId: number; file: { capability: { id: string } } } };
  const ticket = { capabilityId: reply.document.file.capability.id, documentId: reply.document.documentId };
  expect(await h.invoke(ACTIVATE, ev, ticket)).toEqual({ ok: true });
  return { disk, h, ev, ticket };
}

async function grant(h: Harness, ev: ReturnType<typeof mainFrameEvent>, source: string | null, path: string): Promise<unknown> {
  const pending = h.invoke(IPC.requestSaveTarget, ev, { suggestedName: 'new.jcx', encoding: 'utf-8', sourceCapabilityId: source });
  h.resolveDialog(h.dialogParents.length - 1, path);
  return pending;
}

describe('T-CS（IPC 层补充）', () => {
  it('T-CS-1：提交点之前的异常（阶段 2 时钟非有限）→ not-committed；G 已被消费；写 port 零调用', async () => {
    const { disk, h, ev, ticket } = await opened();
    const target = ((await grant(h, ev, ticket.capabilityId, NEW)) as { capabilityId: string }).capabilityId;
    const calls = disk.calls.length;
    h.clock = Number.NaN;
    const reply = await h.invoke(IPC.saveDocument, ev, { capabilityId: target, documentId: ticket.documentId, source: 'x', encoding: 'utf-8', sourceCapabilityId: ticket.capabilityId });
    expect(reply).toMatchObject({ outcome: 'not-committed', error: { code: 'capability-invalid' } });
    expect(disk.calls.length).toBe(calls);
    expect(h.handle.currentState().table.has(target)).toBe(false);
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
  });

  it('T-CS-2：临时文件阶段失败 → not-committed；目标不变，没有残留临时文件', async () => {
    const { disk, h, ev, ticket } = await opened();
    disk.fail('openExclusive', 'ENOSPC');
    expect(await h.invoke(IPC.saveDocument, ev, { ...ticket, source: 'X:1\nT:b\n', encoding: 'utf-8' })).toMatchObject({ outcome: 'not-committed', error: { code: 'disk-full' } });
    expect(disk.text(A)).toBe(A_TEXT);
    expect(disk.list(P('docs'))).toEqual(['a.jcx']);
  });

  it('T-CS-4：提交之后的步骤失败（目录 fsync）→ 仍为 saved，绝不报未提交；记诊断', async () => {
    const { disk, h, ev, ticket } = await opened();
    disk.fail('syncDirectory', 'EIO');
    expect(await h.invoke(IPC.saveDocument, ev, { ...ticket, source: 'X:1\nT:c\n', encoding: 'utf-8' })).toMatchObject({ outcome: 'saved' });
    expect(disk.text(A)).toBe('X:1\nT:c\n');
    expect(h.saveEvents).toContain('directory-sync-failed');
  });

  it('T-CS-8：A9 计算失败（候选 token 与已有记录重复）→ committed-unconfirmed、无 ticket；状态整体不变', async () => {
    let issued = 0;
    let first = '';
    const { disk, h, ev, ticket } = await opened({
      issueToken: () => {
        issued += 1;
        if (issued === 1) first = `token-${String(issued)}`;
        // 第 3 次（A9 的候选）返回第一次签发的 token：settleSave 自检拒绝重复 token。
        return issued === 3 ? first : `token-${String(issued)}`;
      },
    });
    const target = ((await grant(h, ev, ticket.capabilityId, NEW)) as { capabilityId: string }).capabilityId;
    const before = h.handle.currentState().table;
    const reply = await h.invoke(IPC.saveDocument, ev, { capabilityId: target, documentId: ticket.documentId, source: 'X:1\nT:new\n', encoding: 'utf-8', sourceCapabilityId: ticket.capabilityId });
    expect(reply).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
    expect(disk.text(NEW)).toBe('X:1\nT:new\n');
    expect([...h.handle.currentState().table.keys()]).toEqual([...before.keys()].filter((token) => token !== target));
    expect(h.saveEvents).toContain('settle-failed');
    h.expectConsistent();
  });

  it('阶段 1 兜底：授予途中意外异常（token 签发失败）→ refused capability-invalid；不登记，锁已释放', async () => {
    let issued = 0;
    const { h, ev, ticket } = await opened({
      issueToken: () => {
        issued += 1;
        if (issued === 2) throw new Error('token source failed');
        return `token-${String(issued)}`;
      },
    });
    expect(await grant(h, ev, ticket.capabilityId, NEW)).toMatchObject({ kind: 'refused', error: { code: 'capability-invalid' } });
    expect([...h.handle.currentState().table.values()].some((record) => record.purpose === 'save-target')).toBe(false);
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
  });
});
