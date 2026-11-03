/**
 * M3 T4 B1：保存管线在**真实文件系统**上的行为（`createNodeWriteFileSystem` + `createNodeReadOnlyFileSystem`）。
 *
 * - 只在 `os.tmpdir()` 下的 mkdtemp 目录中读写，结束后删除；不触碰任何真实文档。
 * - 平台不支持的场景显式 skip 并写明原因（不静默通过）。编码向量的权威证据在 Electron 探针，这里只用 ASCII。
 */

import { writeFileSync } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, open, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { sha256Hex } from '../../../src/main/document/fingerprint';
import { createNodeReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import { createNodeWriteFileSystem } from '../../../src/main/document/nodeWriteFileSystem';
import { runSavePipeline } from '../../../src/main/document/savePipeline';
import type { SaveFileFacts, SavePipelineDeps, SaveTargetGrant } from '../../../src/main/document/savePipeline';
import type { WriteFileSystem } from '../../../src/main/document/writeFileSystemPort';

const readFs = createNodeReadOnlyFileSystem();
const posix = process.platform !== 'win32';
const root = process.getuid?.() === 0;
let dir = '';
let counter = 0;

beforeAll(async () => {
  dir = await readFs.realpath(await mkdtemp(join(tmpdir(), 'muse-t4-b1-save-')));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function fresh(name: string, text: string, mode = 0o644): Promise<string> {
  const path = join(dir, `${String((counter += 1))}-${name}`);
  await writeFile(path, text);
  await chmod(path, mode);
  return path;
}

async function facts(path: string, text: string): Promise<SaveFileFacts> {
  const s = await stat(path, { bigint: true });
  return {
    realpath: path,
    identity: posix ? { dev: s.dev, ino: s.ino } : null,
    writeEncoding: 'utf-8',
    encodingRoundTrip: 'exact',
    lastKnownDiskFingerprint: sha256Hex(new TextEncoder().encode(text)),
  };
}

/** 由真实 stat 构造 Save As 授予记录（已存在目标）。 */
async function grantOf(path: string): Promise<SaveTargetGrant> {
  const s = await stat(path, { bigint: true });
  return { kind: 'existing', realpath: path, identity: process.platform === 'win32' ? null : { dev: s.dev, ino: s.ino }, size: s.size, mtimeNs: s.mtimeNs };
}

function deps(writeFs: WriteFileSystem = createNodeWriteFileSystem()): SavePipelineDeps {
  return { readFs, writeFs, platform: process.platform, tempName: () => `.muse-b1-${String((counter += 1))}.tmp`, stillCurrent: () => true, log: () => undefined };
}

/** 在真实 port 外包一层，于指定步骤前执行外部动作（模拟其它进程）。 */
function hooked(hooks: { beforeLink?: () => void; duringWrite?: () => Promise<void> }): WriteFileSystem {
  const real = createNodeWriteFileSystem();
  return {
    ...real,
    openExclusive: async (path, mode) => {
      const handle = await real.openExclusive(path, mode);
      return {
        ...handle,
        writeAll: async (bytes) => {
          await hooks.duringWrite?.();
          await handle.writeAll(bytes);
        },
      };
    },
    linkSync: (existing, newPath) => {
      hooks.beforeLink?.();
      real.linkSync(existing, newPath);
    },
  };
}

const leftovers = async (): Promise<string[]> => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));

describe('真实文件系统上的保存管线', () => {
  it('普通 Save：CRLF / 孤立 CR 逐字节写入，权限位保持，不留临时文件', async () => {
    const path = await fresh('crlf.jcx', 'X:1\r\nC D\r', 0o640);
    const result = await runSavePipeline(deps(), { kind: 'save', current: await facts(path, 'X:1\r\nC D\r'), source: 'X:1\r\nC E\r', encoding: 'utf-8' });
    expect(result.outcome).toBe('saved');
    expect(await readFile(path, 'latin1')).toBe('X:1\r\nC E\r');
    if (posix) expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(!posix || root)('只读目标（0444）：拒绝，内容不变——即使目录可写、rename 本可覆盖它（探针 F2）', async () => {
    const path = await fresh('ro.jcx', 'RO', 0o444);
    const result = await runSavePipeline(deps(), { kind: 'save', current: await facts(path, 'RO'), source: 'W', encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'permission-denied' } });
    expect(await readFile(path, 'utf8')).toBe('RO');
  });

  it.skipIf(!posix)('符号链接：经链接另存选中原文件 → 写入真实文件，链接本身保留', async () => {
    const path = await fresh('target.jcx', 'T1');
    const alias = join(dir, `${String((counter += 1))}-alias.jcx`);
    await symlink(path, alias);
    const result = await runSavePipeline(deps(), {
      kind: 'saveAs',
      requestedPath: alias,
      granted: await grantOf(path),
      anchor: await facts(path, 'T1'),
      source: 'T2',
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: true });
    expect((await lstat(alias)).isSymbolicLink()).toBe(true);
    expect(await readFile(alias, 'utf8')).toBe('T2');
  });

  it('r1.1 H-6 反例：写临时文件期间目标被原地改写并还原时间戳 → 未发布，外部修改保留', async () => {
    const text = 'X:1\nABCD\n';
    const path = await fresh('inplace.jcx', text);
    const before = await stat(path);
    const writeFs = hooked({
      duringWrite: async () => {
        const handle = await open(path, 'r+');
        await handle.write('ABCE', 4);
        await handle.close();
        await utimes(path, before.atime, before.mtime);
      },
    });
    const result = await runSavePipeline(deps(writeFs), { kind: 'save', current: await facts(path, text), source: 'X:1\nZZZZ\n', encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(await readFile(path, 'utf8')).toBe('X:1\nABCE\n');
    expect(await leftovers()).toEqual([]);
  });

  it('Save As 新文件：link 发布；发布前被抢先创建 → 拒绝，他人文件逐字节不变，临时文件已删', async () => {
    const fresher = join(dir, `${String((counter += 1))}-new.jcx`);
    const ok = await runSavePipeline(deps(), {
      kind: 'saveAs',
      requestedPath: fresher,
      granted: { kind: 'absent', parentRealpath: dir, basename: fresher.slice(dir.length + 1) },
      anchor: null,
      source: 'NEW',
      encoding: 'utf-8',
    });
    expect(ok.outcome).toBe('saved');
    expect(await readFile(fresher, 'utf8')).toBe('NEW');

    const raced = join(dir, `${String((counter += 1))}-raced.jcx`);
    // 钩子必须同步：模拟另一个进程在授予之后、link 之前抢先建立了同名文件。
    const racing = hooked({ beforeLink: () => writeFileSync(raced, 'theirs') });
    const result = await runSavePipeline(deps(racing), {
      kind: 'saveAs',
      requestedPath: raced,
      granted: { kind: 'absent', parentRealpath: dir, basename: raced.slice(dir.length + 1) },
      anchor: null,
      source: 'MINE',
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(await readFile(raced, 'utf8')).toBe('theirs');
    expect(await leftovers()).toEqual([]);
  });

  it.skipIf(!posix)('Save As 目标名是悬空符号链接 → 拒绝，链接保留、其指向处不被创建', async () => {
    const dangling = join(dir, `${String((counter += 1))}-dangling.jcx`);
    const nowhere = join(dir, `${String((counter += 1))}-nowhere.jcx`);
    await symlink(nowhere, dangling);
    const result = await runSavePipeline(deps(), {
      kind: 'saveAs',
      requestedPath: dangling,
      granted: { kind: 'absent', parentRealpath: dir, basename: dangling.slice(dir.length + 1) },
      anchor: null,
      source: 'X',
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect((await lstat(dangling)).isSymbolicLink()).toBe(true);
    await expect(stat(nowhere)).rejects.toThrow();
  });

  it.skipIf(!posix || root)('目录不可写、文件可写 → 创建临时文件失败 permission-denied，原文件不变（§14 已知限制）', async () => {
    const sub = join(dir, `${String((counter += 1))}-locked`);
    await mkdir(sub);
    const path = join(sub, 'inner.jcx');
    await writeFile(path, 'L1');
    await chmod(sub, 0o555);
    try {
      const result = await runSavePipeline(deps(), { kind: 'save', current: await facts(path, 'L1'), source: 'L2', encoding: 'utf-8' });
      expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'permission-denied' } });
      expect(await readFile(path, 'utf8')).toBe('L1');
    } finally {
      await chmod(sub, 0o755);
    }
  });

  it.skipIf(!posix)('R-H8a（真实目录）：原路径被换成指向同内容另一文件的符号链接 → file-modified-on-disk，另一文件不变', async () => {
    const path = await fresh('h8-x.jcx', 'SAME');
    const anchor = await facts(path, 'SAME');
    const other = await fresh('h8-y.jcx', 'SAME');
    await rm(path);
    await symlink(other, path);
    const result = await runSavePipeline(deps(), { kind: 'save', current: anchor, source: 'EDIT', encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(await readFile(other, 'utf8')).toBe('SAME');
  });

  it.skipIf(!posix)('R-H8a（真实目录）：原路径被换成指向同 inode 硬链接别名的符号链接 → 同一文件，允许保存', async () => {
    const path = await fresh('h8-a.jcx', 'SAME');
    const alias = join(dir, `${String((counter += 1))}-h8-alias.jcx`);
    await link(path, alias);
    const anchor = await facts(path, 'SAME');
    await rm(path);
    await symlink(alias, path);
    const result = await runSavePipeline(deps(), { kind: 'save', current: anchor, source: 'EDIT', encoding: 'utf-8' });
    expect(result.outcome).toBe('saved');
    expect(await readFile(alias, 'utf8')).toBe('EDIT');
  });

  it.skipIf(!posix)('R-H8b（真实目录）：原路径已漂移时 Save As 选原 inode 的硬链接（unsafe）→ unsafe-overwrite-refused', async () => {
    const path = await fresh('h8-u.jcx', 'SAME');
    const z = join(dir, `${String((counter += 1))}-h8-z.jcx`);
    await link(path, z);
    const anchor = { ...(await facts(path, 'SAME')), encodingRoundTrip: 'unsafe' as const };
    const other = await fresh('h8-u-y.jcx', 'SAME');
    await rm(path);
    await symlink(other, path);
    const result = await runSavePipeline(deps(), { kind: 'saveAs', requestedPath: z, granted: await grantOf(z), anchor, source: 'EDIT', encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'unsafe-overwrite-refused' } });
    expect(await readFile(z, 'utf8')).toBe('SAME');
  });

  it.skipIf(!posix)('硬链接指向当前文件：同一文件（dev / ino）→ 普通 Save 规则', async () => {
    const path = await fresh('hard-a.jcx', 'H1');
    const other = join(dir, `${String((counter += 1))}-hard-b.jcx`);
    await link(path, other);
    const result = await runSavePipeline(deps(), {
      kind: 'saveAs',
      requestedPath: other,
      granted: await grantOf(other),
      anchor: { ...(await facts(path, 'H1')), encodingRoundTrip: 'unsafe' },
      source: 'H2',
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'unsafe-overwrite-refused' } });
    expect(await readFile(path, 'utf8')).toBe('H1');
  });
});
