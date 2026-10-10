/**
 * M3 T1a：meaningful identity 与 sameFile 真值表（D4）。
 */

import { describe, expect, it } from 'vitest';

import { meaningfulIdentity, resolveFile, sameFile } from '../../../src/main/document/fileIdentity';
import type { ResolvedFile } from '../../../src/main/document/fileIdentity';
import type { FileStat } from '../../../src/main/document/fileSystemPort';
import { createFakeFileSystem, errno } from './fakeFileSystem';

const stat = (dev: bigint, ino: bigint): FileStat => ({ isFile: () => true, size: 0n, dev, ino, mtimeNs: 0n, ctimeNs: 0n, birthtimeNs: 0n });
const resolved = (realpath: string, identity: { dev: bigint; ino: bigint } | null): ResolvedFile => ({ kind: 'resolved', realpath, identity });
const unresolved: ResolvedFile = { kind: 'unresolved', code: 'not-found' };

describe('meaningfulIdentity', () => {
  it('POSIX：dev、ino 都非 0 时给出身份（bigint 原样保留，不丢精度）', () => {
    const big = 2n ** 63n + 5n;
    expect(meaningfulIdentity(stat(1n, big), 'linux')).toEqual({ dev: 1n, ino: big });
    expect(meaningfulIdentity(stat(3n, 4n), 'darwin')).toEqual({ dev: 3n, ino: 4n });
  });

  it('dev 或 ino 为 0 → null', () => {
    expect(meaningfulIdentity(stat(0n, 4n), 'linux')).toBeNull();
    expect(meaningfulIdentity(stat(3n, 0n), 'darwin')).toBeNull();
  });

  it('win32 不使用 ino → null', () => {
    expect(meaningfulIdentity(stat(3n, 4n), 'win32')).toBeNull();
  });
});

describe('sameFile 真值表', () => {
  it.each([
    ['任一 unresolved → unknown（左）', unresolved, resolved('/a', { dev: 1n, ino: 1n }), 'unknown'],
    ['任一 unresolved → unknown（右）', resolved('/a', null), unresolved, 'unknown'],
    ['两边 unresolved → unknown', unresolved, unresolved, 'unknown'],
    ['realpath 相等 → same（即使 ino 不同：原子替换）', resolved('/a', { dev: 1n, ino: 1n }), resolved('/a', { dev: 1n, ino: 2n }), 'same'],
    ['realpath 相等、身份都缺失 → same', resolved('/a', null), resolved('/a', null), 'same'],
    ['realpath 不同、dev/ino 相等 → same（硬链接）', resolved('/a', { dev: 1n, ino: 9n }), resolved('/b', { dev: 1n, ino: 9n }), 'same'],
    ['realpath 不同、ino 相等但 dev 不同 → different', resolved('/a', { dev: 1n, ino: 9n }), resolved('/b', { dev: 2n, ino: 9n }), 'different'],
    ['realpath 不同、一边身份缺失 → different', resolved('/a', { dev: 1n, ino: 9n }), resolved('/b', null), 'different'],
    ['realpath 不同、两边身份缺失 → different', resolved('/a', null), resolved('/b', null), 'different'],
    ['大小写不同的 realpath 不做折叠 → different', resolved('/x/A.jcx', null), resolved('/x/a.jcx', null), 'different'],
  ] as const)('%s', (_label, a, b, expected) => {
    expect(sameFile(a, b)).toBe(expected);
    expect(sameFile(b, a)).toBe(expected);
  });
});

describe('resolveFile', () => {
  it('实时 realpath + stat；win32 下即使 ino 相同也只靠路径', async () => {
    const fs = createFakeFileSystem(
      { '/real/a': { kind: 'file', dev: 5n, ino: 6n }, '/real/b': { kind: 'file', dev: 5n, ino: 6n } },
      { links: { '/link': '/real/a' } },
    );
    expect(await resolveFile(fs, '/link', 'linux')).toEqual({ kind: 'resolved', realpath: '/real/a', identity: { dev: 5n, ino: 6n } });
    const posixA = await resolveFile(fs, '/real/a', 'linux');
    const posixB = await resolveFile(fs, '/real/b', 'linux');
    expect(sameFile(posixA, posixB)).toBe('same');
    const winA = await resolveFile(fs, '/real/a', 'win32');
    const winB = await resolveFile(fs, '/real/b', 'win32');
    expect(sameFile(winA, winB)).toBe('different');
    expect(sameFile(winA, await resolveFile(fs, '/link', 'win32'))).toBe('same');
  });

  it('realpath / stat 失败 → unresolved（携带映射后的错误码），sameFile 为 unknown 而不是 different', async () => {
    const fs = createFakeFileSystem({ '/a': { kind: 'file' }, '/b': { kind: 'file' } }, { statThrows: { '/b': errno('EACCES') } });
    const missing = await resolveFile(fs, '/missing', 'linux');
    expect(missing).toEqual({ kind: 'unresolved', code: 'not-found' });
    const denied = await resolveFile(fs, '/b', 'linux');
    expect(denied).toEqual({ kind: 'unresolved', code: 'permission-denied' });
    expect(sameFile(await resolveFile(fs, '/a', 'linux'), denied)).toBe('unknown');
  });
});
