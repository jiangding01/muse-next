/**
 * M3 T4 B2：保存 IPC 在真实文件系统上（`os.tmpdir()` 下的隔离目录，不触碰任何用户文档）。
 *
 * 只覆盖内存 fs 证明不了的部分：真实 `link` 发布新文件、真实 `rename` 覆盖已存在文件、A4 之后墓碑仍能识别原文件
 * （R11 / M41）、悬空符号链接不被替换（M42）。Windows 的磁盘行为属 W-DISK（B5），这里只在 POSIX 上运行。
 */

import { mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import { createNodeWriteFileSystem } from '../../../src/main/document/nodeWriteFileSystem';
import { IPC } from '../../../src/shared/ipc';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN } from './openIpcHarness';
import type { Harness } from './openIpcHarness';

const posix = process.platform !== 'win32';
let dir = '';

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'muse-b2-save-')));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function start(): Promise<{ h: Harness; ev: ReturnType<typeof mainFrameEvent>; open(path: string): Promise<{ capabilityId: string; documentId: number }> }> {
  const h = createHarness({ fs: createNodeReadOnlyFileSystem(), writeFs: createNodeWriteFileSystem() });
  const ev = mainFrameEvent(h.window(1).sender);
  return {
    h,
    ev,
    async open(path) {
      const pending = h.invoke(OPEN, ev, DIALOG);
      h.resolveDialog(h.dialogParents.length - 1, path);
      const reply = (await pending) as { document: { documentId: number; file: { capability: { id: string } } } };
      const ticket = { capabilityId: reply.document.file.capability.id, documentId: reply.document.documentId };
      expect(await h.invoke(ACTIVATE, ev, ticket)).toEqual({ ok: true });
      return ticket;
    },
  };
}

async function target(h: Harness, ev: ReturnType<typeof mainFrameEvent>, source: string | null, path: string): Promise<{ kind: string; capabilityId?: string; sameAsCurrent?: boolean; error?: { code: string } }> {
  const pending = h.invoke(IPC.requestSaveTarget, ev, { suggestedName: 'x.jcx', encoding: 'utf-8', sourceCapabilityId: source });
  if (h.dialogParents.length > 0) h.resolveDialog(h.dialogParents.length - 1, path);
  return (await pending) as { kind: string; capabilityId?: string; sameAsCurrent?: boolean };
}

describe.skipIf(!posix)('保存 IPC（真实文件系统）', () => {
  it('普通 Save 与 Save As：新文件经 link 发布、已存在文件经 rename 覆盖，原文件不变', async () => {
    const a = join(dir, 'a.jcx');
    const other = join(dir, 'other.jcx');
    await writeFile(a, 'X:1\nT:a\n');
    await writeFile(other, 'X:1\nT:other\n');
    const { h, ev, open } = await start();
    const ticket = await open(a);
    expect(await h.invoke(IPC.saveDocument, ev, { ...ticket, source: 'X:1\nT:a2\n', encoding: 'utf-8' })).toMatchObject({ outcome: 'saved' });
    expect(await readFile(a, 'utf8')).toBe('X:1\nT:a2\n');

    const fresh = join(dir, 'fresh.jcx');
    const granted = await target(h, ev, ticket.capabilityId, fresh);
    expect(granted).toMatchObject({ kind: 'granted', sameAsCurrent: false });
    expect(await h.invoke(IPC.saveDocument, ev, { capabilityId: granted.capabilityId, documentId: ticket.documentId, source: 'X:1\nT:fresh\n', encoding: 'utf-8', sourceCapabilityId: ticket.capabilityId })).toMatchObject({ outcome: 'saved' });
    expect(await readFile(fresh, 'utf8')).toBe('X:1\nT:fresh\n');

    const replace = await target(h, ev, ticket.capabilityId, other);
    expect(await h.invoke(IPC.saveDocument, ev, { capabilityId: replace.capabilityId, documentId: ticket.documentId, source: 'X:1\nT:replaced\n', encoding: 'utf-8', sourceCapabilityId: ticket.capabilityId })).toMatchObject({ outcome: 'saved' });
    expect(await readFile(other, 'utf8')).toBe('X:1\nT:replaced\n');
    expect(await readFile(a, 'utf8')).toBe('X:1\nT:a2\n');
  });

  it('R11 / M41：A4（页面仍存活）后锚点是墓碑——Save As 选原文件仍识别为同一文件；A5 之后锚点清空', async () => {
    const a = join(dir, 'a.jcx');
    await writeFile(a, 'X:1\nT:a\n');
    const { h, ev, open } = await start();
    const ticket = await open(a);
    h.handle.handleNavigation(1, { isMainFrame: true, isSameDocument: false });
    expect(await target(h, ev, ticket.capabilityId, a)).toMatchObject({ kind: 'granted', sameAsCurrent: true });
    h.handle.handleNavigationCommitted(1);
    expect(await target(h, ev, ticket.capabilityId, a)).toMatchObject({ kind: 'refused', error: { code: 'source-mismatch' } });
    expect(await target(h, ev, null, a)).toMatchObject({ kind: 'granted', sameAsCurrent: false });
  });

  it('M42：目标名是悬空符号链接 → not-a-regular-file；链接保留，其指向处不被创建', async () => {
    const link = join(dir, 'dangling.jcx');
    const pointee = join(dir, 'missing.jcx');
    await symlink(pointee, link);
    const { h, ev } = await start();
    expect(await target(h, ev, null, link)).toMatchObject({ kind: 'refused', error: { code: 'not-a-regular-file' } });
    expect(await readlink(link)).toBe(pointee);
    await expect(readFile(pointee)).rejects.toThrow();
  });
});
