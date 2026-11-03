/**
 * M3 T4 B1：保存错误码与 errno 归类（`saveErrors.ts`，Gate A R15）。
 */

import { describe, expect, it } from 'vitest';

import type { SaveErrorCode } from '../../../src/shared/saveContracts';
import { mapLinkError, mapRenameError, mapVerifyError, mapWriteError, saveError } from '../../../src/main/document/saveErrors';
import { errno } from './fakeWriteFileSystem';

const ALL_CODES: readonly SaveErrorCode[] = [
  'capability-invalid',
  'document-mismatch',
  'encoding-mismatch',
  'request-timeout',
  'unsafe-overwrite-refused',
  'encoding-verification-failed',
  'unencodable-character',
  'file-modified-on-disk',
  'permission-denied',
  'disk-full',
  'not-found',
  'target-busy',
  'same-file-encoding-change-refused',
  'file-too-large',
  'not-a-regular-file',
  'busy',
  'identity-unknown',
  'write-failed',
  'atomic-create-unsupported',
  'source-mismatch',
];

describe('saveError', () => {
  it('终表 20 个错误码各有一条互不相同的固定说明；不含路径分隔、不含 external', () => {
    const messages = ALL_CODES.map((code) => saveError(code).message);
    expect(new Set(messages).size).toBe(ALL_CODES.length);
    for (const message of messages) {
      expect(message).not.toMatch(/[\\/]|external/i);
      expect(message.length).toBeGreaterThan(10);
    }
  });
});

describe('errno 归类', () => {
  it.each([
    ['ENOSPC', 'disk-full'],
    ['EDQUOT', 'disk-full'],
    ['EFBIG', 'disk-full'],
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['EROFS', 'permission-denied'],
    ['ENOENT', 'not-found'],
    ['EIO', 'write-failed'],
  ])('写阶段 %s → %s', (code, expected) => {
    expect(mapWriteError(errno(code))).toBe(expected);
  });

  it('非 errno 异常 → write-failed', () => {
    expect(mapWriteError(new Error('x'))).toBe('write-failed');
    expect(mapWriteError('x')).toBe('write-failed');
  });

  it('rename：Windows 的 EBUSY / EPERM / EACCES 为目标被占用；POSIX 的 EACCES 为权限不足', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES']) expect(mapRenameError(errno(code), 'win32')).toBe('target-busy');
    expect(mapRenameError(errno('EACCES'), 'darwin')).toBe('permission-denied');
    expect(mapRenameError(errno('EBUSY'), 'linux')).toBe('target-busy');
  });

  it('link：EEXIST 为外部抢先创建；POSIX EPERM 为权限不足、Windows EPERM 与其它不支持一律 fail closed', () => {
    expect(mapLinkError(errno('EEXIST'), 'darwin')).toBe('file-modified-on-disk');
    expect(mapLinkError(errno('ENOENT'), 'darwin')).toBe('not-found');
    expect(mapLinkError(errno('ENOSPC'), 'darwin')).toBe('disk-full');
    expect(mapLinkError(errno('EACCES'), 'darwin')).toBe('permission-denied');
    // r1 ERRATA §3.2：POSIX EPERM → permission-denied；Windows EPERM 含义 UNVERIFIED → 不支持（fail closed）。
    expect(mapLinkError(errno('EPERM'), 'linux')).toBe('permission-denied');
    expect(mapLinkError(errno('EPERM'), 'win32')).toBe('atomic-create-unsupported');
    for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EMLINK', 'EWHATEVER']) {
      expect(mapLinkError(errno(code), 'darwin'), code).toBe('atomic-create-unsupported');
    }
    expect(mapLinkError(new Error('x'), 'darwin')).toBe('atomic-create-unsupported');
  });

  it('最终核验：文件消失 / 变成目录为外部修改；权限为 permission-denied', () => {
    expect(mapVerifyError(errno('ENOENT'))).toBe('file-modified-on-disk');
    expect(mapVerifyError(errno('EISDIR'))).toBe('file-modified-on-disk');
    expect(mapVerifyError(errno('EACCES'))).toBe('permission-denied');
    expect(mapVerifyError(errno('EIO'))).toBe('write-failed');
  });
});
