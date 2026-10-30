/**
 * 原子保存：临时文件 → 提交前同步临界区（C2）→ 提交（`docs/M3_EDITOR_CORE_PLAN.md` §12.3、§14，
 * r1 ERRATA §3 / §5 / §6、r1.1 §2，M3 T4 B1）。
 *
 * - 提交点：已存在目标 = `renameSync(temp, realpath)` 成功返回；初始不存在目标 = `linkSync(temp, target)` 成功返回。
 *   提交点之前目标零改动；未提交路径由调用方删除临时文件（`removeTemp`）。
 * - `commitExistingSync` / `commitAbsentSync` 是**同步函数**：从最后一次 `stillCurrent()` 复核、最终读盘核验到
 *   提交系统调用返回，之间不让出事件循环，导航 / 渲染进程事件与其它 IPC 都无法插入（`architecture.m3t4` W5 / W6）。
 * - 已存在目标的 C2 用**内容**判断外部修改：打开 → fstat → 有界读 → fstat → 路径与句柄同一文件 → SHA-256 比较；
 *   不以 stat / mtime 代替指纹（r1.1 H-6：原地改写可保持 dev / ino / size / mtimeNs 全部不变）。
 * - 初始不存在目标只用 `link` 发布：目标名已存在（任何类型）即 `EEXIST`；文件系统不支持即 fail closed，绝不回退 rename。
 * - 临时文件与目标同目录、随机名（不由目标文件名派生），`wx` 独占创建。
 */

import { basename, join } from 'node:path';

import type { SaveErrorCode } from '../../shared/saveContracts';
import { sha256Hex } from './fingerprint';
import type { FileIdentity } from './fileIdentity';
import { errnoCodeOf } from './fsErrors';
import { mapLinkError, mapRenameError, mapVerifyError, mapWriteError } from './saveErrors';
import type { ExclusiveFileHandle, WriteFileSystem, WriteStat } from './writeFileSystemPort';

export interface TempFile {
  readonly path: string;
  /** 临时文件句柄的 fstat：rename / link 不改变 inode，提交后即为目标的身份来源。 */
  readonly stat: WriteStat;
}

export type TempWriteResult =
  | { readonly ok: true; readonly temp: TempFile }
  | { readonly ok: false; readonly code: SaveErrorCode; readonly temp: string | null };

