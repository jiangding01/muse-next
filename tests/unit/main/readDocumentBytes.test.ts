/**
 * M3 T1a：有界读取（D5 三道上限防护）与 fs 错误映射（D7）。
 */

import { describe, expect, it } from 'vitest';

import { errnoCodeOf, mapFsError } from '../../../src/main/document/fsErrors';
import { MAX_DOCUMENT_BYTES, readDocumentBytes } from '../../../src/main/document/readDocumentBytes';
import { bytesOf, createFakeFileSystem, errno, filled } from './fakeFileSystem';

const LIMIT = 100;

describe('readDocumentBytes —— 上限与有界读取', () => {
  it('MAX_DOCUMENT_BYTES 恰为 1 MiB', () => {
    expect(MAX_DOCUMENT_BYTES).toBe(1_048_576);
  });

  it('恰好 limit 字节通过，返回独立拷贝与 realpath、句柄 stat', async () => {
    const bytes = filled(LIMIT);
    const fs = createFakeFileSystem({ '/real/a.jcx': { kind: 'file', bytes, ino: 7n } }, { links: { '/link/a.jcx': '/real/a.jcx' } });
    const result = await readDocumentBytes(fs, '/link/a.jcx', LIMIT);
    if (!result.ok) throw new Error(result.code);
    expect(result.realpath).toBe('/real/a.jcx');
    expect([...result.bytes]).toEqual([...bytes]);
    expect(result.bytes.buffer).not.toBe(bytes.buffer);
    expect(result.bytes.buffer.byteLength).toBe(LIMIT);
    expect(result.handleStat.ino).toBe(7n);
    // 所有操作都针对 realpath；读后复核句柄与路径（realpath 仍针对用户给出的路径重新解析）。
    expect(fs.calls).toEqual([
      'realpath:/link/a.jcx',
      'stat:/real/a.jcx',
      'open:/real/a.jcx',
      'handle.stat',
      'handle.stat',
      'realpath:/link/a.jcx',
      'stat:/real/a.jcx',
    ]);
  });

  it('第一道：stat 报告 limit + 1 → file-too-large，且根本不 open', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(LIMIT + 1) } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
    expect(fs.opened()).toBe(0);
    expect(fs.reads).toEqual([]);
  });

  it('第二道：路径 stat 报小、句柄 stat 报大 → file-too-large，不读取，句柄被关闭', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(10), statSize: 10n, handleSize: BigInt(LIMIT + 1) } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
    expect(fs.reads).toEqual([]);
    expect(fs.closed()).toBe(1);
  });

  it('第三道：两次 stat 都报小，实际读出 > limit → file-too-large；请求与交付永不越过 limit + 1', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(LIMIT * 5), statSize: 3n, chunk: 30 } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
    expect(fs.delivered()).toBe(LIMIT + 1);
    for (const call of fs.reads) {
      expect(call.bufferLength).toBe(LIMIT + 1);
      expect(call.offset + call.length).toBeLessThanOrEqual(LIMIT + 1);
      expect(call.position).toBe(call.offset);
    }
    expect(fs.closed()).toBe(1);
  });

  it('limit + 1 字节的文件（stat 如实报告）在第一道就被拒绝；stat 谎报为 0 时在第三道被拒绝', async () => {
    const honest = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(LIMIT + 1) } });
    expect(await readDocumentBytes(honest, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
    const lying = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(LIMIT + 1), statSize: 0n } });
    expect(await readDocumentBytes(lying, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
  });

  it('EOF 短读：逐块读取直到 bytesRead 为 0，position 单调递增', async () => {
    const bytes = Uint8Array.from({ length: 25 }, (_, index) => index);
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes, chunk: 7 } });
    const result = await readDocumentBytes(fs, '/f', LIMIT);
    if (!result.ok) throw new Error(result.code);
    expect([...result.bytes]).toEqual([...bytes]);
    expect(fs.reads.map((call) => call.position)).toEqual([0, 7, 14, 21, 25]);
  });

  it('空文件与 limit = 0 的边界', async () => {
    const empty = createFakeFileSystem({ '/f': { kind: 'file', bytes: new Uint8Array(0) } });
    const result = await readDocumentBytes(empty, '/f', 0);
    expect(result.ok && result.bytes.length).toBe(0);
    const one = createFakeFileSystem({ '/f': { kind: 'file', bytes: bytesOf(0x41), statSize: 0n } });
    expect(await readDocumentBytes(one, '/f', 0)).toEqual({ ok: false, code: 'file-too-large' });
  });

  it('非法 limit 是编程错误：抛 RangeError', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(1) } });
    await expect(readDocumentBytes(fs, '/f', -1)).rejects.toThrow(RangeError);
    await expect(readDocumentBytes(fs, '/f', 1.5)).rejects.toThrow(RangeError);
  });
});

