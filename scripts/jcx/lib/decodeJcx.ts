/**
 * Re-export shim（M1.4 T2，D8）：真正实现已迁移到
 * `src/formats/jcx/encoding/decodeJcx.ts`。
 *
 * 与 src 版本的差异：src 的 `decodeJcx` **不剥离 BOM**（保留 `hasBom`
 * 供 preserve 模式写回），但 `scan-corpus.ts` / `classifyLine.ts` 是
 * 「BOM 已剥离」假设下写的旧行分类逻辑（例如 `%MUSE` magic header
 * 的 `^%MUSE\d*` 正则不认识前导 U+FEFF）。为保持 `jcx:scan` 输出
 * 不变，这里在 scanner 侧补一次 BOM 剥离，不让 src 的 decoder 剥离。
 */

import { decodeJcx as decodeJcxSrc } from '../../../src/formats/jcx/encoding/decodeJcx';

import type { DecodedJcxFile, JcxEncoding } from './types';

export function decodeJcx(bytes: Uint8Array): DecodedJcxFile {
  const decoded = decodeJcxSrc(bytes);

  const text = decoded.hasBom ? decoded.text.replace(/^\uFEFF/, '') : decoded.text;

  const encoding: JcxEncoding = decoded.encoding;

  return { text, encoding };
}
