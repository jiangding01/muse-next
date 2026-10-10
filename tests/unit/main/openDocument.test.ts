/**
 * M3 T1a：Open 纯管线（读取 → 解码 → 指纹 / 身份 → 分配 id / token），失败时不分配、不签发。
 */

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openDocumentAtPath, openDocumentError } from '../../../src/main/document/openDocument';
import type { OpenDocumentDeps } from '../../../src/main/document/openDocument';
import type { OpenDocumentErrorCode } from '../../../src/shared/openContracts';
import { bytesOf, createFakeFileSystem, errno, filled } from './fakeFileSystem';
import type { FakeFileSystem } from './fakeFileSystem';

interface Counting {
  readonly deps: OpenDocumentDeps;
  readonly counts: { ids: number; tokens: number };
}

function depsFor(fs: FakeFileSystem, platform = 'linux', limit?: number): Counting {
  const counts = { ids: 0, tokens: 0 };
  const base = {
    fs,
    platform,
    ownerId: 42,
    allocateDocumentId: () => {
      counts.ids += 1;
      return 100 + counts.ids;
    },
    issueToken: () => {
      counts.tokens += 1;
      return `token-${String(counts.tokens)}`;
    },
  };
  return { deps: limit === undefined ? base : { ...base, limit }, counts };
}

const ALL_CODES: readonly OpenDocumentErrorCode[] = [
  'not-found',
  'permission-denied',
  'not-a-regular-file',
  'file-too-large',
  'read-failed',
  'decode-utf16-unsupported',
  'decode-invalid-utf8',
  'decode-invalid-gb18030',
];

describe('openDocumentAtPath —— 成功', () => {
  it('返回 DecodedDocument 与 pending 能力：指纹是同一份原始 bytes 的 SHA-256，身份来自句柄 stat', async () => {
    const bytes = bytesOf(0xef, 0xbb, 0xbf, 0x41);
    const fs = createFakeFileSystem({ '/real/song.jcx': { kind: 'file', bytes, dev: 3n, ino: 4n } }, { links: { '/shown/song.jcx': '/real/song.jcx' } });
    const { deps, counts } = depsFor(fs);
    const result = await openDocumentAtPath(deps, '/shown/song.jcx');
    if (result.kind !== 'opened') throw new Error('expected opened');
    const displayPath = resolve('/shown/song.jcx');
    expect(result.document).toEqual({
      documentId: 101,
      source: '﻿A',
      writeEncoding: 'utf-8',
      byteBom: 'utf8',
      encodingRoundTrip: 'exact',
      file: { capability: { id: 'token-1' }, displayName: basename(displayPath), displayPath },
    });
    expect(result.capability).toEqual({
      token: 'token-1',
      ownerId: 42,
      documentId: 101,
      purpose: 'open',
      state: 'pending',
      realpath: '/real/song.jcx',
      displayName: 'song.jcx',
      displayPath,
      writeEncoding: 'utf-8',
      byteBom: 'utf8',
      encodingRoundTrip: 'exact',
      lastKnownDiskFingerprint: createHash('sha256').update(bytes).digest('hex'),
      identity: { dev: 3n, ino: 4n },
    });
    expect(counts).toEqual({ ids: 1, tokens: 1 });
  });

  it('win32 下能力不带 (dev, ino) 身份', async () => {
    const fs = createFakeFileSystem({ '/a.jcx': { kind: 'file', bytes: bytesOf(0x41), dev: 3n, ino: 4n } });
    const result = await openDocumentAtPath(depsFor(fs, 'win32').deps, '/a.jcx');
    expect(result.kind === 'opened' && result.capability.identity).toBeNull();
  });

  it('GB18030 以 U+FEFF 开头：byteBom none、source 保留 U+FEFF', async () => {
    const fs = createFakeFileSystem({ '/g.jcx': { kind: 'file', bytes: bytesOf(0x84, 0x31, 0x95, 0x33, 0xd6, 0xd0) } });
    const result = await openDocumentAtPath(depsFor(fs).deps, '/g.jcx');
    if (result.kind !== 'opened') throw new Error('expected opened');
    expect(result.document.source.startsWith('﻿')).toBe(true);
    expect(result.document.byteBom).toBe('none');
    expect(result.capability.writeEncoding).toBe('gb18030');
  });

  it('GB18030 常见中文正常打开且往返 exact', async () => {
    const fs = createFakeFileSystem({ '/c.jcx': { kind: 'file', bytes: bytesOf(0xd6, 0xd0, 0xce, 0xc4) } });
    const result = await openDocumentAtPath(depsFor(fs).deps, '/c.jcx');
    expect(result.kind === 'opened' && result.document.encodingRoundTrip).toBe('exact');
  });

  it('GB18030 文件的指纹是磁盘原始字节的 SHA-256（不是 source 按 UTF-8 重新编码后的哈希）', async () => {
    const bytes = bytesOf(0xd6, 0xd0, 0xce, 0xc4);
    const fs = createFakeFileSystem({ '/c.jcx': { kind: 'file', bytes } });
    const result = await openDocumentAtPath(depsFor(fs).deps, '/c.jcx');
    if (result.kind !== 'opened') throw new Error('expected opened');
    const rawHash = createHash('sha256').update(bytes).digest('hex');
    const utf8Hash = createHash('sha256').update(new TextEncoder().encode(result.document.source)).digest('hex');
    expect(utf8Hash).not.toBe(rawHash);
    expect(result.capability.lastKnownDiskFingerprint).toBe(rawHash);
  });
});

