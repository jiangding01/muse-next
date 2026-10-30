/**
 * 保存阶段的错误码与固定说明（`docs/M3_EDITOR_CORE_PLAN.md` §13.4、§14，M3 T4 B1；Gate A R15）。
 *
 * - 只看异常上的 errno 字符串（复用 `errnoCodeOf`），不读 message，也不把原始错误文本或路径带出 main。
 * - 读取阶段（Open）的映射在 `fsErrors.ts`，返回类型是 `OpenFileErrorCode`，这里不复用它的表：
 *   写盘阶段的语义不同（如 `ENOSPC` 是磁盘已满、Windows 上 rename 的 `EBUSY` 是目标被占用）。
 * - Windows 上 rename / link 的 errno 含义未经本机实测（UNVERIFIED），按 fail closed 归类，由 Windows CI 冻结。
 */

import type { SaveError, SaveErrorCode } from '../../shared/saveContracts';
import { errnoCodeOf } from './fsErrors';

/** 每个错误码一条固定英文说明（与 Open 的说明风格一致）；不含路径。 */
const SAVE_ERROR_MESSAGES: Readonly<Record<SaveErrorCode, string>> = {
  'capability-invalid': 'The file permission for this document is no longer valid. Use Save As.',
  'document-mismatch': 'The save request does not belong to the current document.',
  'encoding-mismatch': 'The requested encoding does not match the document.',
  'request-timeout': 'The save request timed out.',
  'unsafe-overwrite-refused': 'This file cannot be saved in place without changing its bytes. Use Save As (UTF-8) to another file.',
  'encoding-verification-failed': 'The text cannot be written in this encoding without changing it. Use Save As (UTF-8) to another file.',
  'unencodable-character': 'The text contains a character that cannot be encoded.',
  'file-modified-on-disk': 'The file was changed on disk after it was opened. Use Save As or reopen the file.',
  'permission-denied': 'Permission denied while saving the file.',
  'disk-full': 'There is not enough disk space to save the file.',
  'not-found': 'The file or its folder no longer exists. Use Save As.',
  'target-busy': 'The file is in use by another program.',
  'same-file-encoding-change-refused': 'The encoding of the current file cannot be changed in place. Save As to another file.',
  'file-too-large': 'The document is larger than the maximum supported size.',
  'not-a-regular-file': 'The target is not a regular file.',
  busy: 'Another file operation is in progress.',
  'identity-unknown': 'The file identity could not be confirmed, so the save was refused.',
  'write-failed': 'The file could not be written.',
  'atomic-create-unsupported': 'This location does not support creating a file safely. Save to another location.',
  'source-mismatch': 'The current file state could not be confirmed. Try again.',
};

export function saveError(code: SaveErrorCode): SaveError {
  return { code, message: SAVE_ERROR_MESSAGES[code] };
}

const DISK_FULL = new Set(['ENOSPC', 'EDQUOT', 'EFBIG']);

/** 写临时文件、复制权限位、目录操作等通用写阶段的 errno 归类。 */
export function mapWriteError(error: unknown): SaveErrorCode {
  const errno = errnoCodeOf(error);
  if (errno === null) return 'write-failed';
  if (DISK_FULL.has(errno)) return 'disk-full';
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') return 'permission-denied';
  if (errno === 'ENOENT' || errno === 'ENOTDIR') return 'not-found';
  return 'write-failed';
}

/** 已存在目标的 `rename(temp, realpath)` 失败。Windows 上目标被占用时报 `EBUSY` / `EPERM` / `EACCES`。 */
export function mapRenameError(error: unknown, platform: string): SaveErrorCode {
  const errno = errnoCodeOf(error);
  if (platform === 'win32' && (errno === 'EBUSY' || errno === 'EPERM' || errno === 'EACCES')) return 'target-busy';
  if (errno === 'EBUSY') return 'target-busy';
  return mapWriteError(error);
}

/**
 * 初始不存在目标的 `link(temp, target)` 失败（r1 ERRATA §3.2）。`EEXIST` = 目标在保存前已被创建；
 * 其余（`ENOTSUP`、`EOPNOTSUPP`、`ENOSYS`、`EXDEV`、`EMLINK` 等文件系统不支持硬链接的情形，及未知错误）一律
 * `atomic-create-unsupported`（fail closed，绝不回退 rename）。
 * `EPERM` 按 §3.2 表：POSIX 为 `permission-denied`；Windows 含义可能是权限或不支持（UNVERIFIED），fail closed 为不支持。
 * Linux 上 `EPERM` 也可能表示文件系统不支持硬链接（vfat / exFAT），属 UNVERIFIED，待 Linux 实测后由设计方裁决。
 */
export function mapLinkError(error: unknown, platform: string): SaveErrorCode {
  const errno = errnoCodeOf(error);
  if (errno === 'EEXIST') return 'file-modified-on-disk';
  if (errno === 'ENOENT' || errno === 'ENOTDIR') return 'not-found';
  if (errno !== null && DISK_FULL.has(errno)) return 'disk-full';
  if (errno === 'EACCES' || errno === 'EROFS') return 'permission-denied';
  if (errno === 'EPERM') return platform === 'win32' ? 'atomic-create-unsupported' : 'permission-denied';
  return 'atomic-create-unsupported';
}

/** 提交前最终核验（C2）或提前指纹读取中的 fs 异常：外部变化一律 `file-modified-on-disk`（R13）。 */
export function mapVerifyError(error: unknown): SaveErrorCode {
  const errno = errnoCodeOf(error);
  if (errno === 'EACCES' || errno === 'EPERM') return 'permission-denied';
  if (errno === 'ENOENT' || errno === 'ENOTDIR' || errno === 'EISDIR') return 'file-modified-on-disk';
  return 'write-failed';
}
