/**
 * M3 T4 B1：普通 Save 的 main 管线（`savePipeline.ts` + `atomicWrite.ts`，内存 fs）。
 *
 * 覆盖：顺序与前置拒绝（D1）、只读、外部修改（提前与 C2 最终核验，含 r1.1 H-6 反例）、代次失效（C1 / C2 / 提交后）、
 * rename 失败与清理失败（D3 / D4）、提交后清理 / 目录 fsync 失败的三态（Gate B1 增补合同 C）、Windows 规则。
 */

import { describe, expect, it } from 'vitest';

import { runSavePipeline } from '../../../src/main/document/savePipeline';
import { sha256Hex } from '../../../src/main/document/fingerprint';
import { bytesOf, expectNoWrites, expectUntouched, factsOf, harness, P, setup, snapshot } from './saveTestKit';

const DOC = P('docs', 'song.jcx');
const OLD = 'X:1\r\nK:C\r\nC D\r';
const NEW = 'X:1\r\nK:C\r\nC E\r';

function opened(mode = 0o640): ReturnType<typeof setup> {
  const fs = setup();
  fs.writeFile(DOC, OLD, mode);
  return fs;
}

describe('普通 Save —— 成功路径', () => {
  it('逐字节写入、权限位保持、换 inode；返回写入字节的指纹与临时文件身份；不留临时文件', async () => {
    const fs = opened(0o640);
    const before = fs.inodeOf(DOC);
    const h = harness(fs);
    const result = await runSavePipeline(h.deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result.outcome).toBe('saved');
    if (result.outcome === 'not-committed') return;
    expect(fs.text(DOC)).toBe(NEW);
    expect(fs.modeOf(DOC)).toBe(0o640);
    expect(fs.inodeOf(DOC)).not.toBe(before);
    expect(result.written).toEqual({
      realpath: DOC,
      identity: { dev: 1n, ino: fs.inodeOf(DOC) },
      lastKnownDiskFingerprint: sha256Hex(bytesOf(NEW)),
      writeEncoding: 'utf-8',
      byteBom: 'none',
      encodingRoundTrip: 'exact',
    });
    expect(result.sameAsAnchor).toBe(true);
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
    expect(fs.calls).not.toContain('linkSync');
  });

  it('V6：GB18030 文档删到只剩 ASCII 后保存——允许，且写入事实的 writeEncoding 仍是 gb18030（不切换）', async () => {
    const fs = opened();
    const result = await runSavePipeline(harness(fs).deps, {
      kind: 'save',
      current: factsOf(fs, DOC, OLD, { writeEncoding: 'gb18030' }),
      source: 'X:1\nK:C\n',
      encoding: 'gb18030',
    });
    expect(result).toMatchObject({ outcome: 'saved', written: { writeEncoding: 'gb18030' } });
    expect(fs.text(DOC)).toBe('X:1\nK:C\n');
  });

  // 注意：本用例只证明调用顺序（fake 的调用日志看不到 await）；「临界区内无 await」由 architecture.m3t4 W5 证明。
  it('C2 调用顺序：最终读盘（statSync → openReadSync → fstat → read → fstat → statSync）之后紧接 renameSync，中间只有 *Sync 调用', async () => {
    const fs = opened();
    await runSavePipeline(harness(fs).deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    const from = fs.calls.indexOf('openReadSync');
    const to = fs.calls.indexOf('renameSync');
    expect(from).toBeGreaterThan(fs.calls.indexOf('handle.close'));
    expect(fs.calls.slice(from, to + 1).every((call) => call.endsWith('Sync'))).toBe(true);
    expect(fs.calls.slice(from, to)).toEqual(expect.arrayContaining(['fstatSync', 'readSync', 'statSync', 'closeSync']));
  });
});

describe('普通 Save —— 前置拒绝（D1：写 port 零写调用）', () => {
  it.each([
    ['编码与能力不符', { encoding: 'gb18030' as const }, 'encoding-mismatch'],
    ['孤立 surrogate', { source: 'X:1\n\uD800\n' }, 'unencodable-character'],
    ['编码后超过 1 MiB', { source: 'A'.repeat(1_048_577) }, 'file-too-large'],
  ])('%s → %s', async (_name, override, code) => {
    const fs = opened();
    const before = snapshot(fs, DOC);
    const result = await runSavePipeline(harness(fs).deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8', ...override });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code } });
    expectNoWrites(fs);
    expectUntouched(fs, DOC, before);
  });

  it('unsafe 文档 → unsafe-overwrite-refused（main 强制，不依赖 renderer）', async () => {
    const fs = opened();
    const result = await runSavePipeline(harness(fs).deps, {
      kind: 'save',
      current: factsOf(fs, DOC, OLD, { encodingRoundTrip: 'unsafe' }),
      source: NEW,
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'unsafe-overwrite-refused' } });
    expectNoWrites(fs);
  });

  it('当前文件已不存在 → not-found；身份无法确认（符号链接环）→ identity-unknown', async () => {
    const gone = opened();
    const facts = factsOf(gone, DOC, OLD);
    gone.remove(DOC);
    expect(await runSavePipeline(harness(gone).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'not-found' },
    });
    const loop = setup();
    loop.symlink(DOC, DOC);
    const loopFacts = { ...factsOf(opened(), DOC, OLD), identity: null };
    expect(await runSavePipeline(harness(loop).deps, { kind: 'save', current: loopFacts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'identity-unknown' },
    });
    expectNoWrites(loop);
  });

  it('只读目标（mode 无写位）→ permission-denied，且 rename 从未被调用', async () => {
    const fs = opened(0o444);
    const before = snapshot(fs, DOC);
    const result = await runSavePipeline(harness(fs).deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ error: { code: 'permission-denied' } });
    expect(fs.calls).not.toContain('renameSync');
    expectUntouched(fs, DOC, before);
  });

  it('打开后被外部修改（提前指纹）→ file-modified-on-disk，未创建临时文件', async () => {
    const fs = opened();
    const facts = factsOf(fs, DOC, OLD);
    fs.modifyInPlace(DOC, 'X:1\r\nK:C\r\nC F\r');
    const result = await runSavePipeline(harness(fs).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ error: { code: 'file-modified-on-disk' } });
    expectNoWrites(fs);
  });
});

