/**
 * Electron runtime 真实文件集成（M3 T1a，`docs/M3_EDITOR_CORE_PLAN.md` §11.2、§11.8、§12.3、§25.2）。
 *
 * - 经 `createNodeReadOnlyFileSystem` + `openDocumentAtPath` 打开临时目录中的文件，即 main 的真实 Open 管线。
 * - **零写盘**：所有 open 调用前后对临时目录做快照（每个条目的 name、类型、size、mtimeNs、ctimeNs、内容 SHA-256），
 *   前后必须完全相等，且目录中没有新增条目。
 * - 指纹用独立的 `createHash` 对原字节计算后比较，不复用被测的 `sha256Hex`。
 */

import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDocumentIdAllocator } from '../../src/main/document/documentIds';
import { createNodeReadOnlyFileSystem } from '../../src/main/document/fileSystemPort';
import { errnoCodeOf } from '../../src/main/document/fsErrors';
import { MAX_DOCUMENT_BYTES } from '../../src/main/document/readDocumentBytes';
import { openDocumentAtPath } from '../../src/main/document/openDocument';
import type { OpenAtPathResult, OpenDocumentDeps } from '../../src/main/document/openDocument';
import type { OpenDocumentErrorCode } from '../../src/shared/openContracts';
import { codePoints, expectSame, verdict } from './probeHarness';
import type { Outcome, ProbeRecorder } from './probeHarness';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const FIXTURES: readonly (readonly [string, Uint8Array])[] = [
  ['utf8.jcx', new TextEncoder().encode('X:1\nT:中文\n')],
  ['bom.jcx', Uint8Array.from([0xef, 0xbb, 0xbf, 0x54, 0x3a, 0x78, 0x0a])],
  ['gb18030.jcx', Uint8Array.from([0x54, 0x3a, 0xd6, 0xd0, 0xce, 0xc4, 0x0a])],
  ['leading-feff.jcx', Uint8Array.from([0x84, 0x31, 0x95, 0x33, 0xd6, 0xd0])],
  ['utf16.jcx', Uint8Array.from([0xff, 0xfe, 0x41, 0x00])],
  ['bad-gb18030.jcx', Uint8Array.from([0x41, 0x80, 0x41])],
  ['exact-limit.jcx', new Uint8Array(MAX_DOCUMENT_BYTES).fill(0x61)],
  ['over-limit.jcx', new Uint8Array(MAX_DOCUMENT_BYTES + 1).fill(0x61)],
  ['target.jcx', new TextEncoder().encode('T:target\n')],
  ['locked.jcx', new TextEncoder().encode('T:locked\n')],
];

/** 递归快照：lstat（不跟随链接）+ 内容哈希；不可读文件记为 unreadable（读取本身不写盘）。 */
async function snapshot(dir: string, prefix = ''): Promise<string[]> {
  const lines: string[] = [];
  const self = await lstat(dir, { bigint: true });
  lines.push(`${prefix || '.'} dir mtime=${self.mtimeNs.toString()} ctime=${self.ctimeNs.toString()}`);
  const names = (await readdir(dir)).sort();
  for (const name of names) {
    const path = join(dir, name);
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    const info = await lstat(path, { bigint: true });
    if (info.isDirectory()) {
      lines.push(...(await snapshot(path, rel)));
      continue;
    }
    let content: string;
    if (info.isSymbolicLink()) content = `link->${await readlink(path)}`;
    else {
      try {
        content = sha256(await readFile(path));
      } catch (error) {
        content = `unreadable:${errnoCodeOf(error) ?? 'unknown'}`;
      }
    }
    lines.push(`${rel} size=${info.size.toString()} mtime=${info.mtimeNs.toString()} ctime=${info.ctimeNs.toString()} ${content}`);
  }
  return lines;
}

interface Counters {
  ids: number;
  tokens: number;
}

function makeDeps(counters: Counters): OpenDocumentDeps {
  const allocator = createDocumentIdAllocator();
  return {
    fs: createNodeReadOnlyFileSystem(),
    platform: process.platform,
    ownerId: 1,
    allocateDocumentId: () => {
      counters.ids += 1;
      return allocator.next();
    },
    issueToken: () => {
      counters.tokens += 1;
      return `probe-token-${String(counters.tokens)}`;
    },
  };
}

function expectOpened(result: OpenAtPathResult, original: Uint8Array, check: (problems: string[], result: Extract<OpenAtPathResult, { kind: 'opened' }>) => void): Outcome {
  if (result.kind !== 'opened') return verdict([`expected opened, got ${result.error.code}`]);
  const problems: string[] = [];
  expectSame(problems, 'fingerprint', result.capability.lastKnownDiskFingerprint, sha256(original));
  expectSame(problems, 'capability.state', result.capability.state, 'pending');
  expectSame(problems, 'documentId match', result.capability.documentId, result.document.documentId);
  expectSame(problems, 'token match', result.capability.token, result.document.file.capability.id);
  check(problems, result);
  return verdict(problems);
}

function expectFailed(result: OpenAtPathResult, code: OpenDocumentErrorCode, counters: Counters, before: Counters): Outcome {
  const problems: string[] = [];
  expectSame(problems, 'result', result.kind === 'failed' ? result.error.code : `opened`, code);
  expectSame(problems, 'no allocation', { ids: counters.ids, tokens: counters.tokens }, { ids: before.ids, tokens: before.tokens });
  return verdict(problems);
}

async function trySymlink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === 'win32' && errnoCodeOf(error) === 'EPERM') return false;
    throw error;
  }
}

