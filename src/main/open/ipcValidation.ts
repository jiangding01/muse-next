/**
 * Open IPC 的 sender 与 payload 校验：纯函数（`docs/M3_EDITOR_CORE_PLAN.md` §13，M3 T1b-1，用户裁决 6）。
 *
 * - **不接触 Electron 对象**：T1b-2 的接线在 handler 的同步段（第一个 `await` 之前）把 `event.sender` /
 *   `event.senderFrame` 转换成 `SenderSnapshot`，再交给这里判定。await 之后不得再读 `senderFrame`（导航后为 null），
 *   异步结束后改由协调器的 generation 判断请求是否过期。
 * - **页面身份精确匹配，不做前缀判定**：`PageIdentity` 由 main 在启动时按当前运行模式（开发服务器 / 打包文件 /
 *   smoke 测试页）构造一次；比较的是解析后的 URL 组成部分，而不是字符串前缀。生产代码里没有任何测试白名单。
 * - 拒绝时只给出 `false` / `null`，不携带原始异常或 payload 内容；调用方以通用错误拒绝 invoke，且不改任何状态。
 */

import type { DocumentActivationTicket, OpenDocumentRequest } from '../../shared/activationContracts';
import type { RequestSaveTargetRequest, SaveAsDocumentRequest, SaveDocumentRequest } from '../../shared/saveContracts';

/** handler 同步段从 Electron 事件提取的可信快照。 */
export interface SenderSnapshot {
  /** `event.sender.id`（reload 后不变，用作 owner）。 */
  readonly webContentsId: number;
  /** `event.sender.isDestroyed()`。 */
  readonly destroyed: boolean;
  /** `BrowserWindow.fromWebContents(event.sender)` 是否就是 main 登记的应用窗口。 */
  readonly isRegisteredWindow: boolean;
  /** `event.senderFrame !== null && event.senderFrame === event.sender.mainFrame`。 */
  readonly isMainFrame: boolean;
  /** `event.senderFrame?.url ?? null`。 */
  readonly frameUrl: string | null;
}

/**
 * 应用页面身份：
 * - `dev-server`：Vite 开发服务器的 origin（协议 + 主机 + 端口完全一致），路径只允许 `/` 或 `/index.html`；
 * - `file`：打包后（或 smoke 测试页）的入口文件 URL，协议、主机与路径完全一致。
 * 两种身份都不允许非空 query；hash 被忽略（单页应用不使用 hash 路由，且 hash 不影响页面来源）。
 * `dev-server` 的 `origin` 必须是纯 origin（不含路径、query、hash），否则视为配置错误一律拒绝。
 */
export type PageIdentity =
  | { readonly kind: 'dev-server'; readonly origin: string }
  | { readonly kind: 'file'; readonly url: string };

export type SenderVerdict = { readonly ok: true; readonly ownerId: number } | { readonly ok: false };

const DEV_PATHS: ReadonlySet<string> = new Set(['/', '/index.html']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** 页面 URL 是否精确属于应用页面身份。 */
export function matchesPageIdentity(frameUrl: string, identity: PageIdentity): boolean {
  const actual = parseUrl(frameUrl);
  if (actual === null || actual.search !== '' || actual.username !== '' || actual.password !== '') return false;
  if (identity.kind === 'dev-server') {
    const expected = parseUrl(identity.origin);
    if (expected === null || (expected.protocol !== 'http:' && expected.protocol !== 'https:')) return false;
    if (expected.origin !== identity.origin) return false;
    return actual.protocol === expected.protocol && actual.host === expected.host && DEV_PATHS.has(actual.pathname);
  }
  const expected = parseUrl(identity.url);
  if (expected === null || expected.protocol !== 'file:') return false;
  return actual.protocol === 'file:' && actual.host === expected.host && actual.pathname === expected.pathname;
}

/** sender 是否是应用窗口主 frame 上的应用页面；通过时给出 owner（webContents id）。 */
export function validateSender(snapshot: SenderSnapshot, identity: PageIdentity): SenderVerdict {
  if (snapshot.destroyed || !snapshot.isRegisteredWindow || !snapshot.isMainFrame || snapshot.frameUrl === null) return { ok: false };
  if (!Number.isSafeInteger(snapshot.webContentsId) || snapshot.webContentsId < 0) return { ok: false };
  if (!matchesPageIdentity(snapshot.frameUrl, identity)) return { ok: false };
  return { ok: true, ownerId: snapshot.webContentsId };
}

/**
 * 普通对象且全部自有键（含不可枚举键与 Symbol 键）恰为 `keys`。结构化克隆后的 IPC payload 都是普通对象；
 * 这里仍按不可信输入处理：键集合用 `Reflect.ownKeys` 取全集。
 */
function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => own.includes(key));
}

