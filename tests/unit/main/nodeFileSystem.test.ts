/**
 * M3 T1a：`createNodeReadOnlyFileSystem` 在真实临时目录上的行为（symlink、大小写别名、硬链接、原子替换）。
 *
 * 只在 `os.tmpdir()` 下的 mkdtemp 目录中操作，结束后删除。平台不支持的场景显式 skip（不静默通过）。
 */

import { link, mkdir, mkdtemp, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveFile, sameFile } from '../../../src/main/document/fileIdentity';
import { createNodeReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import { errnoCodeOf } from '../../../src/main/document/fsErrors';
import { readDocumentBytes } from '../../../src/main/document/readDocumentBytes';

const fs = createNodeReadOnlyFileSystem();
const platform = process.platform;
let root = '';

/** 真实根目录（macOS 的 tmpdir 位于 /var → /private/var 符号链接之下）。 */
let realRoot = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'muse-t1a-fs-'));
  realRoot = await fs.realpath(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    // Windows 未开启开发者模式时创建符号链接需要特权。
    if (platform === 'win32' && errnoCodeOf(error) === 'EPERM') return false;
    throw error;
  }
}

/** 探测临时卷是否大小写不敏感：创建 Probe 文件后 stat 其小写别名。 */
async function caseInsensitiveVolume(dir: string): Promise<boolean> {
  const probe = join(dir, 'CaseProbe.txt');
  await writeFile(probe, 'x');
  try {
    await stat(join(dir, 'caseprobe.txt'));
    return true;
  } catch {
    return false;
  }
}

describe('createNodeReadOnlyFileSystem —— 真实文件系统', () => {
  it('读取普通文件：bytes 一致，realpath 位于真实根目录下', async () => {
    const file = join(root, 'plain.jcx');
    await writeFile(file, Uint8Array.from([0x41, 0x42]));
    const result = await readDocumentBytes(fs, file);
    if (!result.ok) throw new Error(result.code);
    expect([...result.bytes]).toEqual([0x41, 0x42]);
    expect(result.realpath).toBe(join(realRoot, 'plain.jcx'));
    expect(result.handleStat.isFile()).toBe(true);
    expect(typeof result.handleStat.size).toBe('bigint');
  });

  it('目录 → not-a-regular-file；不存在 → not-found', async () => {
    await mkdir(join(root, 'dir'));
    expect(await readDocumentBytes(fs, join(root, 'dir'))).toEqual({ ok: false, code: 'not-a-regular-file' });
    expect(await readDocumentBytes(fs, join(root, 'nope.jcx'))).toEqual({ ok: false, code: 'not-found' });
  });

  it('symlink → realpath 是目标的真实路径，sameFile 为 same', async (context) => {
    const target = join(root, 'target.jcx');
    await writeFile(target, 'T:x\n');
    const alias = join(root, 'alias.jcx');
    if (!(await trySymlink(target, alias))) {
      context.skip();
      return;
    }
    const result = await readDocumentBytes(fs, alias);
    expect(result.ok && result.realpath).toBe(join(realRoot, 'target.jcx'));
    expect(sameFile(await resolveFile(fs, alias, platform), await resolveFile(fs, target, platform))).toBe('same');
  });

  it('大小写别名：在大小写不敏感卷上原生 realpath 返回磁盘真实大小写，sameFile 为 same', async (context) => {
    const dir = join(root, 'case');
    await mkdir(dir);
    if (!(await caseInsensitiveVolume(dir))) {
      context.skip();
      return;
    }
    const original = join(dir, 'MixedCase.jcx');
    await writeFile(original, 'x');
    const alias = join(dir, 'mixedcase.JCX');
    const realOriginal = await fs.realpath(original);
    expect(await fs.realpath(alias)).toBe(realOriginal);
    expect(realOriginal.endsWith('MixedCase.jcx')).toBe(true);
    expect(sameFile(await resolveFile(fs, alias, platform), await resolveFile(fs, original, platform))).toBe('same');
  });

  it('硬链接（POSIX）：realpath 不同但 (dev, ino) 相同 → same', async (context) => {
    if (platform === 'win32') {
      context.skip();
      return;
    }
    const a = join(root, 'hard-a.jcx');
    const b = join(root, 'hard-b.jcx');
    await writeFile(a, 'x');
    await link(a, b);
    const ra = await resolveFile(fs, a, platform);
    const rb = await resolveFile(fs, b, platform);
    expect(ra.kind === 'resolved' && rb.kind === 'resolved' && ra.realpath !== rb.realpath).toBe(true);
    expect(sameFile(ra, rb)).toBe('same');
  });

  it('原子替换：ino 变化但 realpath 不变 → same（OR 而不是 AND）', async () => {
    const file = join(root, 'atomic.jcx');
    await writeFile(file, 'old');
    const before = await resolveFile(fs, file, platform);
    const temp = join(root, 'atomic.jcx.tmp');
    await writeFile(temp, 'new');
    await rename(temp, file);
    const after = await resolveFile(fs, file, platform);
    if (before.kind !== 'resolved' || after.kind !== 'resolved') throw new Error('expected resolved');
    expect(after.realpath).toBe(before.realpath);
    if (platform !== 'win32') {
      expect(before.identity).not.toBeNull();
      expect(after.identity?.ino).not.toBe(before.identity?.ino);
    } else {
      expect(after.identity).toBeNull();
    }
    expect(sameFile(before, after)).toBe('same');
  });

  it('两个不同文件 → different；一边不存在 → unknown', async () => {
    const a = join(root, 'diff-a.jcx');
    const b = join(root, 'diff-b.jcx');
    await writeFile(a, 'a');
    await writeFile(b, 'b');
    expect(sameFile(await resolveFile(fs, a, platform), await resolveFile(fs, b, platform))).toBe('different');
    expect(sameFile(await resolveFile(fs, a, platform), await resolveFile(fs, join(root, 'gone'), platform))).toBe('unknown');
  });
});
