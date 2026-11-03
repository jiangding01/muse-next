/**
 * M3 T4 B1：GPT B1 复核 H-8 的复现（当前文件实时身份漂移，内存 fs）。
 *
 * 原文件 X 被移走、原路径改成指向「同内容的另一个文件 Y」的符号链接；X 另有硬链接 Z。
 * 用户裁决 R-H8a / R-H8b（Gate B1）：写盘前实时文件必须与打开时的锚点按 §13.2 OR 规则为同一文件；Save As 的同文件
 * 识别同时比较实时当前文件与记录的锚点。
 */

import { describe, expect, it } from 'vitest';

import { runSavePipeline } from '../../../src/main/document/savePipeline';
import { factsOf, grantExisting, harness, P, setup } from './saveTestKit';

const DOC = P('docs', 'song.jcx');
const OLD = 'X:1\nK:C\nC D\n';
const NEW = 'X:1\nK:C\nC E\n';

/** 原文件 X（=DOC）另有硬链接 Z；Y 与 X 同内容、不同 inode；随后 X 被移走、原路径改成指向 Y 的符号链接。 */
function drifted(): { fs: ReturnType<typeof setup>; anchorUnsafe: ReturnType<typeof factsOf>; anchorExact: ReturnType<typeof factsOf>; Z: string; Y: string } {
  const fs = setup();
  const Z = P('docs', 'z-hardlink.jcx');
  const Y = P('docs', 'y-copy.jcx');
  fs.writeFile(DOC, OLD);
  fs.hardlink(DOC, Z);
  const anchorExact = factsOf(fs, DOC, OLD);
  const anchorUnsafe = factsOf(fs, DOC, OLD, { encodingRoundTrip: 'unsafe' });
  fs.writeFile(Y, OLD);
  fs.remove(DOC);
  fs.symlink(DOC, Y);
  return { fs, anchorUnsafe, anchorExact, Z, Y };
}

describe('H-8：当前文件实时身份漂移（R-H8a / R-H8b）', () => {
  it('普通 Save 不得仅凭 SHA-256 相等覆盖另一个文件 Y', async () => {
    const { fs, anchorExact, Y } = drifted();
    const result = await runSavePipeline(harness(fs).deps, { kind: 'save', current: anchorExact, source: NEW, encoding: 'utf-8' });
    expect(result.outcome).toBe('not-committed');
    expect(fs.text(Y)).toBe(OLD);
  });

  it('Save As 选择原文件的硬链接 Z（原 inode）不得绕过 unsafe 同文件保护', async () => {
    const { fs, anchorUnsafe, Z } = drifted();
    const granted = grantExisting(fs, Z);
    const result = await runSavePipeline(harness(fs).deps, { kind: 'saveAs', requestedPath: Z, granted, anchor: anchorUnsafe, source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'unsafe-overwrite-refused' } });
    expect(fs.text(Z)).toBe(OLD);
  });

  it('Save As 选择原路径（现已指向 Y）：与实时当前文件 same → 执行同文件规则 → 不是锚点文件，拒绝，Y 不变', async () => {
    const { fs, anchorExact, Y } = drifted();
    const granted = grantExisting(fs, Y);
    const result = await runSavePipeline(harness(fs).deps, { kind: 'saveAs', requestedPath: DOC, granted, anchor: anchorExact, source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(Y)).toBe(OLD);
  });

  it('Save As 选择原 inode 的硬链接 Z（锚点 exact）：判 same，按锚点指纹比较后写入 Z', async () => {
    const { fs, anchorExact, Z } = drifted();
    const result = await runSavePipeline(harness(fs).deps, { kind: 'saveAs', requestedPath: Z, granted: grantExisting(fs, Z), anchor: anchorExact, source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: true });
    expect(fs.text(Z)).toBe(NEW);
  });
});

