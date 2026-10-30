/**
 * M3 T4 B1 测试替身：内存文件系统，同时实现只读 port（`ReadOnlyFileSystem`）与写 port（`WriteFileSystem`）。
 *
 * - 以 inode 建模：目录、普通文件、符号链接；硬链接 = 多个名字指向同一 inode；rename 换名、不换 inode。
 * - 路径一律用 `path.resolve` 规范成本平台的绝对路径（Windows CI 上同样成立）；测试用 `P(...)` 构造路径。
 * - 逐调用记录（`calls`），可对任意方法注入 errno 失败（`fail`）或在调用前执行钩子（`before`，模拟外部写者）。
 * - 权限：文件 mode 无写位即 `isWritable` 为假；目录 mode 无写位时在其中新建 / 删除 / 换名都 `EACCES`。
 */

import { basename, dirname, join, resolve, sep } from 'node:path';

import type { FileStat, ReadOnlyFileHandle, ReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';
import type { ExclusiveFileHandle, WriteFileSystem, WriteStat } from '../../../src/main/document/writeFileSystemPort';

export const P = (...parts: string[]): string => resolve(sep, ...parts);

interface Inode {
  readonly ino: bigint;
  readonly kind: 'file' | 'dir' | 'symlink';
  bytes: Uint8Array;
  target: string;
  mode: number;
  mtimeNs: bigint;
  nlink: number;
}

export function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export type FakeMethod = keyof WriteFileSystem | 'openForRead' | 'handle.writeAll' | 'handle.sync' | 'handle.chmod' | 'handle.stat' | 'handle.close';

export interface FakeWriteFs {
  readonly readFs: ReadOnlyFileSystem;
  readonly writeFs: WriteFileSystem;
  readonly calls: string[];
  /** 只读 port 的调用（`方法 路径`），用于断言某条管线没有读取某个路径。 */
  readonly readCalls: string[];
  mkdir(path: string, mode?: number): void;
  writeFile(path: string, bytes: Uint8Array | string, mode?: number): void;
  symlink(path: string, target: string): void;
  hardlink(existing: string, newPath: string): void;
  read(path: string): Uint8Array;
  text(path: string): string;
  exists(path: string): boolean;
  inodeOf(path: string): bigint;
  modeOf(path: string): number;
  /** 跟随符号链接后的 size / mtimeNs（构造 Save As 授予记录用）。 */
  statOf(path: string): { readonly size: bigint; readonly mtimeNs: bigint };
  list(dir: string): string[];
  chmod(path: string, mode: number): void;
  /** 原地改写（不换 inode）；`keepStamp` 时保持 size 不变者的 mtimeNs。 */
  modifyInPlace(path: string, bytes: Uint8Array | string, keepStamp?: boolean): void;
  /** 原子替换为新 inode；`keepStamp` 时新文件沿用旧文件的 mtimeNs（模拟时间戳被还原的替换）。 */
  replaceAtomically(path: string, bytes: Uint8Array | string, keepStamp?: boolean): void;
  remove(path: string): void;
  fail(method: FakeMethod, code: string, times?: number): void;
  before(method: FakeMethod, hook: () => void, times?: number): void;
}

const encoder = new TextEncoder();
const toBytes = (value: Uint8Array | string): Uint8Array => (typeof value === 'string' ? encoder.encode(value) : value.slice());

export function createFakeWriteFs(platform: string = process.platform): FakeWriteFs {
  let nextIno = 100n;
  let clock = 1_000_000n;
  const inodes = new Map<bigint, Inode>();
  const entries = new Map<string, bigint>();
  const calls: string[] = [];
  const readCalls: string[] = [];
  const faults = new Map<string, { code: string; times: number }[]>();
  const hooks = new Map<string, { hook: () => void; times: number }[]>();
  const fds = new Map<number, Inode>();
  let nextFd = 3;

  const tick = (): bigint => (clock += 1000n);
  const newInode = (kind: Inode['kind'], mode: number): Inode => {
    const inode: Inode = { ino: (nextIno += 1n), kind, bytes: new Uint8Array(0), target: '', mode, mtimeNs: tick(), nlink: 0 };
    inodes.set(inode.ino, inode);
    return inode;
  };
  const root = newInode('dir', 0o755);
  entries.set(resolve(sep), root.ino);

  function enter(method: string): void {
    calls.push(method);
    const hookList = hooks.get(method);
    const hook = hookList?.[0];
    if (hookList !== undefined && hook !== undefined) {
      hook.times -= 1;
      if (hook.times <= 0) hookList.shift();
      hook.hook();
    }
    const list = faults.get(method);
    const fault = list?.[0];
    if (list !== undefined && fault !== undefined) {
      fault.times -= 1;
      if (fault.times <= 0) list.shift();
      throw errno(fault.code);
    }
  }

  /** 跟随符号链接（`followLast` 决定最后一段），返回规范路径；不存在时抛 ENOENT。 */
  function walk(path: string, followLast: boolean, depth = 0): string {
    if (depth > 40) throw errno('ELOOP');
    const full = resolve(path);
    if (full === resolve(sep)) return full;
    const parent = walk(dirname(full), true, depth + 1);
    const parentNode = inodes.get(entries.get(parent) ?? -1n);
    if (parentNode === undefined) throw errno('ENOENT');
    if (parentNode.kind !== 'dir') throw errno('ENOTDIR');
    const here = join(parent, basename(full));
    const node = inodes.get(entries.get(here) ?? -1n);
    if (node === undefined) throw errno('ENOENT');
    if (node.kind === 'symlink' && followLast) return walk(resolve(parent, node.target), true, depth + 1);
    return here;
  }
  const nodeAt = (path: string, followLast = true): Inode => {
    const node = inodes.get(entries.get(walk(path, followLast)) ?? -1n);
    if (node === undefined) throw errno('ENOENT');
    return node;
  };
  const entryExists = (path: string): boolean => {
    try {
      const parent = walk(dirname(resolve(path)), true);
      return entries.has(join(parent, basename(resolve(path))));
    } catch {
      return false;
    }
  };
  const parentForCreate = (path: string): { parent: string; dir: Inode } => {
    const parent = walk(dirname(resolve(path)), true);
    const dir = inodes.get(entries.get(parent) ?? -1n);
    if (dir === undefined || dir.kind !== 'dir') throw errno('ENOTDIR');
    if ((dir.mode & 0o200) === 0) throw errno('EACCES');
    return { parent, dir };
  };
  const writeStat = (node: Inode): WriteStat => ({
    isFile: () => node.kind === 'file',
    size: BigInt(node.kind === 'file' ? node.bytes.length : node.target.length),
    dev: platform === 'win32' ? 0n : 1n,
    ino: platform === 'win32' ? 0n : node.ino,
    mode: node.mode,
    mtimeNs: node.mtimeNs,
  });
  const fileStat = (node: Inode): FileStat => ({ ...writeStat(node), ctimeNs: node.mtimeNs, birthtimeNs: node.ino });

  function link(name: string, node: Inode): void {
    entries.set(name, node.ino);
    node.nlink += 1;
  }
  function unlinkName(name: string): void {
    const node = inodes.get(entries.get(name) ?? -1n);
    entries.delete(name);
    if (node !== undefined) node.nlink -= 1;
  }

  function exclusiveHandle(node: Inode): ExclusiveFileHandle {
    return {
      writeAll: async (bytes) => {
        enter('handle.writeAll');
        const merged = new Uint8Array(node.bytes.length + bytes.length);
        merged.set(node.bytes);
        merged.set(bytes, node.bytes.length);
        node.bytes = merged;
        node.mtimeNs = tick();
      },
      sync: async () => enter('handle.sync'),
      chmod: async (mode) => {
        enter('handle.chmod');
        node.mode = mode;
      },
      stat: async () => {
        enter('handle.stat');
        return writeStat(node);
      },
      close: async () => enter('handle.close'),
    };
  }

  const readHandle = (node: Inode): ReadOnlyFileHandle => ({
    stat: async () => fileStat(node),
    read: async (buffer, offset, length, position) => {
      const from = position ?? 0;
      const chunk = node.bytes.subarray(from, from + length);
      buffer.set(chunk, offset);
      return chunk.length;
    },
    close: async () => undefined,
  });

  const readFs: ReadOnlyFileSystem = {
    realpath: async (path) => {
      readCalls.push(`realpath ${resolve(path)}`);
      return walk(path, true);
    },
    stat: async (path) => {
      readCalls.push(`stat ${resolve(path)}`);
      return fileStat(nodeAt(path));
    },
    openForRead: async (path) => {
      readCalls.push(`openForRead ${resolve(path)}`);
      enter('openForRead');
      const node = nodeAt(path);
      if (node.kind === 'dir') throw errno('EISDIR');
      return readHandle(node);
    },
  };

  const writeFs: WriteFileSystem = {
    stat: async (path) => {
      enter('stat');
      return writeStat(nodeAt(path));
    },
    lstat: async (path) => {
      enter('lstat');
      return writeStat(nodeAt(path, false));
    },
    isWritable: async (path) => {
      enter('isWritable');
      return (nodeAt(path).mode & 0o200) !== 0;
    },
    openExclusive: async (path, mode) => {
      enter('openExclusive');
      if (entryExists(path)) throw errno('EEXIST');
      const { parent } = parentForCreate(path);
      const node = newInode('file', mode & ~0o022);
      link(join(parent, basename(resolve(path))), node);
      return exclusiveHandle(node);
    },
    removeFile: async (path) => {
      enter('removeFile');
      const { parent } = parentForCreate(path);
      const name = join(parent, basename(resolve(path)));
      if (!entries.has(name)) throw errno('ENOENT');
      unlinkName(name);
    },
    syncDirectory: async () => enter('syncDirectory'),

    openReadSync: (path) => {
      enter('openReadSync');
      const node = nodeAt(path);
      if (node.kind === 'dir') throw errno('EISDIR');
      nextFd += 1;
      fds.set(nextFd, node);
      return nextFd;
    },
    fstatSync: (fd) => {
      enter('fstatSync');
      const node = fds.get(fd);
      if (node === undefined) throw errno('EBADF');
      return writeStat(node);
    },
    readSync: (fd, buffer, offset, length, position) => {
      enter('readSync');
      const node = fds.get(fd);
      if (node === undefined) throw errno('EBADF');
      const chunk = node.bytes.subarray(position, position + length);
      buffer.set(chunk, offset);
      return chunk.length;
    },
    closeSync: (fd) => {
      enter('closeSync');
      fds.delete(fd);
    },
    statSync: (path) => {
      enter('statSync');
      return writeStat(nodeAt(path));
    },
    realpathSync: (path) => {
      enter('realpathSync');
      return walk(path, true);
    },
    renameSync: (from, to) => {
      enter('renameSync');
      const source = parentForCreate(from);
      const fromName = join(source.parent, basename(resolve(from)));
      const node = inodes.get(entries.get(fromName) ?? -1n);
      if (node === undefined) throw errno('ENOENT');
      const { parent } = parentForCreate(to);
      const toName = join(parent, basename(resolve(to)));
      const existing = inodes.get(entries.get(toName) ?? -1n);
      if (existing?.kind === 'dir') throw errno('EISDIR');
      if (existing !== undefined) unlinkName(toName);
      entries.delete(fromName);
      entries.set(toName, node.ino);
    },
    linkSync: (existing, newPath) => {
      enter('linkSync');
      const node = nodeAt(existing, false);
      if (entryExists(newPath)) throw errno('EEXIST');
      const { parent } = parentForCreate(newPath);
      link(join(parent, basename(resolve(newPath))), node);
    },
    unlinkSync: (path) => {
      enter('unlinkSync');
      const { parent } = parentForCreate(path);
      const name = join(parent, basename(resolve(path)));
      if (!entries.has(name)) throw errno('ENOENT');
      unlinkName(name);
    },
  };

  return {
    readFs,
    writeFs,
    calls,
    readCalls,
    mkdir: (path, mode = 0o755) => link(resolve(path), newInode('dir', mode)),
    writeFile: (path, bytes, mode = 0o644) => {
      const node = newInode('file', mode);
      node.bytes = toBytes(bytes);
      link(resolve(path), node);
    },
    symlink: (path, target) => {
      const node = newInode('symlink', 0o777);
      node.target = target;
      link(resolve(path), node);
    },
    hardlink: (existing, newPath) => link(resolve(newPath), nodeAt(existing)),
    read: (path) => nodeAt(path).bytes.slice(),
    text: (path) => new TextDecoder().decode(nodeAt(path).bytes),
    exists: (path) => entryExists(path),
    inodeOf: (path) => nodeAt(path).ino,
    modeOf: (path) => nodeAt(path).mode,
    statOf: (path) => {
      const node = nodeAt(path);
      return { size: BigInt(node.bytes.length), mtimeNs: node.mtimeNs };
    },
    list: (dir) => [...entries.keys()].filter((name) => name !== resolve(dir) && dirname(name) === resolve(dir)).map((name) => basename(name)).sort(),
    chmod: (path, mode) => {
      nodeAt(path).mode = mode;
    },
    modifyInPlace: (path, bytes, keepStamp = false) => {
      const node = nodeAt(path);
      node.bytes = toBytes(bytes);
      if (!keepStamp) node.mtimeNs = tick();
    },
    replaceAtomically: (path, bytes, keepStamp = false) => {
      const name = walk(path, false);
      const previous = inodes.get(entries.get(name) ?? -1n);
      unlinkName(name);
      const node = newInode('file', 0o644);
      node.bytes = toBytes(bytes);
      if (keepStamp && previous !== undefined) node.mtimeNs = previous.mtimeNs;
      link(name, node);
    },
    remove: (path) => unlinkName(walk(path, false)),
    fail: (method, code, times = 1) => {
      const list = faults.get(method) ?? [];
      list.push({ code, times });
      faults.set(method, list);
    },
    before: (method, hook, times = 1) => {
      const list = hooks.get(method) ?? [];
      list.push({ hook, times });
      hooks.set(method, list);
    },
  };
}
