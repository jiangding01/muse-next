/**
 * M3 T4 B1：原子写的单元行为（`atomicWrite.ts`，内存 fs）——临时文件阶段与两个同步提交函数本身。
 * 管线层的组合场景见 `savePipeline.*.test.ts`。
 */

import { describe, expect, it } from 'vitest';

import { commitAbsentSync, commitExistingSync, removeTemp, writeTempFile } from '../../../src/main/document/atomicWrite';
import type { TempFile } from '../../../src/main/document/atomicWrite';
import { sha256Hex } from '../../../src/main/document/fingerprint';
import { bytesOf, P, setup } from './saveTestKit';

const DOC = P('docs', 'song.jcx');
let n = 0;
const name = (): string => `.t-${String((n += 1))}.tmp`;

async function temp(fs: ReturnType<typeof setup>, text: string, copyMode: number | null = null): Promise<TempFile> {
  const result = await writeTempFile(fs.writeFs, { directory: P('docs'), bytes: bytesOf(text), copyMode, tempName: name, stillCurrent: () => true });
  if (!result.ok) throw new Error(`unexpected ${result.code}`);
  return result.temp;
}

describe('writeTempFile', () => {
  it('同目录独占创建；覆盖已存在目标时先私有权限，fsync 后复制原权限位（§14 顺序）', async () => {
    const fs = setup();
    const written = await temp(fs, 'abc', 0o640);
    expect(fs.text(written.path)).toBe('abc');
    expect(fs.modeOf(written.path)).toBe(0o640);
    expect(fs.calls.slice(0, 6)).toEqual(['openExclusive', 'handle.writeAll', 'handle.sync', 'handle.chmod', 'handle.stat', 'handle.close']);
  });

  it('临时文件名已被占用 → 换名重试（不覆盖他人文件）；三次都被占用 → 失败', async () => {
    const fs = setup();
    fs.writeFile(P('docs', 'taken.tmp'), 'theirs');
    let calls = 0;
    const result = await writeTempFile(fs.writeFs, {
      directory: P('docs'),
      bytes: bytesOf('x'),
      copyMode: null,
      tempName: () => ((calls += 1) === 1 ? 'taken.tmp' : 'free.tmp'),
      stillCurrent: () => true,
    });
    expect(result.ok).toBe(true);
    expect(fs.text(P('docs', 'taken.tmp'))).toBe('theirs');
    const blocked = await writeTempFile(fs.writeFs, { directory: P('docs'), bytes: bytesOf('x'), copyMode: null, tempName: () => 'taken.tmp', stillCurrent: () => true });
    expect(blocked).toEqual({ ok: false, code: 'write-failed', temp: null });
  });

  it('临时文件名含路径分隔符或 .. → write-failed，不创建任何文件', async () => {
    const fs = setup();
    for (const bad of ['../escape.tmp', 'sub/x.tmp', '..', '']) {
      const result = await writeTempFile(fs.writeFs, { directory: P('docs'), bytes: bytesOf('x'), copyMode: null, tempName: () => bad, stillCurrent: () => true });
      expect(result, bad).toEqual({ ok: false, code: 'write-failed', temp: null });
    }
    expect(fs.calls).not.toContain('openExclusive');
  });

  it('复制权限位失败即失败（§14），返回临时文件路径供清理', async () => {
    const fs = setup();
    fs.fail('handle.chmod', 'EPERM');
    const result = await writeTempFile(fs.writeFs, { directory: P('docs'), bytes: bytesOf('x'), copyMode: 0o600, tempName: name, stillCurrent: () => true });
    expect(result).toMatchObject({ ok: false, code: 'permission-denied' });
    if (result.ok || result.temp === null) throw new Error('unexpected');
    expect(await removeTemp(fs.writeFs, result.temp)).toBe(true);
    expect(fs.list(P('docs'))).toEqual([]);
  });

  it('写入中代次失效 → capability-invalid', async () => {
    const fs = setup();
    let live = true;
    fs.before('handle.writeAll', () => {
      live = false;
    });
    const result = await writeTempFile(fs.writeFs, { directory: P('docs'), bytes: bytesOf('x'), copyMode: null, tempName: name, stillCurrent: () => live });
    expect(result).toMatchObject({ ok: false, code: 'capability-invalid' });
  });
});

