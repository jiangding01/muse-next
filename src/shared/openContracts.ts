/**
 * Open 通道的跨进程纯数据契约（`docs/M3_EDITOR_CORE_PLAN.md` §7.1、§11.2–§11.3、§13.4，M3 T1a）。
 *
 * - 只有类型，没有运行时逻辑；类型依赖只来自 shared 与 parse façade（shared 架构守卫）。
 * - 不含任何路径授权字段：读写授权只来自 `FileReference.capability`；`displayPath` 只是 main 生成的展示文本（§13）。
 * - `message` 由 main 固定生成，不透传原始 fs 错误文本或路径（§13.4）。
 */

import type { JcxEncoding } from '../formats/jcxParse';
import type { ByteBom, EncodingRoundTrip, FileReference } from './documentContracts';

/** 读取阶段（realpath / stat / open / 有界读取）的失败分类（§13.4「打开」）。 */
export type OpenFileErrorCode = 'not-found' | 'permission-denied' | 'not-a-regular-file' | 'file-too-large' | 'read-failed';

/** 字节解码失败（DecodeFailure，§11.3）的分类：只按原始字节前缀判定，与 `decodeJcx` 的失败分支一一对应。 */
export type DecodeFailureCode = 'decode-utf16-unsupported' | 'decode-invalid-utf8' | 'decode-invalid-gb18030';

export type OpenDocumentErrorCode = OpenFileErrorCode | DecodeFailureCode;

export interface OpenDocumentError {
  readonly code: OpenDocumentErrorCode;
  readonly message: string;
}

/**
 * Open 成功时 main 交给 renderer 的文档事实（§11.2 流程图末端）。
 *
 * - `source`：exact source，原样保留开头 U+FEFF（不剥离 BOM）。
 * - `writeEncoding`：取自 main 的解码结果（§11.6）。
 * - `byteBom`：只来自 main 对原始字节的检测，不由 source 首字符推断（§6.3）。
 * - `encodingRoundTrip`：main 在 Electron 运行时判定的字节往返安全性（§11.4），同时绑定在能力上。
 */
export interface DecodedDocument {
  readonly documentId: number;
  readonly source: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly file: FileReference;
}

export type OpenDocumentResult =
  | { readonly kind: 'canceled' }
  | { readonly kind: 'opened'; readonly document: DecodedDocument }
  | { readonly kind: 'failed'; readonly error: OpenDocumentError };
