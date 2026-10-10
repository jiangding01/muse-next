/**
 * 文件身份与同一文件判定（`docs/M3_EDITOR_CORE_PLAN.md` §13.2，用户裁决 D4）。
 *
 * `sameFile(a, b) = 同一 realpath 字符串 OR 同一 meaningful (dev, ino)`：
 *
 * - **不做任何人工大小写折叠**：realpath 由原生 realpath 给出，在大小写不敏感卷上已返回磁盘真实大小写，
 *   两个大小写别名的 realpath 本来就相等；自行 `toLowerCase()` 会在大小写敏感卷（Linux、APFS 区分大小写卷）上
 *   把两个不同文件误判为同一个，也无法正确处理 Unicode 大小写规则与卷的实际折叠规则。
 * - meaningful identity：只在 POSIX 且 dev、ino 都非 0 时使用（bigint 比较，不丢精度）；
 *   Windows（`platform === 'win32'`）不使用 Node 的 ino（不可靠），只用路径。
 * - **OR 而不是 AND**：原子替换会改变 ino 而路径不变；硬链接 / 符号链接使路径不同而 ino 相同。
 * - 无法确认身份（realpath / stat 失败）→ `'unknown'`，绝不当作 `'different'`。
 *
 * 调用方语义（T4 / T5）：sameFile 用于「同一文件即拒绝」的写盘保护（unsafe 防绕过、Normalize Copy 不覆盖已打开文件、
 * Save As 同文件识别），因此 `'unknown'` 必须 fail closed（按同一文件拒绝或报错）。每次写盘前实时重新 resolve，
 * 不缓存身份。T1a 只提供 helper，没有运行时调用方。
 */

import type { OpenFileErrorCode } from '../../shared/openContracts';
import type { FileStat, ReadOnlyFileSystem } from './fileSystemPort';
import { mapFsError } from './fsErrors';

export interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

export type ResolvedFile =
  | { readonly kind: 'resolved'; readonly realpath: string; readonly identity: FileIdentity | null }
  | { readonly kind: 'unresolved'; readonly code: OpenFileErrorCode };

export type SameFileResult = 'same' | 'different' | 'unknown';

/** stat 给出的 (dev, ino) 是否可作为身份依据；不可用时返回 null（调用方只用路径）。 */
export function meaningfulIdentity(stat: FileStat, platform: string): FileIdentity | null {
  if (platform === 'win32') return null;
  if (stat.dev === 0n || stat.ino === 0n) return null;
  return { dev: stat.dev, ino: stat.ino };
}

/** 实时 realpath + stat（不缓存）；任何失败都给出 unresolved，错误码映射与读取路径一致。 */
export async function resolveFile(fs: ReadOnlyFileSystem, path: string, platform: string): Promise<ResolvedFile> {
  try {
    const realpath = await fs.realpath(path);
    const stat = await fs.stat(realpath);
    return { kind: 'resolved', realpath, identity: meaningfulIdentity(stat, platform) };
  } catch (error) {
    return { kind: 'unresolved', code: mapFsError(error) };
  }
}

export function sameFile(a: ResolvedFile, b: ResolvedFile): SameFileResult {
  if (a.kind === 'unresolved' || b.kind === 'unresolved') return 'unknown';
  // 原样字符串严格相等，不折叠大小写、不做 Unicode 规范化。
  if (a.realpath === b.realpath) return 'same';
  if (a.identity !== null && b.identity !== null && a.identity.dev === b.identity.dev && a.identity.ino === b.identity.ino) {
    return 'same';
  }
  return 'different';
}
