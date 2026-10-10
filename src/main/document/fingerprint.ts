/**
 * 磁盘内容指纹（`docs/M3_EDITOR_CORE_PLAN.md` §12.3，M3 T1a）。
 *
 * Open 时对**被解码的同一份原始 bytes** 计算 SHA-256，作为能力上的 `lastKnownDiskFingerprint`；
 * T4 普通 Save 前重新读取磁盘字节比较，不只依赖 mtime / size。
 */

import { createHash } from 'node:crypto';

/** 小写十六进制 SHA-256（64 个字符）。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
