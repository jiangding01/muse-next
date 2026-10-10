/**
 * M3 T1a：读取一致性复核（TOCTOU 检测，`readDocumentBytes.ts` 第 3 / 5 步）。
 *
 * 复核只能检测变化、不等于原子快照（残余竞态见实现文件头）；这里钉死可检测的几类：
 * stat 与 open 之间路径被替换、读取过程中文件被改写、读取过程中路径被替换、句柄 size 与实际读取量不符。
 * 任一被检测到都必须是 `read-failed`，且 Open 管线不分配 documentId、不签发 token。
 */

import { mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createNodeReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import type { ReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import { openDocumentAtPath } from '../../../src/main/document/openDocument';
import { readDocumentBytes } from '../../../src/main/document/readDocumentBytes';
import { createFakeFileSystem, filled } from './fakeFileSystem';

const LIMIT = 100;

describe('readDocumentBytes —— 一致性复核（内存 fake）', () => {
  it('stat 与 open 之间被 rename 替换（句柄 ino ≠ 路径 ino）→ read-failed', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), ino: 5n, handleIno: 6n } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    expect(fs.closed()).toBe(fs.opened());
  });

  it('读取过程中被原地改写（读后 mtime 变化）→ read-failed', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), mtimeNs: 1n, mtimeNsAfterRead: 2n } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('读取过程中路径被替换（句柄仍指向旧文件，路径 ino 已变）→ read-failed', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), ino: 5n, pathInoAfterRead: 9n } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('句柄 size 与实际读到的字节数不符（未超上限）→ read-failed，而不是当成稳定快照', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(20), statSize: 10n } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('读后 realpath 解析到其它路径 → read-failed', async () => {
    let calls = 0;
    const base = createFakeFileSystem({ '/a': { kind: 'file', bytes: filled(3) }, '/b': { kind: 'file', bytes: filled(3) } });
    const relinking: ReadOnlyFileSystem = {
      ...base,
      realpath: async (path) => {
        calls += 1;
        return calls === 1 ? base.realpath('/a') : base.realpath(path === '/link' ? '/b' : path);
      },
    };
    expect(await readDocumentBytes(relinking, '/link', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it.each([
    ['ctime', { handleCtimeNs: 7n }],
    ['birthtime', { handleBirthtimeNs: 7n }],
  ] as const)('句柄 stat 的 %s 与路径 stat 不同（同一 ino 也不放行）→ read-failed', async (_label, knob) => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), ino: 5n, ...knob } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('读后路径复核时 stat 抛 ENOENT（读完后文件被删除）→ read-failed，而不是 not-found 或异常外抛', async () => {
    let stats = 0;
    const base = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(3) } });
    const vanishing: ReadOnlyFileSystem = {
      ...base,
      stat: async (path) => {
        stats += 1;
        if (stats > 1) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return base.stat(path);
      },
    };
    expect(await readDocumentBytes(vanishing, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    expect(stats).toBe(2);
  });

  it('无变化时一切复核通过', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), ino: 5n, mtimeNs: 3n } });
    expect((await readDocumentBytes(fs, '/f', LIMIT)).ok).toBe(true);
  });

  it('Open 管线：一致性复核失败时不分配 documentId、不签发 token', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), mtimeNs: 1n, mtimeNsAfterRead: 2n } });
    let allocated = 0;
    let issued = 0;
    const result = await openDocumentAtPath(
      {
        fs,
        platform: 'linux',
        ownerId: 1,
        allocateDocumentId: () => {
          allocated += 1;
          return allocated;
        },
        issueToken: () => {
          issued += 1;
          return `t${String(issued)}`;
        },
      },
      '/f',
    );
    expect(result.kind).toBe('failed');
    expect(allocated).toBe(0);
    expect(issued).toBe(0);
  });
});

describe('readDocumentBytes —— 一致性复核（真实文件系统）', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'muse-t1a-consistency-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('stat 之后、open 之前被 rename 原子替换 → read-failed', async () => {
    const target = join(root, 'song.jcx');
    const replacement = join(root, 'replacement.jcx');
    await writeFile(target, 'T:original\n');
    await writeFile(replacement, 'T:replacement\n');
    const real = createNodeReadOnlyFileSystem();
    const swapping: ReadOnlyFileSystem = {
      ...real,
      openForRead: async (path) => {
        await rename(replacement, target);
        return real.openForRead(path);
      },
    };
    expect(await readDocumentBytes(swapping, target, LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('stat 之后、open 之前被换成指向另一文件的 symlink → read-failed', async (context) => {
    const target = join(root, 'song.jcx');
    const other = join(root, 'other.jcx');
    const staged = join(root, 'staged-link.jcx');
    await writeFile(target, 'T:original\n');
    await writeFile(other, 'T:other-file\n');
    try {
      await symlink(other, staged);
    } catch (error) {
      if (process.platform === 'win32') {
        context.skip(`symlink needs privilege on this Windows host: ${String(error)}`);
        return;
      }
      throw error;
    }
    const real = createNodeReadOnlyFileSystem();
    const swapping: ReadOnlyFileSystem = {
      ...real,
      openForRead: async (path) => {
        await rename(staged, target);
        return real.openForRead(path);
      },
    };
    expect(await readDocumentBytes(swapping, target, LIMIT)).toEqual({ ok: false, code: 'read-failed' });
  });

  it('读取第一块之后文件被整体改写 → read-failed（不产出磁盘上从未存在过的拼接内容）', async () => {
    const target = join(root, 'song.jcx');
    await writeFile(target, 'A'.repeat(64));
    const real = createNodeReadOnlyFileSystem();
    const tearing: ReadOnlyFileSystem = {
      ...real,
      openForRead: async (path) => {
        const handle = await real.openForRead(path);
        let first = true;
        return {
          ...handle,
          read: async (buffer, offset, _length, position) => {
            // 每次只交付 8 字节，读完第一块后改写文件（新的 size 与内容）。
            const bytesRead = await handle.read(buffer, offset, 8, position);
            if (first) {
              first = false;
              await writeFile(target, 'B'.repeat(80));
            }
            return bytesRead;
          },
        };
      },
    };
    expect(await readDocumentBytes(tearing, target, LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    // 测试自身的改写确实发生了（证明场景成立，而不是复核碰巧失败）。
    expect((await readFile(target, 'utf8')).startsWith('B')).toBe(true);
  });
});
