/**
 * Electron runtime 保存用例（M3 T4 B1，`docs/M3_EDITOR_CORE_PLAN.md` §11.5–§11.7、§12、§14、§25.2；Gate B1 C2）。
 *
 * - 编码与自解码校验只以 Electron 运行时结果为证据（GB18030 映射在 Electron 与系统 Node 之间不一致）：这里调用生产
 *   `encodeForSave`，向量取自 T4 Preflight r0 探针 C1–C10。
 * - 磁盘用例经生产 `runSavePipeline` + `createNodeWriteFileSystem` 在 `os.tmpdir()` 下的 mkdtemp 目录中读写，结束删除；
 *   不触碰任何真实文档。断言用独立的 `createHash` 与 `node:fs/promises` 读取结果，不复用被测代码。
 * - 平台不支持的场景显式 skip（只允许 `SKIPPABLE_CASE_IDS` 中列出的用例）。
 */

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeReadOnlyFileSystem } from '../../src/main/document/fileSystemPort';
import { errnoCodeOf } from '../../src/main/document/fsErrors';
import { createNodeWriteFileSystem } from '../../src/main/document/nodeWriteFileSystem';
import { encodeForSave } from '../../src/main/document/saveEncoding';
import { runSavePipeline } from '../../src/main/document/savePipeline';
import type { SaveFileFacts, SavePipelineDeps, SaveRequest, SaveTargetGrant } from '../../src/main/document/savePipeline';
import type { WriteFileSystem } from '../../src/main/document/writeFileSystemPort';
import type { JcxEncoding } from '../../src/formats/jcx/codec';
import { expectSame, hex, verdict } from './probeHarness';
import type { Outcome, ProbeRecorder } from './probeHarness';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const gb18030Text = (bytes: readonly number[]): string => new TextDecoder('gb18030').decode(Uint8Array.from(bytes));

function encodeCase(source: string, encoding: JcxEncoding, expectCode: string | null, check?: (bytes: Uint8Array, byteBom: string) => string[]): Outcome {
  const result = encodeForSave(source, encoding);
  const problems: string[] = [];
  if (expectCode !== null) {
    expectSame(problems, 'result', result.ok ? 'ok' : result.code, expectCode);
    return verdict(problems);
  }
  if (!result.ok) return verdict([`unexpected ${result.code}`]);
  problems.push(...(check?.(result.encoded.bytes, result.encoded.byteBom) ?? []));
  return verdict(problems, hex(result.encoded.bytes.slice(0, 4)));
}

async function runVerificationCases(recorder: ProbeRecorder): Promise<void> {
  await recorder.run('save.verify utf8-bom', () =>
    encodeCase('﻿X:1\r\nT:a\n', 'utf-8', null, (bytes, bom) => {
      const problems: string[] = [];
      expectSame(problems, 'head', hex(bytes.slice(0, 3)), 'EF BB BF');
      expectSame(problems, 'byteBom', bom, 'utf8');
      return problems;
    }),
  );
  await recorder.run('save.verify utf8 lone-surrogate', () => encodeCase('X:1\nA\uD800B\n', 'utf-8', 'unencodable-character'));
  await recorder.run('save.verify gb18030 lone-surrogate', () => encodeCase('X:1\nA\uDC00\n', 'gb18030', 'unencodable-character'));
  await recorder.run('save.verify gb18030-to-ascii', () => encodeCase('X:1\nT:abc\r\n', 'gb18030', null));
  await recorder.run('save.verify gb18030 valid-utf8-bytes U+4E00', () => encodeCase('一', 'gb18030', 'encoding-verification-failed'));
  await recorder.run('save.verify gb18030 EF-BB-BF-prefix', () => encodeCase(gb18030Text([0xef, 0xbb, 0xbf, 0xc0]), 'gb18030', 'encoding-verification-failed'));
  await recorder.run('save.verify leading-feff gb18030 / utf8', () => {
    const problems: string[] = [];
    const gb = encodeForSave('﻿X:1\n', 'gb18030');
    const u8 = encodeForSave('﻿X:1\n', 'utf-8');
    expectSame(problems, 'gb head', gb.ok ? hex(gb.encoded.bytes.slice(0, 4)) : gb.code, '84 31 95 33');
    expectSame(problems, 'gb byteBom', gb.ok ? gb.encoded.byteBom : gb.code, 'none');
    expectSame(problems, 'utf8 byteBom', u8.ok ? u8.encoded.byteBom : u8.code, 'utf8');
    return verdict(problems);
  });
  await recorder.run('save.verify mixed-eol', () => {
    const problems: string[] = [];
    const source = 'A\r\nB\nC\rD\r\n中';
    for (const encoding of ['utf-8', 'gb18030'] as const) {
      const result = encodeForSave(source, encoding);
      expectSame(problems, `${encoding} CR count`, result.ok ? result.encoded.bytes.filter((byte) => byte === 0x0d).length : result.code, 3);
    }
    return verdict(problems);
  });
  await recorder.run('save.verify mapping-vectors', () => {
    const problems: string[] = [];
    for (const bytes of [[0x80], [0xa6, 0xd9], [0xfe, 0x59], [0xfe, 0x61]]) {
      const result = encodeForSave(`X${gb18030Text(bytes)}\n`, 'gb18030');
      expectSame(problems, hex(Uint8Array.from(bytes)), result.ok ? 'ok' : result.code, 'ok');
    }
    return verdict(problems);
  });
}

