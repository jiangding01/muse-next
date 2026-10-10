/**
 * 原始字节 → exact source 与编码事实（`docs/M3_EDITOR_CORE_PLAN.md` §6.3、§11.3、§11.4，M3 T1a）。
 *
 * - 解码只经生产 `decodeJcx`（codec 入口），不复制任何解码算法，不做有损 / 回退解码：
 *   无 BOM 的非法 UTF-8 由 `decodeJcx` 自己尝试 GB18030。
 * - `byteBom` 只来自 `decodeJcx` 的 `hasBom`，**绝不**由 source 首字符推断：GB18030 文件可以以 U+FEFF 开头
 *   （字节 `84 31 95 33`），但 `byteBom` 仍是 `'none'`（§6.3）。
 * - 往返判定 `encodingRoundTrip` 在 main 执行；生产环境是 Electron main，判定结果才是 seal 证据（§25.2）。
 */

import { decodeJcx, encodeJcx } from '../../formats/jcx/codec';
import type { JcxEncoding } from '../../formats/jcx/codec';
import type { ByteBom, EncodingRoundTrip } from '../../shared/documentContracts';
import type { DecodeFailureCode } from '../../shared/openContracts';

export type DecodeDocumentResult =
  | {
      readonly ok: true;
      readonly source: string;
      readonly writeEncoding: JcxEncoding;
      readonly byteBom: ByteBom;
      readonly encodingRoundTrip: EncodingRoundTrip;
    }
  | { readonly ok: false; readonly code: DecodeFailureCode };

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}

/**
 * 解码失败分类：**只按字节前缀**，不看异常的 message / name / instanceof。
 *
 * 与 `decodeJcx` 的分支一一对应（其检测顺序固定）：
 * - `EF BB BF` 开头 → 只走 UTF-8 BOM 分支，失败只可能是 fatal UTF-8 解码抛出的原生 TypeError → `decode-invalid-utf8`；
 * - 否则 `FF FE` / `FE FF` 开头 → 只走 UTF-16 BOM 分支，恒抛 `JcxEncodingError` → `decode-utf16-unsupported`；
 * - 否则：纯 ASCII 与合法 UTF-8 不会失败，唯一失败来源是最后的 GB18030 严格解码 → `decode-invalid-gb18030`。
 *
 * 不依赖异常形状的理由：UTF-8 BOM 分支抛的是未包装的原生 TypeError，而 `JcxEncodingError` 是 interface
 * （工厂造的普通 Error），无法 instanceof；按字节前缀分类对两者一视同仁，且不受 message 文案变化影响。
 */
export function classifyDecodeFailure(bytes: Uint8Array): DecodeFailureCode {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return 'decode-invalid-utf8';
  if (startsWith(bytes, [0xff, 0xfe]) || startsWith(bytes, [0xfe, 0xff])) return 'decode-utf16-unsupported';
  return 'decode-invalid-gb18030';
}

/**
 * 字节往返安全（§11.4）：`encodeJcx(source, encoding)`（默认 `'error'` 策略）的字节与原字节逐字节相等 → `'exact'`。
 * 编码抛出任何异常（如孤立 surrogate 无法编码为 GB18030）→ `'unsafe'`；这不是 DecodeFailure，文档仍可打开。
 */
export function classifyEncodingRoundTrip(source: string, encoding: JcxEncoding, originalBytes: Uint8Array): EncodingRoundTrip {
  let encoded: Uint8Array;
  try {
    encoded = encodeJcx(source, encoding).bytes;
  } catch {
    return 'unsafe';
  }
  if (encoded.length !== originalBytes.length) return 'unsafe';
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] !== originalBytes[index]) return 'unsafe';
  }
  return 'exact';
}

export function decodeDocumentBytes(bytes: Uint8Array): DecodeDocumentResult {
  let decoded: ReturnType<typeof decodeJcx>;
  try {
    decoded = decodeJcx(bytes);
  } catch {
    // 捕获任何异常（JcxEncodingError、原生 TypeError……），分类只看字节前缀。
    return { ok: false, code: classifyDecodeFailure(bytes) };
  }
  return {
    ok: true,
    // 原样保留：带 BOM 的 UTF-8 与以 U+FEFF 开头的 GB18030 文本首字符都是 U+FEFF。
    source: decoded.text,
    writeEncoding: decoded.encoding,
    byteBom: decoded.hasBom ? 'utf8' : 'none',
    encodingRoundTrip: classifyEncodingRoundTrip(decoded.text, decoded.encoding, bytes),
  };
}