describe('commitExistingSync —— 同步临界区', () => {
  it('是同步函数：返回值不是 Promise；临界区内只调用 *Sync 方法', async () => {
    const fs = setup();
    fs.writeFile(DOC, 'old');
    const t = await temp(fs, 'new');
    const start = fs.calls.length;
    const result = commitExistingSync(fs.writeFs, {
      temp: t,
      realpath: DOC,
      expectedFingerprint: sha256Hex(bytesOf('old')),
      expectedIdentity: null,
      expectedStamp: null,
      platform: 'darwin',
      limit: 1024,
      stillCurrent: () => true,
    });
    expect(result instanceof Promise).toBe(false);
    expect(result).toEqual({ committed: true, tempUnlinked: true });
    expect(fs.calls.slice(start).every((call) => call.endsWith('Sync'))).toBe(true);
    expect(fs.text(DOC)).toBe('new');
  });

  it('进入临界区时代次已失效 → 不读盘、不 rename', async () => {
    const fs = setup();
    fs.writeFile(DOC, 'old');
    const t = await temp(fs, 'new');
    const start = fs.calls.length;
    const result = commitExistingSync(fs.writeFs, {
      temp: t,
      realpath: DOC,
      expectedFingerprint: sha256Hex(bytesOf('old')),
      expectedIdentity: null,
      expectedStamp: null,
      platform: 'darwin',
      limit: 1024,
      stillCurrent: () => false,
    });
    expect(result).toEqual({ committed: false, code: 'capability-invalid' });
    expect(fs.calls.slice(start)).toEqual([]);
  });

  it('最终读盘：超过上限、读取后大小变化（注入）、指纹不同都拒绝', async () => {
    const fs = setup();
    fs.writeFile(DOC, 'old content');
    const t = await temp(fs, 'new');
    const base = { temp: t, realpath: DOC, expectedIdentity: null, expectedStamp: null, platform: 'darwin', stillCurrent: () => true };
    expect(commitExistingSync(fs.writeFs, { ...base, expectedFingerprint: sha256Hex(bytesOf('old content')), limit: 4 })).toEqual({
      committed: false,
      code: 'file-modified-on-disk',
    });
    fs.before('readSync', () => fs.modifyInPlace(DOC, 'old content!!'));
    expect(commitExistingSync(fs.writeFs, { ...base, expectedFingerprint: sha256Hex(bytesOf('old content')), limit: 1024 })).toEqual({
      committed: false,
      code: 'file-modified-on-disk',
    });
    expect(commitExistingSync(fs.writeFs, { ...base, expectedFingerprint: sha256Hex(bytesOf('different')), limit: 1024 })).toEqual({
      committed: false,
      code: 'file-modified-on-disk',
    });
    expect(fs.text(DOC)).toBe('old content!!');
  });

  it('打开句柄之后路径被换成另一个文件（同内容）→ 句柄与路径身份不符，拒绝（POSIX）', async () => {
    const fs = setup();
    fs.writeFile(DOC, 'same');
    const t = await temp(fs, 'new');
    fs.before('fstatSync', () => fs.replaceAtomically(DOC, 'same'), 2);
    const result = commitExistingSync(fs.writeFs, {
      temp: t,
      realpath: DOC,
      expectedFingerprint: sha256Hex(bytesOf('same')),
      expectedIdentity: null,
      expectedStamp: null,
      platform: 'darwin',
      limit: 1024,
      stillCurrent: () => true,
    });
    expect(result).toEqual({ committed: false, code: 'file-modified-on-disk' });
  });
});

describe('commitAbsentSync', () => {
  it('同步；只用 link，从不 rename；代次失效时不 link', async () => {
    const fs = setup();
    const t = await temp(fs, 'new');
    const target = P('docs', 'new.jcx');
    expect(commitAbsentSync(fs.writeFs, { temp: t, target, platform: 'darwin', stillCurrent: () => false })).toEqual({
      committed: false,
      code: 'capability-invalid',
    });
    expect(fs.calls).not.toContain('linkSync');
    const result = commitAbsentSync(fs.writeFs, { temp: t, target, platform: 'darwin', stillCurrent: () => true });
    expect(result instanceof Promise).toBe(false);
    expect(result).toEqual({ committed: true, tempUnlinked: true });
    expect(fs.calls).not.toContain('renameSync');
    expect(fs.text(target)).toBe('new');
  });
});