interface DiskContext {
  readonly dir: string;
  next(name: string): string;
}

function deps(writeFs: WriteFileSystem = createNodeWriteFileSystem()): SavePipelineDeps {
  let counter = 0;
  return {
    readFs: createNodeReadOnlyFileSystem(),
    writeFs,
    platform: process.platform,
    tempName: () => `.muse-probe-${String((counter += 1))}.tmp`,
    stillCurrent: () => true,
    log: () => undefined,
  };
}

async function factsFor(path: string, bytes: Uint8Array, encoding: JcxEncoding): Promise<SaveFileFacts> {
  const s = await stat(path, { bigint: true });
  return {
    realpath: path,
    identity: process.platform === 'win32' ? null : { dev: s.dev, ino: s.ino },
    writeEncoding: encoding,
    encodingRoundTrip: 'exact',
    lastKnownDiskFingerprint: sha256(bytes),
  };
}

/** 由真实 stat 构造 Save As 授予记录（已存在目标）。 */
async function grantOf(path: string): Promise<SaveTargetGrant> {
  const s = await stat(path, { bigint: true });
  return { kind: 'existing', realpath: path, identity: process.platform === 'win32' ? null : { dev: s.dev, ino: s.ino }, size: s.size, mtimeNs: s.mtimeNs };
}

const leftovers = async (dir: string): Promise<number> => (await readdir(dir)).filter((name) => name.endsWith('.tmp')).length;

