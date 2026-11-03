/**
 * `WriteFileSystem` 的唯一 Node 实现（`docs/M3_EDITOR_CORE_PLAN.md` §14，M3 T4 B1；Gate B1 C3）。
 *
 * - `src/main/**` 中只有本文件（与只读的 `fileSystemPort.ts`）导入 Node fs 模块，也只有本文件调用写盘 API；
 *   由 `architecture.m3t3`（G1）与 `architecture.m3t4`（W1–W6）钉死。
 * - 这里**没有任何策略判断**（只读、指纹、sameFile、提交顺序都在 `atomicWrite.ts` / `savePipeline.ts`），
 *   只把 Node API 原样包装成 port；异常原样抛出，由调用方按 errno 归类。
 * - 本模块不 import `electron`，可在普通 Node（vitest）与 `ELECTRON_RUN_AS_NODE=1` 下运行。
 */

import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { access, lstat, open, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

import type { ExclusiveFileHandle, WriteFileSystem, WriteStat } from './writeFileSystemPort';

function toWriteStat(stats: BigIntStats): WriteStat {
  return {
    isFile: () => stats.isFile(),
    size: stats.size,
    dev: stats.dev,
    ino: stats.ino,
    mode: Number(stats.mode & 0o7777n),
    mtimeNs: stats.mtimeNs,
  };
}

function wrapExclusive(handle: FileHandle): ExclusiveFileHandle {
  return {
    writeAll: async (bytes) => {
      let written = 0;
      while (written < bytes.length) {
        const { bytesWritten } = await handle.write(bytes, written, bytes.length - written, written);
        if (bytesWritten <= 0) throw new Error('write made no progress');
        written += bytesWritten;
      }
    },
    sync: () => handle.sync(),
    chmod: (mode) => handle.chmod(mode),
    stat: async () => toWriteStat(await handle.stat({ bigint: true })),
    close: () => handle.close(),
  };
}

/** 只读打开 flag（C2 的最终读盘）；独占新建 flag 只用于临时文件。 */
const READ_FLAG = 'r';
const EXCLUSIVE_CREATE_FLAG = 'wx';

export function createNodeWriteFileSystem(): WriteFileSystem {
  return {
    stat: async (path) => toWriteStat(await stat(path, { bigint: true })),
    lstat: async (path) => toWriteStat(await lstat(path, { bigint: true })),
    isWritable: async (path) => {
      try {
        await access(path, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    },
    openExclusive: async (path, mode) => wrapExclusive(await open(path, EXCLUSIVE_CREATE_FLAG, mode)),
    removeFile: (path) => unlink(path),
    syncDirectory: async (path) => {
      const handle = await open(path, READ_FLAG);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    },

    openReadSync: (path) => openSync(path, READ_FLAG),
    fstatSync: (fd) => toWriteStat(fstatSync(fd, { bigint: true })),
    readSync: (fd, buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
    closeSync: (fd) => closeSync(fd),
    statSync: (path) => toWriteStat(statSync(path, { bigint: true })),
    realpathSync: (path) => realpathSync.native(path),
    renameSync: (from, to) => renameSync(from, to),
    linkSync: (existing, newPath) => linkSync(existing, newPath),
    unlinkSync: (path) => unlinkSync(path),
  };
}
