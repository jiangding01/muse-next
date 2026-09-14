/**
 * JCX 字节 → 文本解码（M1.4 T2，§4.3 检测策略）。
 *
 * 检测顺序（不可交换，见 §4.3 注）：
 *
 * 1. UTF-8 BOM（EF BB BF）→ 判定 UTF-8，`hasBom: true`，BOM **不剥离**。
 * 2. UTF-16 BOM（FF FE / FE FF）→ 语料与文档均无证据支持，判定为不支持，
 *    抛出 `JcxEncodingError`（§4.3 第 1 条）。
 * 3. 纯 ASCII → 等价于 UTF-8，直接判定 UTF-8。
 * 4. 严格 UTF-8 校验（fatal，不允许替换字符）→ 判定 UTF-8。
 * 5. 否则判定 GB18030（全覆盖编码，作为兜底，必须放在最后）。
 *
 * 只使用全局 `TextDecoder`（浏览器与 Node 均可用），不 import `node:util`。
 */

import type { DecodedJcx, JcxEncoding } from './types';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16LE_BOM = [0xff, 0xfe] as const;
const UTF16BE_BOM = [0xfe, 0xff] as const;

export interface JcxEncodingError extends Error {
  readonly name: 'JcxEncodingError';
}

/**
 * 工厂函数（不用 class）创建 `name === 'JcxEncodingError'` 的 Error。
 */
export function createJcxEncodingError(message: string): JcxEncodingError {
  const error = new Error(message) as JcxEncodingError;
  Object.defineProperty(error, 'name', {
    value: 'JcxEncodingError',
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return error;
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) {
    return false;
  }

  return prefix.every((value, index) => bytes[index] === value);
}

function isPureAscii(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) {
    if ((bytes[index] ?? 0) > 0x7f) {
      return false;
    }
  }

  return true;
}

function decodeWith(
  bytes: Uint8Array,
  encoding: string,
  fatal: boolean,
): string {
  const decoder = new TextDecoder(encoding, { fatal, ignoreBOM: true });
  return decoder.decode(bytes);
}

/**
 * 解码 JCX 文件字节为文本，同时返回检测到的编码与 BOM 状态。
 */
export function decodeJcx(bytes: Uint8Array): DecodedJcx {
  // 1. UTF-8 BOM
  if (hasPrefix(bytes, UTF8_BOM)) {
    return {
      text: decodeWith(bytes, 'utf-8', true),
      encoding: 'utf-8',
      hasBom: true,
    };
  }

  // 2. UTF-16 BOM —— 判定为不支持，报错退出（§4.3 第 1 条）。
  if (hasPrefix(bytes, UTF16LE_BOM)) {
    throw createJcxEncodingError(
      'Unsupported JCX encoding: UTF-16 LE BOM detected. JCX does not support UTF-16 (see spec §4.3).',
    );
  }

  if (hasPrefix(bytes, UTF16BE_BOM)) {
    throw createJcxEncodingError(
      'Unsupported JCX encoding: UTF-16 BE BOM detected. JCX does not support UTF-16 (see spec §4.3).',
    );
  }

  // 3. 纯 ASCII —— 等价于 UTF-8。
  if (isPureAscii(bytes)) {
    return {
      text: decodeWith(bytes, 'utf-8', true),
      encoding: 'utf-8' satisfies JcxEncoding,
      hasBom: false,
    };
  }

  // 4. 严格 UTF-8 校验（fatal: true，禁止替换字符）。
  try {
    return {
      text: decodeWith(bytes, 'utf-8', true),
      encoding: 'utf-8',
      hasBom: false,
    };
  } catch {
    // 继续尝试 GB18030 兜底。
  }

  // 5. GB18030 兜底（全覆盖编码，不会解码失败）。
  try {
    return {
      text: decodeWith(bytes, 'gb18030', true),
      encoding: 'gb18030',
      hasBom: false,
    };
  } catch (error) {
    throw createJcxEncodingError(
      [
        'Unable to decode JCX file.',
        'Tried UTF-8 and GB18030.',
        '',
        error instanceof Error ? error.message : String(error),
      ].join('\n'),
    );
  }
}