/** 解析不可信 payload：取值过程中的任何异常（如 getter 抛错）都视为非法输入，不向外传播。 */
function safely<T>(parse: () => T | null): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

/** `open-document` 的输入：恰为 `{ intent: 'dialog' }`。 */
export function parseOpenRequest(payload: unknown): OpenDocumentRequest | null {
  return safely(() => (hasExactKeys(payload, ['intent']) && payload.intent === 'dialog' ? { intent: 'dialog' } : null));
}

/** 能力 id 的形状上限：main 签发的不透明串（UUID）只含字母、数字与连字符。 */
const CAPABILITY_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

/**
 * `activate-document` / `reject-document` 的输入：恰为 `{ capabilityId, documentId }`。M3 T4 Gate A R9：`documentId ≥ 0`——
 * 从 demo（documentId 0）Save As 得到的候选沿用 0。
 */
export function parseActivationTicket(payload: unknown): DocumentActivationTicket | null {
  return safely(() => {
    if (!hasExactKeys(payload, ['capabilityId', 'documentId'])) return null;
    const { capabilityId, documentId } = payload;
    if (typeof capabilityId !== 'string' || !CAPABILITY_ID_PATTERN.test(capabilityId)) return null;
    if (typeof documentId !== 'number' || !Number.isSafeInteger(documentId) || documentId < 0) return null;
    return { capabilityId, documentId };
  });
}

const ENCODINGS: ReadonlySet<unknown> = new Set(['utf-8', 'gb18030']);
/** 建议文件名的形状上限；清洗（basename、控制字符、长度）在 main 的对话框接线中完成（Q-B2-9）。 */
const MAX_SUGGESTED_NAME_LENGTH = 1024;
/**
 * `source` 的形状上限（UTF-16 码元）。每个码元编码后至少 1 字节，超过读写上限（1 MiB）的文本由保存管线报
 * `file-too-large`；这里只拒绝远超上限、显然非法的载荷，避免无界的编码开销。
 */
export const MAX_SAVE_SOURCE_LENGTH = 4 * 1_048_576;

const isToken = (value: unknown): value is string => typeof value === 'string' && CAPABILITY_ID_PATTERN.test(value);
const isSourceToken = (value: unknown): value is string | null => value === null || isToken(value);
const isEncoding = (value: unknown): value is SaveDocumentRequest['encoding'] => ENCODINGS.has(value);
const isDocumentId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** `request-save-target`（Save As 阶段 1）的输入：恰为 `{ suggestedName, encoding, sourceCapabilityId }`（r1.2 ERRATA §3）。 */
export function parseRequestSaveTarget(payload: unknown): RequestSaveTargetRequest | null {
  return safely(() => {
    if (!hasExactKeys(payload, ['suggestedName', 'encoding', 'sourceCapabilityId'])) return null;
    const { suggestedName, encoding, sourceCapabilityId } = payload;
    if (typeof suggestedName !== 'string' || suggestedName.length > MAX_SUGGESTED_NAME_LENGTH) return null;
    if (!isEncoding(encoding) || !isSourceToken(sourceCapabilityId)) return null;
    return { suggestedName, encoding, sourceCapabilityId };
  });
}

export type ParsedSaveDocument =
  | { readonly kind: 'save'; readonly request: SaveDocumentRequest }
  | { readonly kind: 'saveAs'; readonly request: SaveAsDocumentRequest };

/**
 * `save-document` 的输入：分支只由键集合决定（Q-B2-11）——恰为 `{ capabilityId, documentId, source, encoding }` 是普通 Save；
 * 另加 `sourceCapabilityId` 是 Save As 阶段 2。其它键集合（含多余键、缺键）一律非法。
 */
export function parseSaveDocument(payload: unknown): ParsedSaveDocument | null {
  return safely(() => {
    const saveAs = hasExactKeys(payload, ['capabilityId', 'documentId', 'source', 'encoding', 'sourceCapabilityId']);
    if (!saveAs && !hasExactKeys(payload, ['capabilityId', 'documentId', 'source', 'encoding'])) return null;
    const { capabilityId, documentId, source, encoding } = payload;
    if (!isToken(capabilityId) || !isDocumentId(documentId) || !isEncoding(encoding)) return null;
    if (typeof source !== 'string' || source.length > MAX_SAVE_SOURCE_LENGTH) return null;
    const request: SaveDocumentRequest = { capabilityId, documentId, source, encoding };
    if (!saveAs) return { kind: 'save', request };
    const { sourceCapabilityId } = payload;
    if (!isSourceToken(sourceCapabilityId)) return null;
    return { kind: 'saveAs', request: { ...request, sourceCapabilityId } };
  });
}