async function runDiskCases(recorder: ProbeRecorder, ctx: DiskContext): Promise<void> {
  await recorder.run('save.disk crlf-lone-cr exact', async () => {
    const path = ctx.next('crlf.jcx');
    const before = new TextEncoder().encode('X:1\r\nC D\r');
    await writeFile(path, before);
    const request: SaveRequest = { kind: 'save', current: await factsFor(path, before, 'utf-8'), source: 'X:1\r\nC E\r', encoding: 'utf-8' };
    const result = await runSavePipeline(deps(), request);
    const problems: string[] = [];
    expectSame(problems, 'outcome', result.outcome, 'saved');
    expectSame(problems, 'bytes', hex(new Uint8Array(await readFile(path))), hex(new TextEncoder().encode('X:1\r\nC E\r')));
    expectSame(problems, 'temp leftovers', await leftovers(ctx.dir), 0);
    return verdict(problems);
  });

  await recorder.run('save.disk gb18030 round-trip', async () => {
    const path = ctx.next('gb.jcx');
    const before = Uint8Array.from([0x54, 0x3a, 0xd6, 0xd0, 0x0a]);
    await writeFile(path, before);
    const result = await runSavePipeline(deps(), { kind: 'save', current: await factsFor(path, before, 'gb18030'), source: 'T:中文\n', encoding: 'gb18030' });
    const problems: string[] = [];
    expectSame(problems, 'outcome', result.outcome, 'saved');
    expectSame(problems, 'decoded', new TextDecoder('gb18030').decode(await readFile(path)), 'T:中文\n');
    return verdict(problems);
  });

  await recorder.run('save.disk in-place-modification refused', async () => {
    const path = ctx.next('inplace.jcx');
    const before = new TextEncoder().encode('X:1\nABCD\n');
    await writeFile(path, before);
    const times = await stat(path);
    const real = createNodeWriteFileSystem();
    const writeFs: WriteFileSystem = {
      ...real,
      openExclusive: async (p, mode) => {
        const handle = await real.openExclusive(p, mode);
        return {
          ...handle,
          writeAll: async (bytes) => {
            const target = await open(path, 'r+');
            await target.write('ABCE', 4);
            await target.close();
            await utimes(path, times.atime, times.mtime);
            await handle.writeAll(bytes);
          },
        };
      },
    };
    const result = await runSavePipeline(deps(writeFs), { kind: 'save', current: await factsFor(path, before, 'utf-8'), source: 'X:1\nZZZZ\n', encoding: 'utf-8' });
    const problems: string[] = [];
    expectSame(problems, 'outcome', result.outcome === 'not-committed' ? result.error.code : result.outcome, 'file-modified-on-disk');
    expectSame(problems, 'content keeps the concurrent edit', await readFile(path, 'utf8'), 'X:1\nABCE\n');
    expectSame(problems, 'temp leftovers', await leftovers(ctx.dir), 0);
    return verdict(problems);
  });

  await recorder.run('save.disk link-publish and EEXIST', async () => {
    const problems: string[] = [];
    const fresh = ctx.next('new.jcx');
    const grant = (path: string) => ({ kind: 'absent' as const, parentRealpath: ctx.dir, basename: path.slice(ctx.dir.length + 1) });
    const ok = await runSavePipeline(deps(), { kind: 'saveAs', requestedPath: fresh, granted: grant(fresh), anchor: null, source: 'NEW', encoding: 'utf-8' });
    expectSame(problems, 'new outcome', ok.outcome, 'saved');
    expectSame(problems, 'new content', await readFile(fresh, 'utf8'), 'NEW');
    const raced = ctx.next('raced.jcx');
    const real = createNodeWriteFileSystem();
    const racing: WriteFileSystem = {
      ...real,
      linkSync: (existing, newPath) => {
        writeFileSync(raced, 'theirs');
        real.linkSync(existing, newPath);
      },
    };
    const lost = await runSavePipeline(deps(racing), { kind: 'saveAs', requestedPath: raced, granted: grant(raced), anchor: null, source: 'MINE', encoding: 'utf-8' });
    expectSame(problems, 'raced outcome', lost.outcome === 'not-committed' ? lost.error.code : lost.outcome, 'file-modified-on-disk');
    expectSame(problems, 'raced content', await readFile(raced, 'utf8'), 'theirs');
    expectSame(problems, 'temp leftovers', await leftovers(ctx.dir), 0);
    return verdict(problems);
  });

  const readonlyId = 'save.disk read-only refused';
  if (process.platform !== 'win32' && process.getuid?.() === 0) recorder.skip(readonlyId, 'running as root: POSIX permission bits are bypassed');
  else {
    await recorder.run(readonlyId, async () => {
      const path = ctx.next('ro.jcx');
      const before = new TextEncoder().encode('RO');
      await writeFile(path, before);
      await chmod(path, 0o444);
      const result = await runSavePipeline(deps(), { kind: 'save', current: await factsFor(path, before, 'utf-8'), source: 'W', encoding: 'utf-8' });
      const problems: string[] = [];
      expectSame(problems, 'code', result.outcome === 'not-committed' ? result.error.code : result.outcome, 'permission-denied');
      expectSame(problems, 'content', await readFile(path, 'utf8'), 'RO');
      await chmod(path, 0o644);
      return verdict(problems);
    });
  }

  const symlinkId = 'save.disk symlink preserved';
  const target = ctx.next('target.jcx');
  const alias = ctx.next('alias.jcx');
  const targetBytes = new TextEncoder().encode('T1');
  await writeFile(target, targetBytes);
  let linked = true;
  try {
    await symlink(target, alias);
  } catch (error) {
    if (process.platform !== 'win32' || errnoCodeOf(error) !== 'EPERM') throw error;
    linked = false;
  }
  if (!linked) recorder.skip(symlinkId, 'creating symbolic links requires a privilege on this Windows host');
  else {
    await recorder.run(symlinkId, async () => {
      const result = await runSavePipeline(deps(), {
        kind: 'saveAs',
        requestedPath: alias,
        granted: await grantOf(target),
        anchor: await factsFor(target, targetBytes, 'utf-8'),
        source: 'T2',
        encoding: 'utf-8',
      });
      const problems: string[] = [];
      expectSame(problems, 'outcome', result.outcome, 'saved');
      expectSame(problems, 'link kept', (await lstat(alias)).isSymbolicLink(), true);
      expectSame(problems, 'content', await readFile(target, 'utf8'), 'T2');
      return verdict(problems);
    });
  }
}

export async function runSaveCases(recorder: ProbeRecorder): Promise<void> {
  await runVerificationCases(recorder);
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'muse-t4-save-probe-')));
  let counter = 0;
  try {
    await runDiskCases(recorder, { dir, next: (name) => join(dir, `${String((counter += 1))}-${name}`) });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
