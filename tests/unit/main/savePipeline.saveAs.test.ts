/**
 * M3 T4 B1：Save As 的 main 管线（内存 fs）。授权与锚点由 B2 提供，这里直接给出已授权事实。
 *
 * 覆盖：初始不存在目标的 `link` 不覆盖发布（r1 ERRATA §3：抢先创建、悬空符号链接、不支持、提交后清理失败）、
 * 授予后目标状态变化、已存在的其它文件（不比指纹、身份复核）、同一文件识别（符号链接、硬链接、unsafe、改编码）、
 * 原文件不存在的判定表（r1 ERRATA §4.2，R4 默认拒绝）、未命名文档、byteBom 取自写入字节。
 */

import { describe, expect, it } from 'vitest';

import { runSavePipeline } from '../../../src/main/document/savePipeline';
import type { SaveFileFacts, SaveRequest, SaveTargetGrant } from '../../../src/main/document/savePipeline';
import { expectNoWrites, expectUntouched, factsOf, grantExisting, harness, P, setup, snapshot } from './saveTestKit';

const DOC = P('docs', 'song.jcx');
const OTHER = P('docs', 'other.jcx');
const NEW_FILE = P('docs', 'new.jcx');
const OLD = 'X:1\nK:C\nC D\n';
const NEW = 'X:1\nK:C\nC E\n';
const ABSENT: SaveTargetGrant = { kind: 'absent', parentRealpath: P('docs'), basename: 'new.jcx' };

function saveAs(requestedPath: string, granted: SaveTargetGrant, anchor: SaveFileFacts | null, overrides: Partial<Extract<SaveRequest, { kind: 'saveAs' }>> = {}): SaveRequest {
  return { kind: 'saveAs', requestedPath, granted, anchor, source: NEW, encoding: 'utf-8', ...overrides };
}

function withDoc(): ReturnType<typeof setup> {
  const fs = setup();
  fs.writeFile(DOC, OLD, 0o640);
  return fs;
}

describe('初始不存在的目标：link 不覆盖发布', () => {
  it('新文件：用 link 提交、从不 rename；权限交给 umask（0644）；不留临时文件', async () => {
    const fs = withDoc();
    const result = await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)));
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: false, written: { realpath: NEW_FILE } });
    expect(fs.text(NEW_FILE)).toBe(NEW);
    expect(fs.modeOf(NEW_FILE)).toBe(0o644);
    expect(fs.calls).toContain('linkSync');
    expect(fs.calls).not.toContain('renameSync');
    // 不存在目标管线不读取任何既有内容（r1.1 M1）。
    expect(fs.calls).not.toContain('openForRead');
    expect(fs.calls).not.toContain('openReadSync');
    expect(fs.readCalls.filter((call) => call.endsWith(NEW_FILE))).toEqual([]);
    expect(fs.list(P('docs'))).toEqual(['new.jcx', 'song.jcx']);
    expect(fs.text(DOC)).toBe(OLD);
  });

  it('未命名文档（锚点为 null）同样可以另存为新文件', async () => {
    const fs = setup();
    expect((await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, null, { encoding: 'gb18030' }))).outcome).toBe('saved');
  });

  it('授予后、发布前被其它进程抢先创建 → link 得 EEXIST → file-modified-on-disk；他人文件不变；临时文件已删', async () => {
    const fs = withDoc();
    fs.before('linkSync', () => fs.writeFile(NEW_FILE, 'someone else'));
    const result = await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)));
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(NEW_FILE)).toBe('someone else');
    expect(fs.calls).not.toContain('renameSync');
    expect(fs.list(P('docs'))).toEqual(['new.jcx', 'song.jcx']);
  });

  it('授予后、规划前目标已出现 → file-modified-on-disk，写 port 零写调用', async () => {
    const fs = withDoc();
    fs.writeFile(NEW_FILE, 'appeared');
    expect(await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expectNoWrites(fs);
  });

  it('目标名是悬空符号链接 → 视为占用，拒绝；链接本身不被替换', async () => {
    const fs = withDoc();
    fs.symlink(NEW_FILE, P('docs', 'nowhere.jcx'));
    expect(await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.exists(P('docs', 'nowhere.jcx'))).toBe(false);
    expectNoWrites(fs);
  });

  it('文件系统不支持硬链接（ENOTSUP）→ atomic-create-unsupported；绝不回退 rename；目标不出现', async () => {
    const fs = withDoc();
    fs.fail('linkSync', 'ENOTSUP');
    const result = await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)));
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'atomic-create-unsupported' } });
    expect(fs.calls).not.toContain('renameSync');
    expect(fs.exists(NEW_FILE)).toBe(false);
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
  });

  it('PC-1：link 成功、删除临时文件名失败 → 仍为已提交（saved），记录清理失败，目标内容正确', async () => {
    const fs = withDoc();
    const h = harness(fs);
    fs.fail('unlinkSync', 'EIO');
    const result = await runSavePipeline(h.deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)));
    expect(result.outcome).toBe('saved');
    expect(h.events).toContain('temp-cleanup-failed');
    expect(fs.text(NEW_FILE)).toBe(NEW);
  });

  it('父目录不可写 → 创建临时文件失败 permission-denied，目录不变', async () => {
    const fs = withDoc();
    fs.chmod(P('docs'), 0o555);
    const before = snapshot(fs, DOC);
    expect(await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'permission-denied' },
    });
    expectUntouched(fs, DOC, before);
  });
});