describe('普通 Save —— 提交前同步最终核验（r1.1 H-6，D2）', () => {
  it('反例：临时文件写入期间被原地改写，inode / 大小 / mtime 都不变 → C2 读盘发现，未发布，外部修改保留，临时文件已删', async () => {
    const fs = opened();
    const facts = factsOf(fs, DOC, OLD);
    const external = 'X:1\r\nK:C\r\nC G\r';
    fs.before('handle.writeAll', () => fs.modifyInPlace(DOC, external, true));
    const ino = fs.inodeOf(DOC);
    const result = await runSavePipeline(harness(fs).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'file-modified-on-disk' } });
    expect(fs.text(DOC)).toBe(external);
    expect(fs.inodeOf(DOC)).toBe(ino);
    expect(fs.calls).not.toContain('renameSync');
    expect(fs.list(P('docs'))).toEqual(['song.jcx']);
  });

  it('临时文件写入期间被外部编辑器原子替换为相同内容 → 内容一致即允许提交；替换为不同内容 → 拒绝', async () => {
    const same = opened();
    same.before('handle.sync', () => same.replaceAtomically(DOC, OLD));
    expect((await runSavePipeline(harness(same).deps, { kind: 'save', current: factsOf(same, DOC, OLD), source: NEW, encoding: 'utf-8' })).outcome).toBe(
      'saved',
    );
    const changed = opened();
    const facts = factsOf(changed, DOC, OLD);
    changed.before('handle.sync', () => changed.replaceAtomically(DOC, 'other'));
    expect(await runSavePipeline(harness(changed).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(changed.text(DOC)).toBe('other');
  });

  it('临时文件写入期间目标变为只读 → C2 拒绝 permission-denied', async () => {
    const fs = opened();
    const facts = factsOf(fs, DOC, OLD);
    fs.before('handle.writeAll', () => fs.chmod(DOC, 0o444));
    expect(await runSavePipeline(harness(fs).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'permission-denied' },
    });
    expect(fs.calls).not.toContain('renameSync');
  });
});

