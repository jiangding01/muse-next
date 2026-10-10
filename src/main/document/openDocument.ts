/**
 * Open 纯管线：路径 → DecodedDocument + pending 候选能力（`docs/M3_EDITOR_CORE_PLAN.md` §11.2–§11.4、§13.1，M3 T1a）。
 *
 * 顺序：有界读取 → 解码（含往返判定）→ 指纹 / 身份 / 展示文本 → 分配 documentId → 签发 token。
 *
 * - 读取或解码失败：返回 `failed`，**不分配 documentId、不签发 token**（D2：只在 Open 完整成功后分配）。
 * - 指纹与身份都取自同一次读取：指纹是被解码的同一份原始 bytes，身份来自打开句柄的 stat。
 * - 本函数**不修改任何能力表**：返回的能力记录是 `pending`，何时登记、激活、吊销由 T1b 的 IPC 层决定。
 * - 错误 `message` 由这里按错误码固定生成，不含原始 fs 错误文本或路径（§13.4）。
 * - 对话框取消（`canceled`）属于 IPC 层，不在本管线中出现。
 */

import { basename, resolve } from 'node:path';

import type { DecodedDocument, OpenDocumentError, OpenDocumentErrorCode } from '../../shared/openContracts';
import type { OpenCapabilityRecord } from './capabilities';
import { decodeDocumentBytes } from './decodeDocument';
import { sha256Hex } from './fingerprint';
import { meaningfulIdentity } from './fileIdentity';
import type { ReadOnlyFileSystem } from './fileSystemPort';
import { MAX_DOCUMENT_BYTES, readDocumentBytes } from './readDocumentBytes';

export interface OpenDocumentDeps {
  readonly fs: ReadOnlyFileSystem;
  /** 运行平台（生产传 `process.platform`）；决定是否使用 (dev, ino) 身份。 */
  readonly platform: string;
  /** 能力绑定的窗口标识。 */
  readonly ownerId: number;
  allocateDocumentId(): number;
  issueToken(): string;
  /** 原始字节上限，默认 `MAX_DOCUMENT_BYTES`（1 MiB）。 */
  readonly limit?: number;
}

export type OpenAtPathResult =
  | { readonly kind: 'opened'; readonly document: DecodedDocument; readonly capability: OpenCapabilityRecord }
  | { readonly kind: 'failed'; readonly error: OpenDocumentError };

/** 每个错误码一条固定英文说明（与现有英文 UI 一致）。 */
const OPEN_ERROR_MESSAGES: Readonly<Record<OpenDocumentErrorCode, string>> = {
  'not-found': 'The file could not be found.',
  'permission-denied': 'Permission denied while reading the file.',
  'not-a-regular-file': 'The selected item is not a regular file.',
  'file-too-large': 'The file is larger than the maximum supported document size.',
  'read-failed': 'The file could not be read.',
  'decode-utf16-unsupported': 'UTF-16 encoded files are not supported. Use UTF-8 or GB18030.',
  'decode-invalid-utf8': 'The file starts with a UTF-8 byte order mark but is not valid UTF-8.',
  'decode-invalid-gb18030': 'The file is neither valid UTF-8 nor valid GB18030.',
};

export function openDocumentError(code: OpenDocumentErrorCode): OpenDocumentError {
  return { code, message: OPEN_ERROR_MESSAGES[code] };
}

export async function openDocumentAtPath(deps: OpenDocumentDeps, requestedPath: string): Promise<OpenAtPathResult> {
  const read = await readDocumentBytes(deps.fs, requestedPath, deps.limit ?? MAX_DOCUMENT_BYTES);
  if (!read.ok) return { kind: 'failed', error: openDocumentError(read.code) };

  const decoded = decodeDocumentBytes(read.bytes);
  if (!decoded.ok) return { kind: 'failed', error: openDocumentError(decoded.code) };

  const lastKnownDiskFingerprint = sha256Hex(read.bytes);
  const identity = meaningfulIdentity(read.handleStat, deps.platform);
  // 展示文本：用户选择的路径（规范为绝对路径），不是 realpath；它只用于展示，不构成授权（§13）。
  const displayPath = resolve(requestedPath);
  const displayName = basename(displayPath);

  const documentId = deps.allocateDocumentId();
  const token = deps.issueToken();

  const capability: OpenCapabilityRecord = {
    token,
    ownerId: deps.ownerId,
    documentId,
    purpose: 'open',
    state: 'pending',
    realpath: read.realpath,
    displayName,
    displayPath,
    writeEncoding: decoded.writeEncoding,
    byteBom: decoded.byteBom,
    encodingRoundTrip: decoded.encodingRoundTrip,
    lastKnownDiskFingerprint,
    identity,
  };
  const document: DecodedDocument = {
    documentId,
    source: decoded.source,
    writeEncoding: decoded.writeEncoding,
    byteBom: decoded.byteBom,
    encodingRoundTrip: decoded.encodingRoundTrip,
    file: { capability: { id: token }, displayName, displayPath },
  };
  return { kind: 'opened', document, capability };
}