describe('父目录不存在（R15：not-found）', () => {
  it('授予后父目录被删除 → not-found，零写调用', async () => {
    const fs = setup();
    fs.mkdir(P('gone'));
    const grant: SaveTargetGrant = { kind: 'absent', parentRealpath: P('gone'), basename: 'x.jcx' };
    fs.remove(P('gone'));
    expect(await runSavePipeline(harness(fs).deps, saveAs(P('gone', 'x.jcx'), grant, null))).toMatchObject({ error: { code: 'not-found' } });
    expectNoWrites(fs);
  });
});

describe('已存在的其它文件', () => {
  it('不比较指纹（不读取目标内容），rename 提交；覆盖后取原文件权限位', async () => {
    const fs = withDoc();
    fs.writeFile(OTHER, 'other content', 0o600);
    const result = await runSavePipeline(harness(fs).deps, saveAs(OTHER, grantExisting(fs, OTHER), factsOf(fs, DOC, OLD)));
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: false });
    expect(fs.text(OTHER)).toBe(NEW);
    expect(fs.modeOf(OTHER)).toBe(0o600);
    expect(fs.calls).not.toContain('openForRead');
    expect(fs.calls).not.toContain('readSync');
  });

  it('临时文件写入期间该文件被替换为另一个文件 → C2 身份复核拒绝，替换者不变', async () => {
    const fs = withDoc();
    fs.writeFile(OTHER, 'other content');
    fs.before('handle.writeAll', () => fs.replaceAtomically(OTHER, 'replaced'));
    expect(await runSavePipeline(harness(fs).deps, saveAs(OTHER, grantExisting(fs, OTHER), factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.text(OTHER)).toBe('replaced');
  });

  it('授予时存在、写前已消失 → file-modified-on-disk', async () => {
    const fs = withDoc();
    fs.writeFile(OTHER, 'other content');
    const granted = grantExisting(fs, OTHER);
    fs.remove(OTHER);
    expect(await runSavePipeline(harness(fs).deps, saveAs(OTHER, granted, factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expectNoWrites(fs);
  });

  it('只读的其它文件 → permission-denied，rename 未调用', async () => {
    const fs = withDoc();
    fs.writeFile(OTHER, 'x', 0o444);
    expect(await runSavePipeline(harness(fs).deps, saveAs(OTHER, grantExisting(fs, OTHER), factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'permission-denied' },
    });
    expect(fs.calls).not.toContain('renameSync');
  });
});

describe('同一文件识别：按普通 Save 规则', () => {
  it('经符号链接选当前文件：same → 写入真实文件，符号链接保留', async () => {
    const fs = withDoc();
    const link = P('docs', 'alias.jcx');
    fs.symlink(link, DOC);
    const result = await runSavePipeline(harness(fs).deps, saveAs(link, grantExisting(fs, DOC), factsOf(fs, DOC, OLD)));
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: true, written: { realpath: DOC } });
    expect(fs.text(DOC)).toBe(NEW);
    expect(fs.list(P('docs'))).toEqual(['alias.jcx', 'song.jcx']);
  });

  it('硬链接指向当前文件：same（dev / ino 相同）→ 适用指纹比较：磁盘已改 → 拒绝', async () => {
    const fs = withDoc();
    const hard = P('docs', 'hard.jcx');
    fs.hardlink(DOC, hard);
    const facts = factsOf(fs, DOC, OLD);
    fs.modifyInPlace(DOC, 'changed elsewhere');
    expect(await runSavePipeline(harness(fs).deps, saveAs(hard, grantExisting(fs, hard), facts))).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.text(hard)).toBe('changed elsewhere');
  });

  it('unsafe 原文件 → unsafe-overwrite-refused；exact 但改编码 → same-file-encoding-change-refused；均零写调用', async () => {
    const unsafe = withDoc();
    expect(
      await runSavePipeline(harness(unsafe).deps, saveAs(DOC, grantExisting(unsafe, DOC), factsOf(unsafe, DOC, OLD, { encodingRoundTrip: 'unsafe' }))),
    ).toMatchObject({ error: { code: 'unsafe-overwrite-refused' } });
    expectNoWrites(unsafe);
    const change = withDoc();
    expect(
      await runSavePipeline(harness(change).deps, saveAs(DOC, grantExisting(change, DOC), factsOf(change, DOC, OLD, { writeEncoding: 'gb18030' }))),
    ).toMatchObject({ error: { code: 'same-file-encoding-change-refused' } });
    expectNoWrites(change);
  });

  it('unsafe 文档另存到其它文件：只允许 UTF-8（§11.4）', async () => {
    const fs = withDoc();
    const anchor = factsOf(fs, DOC, OLD, { encodingRoundTrip: 'unsafe', writeEncoding: 'gb18030' });
    expect(await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, anchor, { encoding: 'gb18030' }))).toMatchObject({
      error: { code: 'encoding-mismatch' },
    });
    expect((await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, anchor))).outcome).toBe('saved');
  });
});