describe('普通 Save —— 代次失效与失败清理', () => {
  it('C1：写临时文件期间代次失效 → capability-invalid，目标不变，临时文件已删', async () => {
    const fs = opened();
    const before = snapshot(fs, DOC);
    const h = harness(fs);
    fs.before('handle.writeAll', () => h.revoke());
    expect(await runSavePipeline(h.deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' })).toMatchObject({
      outcome: 'not-committed',
      error: { code: 'capability-invalid' },
    });
    expectUntouched(fs, DOC, before);
  });

  it('D3：rename 失败（darwin EACCES → permission-denied；win32 EBUSY → target-busy），临时文件已删', async () => {
    for (const [platform, code, expected] of [
      ['darwin', 'EACCES', 'permission-denied'],
      ['win32', 'EBUSY', 'target-busy'],
    ] as const) {
      const fs = setup(platform);
      fs.writeFile(DOC, OLD);
      const facts = { ...factsOf(fs, DOC, OLD), identity: null };
      const before = snapshot(fs, DOC);
      fs.fail('renameSync', code);
      const result = await runSavePipeline(harness(fs, platform).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' });
      expect(result, platform).toMatchObject({ outcome: 'not-committed', error: { code: expected } });
      expectUntouched(fs, DOC, before);
    }
  });

  it('D4 / PC-5：rename 失败且临时文件删除也失败 → 仍 not-committed，记录清理失败，目标不变', async () => {
    const fs = opened();
    const text = fs.text(DOC);
    const h = harness(fs);
    fs.fail('renameSync', 'EIO');
    fs.fail('removeFile', 'EIO');
    const result = await runSavePipeline(h.deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'not-committed', error: { code: 'write-failed' } });
    expect(h.events).toEqual(['temp-cleanup-failed']);
    expect(fs.text(DOC)).toBe(text);
  });
});

describe('普通 Save —— 回调与意外异常（独立审查 M1）', () => {
  it('stillCurrent() 在写临时文件期间抛出（窗口已销毁）→ 视为代次失效：not-committed，临时文件已删，目标不变', async () => {
    const fs = opened();
    const before = snapshot(fs, DOC);
    const h = harness(fs);
    let boom = false;
    const deps = { ...h.deps, stillCurrent: () => { if (boom) throw new Error('Object has been destroyed'); return true; } };
    fs.before('handle.writeAll', () => { boom = true; });
    expect(await runSavePipeline(deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' })).toMatchObject({
      outcome: 'not-committed',
      error: { code: 'capability-invalid' },
    });
    expectUntouched(fs, DOC, before);
  });

  it('提交之后 stillCurrent() 抛出 → committed-unconfirmed（不 reject、不报未提交）；log() 抛出不影响结论', async () => {
    const fs = opened();
    const h = harness(fs);
    let boom = false;
    const deps = {
      ...h.deps,
      stillCurrent: () => { if (boom) throw new Error('destroyed'); return true; },
      log: () => { throw new Error('logger down'); },
    };
    fs.fail('syncDirectory', 'EIO');
    fs.before('syncDirectory', () => { boom = true; });
    const result = await runSavePipeline(deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result.outcome).toBe('committed-unconfirmed');
    expect(fs.text(DOC)).toBe(NEW);
  });

  it('提交前的意外异常（临时文件命名抛出）→ not-committed: write-failed，目标不变', async () => {
    const fs = opened();
    const before = snapshot(fs, DOC);
    const deps = { ...harness(fs).deps, tempName: (): string => { throw new Error('bad name'); } };
    expect(await runSavePipeline(deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' })).toMatchObject({
      outcome: 'not-committed',
      error: { code: 'write-failed' },
    });
    expectUntouched(fs, DOC, before);
  });
});