describe('openDocumentAtPath —— 失败不分配 documentId、不签发 token', () => {
  it.each([
    ['not-found', {}, '/missing'],
    ['not-a-regular-file', { '/d': { kind: 'dir' } }, '/d'],
    ['file-too-large', { '/big': { kind: 'file', bytes: filled(11) } }, '/big'],
    ['decode-utf16-unsupported', { '/u16': { kind: 'file', bytes: bytesOf(0xff, 0xfe, 0x41, 0x00) } }, '/u16'],
    ['decode-invalid-utf8', { '/bad8': { kind: 'file', bytes: bytesOf(0xef, 0xbb, 0xbf, 0xc3, 0x28) } }, '/bad8'],
    ['decode-invalid-gb18030', { '/badgb': { kind: 'file', bytes: bytesOf(0x41, 0xff, 0x41) } }, '/badgb'],
  ] as const)('%s', async (code, entries, path) => {
    const { deps, counts } = depsFor(createFakeFileSystem(entries), 'linux', 10);
    expect(await openDocumentAtPath(deps, path)).toEqual({ kind: 'failed', error: openDocumentError(code) });
    expect(counts).toEqual({ ids: 0, tokens: 0 });
  });

  it('permission-denied / read-failed 同样不分配', async () => {
    const fs = createFakeFileSystem(
      { '/p': { kind: 'file', bytes: filled(1) }, '/e': { kind: 'file', bytes: filled(1), readThrowsAt: { call: 0, error: errno('EIO') } } },
      { openThrows: { '/p': errno('EACCES') } },
    );
    const { deps, counts } = depsFor(fs);
    expect(await openDocumentAtPath(deps, '/p')).toEqual({ kind: 'failed', error: openDocumentError('permission-denied') });
    expect(await openDocumentAtPath(deps, '/e')).toEqual({ kind: 'failed', error: openDocumentError('read-failed') });
    expect(counts).toEqual({ ids: 0, tokens: 0 });
  });
});

describe('openDocumentError —— 固定 message', () => {
  it('每个错误码都有非空、固定的英文说明，不含路径与 external 一词', () => {
    for (const code of ALL_CODES) {
      const error = openDocumentError(code);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
      expect(error.message).not.toMatch(/external/i);
      expect(error.message).not.toMatch(/[/\\]/);
      expect(code).not.toMatch(/external/i);
    }
    expect(new Set(ALL_CODES.map((code) => openDocumentError(code).message)).size).toBe(ALL_CODES.length);
  });
});
