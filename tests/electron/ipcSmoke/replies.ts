/**
 * 页面返回值的结构校验（M3 T1b-2b-1）。`executeJavaScript` 的结果是不可信的 `unknown`：这里逐字段检查后才构造类型化对象，
 * 不使用类型断言。只校验 smoke 断言用到的字段。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 页面里 `(async () => …)()` 包装后的结果：正常值或页面侧抛出的错误文本。 */
export type PageResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };

export function parsePageResult(value: unknown): PageResult {
  if (isRecord(value) && value.ok === true) return { ok: true, value: value.value };
  if (isRecord(value) && value.ok === false && typeof value.error === 'string') return { ok: false, error: value.error };
  return { ok: false, error: `malformed page result: ${JSON.stringify(value) ?? String(value)}` };
}

export interface Ticket {
  readonly capabilityId: string;
  readonly documentId: number;
}

export type OpenReply =
  | {
      readonly kind: 'opened';
      readonly ticket: Ticket;
      readonly source: string;
      readonly writeEncoding: string;
      readonly displayName: string;
      readonly displayPath: string;
    }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'failed'; readonly code: string; readonly message: string }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'invalid'; readonly raw: string };

function invalid(value: unknown): OpenReply {
  return { kind: 'invalid', raw: JSON.stringify(value) ?? String(value) };
}

export function parseOpenReply(value: unknown): OpenReply {
  if (!isRecord(value)) return invalid(value);
  if (value.kind === 'canceled') return { kind: 'canceled' };
  if (value.kind === 'rejected' && typeof value.reason === 'string') return { kind: 'rejected', reason: value.reason };
  if (value.kind === 'failed' && isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string') {
    return { kind: 'failed', code: value.error.code, message: value.error.message };
  }
  if (value.kind !== 'opened' || !isRecord(value.document)) return invalid(value);
  const document = value.document;
  const file = document.file;
  if (!isRecord(file) || !isRecord(file.capability)) return invalid(value);
  const { documentId, source, writeEncoding } = document;
  const id = file.capability.id;
  if (typeof documentId !== 'number' || typeof source !== 'string' || typeof writeEncoding !== 'string' || typeof id !== 'string') return invalid(value);
  if (typeof file.displayName !== 'string' || typeof file.displayPath !== 'string') return invalid(value);
  return {
    kind: 'opened',
    ticket: { capabilityId: id, documentId },
    source,
    writeEncoding,
    displayName: file.displayName,
    displayPath: file.displayPath,
  };
}

export type ActivationReply = { readonly ok: true } | { readonly ok: false; readonly code: string } | { readonly invalid: string };

export function parseActivationReply(value: unknown): ActivationReply {
  if (isRecord(value) && value.ok === true && Object.keys(value).length === 1) return { ok: true };
  if (isRecord(value) && value.ok === false && typeof value.code === 'string') return { ok: false, code: value.code };
  return { invalid: JSON.stringify(value) ?? String(value) };
}

/** 一句话描述（写进用例 detail）。 */
export function describeOpen(reply: OpenReply): string {
  switch (reply.kind) {
    case 'opened':
      return `opened#${String(reply.ticket.documentId)}`;
    case 'failed':
      return `failed:${reply.code}`;
    case 'rejected':
      return `rejected:${reply.reason}`;
    case 'canceled':
      return 'canceled';
    case 'invalid':
      return `invalid:${reply.raw}`;
  }
}