describe('普通 Save —— C2 的路径复核（独立审查 L1）', () => {
  it('写临时文件期间目标被换成目录 → C2 先 stat 发现非普通文件，不打开（避免同步打开 FIFO 等阻塞）', async () => {
    const fs = opened();
    const facts = factsOf(fs, DOC, OLD);
    fs.before('handle.writeAll', () => {
      fs.remove(DOC);
      fs.mkdir(DOC);
    });
    expect(await runSavePipeline(harness(fs).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.calls).not.toContain('openReadSync');
  });

  it('写临时文件期间路径被换成指向同一 inode 的符号链接 → realpath 不再等于自身，拒绝（不替换链接本身）', async () => {
    const fs = opened();
    const facts = factsOf(fs, DOC, OLD);
    const real = P('docs', 'real.jcx');
    fs.before('handle.writeAll', () => {
      fs.hardlink(DOC, real);
      fs.remove(DOC);
      fs.symlink(DOC, real);
    });
    expect(await runSavePipeline(harness(fs).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.text(real)).toBe(OLD);
  });

  it.each(['darwin', 'win32'])('%s：C2 读盘期间路径被原子替换为相同内容的新文件 → 句柄与路径不符，拒绝', async (platform) => {
    const fs = setup(platform);
    fs.writeFile(DOC, OLD);
    const facts = { ...factsOf(fs, DOC, OLD), identity: null };
    fs.before('readSync', () => fs.replaceAtomically(DOC, OLD));
    expect(await runSavePipeline(harness(fs, platform).deps, { kind: 'save', current: facts, source: NEW, encoding: 'utf-8' })).toMatchObject({
      error: { code: 'file-modified-on-disk' },
    });
    expect(fs.text(DOC)).toBe(OLD);
  });
});

describe('普通 Save —— 提交之后（Gate B1 增补合同 C）', () => {
  it('PC-2：目录 fsync 失败 → 仍 saved，记录事件', async () => {
    const fs = opened();
    const h = harness(fs);
    fs.fail('syncDirectory', 'EINVAL');
    const result = await runSavePipeline(h.deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result.outcome).toBe('saved');
    expect(h.events).toEqual(['directory-sync-failed']);
    expect(fs.text(DOC)).toBe(NEW);
  });

  it('PC-4：提交后代次失效 → committed-unconfirmed（如实报告已写入），仍给出写入指纹', async () => {
    const fs = opened();
    const h = harness(fs);
    fs.before('syncDirectory', () => h.revoke());
    const result = await runSavePipeline(h.deps, { kind: 'save', current: factsOf(fs, DOC, OLD), source: NEW, encoding: 'utf-8' });
    expect(result).toMatchObject({ outcome: 'committed-unconfirmed', written: { lastKnownDiskFingerprint: sha256Hex(bytesOf(NEW)) } });
    expect(fs.text(DOC)).toBe(NEW);
  });

  it('Windows 规则：不用 ino（写入身份为 null）；C2 以 size / mtime / realpath 复核', async () => {
    const fs = setup('win32');
    fs.writeFile(DOC, OLD);
    const result = await runSavePipeline(harness(fs, 'win32').deps, {
      kind: 'save',
      current: { ...factsOf(fs, DOC, OLD), identity: null },
      source: NEW,
      encoding: 'utf-8',
    });
    expect(result).toMatchObject({ outcome: 'saved', written: { identity: null } });
    expect(fs.text(DOC)).toBe(NEW);
  });
});
