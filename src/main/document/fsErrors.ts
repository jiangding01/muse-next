/**
 * fs 异常 → Open 读取错误码（`docs/M3_EDITOR_CORE_PLAN.md` §13.4，用户裁决 D7）。
 *
 * - 只看异常上的 errno 字符串 `code`（类型守卫取值，不用断言）；不读 message，也不把原始错误文本带出 main。
 * - 未列出的 errno（ELOOP、EIO、EMFILE、EBUSY……）与非 errno 异常一律 `read-failed`。
 */

import type { OpenFileErrorCode } from '../../shared/openContracts';

const ERRNO_TO_OPEN_CODE: ReadonlyMap<string, OpenFileErrorCode> = new Map([
  ['ENOENT', 'not-found'],
  ['ENOTDIR', 'not-found'],
  ['EACCES', 'permission-denied'],
  ['EPERM', 'permission-denied'],
  ['EISDIR', 'not-a-regular-file'],
]);

/** 取 Node fs 异常的 errno 字符串；不是带字符串 `code` 的对象时返回 null。 */
export function errnoCodeOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return null;
}

export function mapFsError(error: unknown): OpenFileErrorCode {
  const errno = errnoCodeOf(error);
  return (errno === null ? undefined : ERRNO_TO_OPEN_CODE.get(errno)) ?? 'read-failed';
}