describe('readDocumentBytes —— 非普通文件与句柄关闭', () => {
  it('目录与 FIFO 在 open 之前被拒绝（not-a-regular-file）', async () => {
    const fs = createFakeFileSystem({ '/d': { kind: 'dir' }, '/p': { kind: 'fifo' } });
    expect(await readDocumentBytes(fs, '/d', LIMIT)).toEqual({ ok: false, code: 'not-a-regular-file' });
    expect(await readDocumentBytes(fs, '/p', LIMIT)).toEqual({ ok: false, code: 'not-a-regular-file' });
    expect(fs.opened()).toBe(0);
  });

  it('stat 与 open 之间被替换成非普通文件：句柄 stat 复核拒绝并关闭句柄', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(3), handleKind: 'fifo' } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'not-a-regular-file' });
    expect(fs.closed()).toBe(1);
  });

  it('读取中途抛错：映射错误码，句柄仍被关闭', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(50), chunk: 10, readThrowsAt: { call: 2, error: errno('EIO') } } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    expect(fs.closed()).toBe(1);
  });

  it('句柄 stat 抛错：映射错误码，句柄仍被关闭', async () => {
    const fs = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(5), handleStatThrows: errno('EACCES') } });
    expect(await readDocumentBytes(fs, '/f', LIMIT)).toEqual({ ok: false, code: 'permission-denied' });
    expect(fs.closed()).toBe(1);
  });

  it('close 失败不覆盖已得出的结论（成功仍成功，失败码不变）', async () => {
    const ok = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(5), closeThrows: errno('EIO') } });
    expect((await readDocumentBytes(ok, '/f', LIMIT)).ok).toBe(true);
    const tooLarge = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(5), handleSize: 999n, closeThrows: errno('EIO') } });
    expect(await readDocumentBytes(tooLarge, '/f', LIMIT)).toEqual({ ok: false, code: 'file-too-large' });
  });

  it('port 返回越界 bytesRead 视为 read-failed', async () => {
    const base = createFakeFileSystem({ '/f': { kind: 'file', bytes: filled(5) } });
    const lying = {
      ...base,
      openForRead: async (path: string) => {
        const handle = await base.openForRead(path);
        return { ...handle, read: async () => 10_000 };
      },
    };
    expect(await readDocumentBytes(lying, '/f', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    expect(base.closed()).toBe(1);
  });
});

describe('fs 错误映射（D7）', () => {
  it.each([
    ['ENOENT', 'not-found'],
    ['ENOTDIR', 'not-found'],
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['EISDIR', 'not-a-regular-file'],
    ['ELOOP', 'read-failed'],
    ['EIO', 'read-failed'],
    ['EMFILE', 'read-failed'],
    ['EBUSY', 'read-failed'],
  ])('%s → %s', (code, expected) => {
    expect(mapFsError(errno(code))).toBe(expected);
  });

  it('非 errno 异常 → read-failed；code 不是字符串时不当作 errno', () => {
    expect(mapFsError(new Error('boom'))).toBe('read-failed');
    expect(mapFsError('ENOENT')).toBe('read-failed');
    expect(mapFsError(null)).toBe('read-failed');
    expect(mapFsError({ code: 2 })).toBe('read-failed');
    expect(errnoCodeOf({ code: 'ENOENT' })).toBe('ENOENT');
    expect(errnoCodeOf({ code: 2 })).toBeNull();
  });

  it('realpath / stat / open 各阶段的 errno 都被映射', async () => {
    const fs = createFakeFileSystem(
      { '/a': { kind: 'file', bytes: filled(1) }, '/b': { kind: 'file', bytes: filled(1) }, '/c': { kind: 'file', bytes: filled(1) } },
      { realpathThrows: { '/a': errno('ELOOP') }, statThrows: { '/b': errno('EACCES') }, openThrows: { '/c': errno('EPERM') } },
    );
    expect(await readDocumentBytes(fs, '/a', LIMIT)).toEqual({ ok: false, code: 'read-failed' });
    expect(await readDocumentBytes(fs, '/b', LIMIT)).toEqual({ ok: false, code: 'permission-denied' });
    expect(await readDocumentBytes(fs, '/c', LIMIT)).toEqual({ ok: false, code: 'permission-denied' });
    expect(await readDocumentBytes(fs, '/missing', LIMIT)).toEqual({ ok: false, code: 'not-found' });
  });
});