/** 没有可信 inode 时用作身份旁证的长度与修改时间。 */
export interface FileStamp {
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

export type CommitResult = { readonly committed: true; readonly tempUnlinked: boolean } | { readonly committed: false; readonly code: SaveErrorCode };

/** 新建文件的权限：交给 umask（与普通新建文件一致）。 */
const NEW_FILE_MODE = 0o666;
/** 覆盖已存在目标时先以私有权限创建，写完再复制原文件的权限位。 */
const PRIVATE_MODE = 0o600;
const TEMP_NAME_ATTEMPTS = 3;

/** 代次复核：回调抛出（例如窗口已销毁）一律视为已失效（fail closed）。 */
function isCurrent(options: { stillCurrent(): boolean }): boolean {
  try {
    return options.stillCurrent();
  } catch {
    return false;
  }
}

/** 写位：任一写权限位存在。Windows 只读属性在 Node 中表现为 mode 无写位。 */
export const hasWriteBit = (stat: WriteStat): boolean => (stat.mode & 0o222) !== 0;

export interface TempWriteOptions {
  readonly directory: string;
  readonly bytes: Uint8Array;
  /** 已存在目标的权限位（复制失败即保存失败，§14）；新建文件为 null。 */
  readonly copyMode: number | null;
  tempName(): string;
  /** 窗口 / 记录仍有效（C1）。每个 await 之后都复核，失效即中止。 */
  stillCurrent(): boolean;
}

/** 写临时文件：独占创建（同名已存在则换名重试有限次）→ 写全 → fsync → 复制权限位 → fstat → close（方案 §14 顺序）。 */
export async function writeTempFile(fs: WriteFileSystem, options: TempWriteOptions): Promise<TempWriteResult> {
  const mode = options.copyMode === null ? NEW_FILE_MODE : PRIVATE_MODE;
  let path = '';
  let opened: ExclusiveFileHandle | null = null;
  for (let attempt = 0; attempt < TEMP_NAME_ATTEMPTS && opened === null; attempt += 1) {
    const name = options.tempName();
    // 临时文件名必须是单纯的文件名：含路径分隔符或 `..` 会把临时文件建到目标目录之外。
    if (name === '' || name === '.' || name === '..' || basename(name) !== name) return { ok: false, code: 'write-failed', temp: null };
    path = join(options.directory, name);
    try {
      opened = await fs.openExclusive(path, mode);
    } catch (error) {
      const retry = errnoCodeOf(error) === 'EEXIST' && attempt < TEMP_NAME_ATTEMPTS - 1;
      if (!retry) return { ok: false, code: mapWriteError(error), temp: null };
    }
  }
  if (opened === null) return { ok: false, code: 'write-failed', temp: null };
  const handle = opened;
  const abort = async (code: SaveErrorCode): Promise<TempWriteResult> => {
    await closeQuietly(handle);
    return { ok: false, code, temp: path };
  };

  let stat: WriteStat;
  try {
    if (!isCurrent(options)) return await abort('capability-invalid');
    await handle.writeAll(options.bytes);
    if (!isCurrent(options)) return await abort('capability-invalid');
    await handle.sync();
    if (options.copyMode !== null) await handle.chmod(options.copyMode);
    stat = await handle.stat();
    if (!isCurrent(options)) return await abort('capability-invalid');
  } catch (error) {
    return abort(mapWriteError(error));
  }
  try {
    await handle.close();
  } catch (error) {
    return { ok: false, code: mapWriteError(error), temp: path };
  }
  if (!isCurrent(options)) return { ok: false, code: 'capability-invalid', temp: path };
  return { ok: true, temp: { path, stat } };
}

async function closeQuietly(handle: { close(): Promise<void> }): Promise<void> {
  try {
    await handle.close();
  } catch {
    // 关闭失败不改变结论；临时文件由调用方删除。
  }
}

/** 未提交路径删除临时文件；失败只报告（由调用方记录），不改变「未提交」结论。 */
export async function removeTemp(fs: WriteFileSystem, path: string): Promise<boolean> {
  try {
    await fs.removeFile(path);
    return true;
  } catch {
    return false;
  }
}

export interface CommitExistingOptions {
  readonly temp: TempFile;
  /** 写入对象：已存在目标的实时 realpath。 */
  readonly realpath: string;
  /** 普通 Save 与同文件 Save As：必须等于磁盘当前内容的指纹；Save As 到其它已存在文件为 null（§12.3 不比指纹）。 */
  readonly expectedFingerprint: string | null;
  /** 不比指纹时，目标必须仍是解析时的那个文件：POSIX 用 dev / ino。 */
  readonly expectedIdentity: FileIdentity | null;
  /** 无可信 inode（Windows）时的限制性规则：size 与 mtimeNs 必须不变（R19，UNVERIFIED）。 */
  readonly expectedStamp: FileStamp | null;
  readonly platform: string;
  readonly limit: number;
  stillCurrent(): boolean;
}

/**
 * 已存在目标的提交前同步临界区（C2）与提交。任何复核不通过都返回未提交，目标零改动。
 * 本函数体内不得出现 await（`architecture.m3t4` W5）。
 */
export function commitExistingSync(fs: WriteFileSystem, options: CommitExistingOptions): CommitResult {
  if (!isCurrent(options)) return { committed: false, code: 'capability-invalid' };
  const rejection = options.expectedFingerprint === null ? verifyIdentitySync(fs, options) : verifyContentSync(fs, options, options.expectedFingerprint);
  if (rejection !== null) return { committed: false, code: rejection };
  try {
    fs.renameSync(options.temp.path, options.realpath);
  } catch (error) {
    return { committed: false, code: mapRenameError(error, options.platform) };
  }
  return { committed: true, tempUnlinked: true };
}

/** 最终读盘核验：同一个打开的句柄上 fstat → 有界读 → fstat；路径仍指向该句柄的文件；内容指纹相等。 */
function verifyContentSync(fs: WriteFileSystem, options: CommitExistingOptions, expected: string): SaveErrorCode | null {
  let fd: number | null = null;
  try {
    // 先确认路径仍是普通文件再打开：同步打开 FIFO 等特殊文件会阻塞主进程。
    if (!fs.statSync(options.realpath).isFile()) return 'file-modified-on-disk';
    fd = fs.openReadSync(options.realpath);
    const before = fs.fstatSync(fd);
    if (!before.isFile()) return 'file-modified-on-disk';
    if (!hasWriteBit(before)) return 'permission-denied';
    if (before.size > BigInt(options.limit)) return 'file-modified-on-disk';
    const buffer = new Uint8Array(options.limit + 1);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, total, buffer.length - total, total);
      if (read === 0) break;
      total += read;
      if (total > options.limit) return 'file-modified-on-disk';
    }
    const after = fs.fstatSync(fd);
    // 读到的字节数必须等于读取前与读取后的文件长度（r1.1 §2.3）：读完之后的追加 / 截断不会改变已读字节的指纹。
    if (BigInt(total) !== before.size || after.size !== before.size) return 'file-modified-on-disk';
    if (!pathStillDescribesHandle(fs, options.realpath, after, options.platform)) return 'file-modified-on-disk';
    if (sha256Hex(buffer.subarray(0, total)) !== expected) return 'file-modified-on-disk';
    return null;
  } catch (error) {
    return mapVerifyError(error);
  } finally {
    if (fd !== null) closeSyncQuietly(fs, fd);
  }
}

