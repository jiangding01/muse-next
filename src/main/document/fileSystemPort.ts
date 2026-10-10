/**
 * main 读取路径使用的只读文件系统 port（`docs/M3_EDITOR_CORE_PLAN.md` §11.2、§13.2，M3 T1a）。
 *
 * - port 上**没有任何写方法**：Open 管线在类型层就无法写盘（§11.8 零写盘）。
 * - 纯 helper 只依赖这个 port，单元测试用内存 fake 注入；生产用 `createNodeReadOnlyFileSystem()`。
 * - 本目录不 import `electron`，因此能在普通 Node（vitest）与 `ELECTRON_RUN_AS_NODE=1` 下运行。
 */

import { open, realpath, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

/**
 * 读取路径关心的 stat 子集；数值一律 bigint（`stat(p, { bigint: true })`），避免大 ino / size 丢精度。
 * 时间戳（纳秒）用于读取一致性复核（`readDocumentBytes.ts`），不作为身份依据。
 */
export interface FileStat {
  isFile(): boolean;
  readonly size: bigint;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  readonly birthtimeNs: bigint;
}

export interface ReadOnlyFileHandle {
  stat(): Promise<FileStat>;
  /** 读入 `buffer[offset, offset + length)`；返回实际读到的字节数，0 表示 EOF。 */
  read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<number>;
  close(): Promise<void>;
}

export interface ReadOnlyFileSystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileStat>;
  openForRead(path: string): Promise<ReadOnlyFileHandle>;
}

/** open flag 只允许只读：任何写 / 创建 / 截断 flag 都不出现在本文件中。 */
const READ_ONLY_FLAG = 'r';

function wrapHandle(handle: FileHandle): ReadOnlyFileHandle {
  return {
    stat: () => handle.stat({ bigint: true }),
    read: async (buffer, offset, length, position) => {
      const { bytesRead } = await handle.read(buffer, offset, length, position);
      return bytesRead;
    },
    close: () => handle.close(),
  };
}

/**
 * 基于 `node:fs/promises` 的生产实现。
 *
 * `realpath` 用 promises 版：它直接调用 libuv 的原生 realpath，返回磁盘上的真实路径（含真实大小写）；
 * 不使用 `fs.realpathSync` 的 JS 实现（它逐段 lstat 拼接，不规范化大小写）。
 */
export function createNodeReadOnlyFileSystem(): ReadOnlyFileSystem {
  return {
    realpath: (path) => realpath(path),
    stat: (path) => stat(path, { bigint: true }),
    openForRead: async (path) => wrapHandle(await open(path, READ_ONLY_FLAG)),
  };
}
