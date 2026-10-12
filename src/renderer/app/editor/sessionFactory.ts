/**
 * Renderer 会话工厂（M3 T1c-2，T1c Preflight r2 §6.1–§6.2；纯逻辑）。
 *
 * - 会话一律经 T0 的 `createDocumentSession` 建立，再把**同一次** `loadJcx` 的结果经 `acceptParsedSnapshot` 接入，
 *   因此 `parsed.load` 与 session 的 `(documentId, sourceVersion)` 恒一致；本模块不复制、不改写 T0 合同。
 * - Exact Source：main 交来的 `source` 原样进入会话与解析——不 trim、不改换行、不剥开头 U+FEFF；`byteBom`、`writeEncoding`、
 *   `encodingRoundTrip`、`file` 原样取自 `DecodedDocument`，不由文本推断；`loadJcx` 显式传入 `sourceEncoding`（方案 §7.1）。
 * - `displayPath` 只用于展示；授权只来自 `file.capability` 与 `documentId`，二者只出现在会话与激活票据里。
 * - 候选只是数据：准备成功不代表任何状态变化，是否提交由 Open 状态机在收到明确的激活成功后决定。
 * 不依赖 React / DOM / Electron / 定时器。
 */

import { createDocumentSession } from '../../../editor/session/create';
import type { DocumentSessionInit } from '../../../editor/session/create';
import { acceptParsedSnapshot } from '../../../editor/session/reducer';
import type { DocumentSession } from '../../../editor/session/types';
import { loadJcx } from '../../../formats/jcxParse';
import type { DocumentActivationTicket } from '../../../shared/activationContracts';
import type { DecodedDocument } from '../../../shared/openContracts';

/** 启动 demo 的 documentId（T1 preflight 裁决 D2）；main 分配的 documentId 从 1 开始。 */
export const DEMO_DOCUMENT_ID = 0;

export const DEMO_SOURCE = `%MUSE2
T: Muse Next Demo
C: Clean-room TypeScript scaffold
M: 4/4
L: 1/8
Q: 1/4=96
K: G
%%showfinger yes
%%gchord G=1;3(3),2(2),0,0,0,3(4)
%%gchord C=1;X,3(3),2(2),0,1(1),0
%%gchord D=1;X,X,0,2(1),3(3),2(2)
V:1 name="Guitar" style=tab play=1 instrument=24 volumn=64
V:2 name="Melody" style=jianpu play=1 instrument=0 volumn=64
[V:1]
"G"fxcx/bx/fx/ax/bx/cx/ | "C"excx/bx/ex/ax/bx/cx/ | "D"dxcx/bx/dx/ax/bx/cx/ |
[V:2]
G2 A2 B2 d2 | c2 B2 A2 G2 |
`;

/** 建立会话并接入同一次解析的快照；接入失败说明会话不变量被破坏，属内部错误，直接抛出。 */
function parsedSession(init: DocumentSessionInit): DocumentSession {
  const session = createDocumentSession(init);
  const load = loadJcx(session.source, { sourceEncoding: session.writeEncoding });
  const accepted = acceptParsedSnapshot(session, { documentId: session.documentId, sourceVersion: session.sourceVersion, load });
  if (!accepted.ok) throw new Error(`sessionFactory: parsed snapshot rejected (${accepted.reason})`);
  return accepted.session;
}

/** 启动 demo（方案 §7.2 启动行）：documentId 0、无文件、UTF-8、无字节 BOM、往返 exact。 */
export function createDemoSession(): DocumentSession {
  return parsedSession({ documentId: DEMO_DOCUMENT_ID, source: DEMO_SOURCE, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

export interface PreparedCandidate {
  readonly session: DocumentSession;
  readonly ticket: DocumentActivationTicket;
}

export type PrepareFailureReason = 'invalid-document' | 'session-failed';

export type PrepareResult =
  | { readonly ok: true; readonly candidate: PreparedCandidate }
  | { readonly ok: false; readonly reason: PrepareFailureReason; readonly ticket: DocumentActivationTicket | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** 能拿到合法票据时给出票据（准备失败也要凭它通知 main 丢弃候选）。 */
function ticketOf(value: unknown): DocumentActivationTicket | null {
  if (!isRecord(value) || !isRecord(value.file) || !isRecord(value.file.capability)) return null;
  const { documentId } = value;
  const capabilityId = value.file.capability.id;
  if (typeof documentId !== 'number' || !Number.isSafeInteger(documentId) || documentId < 1) return null;
  if (typeof capabilityId !== 'string' || capabilityId === '') return null;
  return { capabilityId, documentId };
}

/** main 回复的文档形状校验（结构化克隆后的数据仍按不可信输入处理）。 */
function isDecodedDocument(value: unknown): value is DecodedDocument {
  if (!isRecord(value) || ticketOf(value) === null || !isRecord(value.file)) return false;
  return (
    typeof value.source === 'string' &&
    (value.writeEncoding === 'utf-8' || value.writeEncoding === 'gb18030') &&
    (value.byteBom === 'utf8' || value.byteBom === 'none') &&
    (value.encodingRoundTrip === 'exact' || value.encodingRoundTrip === 'unsafe') &&
    typeof value.file.displayName === 'string' &&
    typeof value.file.displayPath === 'string'
  );
}

/** 由 `opened` 回复准备候选会话：只做数据准备，不改变任何状态。 */
export function prepareCandidate(value: unknown): PrepareResult {
  const ticket = ticketOf(value);
  if (!isDecodedDocument(value) || ticket === null) return { ok: false, reason: 'invalid-document', ticket };
  try {
    const session = parsedSession({
      documentId: value.documentId,
      source: value.source,
      writeEncoding: value.writeEncoding,
      byteBom: value.byteBom,
      encodingRoundTrip: value.encodingRoundTrip,
      file: { capability: { id: value.file.capability.id }, displayName: value.file.displayName, displayPath: value.file.displayPath },
    });
    return { ok: true, candidate: { session, ticket } };
  } catch {
    return { ok: false, reason: 'session-failed', ticket };
  }
}
