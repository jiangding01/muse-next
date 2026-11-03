/**
 * M3 T4 B1：保存期间的外部漂移（GPT B1 复核 H-9 / M-5，内存 fs）。
 *
 * - H-9：Save As 授予（阶段 1）时的目标身份必须贯穿到阶段 2 与 C2。
 * - M-5：C2 读取的字节数必须与读取前、读取后的文件长度一致（r1.1 §2.3）。
 */

import { describe, expect, it } from 'vitest';

import { runSavePipeline } from '../../../src/main/document/savePipeline';
import type { SaveRequest, SaveTargetGrant } from '../../../src/main/document/savePipeline';
import { factsOf, grantExisting, harness, P, setup, snapshot } from './saveTestKit';

const DOC = P('docs', 'song.jcx');
const OTHER = P('docs', 'other.jcx');
const OLD = 'X:1\nK:C\nC D\n';
const NEW = 'X:1\nK:C\nC E\n';

describe('M-5：C2 读取长度与前后 fstat 一致', () => {
  function opened(): ReturnType<typeof setup> {
    const fs = setup();
    fs.writeFile(DOC, OLD);
    return fs;
  }
  const save = (fs: ReturnType<typeof setup>): Promise<Awaited<ReturnType<typeof runSavePipeline>>> =>
    runSavePipeline(harness(fs).deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });

  it('读完之后、读后 fstat 之前被外部追加（已读字节的指纹仍相等）→ file-modified-on-disk，追加内容保留，临时文件已删', async () => {
    const fs = opened();
    // C2 中第一次 fstatSync 在读取前、第二次在读取后：在第二次之前追加。
    let fstats = 0;
    fs.before('fstatSync', () => {
      fstats += 1;
      if (fstats === 2) fs.modifyInPlace(DOC, `${OLD}APPENDED`, true);
    }, 2);
    expect(await save(fs)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(DOC)).toBe(`${OLD}APPENDED`);
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
  });

  it('读完之后被外部截断 → file-modified-on-disk，截断结果保留', async () => {
    const fs = opened();
    let fstats = 0;
    fs.before('fstatSync', () => {
      fstats += 1;
      if (fstats === 2) fs.modifyInPlace(DOC, 'X:1\n', true);
    }, 2);
    expect(await save(fs)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(DOC)).toBe('X:1\n');
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
  });

  it('读取前被改成别的长度、读取时又被还原为原内容（指纹相等）→ 读取前长度与读取字节数不符，拒绝', async () => {
    const fs = opened();
    fs.before('openReadSync', () => fs.modifyInPlace(DOC, 'X:1\nchanged meanwhile\n', true));
    fs.before('readSync', () => fs.modifyInPlace(DOC, OLD, true));
    expect(await save(fs)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(DOC)).toBe(OLD);
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
  });

  it('读取过程中被追加（读到的字节多于读取前的长度）→ file-modified-on-disk', async () => {
    const fs = opened();
    fs.before('readSync', () => fs.modifyInPlace(DOC, `${OLD}MORE`, true));
    expect(await save(fs)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(DOC)).toBe(`${OLD}MORE`);
  });
});

describe('H-9：Save As 授予时的目标身份贯穿两阶段', () => {
  function withOther(platform = 'darwin'): ReturnType<typeof setup> {
    const fs = setup(platform);
    fs.writeFile(DOC, OLD);
    fs.writeFile(OTHER, 'other content');
    return fs;
  }
  const grantOf = (fs: ReturnType<typeof setup>, platform = 'darwin'): SaveTargetGrant => grantExisting(fs, OTHER, platform);
  const saveAs = (fs: ReturnType<typeof setup>, granted: SaveTargetGrant, platform = 'darwin'): Promise<Awaited<ReturnType<typeof runSavePipeline>>> => {
    const request: SaveRequest = { kind: 'saveAs', requestedPath: OTHER, granted, anchor: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' };
    return runSavePipeline(harness(fs, platform).deps, request);
  };

  it('授予之后、阶段 2 之前目标被原子替换为另一个文件（POSIX：新 inode）→ file-modified-on-disk，新对象不被覆盖，零写调用', async () => {
    const fs = withOther();
    const granted = grantOf(fs);
    fs.replaceAtomically(OTHER, 'someone else');
    const before = snapshot(fs, OTHER);
    expect(await saveAs(fs, granted)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(snapshot(fs, OTHER)).toEqual(before);
    expect(fs.calls).not.toContain('openExclusive');
  });

  it('POSIX：授予后被替换为同长度、同修改时间的另一个文件 → 仅凭 dev / ino 识别并拒绝', async () => {
    const fs = withOther();
    const granted = grantOf(fs);
    fs.replaceAtomically(OTHER, 'OTHER CONTENT', true);
    expect(await saveAs(fs, granted)).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(OTHER)).toBe('OTHER CONTENT');
  });

  it('授予身份未变 → 正常提交', async () => {
    const fs = withOther();
    expect((await saveAs(fs, grantOf(fs))).outcome).toBe('saved');
    expect(fs.text(OTHER)).toBe(NEW);
  });

  it('Windows（无可信 inode）：授予后被换成长度不同的文件 → 按 size / mtime / realpath 的限制性规则拒绝', async () => {
    const fs = withOther('win32');
    const granted = grantOf(fs, 'win32');
    fs.replaceAtomically(OTHER, 'someone else, longer');
    expect(await saveAs(fs, granted, 'win32')).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(OTHER)).toBe('someone else, longer');
  });

  it('C2：阶段 2 解析之后、发布之前目标再被替换 → 身份复核拒绝（POSIX 与 Windows）', async () => {
    for (const platform of ['darwin', 'win32']) {
      const fs = withOther(platform);
      const granted = grantOf(fs, platform);
      fs.before('handle.writeAll', () => fs.replaceAtomically(OTHER, 'replaced during write!'));
      expect(await saveAs(fs, granted, platform), platform).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
      expect(fs.text(OTHER), platform).toBe('replaced during write!');
    }
  });
});
