/**
 * 保存前的编码与自解码校验（`docs/M3_EDITOR_CORE_PLAN.md` §11.5–§11.7，M3 T4 B1）。
 *
 * 顺序：source 长度上限 → 孤立 surrogate 扫描 → `encodeJcx`（捕获异常）→ 字节上限 → 生产 `decodeJcx` 自解码，
 * **只比较文本**，任何异常都归为校验失败。全程纯计算、不触碰磁盘（管线中排在一切磁盘检查之前）。
 *
 * - 不按 `byteBom` 补 BOM：带 BOM 的文档 source 首字符就是 U+FEFF，`encodeJcx` 会把它编码为 `EF BB BF`（r0 探针 C1）。
 * - UTF-8 路径的 `TextEncoder` 会把孤立 surrogate 静默替换为 U+FFFD 而不抛错（r0 探针 C2），所以两种编码都先扫描，
 *   给出精确的 `unencodable-character`；自解码校验仍保留为最终兜底。
 * - 编码正确性只以 Electron 运行时结果为证据（§25.2）；普通 Node 下的测试只覆盖分支逻辑。
 */

import type { EncodingRoundTrip, ByteBom } from '../../shared/documentContracts';
import type { SaveErrorCode } from '../../shared/saveContracts';
import { decodeJcx, encodeJcx } from '../../formats/jcx/codec';
import type { JcxEncoding } from '../../formats/jcx/codec';
import { MAX_DOCUMENT_BYTES } from './readDocumentBytes';

export interface EncodedForSave {
  readonly bytes: Uint8Array;
  /** 由写入字节检测（Save As 时作为新的 `byteBom`）。 */
  readonly byteBom: ByteBom;
  /**
   * 写入字节的往返安全性：恒为 exact——写入字节就是 `encodeJcx(source)`，且自解码文本与 source 相等，
   * 所以「重新打开得到同一文本、再编码得到同一字节」成立（Save As 成功后会话改为 exact，§7.2）。
   */
  readonly encodingRoundTrip: EncodingRoundTrip;
}

export type EncodeForSaveResult = { readonly ok: true; readonly encoded: EncodedForSave } | { readonly ok: false; readonly code: SaveErrorCode };

/** 是否含孤立 surrogate（不成对的 U+D800–U+DFFF 码元）。 */
export function hasLoneSurrogate(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < text.length ? text.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
      return true;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function encodeForSave(source: string, encoding: JcxEncoding, limit: number = MAX_DOCUMENT_BYTES): EncodeForSaveResult {
  // 每个 UTF-16 码元至少编码为 1 个字节：码元数超过上限时字节必然超限，先拒绝，避免为巨大字符串分配编码缓冲。
  if (source.length > limit) return { ok: false, code: 'file-too-large' };
  if (hasLoneSurrogate(source)) return { ok: false, code: 'unencodable-character' };

  let bytes: Uint8Array;
  try {
    bytes = encodeJcx(source, encoding).bytes;
  } catch {
    return { ok: false, code: 'unencodable-character' };
  }
  if (bytes.length > limit) return { ok: false, code: 'file-too-large' };

  let decodedText: string;
  let hasBom: boolean;
  try {
    const decoded = decodeJcx(bytes);
    decodedText = decoded.text;
    hasBom = decoded.hasBom;
  } catch {
    return { ok: false, code: 'encoding-verification-failed' };
  }
  if (decodedText !== source) return { ok: false, code: 'encoding-verification-failed' };

  return {
    ok: true,
    encoded: { bytes, byteBom: hasBom ? 'utf8' : 'none', encodingRoundTrip: 'exact' },
  };
}