describe('原文件不存在（r1 ERRATA §4.2，R4 默认拒绝存回原路径）', () => {
  function vanished(): { fs: ReturnType<typeof setup>; anchor: SaveFileFacts } {
    const fs = withDoc();
    const anchor = factsOf(fs, DOC, OLD);
    fs.remove(DOC);
    return { fs, anchor };
  }

  it('另存到其它新路径 → 允许', async () => {
    const { fs, anchor } = vanished();
    expect((await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, anchor))).outcome).toBe('saved');
  });

  it('存回已不存在的原路径 → not-found，零写调用', async () => {
    const { fs, anchor } = vanished();
    const grant: SaveTargetGrant = { kind: 'absent', parentRealpath: P('docs'), basename: 'song.jcx' };
    expect(await runSavePipeline(harness(fs).deps, saveAs(DOC, grant, anchor))).toMatchObject({ error: { code: 'not-found' } });
    expectNoWrites(fs);
  });

  it('原文件被移到目标路径（同 inode）→ 判 same，按记录的指纹比较', async () => {
    const fs = withDoc();
    const anchor = factsOf(fs, DOC, OLD);
    fs.hardlink(DOC, OTHER);
    fs.remove(DOC);
    const result = await runSavePipeline(harness(fs).deps, saveAs(OTHER, grantExisting(fs, OTHER), anchor));
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: true });
  });

  it('目标解析 unknown（符号链接环）→ identity-unknown，永不当作 different', async () => {
    const fs = withDoc();
    const loop = P('docs', 'loop.jcx');
    fs.symlink(loop, loop);
    expect(await runSavePipeline(harness(fs).deps, saveAs(loop, { kind: 'existing', realpath: loop, identity: null, size: 0n, mtimeNs: 0n }, factsOf(fs, DOC, OLD)))).toMatchObject({
      error: { code: 'identity-unknown' },
    });
    expectNoWrites(fs);
  });
});

describe('写入事实', () => {
  it('byteBom 取自写入字节：开头 U+FEFF 以 UTF-8 写出即为 utf8', async () => {
    const fs = setup();
    const result = await runSavePipeline(harness(fs).deps, saveAs(NEW_FILE, ABSENT, null, { source: '﻿X:1\n' }));
    expect(result).toMatchObject({ outcome: 'saved', written: { byteBom: 'utf8', encodingRoundTrip: 'exact' } });
  });
});