export async function runFileCases(recorder: ProbeRecorder): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'muse-codec-files-'));
  try {
    const realRoot = await realpath(root);
    const bytesByName = new Map(FIXTURES);
    for (const [name, bytes] of FIXTURES) await writeFile(join(root, name), bytes);
    await mkdir(join(root, 'folder.jcx'));
    const hasSymlink = await trySymlink(join(root, 'target.jcx'), join(root, 'link.jcx'));
    const canLock = process.platform !== 'win32' && process.getuid?.() !== 0;
    if (canLock) await chmod(join(root, 'locked.jcx'), 0o000);

    const before = await snapshot(root);
    const counters: Counters = { ids: 0, tokens: 0 };
    const deps = makeDeps(counters);
    const open = (name: string): Promise<OpenAtPathResult> => openDocumentAtPath(deps, join(root, name));
    const original = (name: string): Uint8Array => bytesByName.get(name) ?? new Uint8Array(0);
    const failing = async (name: string, code: OpenDocumentErrorCode): Promise<Outcome> => {
      const snap = { ...counters };
      return expectFailed(await open(name), code, counters, snap);
    };

    await recorder.run('file.utf8', async () =>
      expectOpened(await open('utf8.jcx'), original('utf8.jcx'), (problems, r) => {
        expectSame(problems, 'source', r.document.source, 'X:1\nT:中文\n');
        expectSame(problems, 'encoding', [r.document.writeEncoding, r.document.byteBom, r.document.encodingRoundTrip], ['utf-8', 'none', 'exact']);
        expectSame(problems, 'realpath', r.capability.realpath, join(realRoot, 'utf8.jcx'));
        expectSame(problems, 'displayName', r.document.file.displayName, 'utf8.jcx');
      }),
    );
    await recorder.run('file.utf8-bom', async () =>
      expectOpened(await open('bom.jcx'), original('bom.jcx'), (problems, r) => {
        expectSame(problems, 'source', codePoints(r.document.source), codePoints('﻿T:x\n'));
        expectSame(problems, 'encoding', [r.document.writeEncoding, r.document.byteBom, r.document.encodingRoundTrip], ['utf-8', 'utf8', 'exact']);
      }),
    );
    await recorder.run('file.gb18030', async () =>
      expectOpened(await open('gb18030.jcx'), original('gb18030.jcx'), (problems, r) => {
        expectSame(problems, 'source', r.document.source, 'T:中文\n');
        expectSame(problems, 'encoding', [r.document.writeEncoding, r.document.byteBom, r.document.encodingRoundTrip], ['gb18030', 'none', 'exact']);
      }),
    );
    await recorder.run('file.gb18030-leading-feff', async () =>
      expectOpened(await open('leading-feff.jcx'), original('leading-feff.jcx'), (problems, r) => {
        expectSame(problems, 'source', codePoints(r.document.source), codePoints('﻿中'));
        expectSame(problems, 'encoding', [r.document.writeEncoding, r.document.byteBom, r.document.encodingRoundTrip], ['gb18030', 'none', 'exact']);
      }),
    );
    await recorder.run('file.utf16-rejected', () => failing('utf16.jcx', 'decode-utf16-unsupported'));
    await recorder.run('file.invalid-gb18030-rejected', () => failing('bad-gb18030.jcx', 'decode-invalid-gb18030'));
    await recorder.run('file.exact-1mib', async () =>
      expectOpened(await open('exact-limit.jcx'), original('exact-limit.jcx'), (problems, r) => {
        expectSame(problems, 'length', r.document.source.length, MAX_DOCUMENT_BYTES);
      }),
    );
    await recorder.run('file.1mib-plus-1-too-large', () => failing('over-limit.jcx', 'file-too-large'));
    await recorder.run('file.directory', () => failing('folder.jcx', 'not-a-regular-file'));
    await recorder.run('file.missing', () => failing('missing.jcx', 'not-found'));

    if (hasSymlink) {
      await recorder.run('file.symlink-realpath', async () =>
        expectOpened(await open('link.jcx'), original('target.jcx'), (problems, r) => {
          expectSame(problems, 'realpath', r.capability.realpath, join(realRoot, 'target.jcx'));
          expectSame(problems, 'displayName', r.document.file.displayName, 'link.jcx');
        }),
      );
    } else recorder.skip('file.symlink-realpath', 'symlink creation needs privilege on this Windows host (EPERM)');

    if (canLock) await recorder.run('file.permission-denied', () => failing('locked.jcx', 'permission-denied'));
    else recorder.skip('file.permission-denied', process.platform === 'win32' ? 'POSIX permissions not applicable on win32' : 'running as root');

    await recorder.run('file.allocation-only-on-success', () => {
      const opened = 5 + (hasSymlink ? 1 : 0);
      return verdict(counters.ids === opened && counters.tokens === opened ? [] : [`ids=${String(counters.ids)} tokens=${String(counters.tokens)} expected ${String(opened)}`]);
    });

    const after = await snapshot(root);
    await recorder.run('file.zero-write', () => {
      const problems: string[] = [];
      if (before.length !== after.length) problems.push(`entry count ${String(before.length)} -> ${String(after.length)}`);
      before.forEach((line, index) => {
        if (after[index] !== line) problems.push(`changed: ${line.split(' ')[0] ?? ''}`);
      });
      return verdict(problems, `${String(before.length)} entries unchanged`);
    });
  } finally {
    if (process.env.KEEP_PROBE !== '1') await rm(root, { recursive: true, force: true });
  }
}
