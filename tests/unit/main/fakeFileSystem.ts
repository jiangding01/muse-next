/**
 * 内存版只读文件系统 fake（M3 T1a 单元测试共用）。
 *
 * - 每个路径是一个条目：文件 / 目录 / FIFO；可分别伪造「路径 stat」与「句柄 stat」报告的 size / 类型，
 *   以覆盖三道上限防护（读前 stat、句柄 stat、有界读取）。
 * - 记录 read 调用：每次请求的 offset / length / position，以及实际交付的总字节数，供断言「永不越过 limit + 1」。
 * - 记录句柄的打开 / 关闭次数，供断言句柄总被关闭。
 */

import type { FileStat, ReadOnlyFileHandle, ReadOnlyFileSystem } from '../../../src/main/document/fileSystemPort';

export type FakeKind = 'file' | 'dir' | 'fifo';

export interface FakeEntry {
  readonly kind: FakeKind;
  readonly bytes?: Uint8Array;
  /** 路径 stat 报告的 size（默认真实长度）。 */
  readonly statSize?: bigint;
  /** 句柄 stat 报告的 size（默认同 statSize）。 */
  readonly handleSize?: bigint;
  /** 句柄 stat 报告的类型（默认同 kind），模拟 stat 与 open 之间被替换。 */
  readonly handleKind?: FakeKind;
  /** 每次 read 最多交付的字节数（模拟短读）。 */
  readonly chunk?: number;
  /** 第 n 次 read（0 起）抛出此异常。 */
  readonly readThrowsAt?: { readonly call: number; readonly error: unknown };
  readonly handleStatThrows?: unknown;
  readonly closeThrows?: unknown;
  readonly dev?: bigint;
  readonly ino?: bigint;
  readonly mtimeNs?: bigint;
  /** 句柄 stat 报告的 ino（默认同 ino），模拟 stat 与 open 之间路径被 rename 替换成另一个文件。 */
  readonly handleIno?: bigint;
  /** 第一次 read 之后，所有 stat（路径与句柄）报告的 mtime，模拟读取过程中文件被改写。 */
  readonly mtimeNsAfterRead?: bigint;
  /** 第一次 read 之后，路径 stat 报告的 ino，模拟读取过程中路径被替换（句柄仍指向旧文件）。 */
  readonly pathInoAfterRead?: bigint;
  /** 句柄 stat 报告的 ctime / birthtime（默认 ctime 同 mtime、birthtime 为 1n），覆盖一致性复核的其余字段。 */
  readonly handleCtimeNs?: bigint;
  readonly handleBirthtimeNs?: bigint;
}

export interface FakeOptions {
  /** 路径 → realpath；未列出则 realpath 为自身。 */
  readonly links?: Readonly<Record<string, string>>;
  readonly realpathThrows?: Readonly<Record<string, unknown>>;
  readonly statThrows?: Readonly<Record<string, unknown>>;
  readonly openThrows?: Readonly<Record<string, unknown>>;
}

export interface ReadCall {
  readonly offset: number;
  readonly length: number;
  readonly position: number | null;
  readonly bufferLength: number;
}

export interface FakeFileSystem extends ReadOnlyFileSystem {
  readonly reads: ReadCall[];
  readonly calls: string[];
  delivered(): number;
  opened(): number;
  closed(): number;
}

export function errno(code: string): Error & { code: string } {
  return Object.assign(new Error(`fake ${code}`), { code });
}

function fakeStat(kind: FakeKind, size: bigint, dev: bigint, ino: bigint, mtimeNs: bigint, ctimeNs: bigint, birthtimeNs: bigint): FileStat {
  return { isFile: () => kind === 'file', size, dev, ino, mtimeNs, ctimeNs, birthtimeNs };
}

export function createFakeFileSystem(entries: Readonly<Record<string, FakeEntry>>, options: FakeOptions = {}): FakeFileSystem {
  const reads: ReadCall[] = [];
  const calls: string[] = [];
  let delivered = 0;
  let opened = 0;
  let closed = 0;
  const readStarted = new Set<FakeEntry>();

  const lookup = (path: string): FakeEntry => {
    const entry = entries[path];
    if (entry === undefined) throw errno('ENOENT');
    return entry;
  };
  const statOf = (entry: FakeEntry, forHandle: boolean): FileStat => {
    const real = BigInt(entry.bytes?.length ?? 0);
    const size = forHandle ? (entry.handleSize ?? entry.statSize ?? real) : (entry.statSize ?? real);
    const kind = forHandle ? (entry.handleKind ?? entry.kind) : entry.kind;
    const afterRead = readStarted.has(entry);
    const baseIno = entry.ino ?? 1n;
    const ino = forHandle ? (entry.handleIno ?? baseIno) : afterRead ? (entry.pathInoAfterRead ?? baseIno) : baseIno;
    const mtimeNs = afterRead ? (entry.mtimeNsAfterRead ?? entry.mtimeNs ?? 1n) : (entry.mtimeNs ?? 1n);
    const ctimeNs = forHandle ? (entry.handleCtimeNs ?? mtimeNs) : mtimeNs;
    const birthtimeNs = forHandle ? (entry.handleBirthtimeNs ?? 1n) : 1n;
    return fakeStat(kind, size, entry.dev ?? 1n, ino, mtimeNs, ctimeNs, birthtimeNs);
  };

  const openHandle = (entry: FakeEntry): ReadOnlyFileHandle => {
    let readCount = 0;
    return {
      stat: async () => {
        calls.push('handle.stat');
        if (entry.handleStatThrows !== undefined) throw entry.handleStatThrows;
        return statOf(entry, true);
      },
      read: async (buffer, offset, length, position) => {
        reads.push({ offset, length, position, bufferLength: buffer.length });
        const call = readCount;
        readCount += 1;
        readStarted.add(entry);
        if (entry.readThrowsAt !== undefined && entry.readThrowsAt.call === call) throw entry.readThrowsAt.error;
        const bytes = entry.bytes ?? new Uint8Array(0);
        const start = position ?? 0;
        const available = Math.max(0, bytes.length - start);
        const count = Math.min(length, available, entry.chunk ?? Number.MAX_SAFE_INTEGER);
        buffer.set(bytes.subarray(start, start + count), offset);
        delivered += count;
        return count;
      },
      close: async () => {
        closed += 1;
        if (entry.closeThrows !== undefined) throw entry.closeThrows;
      },
    };
  };

  return {
    reads,
    calls,
    delivered: () => delivered,
    opened: () => opened,
    closed: () => closed,
    realpath: async (path) => {
      calls.push(`realpath:${path}`);
      const thrown = options.realpathThrows?.[path];
      if (thrown !== undefined) throw thrown;
      const target = options.links?.[path] ?? path;
      lookup(target);
      return target;
    },
    stat: async (path) => {
      calls.push(`stat:${path}`);
      const thrown = options.statThrows?.[path];
      if (thrown !== undefined) throw thrown;
      return statOf(lookup(path), false);
    },
    openForRead: async (path) => {
      calls.push(`open:${path}`);
      const thrown = options.openThrows?.[path];
      if (thrown !== undefined) throw thrown;
      const entry = lookup(path);
      if (entry.kind === 'dir') throw errno('EISDIR');
      opened += 1;
      return openHandle(entry);
    },
  };
}

export const bytesOf = (...values: number[]): Uint8Array => Uint8Array.from(values);
export const filled = (length: number, value = 0x61): Uint8Array => new Uint8Array(length).fill(value);