describe('R-H8a：same / different / unknown', () => {
  function opened(platform = 'darwin'): ReturnType<typeof setup> {
    const fs = setup(platform);
    fs.writeFile(DOC, OLD);
    return fs;
  }
  const save = (fs: ReturnType<typeof setup>, current: ReturnType<typeof factsOf>, platform = 'darwin') =>
    runSavePipeline(harness(fs, platform).deps, { kind: 'save', current, source: NEW, encoding: 'utf-8' });

  it('合法反例：原路径被换成指向「同一 inode 的硬链接别名」的符号链接 → 身份相同（same），允许保存', async () => {
    const fs = opened();
    const alias = P('docs', 'alias-hardlink.jcx');
    fs.hardlink(DOC, alias);
    const anchor = factsOf(fs, DOC, OLD);
    fs.remove(DOC);
    fs.symlink(DOC, alias);
    expect((await save(fs, anchor)).outcome).toBe('saved');
    expect(fs.text(alias)).toBe(NEW);
  });

  it('同路径的外部原子保存（新 inode）→ 路径相同即 same，进入指纹比较：内容相同允许，内容不同拒绝', async () => {
    const same = opened();
    const anchorSame = factsOf(same, DOC, OLD);
    same.replaceAtomically(DOC, OLD);
    expect((await save(same, anchorSame)).outcome).toBe('saved');
    const changed = opened();
    const anchorChanged = factsOf(changed, DOC, OLD);
    changed.replaceAtomically(DOC, 'changed by another editor');
    expect(await save(changed, anchorChanged)).toMatchObject({ error: { code: 'file-modified-on-disk' } });
    expect(changed.text(DOC)).toBe('changed by another editor');
  });

  it('different：原路径改指向同内容的另一个文件 → file-modified-on-disk（指纹相同也不写）', async () => {
    const { fs, anchorExact, Y } = drifted();
    expect(await save(fs, anchorExact)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(Y)).toBe(OLD);
  });

  it('unknown：原路径成为符号链接环 → identity-unknown，零写调用', async () => {
    const fs = opened();
    const anchor = factsOf(fs, DOC, OLD);
    fs.remove(DOC);
    fs.symlink(DOC, DOC);
    expect(await save(fs, anchor)).toMatchObject({ error: { code: 'identity-unknown' } });
    expect(fs.calls).not.toContain('openExclusive');
  });

  it('Windows（不用 ino，只比可信路径）：原路径改为指向另一文件的符号链接 → 路径不等即拒绝；原路径不变则正常保存', async () => {
    const drift = opened('win32');
    const anchor = { ...factsOf(drift, DOC, OLD), identity: null };
    const Y = P('docs', 'y-copy.jcx');
    drift.writeFile(Y, OLD);
    drift.remove(DOC);
    drift.symlink(DOC, Y);
    expect(await save(drift, anchor, 'win32')).toMatchObject({ error: { code: 'file-modified-on-disk' } });
    expect(drift.text(Y)).toBe(OLD);
    const stable = opened('win32');
    expect((await save(stable, { ...factsOf(stable, DOC, OLD), identity: null }, 'win32')).outcome).toBe('saved');
  });
});

describe('R19 已接受限制（Windows 不用 ino）', () => {
  it('Windows：unsafe 原文件的硬链接别名被判为其它文件；rename 只替换别名的目录项，原文件字节不变', async () => {
    const fs = setup('win32');
    const alias = P('docs', 'alias.jcx');
    fs.writeFile(DOC, OLD);
    fs.hardlink(DOC, alias);
    const anchor = { ...factsOf(fs, DOC, OLD, { encodingRoundTrip: 'unsafe' }), identity: null };
    const result = await runSavePipeline(harness(fs, 'win32').deps, {
      kind: 'saveAs',
      requestedPath: alias,
      granted: grantExisting(fs, alias, 'win32'),
      anchor,
      source: NEW,
      encoding: 'utf-8',
    });
    // 这是方案 §26 R19 已接受的限制：同文件识别在 Windows 上只靠路径。若将来引入可信的文件 ID，应把本例改为拒绝。
    expect(result).toMatchObject({ outcome: 'saved', sameAsAnchor: false });
    expect(fs.text(DOC)).toBe(OLD);
  });
});
