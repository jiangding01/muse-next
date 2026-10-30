/**
 * M3 T4 B1 保存管线测试的共用工具：内存 fs、已授权事实、依赖注入与磁盘快照（D1–D5 断言）。
 */

import { expect } from 'vitest';

import { sha256Hex } from '../../../src/main/document/fingerprint';
import type { SaveFileFacts, SavePipelineDeps, SavePipelineEvent, SaveTargetGrant } from '../../../src/main/document/savePipeline';
import { createFakeWriteFs, P } from './fakeWriteFileSystem';
import type { FakeWriteFs } from './fakeWriteFileSystem';

export { P };

export const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 有 `docs` 目录的内存 fs；平台固定，保证 Windows CI 上的身份规则与断言一致。 */
export function setup(platform = 'darwin'): FakeWriteFs {
  const fs = createFakeWriteFs(platform);
  fs.mkdir(P('docs'));
  return fs;
}

export function factsOf(fs: FakeWriteFs, path: string, text: string, overrides: Partial<SaveFileFacts> = {}): SaveFileFacts {
  return {
    realpath: path,
    identity: { dev: 1n, ino: fs.inodeOf(path) },
    writeEncoding: 'utf-8',
    encodingRoundTrip: 'exact',
    lastKnownDiskFingerprint: sha256Hex(bytesOf(text)),
    ...overrides,
  };
}

/** 授予（阶段 1）时对已存在目标的记录：POSIX 平台带 dev / ino，Windows 只有 size / mtimeNs。 */
export function grantExisting(fs: FakeWriteFs, path: string, platform = 'darwin'): SaveTargetGrant {
  const stat = fs.statOf(path);
  return { kind: 'existing', realpath: path, identity: platform === 'win32' ? null : { dev: 1n, ino: fs.inodeOf(path) }, size: stat.size, mtimeNs: stat.mtimeNs };
}

export interface Harness {
  readonly deps: SavePipelineDeps;
  readonly events: SavePipelineEvent[];
  /** 让 `stillCurrent()` 从此返回 false（模拟窗口重载 / 导航导致的代次变化）。 */
  revoke(): void;
}

export function harness(fs: FakeWriteFs, platform = 'darwin'): Harness {
  let live = true;
  let counter = 0;
  const events: SavePipelineEvent[] = [];
  return {
    deps: {
      readFs: fs.readFs,
      writeFs: fs.writeFs,
      platform,
      tempName: () => `.muse-save-${String((counter += 1))}.tmp`,
      stillCurrent: () => live,
      log: (event) => events.push(event),
    },
    events,
    revoke: () => {
      live = false;
    },
  };
}

export interface DiskSnapshot {
  readonly text: string | null;
  readonly ino: bigint | null;
  readonly mode: number | null;
  readonly listing: string[];
}

export function snapshot(fs: FakeWriteFs, path: string, dir = P('docs')): DiskSnapshot {
  const exists = fs.exists(path);
  return {
    text: exists ? fs.text(path) : null,
    ino: exists ? fs.inodeOf(path) : null,
    mode: exists ? fs.modeOf(path) : null,
    listing: fs.list(dir),
  };
}

const WRITE_CALLS = ['openExclusive', 'handle.writeAll', 'renameSync', 'linkSync', 'unlinkSync', 'removeFile'];

/** D1：前置拒绝——写 port 零写调用。 */
export function expectNoWrites(fs: FakeWriteFs): void {
  expect(fs.calls.filter((call) => WRITE_CALLS.includes(call))).toEqual([]);
}

/** D2 / D3：目标与目录与操作前一致，且没有成功的发布。 */
export function expectUntouched(fs: FakeWriteFs, path: string, before: DiskSnapshot, dir = P('docs')): void {
  expect(snapshot(fs, path, dir)).toEqual(before);
}