/** 不比指纹的已存在目标（Save As 到其它文件）：只确认路径仍是解析时的那个普通、可写文件。 */
function verifyIdentitySync(fs: WriteFileSystem, options: CommitExistingOptions): SaveErrorCode | null {
  try {
    const now = fs.statSync(options.realpath);
    if (!now.isFile()) return 'file-modified-on-disk';
    if (!hasWriteBit(now)) return 'permission-denied';
    if (options.expectedIdentity !== null) {
      if (now.dev !== options.expectedIdentity.dev || now.ino !== options.expectedIdentity.ino) return 'file-modified-on-disk';
    } else if (options.expectedStamp === null || now.size !== options.expectedStamp.size || now.mtimeNs !== options.expectedStamp.mtimeNs) {
      return 'file-modified-on-disk';
    }
    if (fs.realpathSync(options.realpath) !== options.realpath) return 'file-modified-on-disk';
    return null;
  } catch (error) {
    return mapVerifyError(error);
  }
}

/**
 * 路径当前指向的是否仍是被读的那个文件，且路径本身仍是 realpath（没有被换成符号链接——否则 rename 会替换链接本身）。
 * POSIX：dev / ino 相等；Windows 不用 ino（D4）：size 与 mtimeNs 相等。
 */
function pathStillDescribesHandle(fs: WriteFileSystem, realpath: string, handleStat: WriteStat, platform: string): boolean {
  const atPath = fs.statSync(realpath);
  if (fs.realpathSync(realpath) !== realpath) return false;
  if (platform !== 'win32' && handleStat.dev !== 0n && handleStat.ino !== 0n) {
    return atPath.dev === handleStat.dev && atPath.ino === handleStat.ino;
  }
  return atPath.size === handleStat.size && atPath.mtimeNs === handleStat.mtimeNs;
}

function closeSyncQuietly(fs: WriteFileSystem, fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {
    // 只读句柄关闭失败不影响结论。
  }
}

export interface CommitAbsentOptions {
  readonly temp: TempFile;
  /** 合成的目标路径（父目录 realpath + basename）。 */
  readonly target: string;
  readonly platform: string;
  stillCurrent(): boolean;
}

/**
 * 初始不存在目标的同步提交（r1 ERRATA §3）：`link` 是唯一的发布原语，`EEXIST` 即拒绝，不支持即 fail closed。
 * 提交后删除临时文件名；删除失败不改变「已提交」结论（`tempUnlinked: false`，残留的是同一 inode 的另一个名字）。
 * 本函数体内不得出现 await，也不得调用 `renameSync`（`architecture.m3t4` W5 / W6）。
 */
export function commitAbsentSync(fs: WriteFileSystem, options: CommitAbsentOptions): CommitResult {
  if (!isCurrent(options)) return { committed: false, code: 'capability-invalid' };
  try {
    fs.linkSync(options.temp.path, options.target);
  } catch (error) {
    return { committed: false, code: mapLinkError(error, options.platform) };
  }
  try {
    fs.unlinkSync(options.temp.path);
    return { committed: true, tempUnlinked: true };
  } catch {
    return { committed: true, tempUnlinked: false };
  }
}
