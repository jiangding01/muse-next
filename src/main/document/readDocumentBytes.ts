/**
 * 有界读取文档原始字节（`docs/M3_EDITOR_CORE_PLAN.md` §11.2「大小上限」、§13.3，用户裁决 D5 / D7）。
 *
 * 顺序（不可交换）：
 *
 * 1. `realpath(requestedPath)`：之后所有操作都针对真实路径。
 * 2. `stat(realpath)`：非普通文件 → `not-a-regular-file`（必须在 open 之前判定，避免 open FIFO / 设备阻塞）；
 *    size > limit → `file-too-large`。—— 第一道上限防护。
 * 3. `openForRead(realpath)` 后 `handle.stat()`：同样的类型 / 上限判定（第二道），并与第 2 步的路径 stat
 *    核对是否描述同一文件、同一版本（`describesSameSnapshot`）；不一致说明 stat 与 open 之间路径被替换
 *    （rename 原子替换、换成 symlink 等）→ `read-failed`。
 * 4. 固定 `limit + 1` 字节缓冲有界循环读取，读到 EOF 或读满缓冲为止；总量 > limit → `file-too-large`。
 *    stat 报告的 size 不可信（procfs、并发追加等），这里是最终防线。—— 第三道。
 * 5. 读后复核：再次 `handle.stat()`，要求与读前句柄 stat 是同一快照且 size 等于实际读到的字节数；再次
 *    `realpath(requestedPath)` + `stat`，要求路径仍解析到同一真实路径、同一快照。任一不一致 → `read-failed`。
 *
 * 一致性复核只能**检测**变化，不等于原子快照：时间戳精度内的同尺寸原地改写、被回拨的时间戳、Windows 下
 * 共享写打开的并发修改，都可能漏检。这是已记录的残余竞态边界；真正防止静默覆盖的兜底是 T4 普通 Save 写盘前
 * 重新读取磁盘字节比较指纹（§12.3 `file-modified-on-disk`）。
 *
 * 禁止无界 `readFile()` 后再检查长度：那样超大文件会先被整体读进内存。
 * 句柄在 `finally` 中关闭；close 失败不覆盖已得出的结论。
 */

import type { OpenFileErrorCode } from '../../shared/openContracts';
import type { FileStat, ReadOnlyFileHandle, ReadOnlyFileSystem } from './fileSystemPort';
import { mapFsError } from './fsErrors';

/** 原始字节上限：1 MiB（D5）。作用于文件字节，不是解码后的字符数。 */
export const MAX_DOCUMENT_BYTES = 1_048_576;

export type ReadDocumentBytesResult =
  | { readonly ok: true; readonly realpath: string; readonly bytes: Uint8Array; readonly handleStat: FileStat }
  | { readonly ok: false; readonly code: OpenFileErrorCode };

const fail = (code: OpenFileErrorCode): ReadDocumentBytesResult => ({ ok: false, code });

/** 两次 stat 共用的判定：先判文件类型，再判大小。 */
function statRejection(stat: FileStat, limit: number): OpenFileErrorCode | null {
  if (!stat.isFile()) return 'not-a-regular-file';
  if (stat.size > BigInt(limit)) return 'file-too-large';
  return null;
}

/**
 * 两次 stat 是否描述同一文件的同一版本（读取一致性复核，不是 sameFile 身份判定）。
 *
 * - (dev, ino)：两边都非 0 时必须相等。这里比较的是同一时刻附近对同一路径 / 句柄的两次查询，Windows 上
 *   Node 由同一文件 ID 给出，用于检测「被换成另一个文件」是可靠的；它仍**不**作为 sameFile 的身份依据（D4）。
 * - size、mtimeNs、ctimeNs、birthtimeNs 必须全部相等：rename 原子替换会换 ino / birthtime，原地改写会换
 *   mtime / ctime / size。
 */
function describesSameSnapshot(a: FileStat, b: FileStat): boolean {
  const identityKnown = a.dev !== 0n && a.ino !== 0n && b.dev !== 0n && b.ino !== 0n;
  if (identityKnown && (a.dev !== b.dev || a.ino !== b.ino)) return false;
  return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.birthtimeNs === b.birthtimeNs;
}

async function closeQuietly(handle: ReadOnlyFileHandle): Promise<void> {
  try {
    await handle.close();
  } catch {
    // close 失败不改变已得出的读取结论（只读句柄，没有待刷新的写入）。
  }
}

/**
 * 有界循环读取：缓冲区固定 `limit + 1` 字节，position 显式递增；返回实际读到的总字节数。
 * port 返回越界 / 非整数的 bytesRead 视为读取失败（不信任实现）。
 */
async function readBounded(handle: ReadOnlyFileHandle, buffer: Uint8Array): Promise<number | null> {
  let total = 0;
  while (total < buffer.length) {
    const remaining = buffer.length - total;
    const bytesRead = await handle.read(buffer, total, remaining, total);
    if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > remaining) return null;
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total;
}

/** 读后复核路径：仍解析到同一真实路径、同一快照。查询失败（文件已被删除等）同样视为无法确认。 */
async function pathStillMatches(fs: ReadOnlyFileSystem, requestedPath: string, resolved: string, expected: FileStat): Promise<boolean> {
  try {
    if ((await fs.realpath(requestedPath)) !== resolved) return false;
    return describesSameSnapshot(await fs.stat(resolved), expected);
  } catch {
    return false;
  }
}

interface ReadTarget {
  readonly fs: ReadOnlyFileSystem;
  readonly requestedPath: string;
  readonly resolved: string;
  readonly pathStat: FileStat;
  readonly limit: number;
}

async function readFromHandle(handle: ReadOnlyFileHandle, target: ReadTarget): Promise<ReadDocumentBytesResult> {
  const handleStat = await handle.stat();
  const rejection = statRejection(handleStat, target.limit);
  if (rejection !== null) return fail(rejection);
  if (!describesSameSnapshot(target.pathStat, handleStat)) return fail('read-failed');

  const buffer = new Uint8Array(target.limit + 1);
  const total = await readBounded(handle, buffer);
  if (total === null) return fail('read-failed');
  if (total > target.limit) return fail('file-too-large');

  const afterStat = await handle.stat();
  if (!describesSameSnapshot(handleStat, afterStat) || afterStat.size !== BigInt(total)) return fail('read-failed');
  if (!(await pathStillMatches(target.fs, target.requestedPath, target.resolved, afterStat))) return fail('read-failed');

  // slice 产生独立拷贝：返回的 bytes 长度恰为实际内容，与缓冲区不共享内存。
  return { ok: true, realpath: target.resolved, bytes: buffer.slice(0, total), handleStat };
}

export async function readDocumentBytes(
  fs: ReadOnlyFileSystem,
  requestedPath: string,
  limit: number = MAX_DOCUMENT_BYTES,
): Promise<ReadDocumentBytesResult> {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError('readDocumentBytes: limit must be a non-negative safe integer');
  }

  let resolved: string;
  let pathStat: FileStat;
  try {
    resolved = await fs.realpath(requestedPath);
    pathStat = await fs.stat(resolved);
  } catch (error) {
    return fail(mapFsError(error));
  }
  const rejection = statRejection(pathStat, limit);
  if (rejection !== null) return fail(rejection);

  let handle: ReadOnlyFileHandle;
  try {
    handle = await fs.openForRead(resolved);
  } catch (error) {
    return fail(mapFsError(error));
  }

  try {
    return await readFromHandle(handle, { fs, requestedPath, resolved, pathStat, limit });
  } catch (error) {
    return fail(mapFsError(error));
  } finally {
    await closeQuietly(handle);
  }
}
