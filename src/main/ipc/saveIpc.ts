/**
 * 保存 IPC 的执行体（M3 T4 B2；r1 ERRATA §2 / §5，r1.2 ERRATA §2.1 R19，B2 r0 §3、r0.1 勘误 §2 / §3，Gate B2 F1 / F2）。
 *
 * 由 `registerOpenIpc` 在同一闭包中调用 `registerSaveIpc`；状态、窗口登记、鉴权与对话框所有权（写入只在 `registerOpenIpc.ts`）
 * 都只经 `SaveIpcContext` 读写。**本模块不 import electron**。
 * - **鉴权与载荷校验**在同步段完成（Open 的 `authenticate` + 两个解析函数）；失败抛出 `Request rejected`，不改任何状态。
 * - **物理对话框所有权先于逻辑锁**（F1）：该窗口实例的原生对话框（Open 或 Save As）尚未 settle 时，Save As 与普通 Save
 *   都回复 `busy`——即使 reload（A4 / A5）已经清掉了旧的逻辑锁。对话框 settle 之后才释放物理所有权。
 * - **保存逻辑锁**：协调器的操作票据（不可复用 id + generation）；每个请求只在 `finally` 中以 CAS 释放自己的票据。
 *   旧回调（reload / 窗口销毁 / 实例替换之后才返回）既不登记 save-target，也不会释放新操作的锁。
 * - **三态以提交事实为准**（勘误 §3）：交给 B1 管线的写 port 包装了仅有的两个提交原语（`renameSync` / `linkSync`），
 *   原语成功返回的同一同步帧内记录 `crossed`；三态只取决于它，与异常在哪里被捕获无关。A9 一次赋值；回复构造有兜底。
 */

import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { ActiveOpenRecord, TombstoneRecord } from '../document/capabilities';
import type { ReadOnlyFileSystem } from '../document/fileSystemPort';
import { saveError } from '../document/saveErrors';
import { runSavePipeline } from '../document/savePipeline';
import type { SaveFileFacts, SavePipelineResult, SaveRequest, SaveTargetGrant, WrittenFacts } from '../document/savePipeline';
import { compareWithAnchor, resolveCurrentFile, resolveTarget } from '../document/saveTargetResolve';
import type { WriteFileSystem } from '../document/writeFileSystemPort';
import { parseRequestSaveTarget, parseSaveDocument } from '../open/ipcValidation';
import type { ParsedSaveDocument } from '../open/ipcValidation';
import type { OpenCoordinatorState, SaveOperation } from '../open/openCoordinator';
import {
  beginSave,
  beginSaveTarget,
  consumeSaveTarget,
  discardSaveTarget,
  grantSaveTarget,
  holdsSaveOperation,
  releaseSaveOperation,
  SAVE_TARGET_TTL_MS,
  saveAsStillCurrent,
  saveStillCurrent,
  settleSave,
} from '../open/saveCoordinator';
import type { InvokeEventLike, IpcRegistrarLike, SenderLike } from './registerOpenIpc';
import { sanitizeSuggestedName } from './wireOpenIpcWindow';
import type { DocumentActivationTicket } from '../../shared/activationContracts';
import { IPC } from '../../shared/ipc';
import type { RequestSaveTargetReply, RequestSaveTargetRequest, SaveDocumentReply, SaveErrorCode } from '../../shared/saveContracts';

/** 保存诊断事件（不含路径）。 */
export type SaveIpcEvent = 'temp-cleanup-failed' | 'directory-sync-failed' | 'commit-state-mismatch' | 'settle-failed' | 'reply-failed';

/** 保存需要的注入依赖；`OpenIpcDeps` 继承它（与 Open 共用读 port、时钟、token、定时器）。 */
export interface SaveIpcDeps {
  readonly fs: ReadOnlyFileSystem;
  /** M3 T4：写 port（生产为唯一的 Node 写实现，只由 main.ts 构造）。 */
  readonly writeFs: WriteFileSystem;
  readonly platform: string;
  /** M3 T4：同目录临时文件名（生产为随机 UUID）。 */
  tempName(): string;
  now(): number;
  issueToken(): string;
  schedule(delayMs: number, task: () => void): void;
  /** M3 T4：保存诊断（不含路径）；缺省忽略。 */
  logSave?(event: SaveIpcEvent): void;
}

/** `registerOpenIpc` 闭包中保存需要的部分。 */
export interface SaveIpcContext<S extends SenderLike, W> {
  readonly deps: SaveIpcDeps & { readonly ipc: IpcRegistrarLike<S> };
  /** Open 的同步鉴权：通过时给出 owner 与登记的窗口实例，失败抛出 `Request rejected`。 */
  authenticate(event: InvokeEventLike<S>): { readonly ownerId: number; readonly window: W };
  getState(): OpenCoordinatorState;
  setState(next: OpenCoordinatorState): void;
  /** 该窗口实例是否有尚未 settle 的原生对话框（Open 或 Save As）。 */
  hasNativeDialog(window: W): boolean;
  /** 在该窗口实例上弹出原生保存对话框并持有物理所有权，直到它 settle；取消返回 null，异常原样抛出。 */
  chooseSavePath(ownerId: number, window: W, defaultPath: string): Promise<string | null>;
  isCurrentWindow(ownerId: number, window: W): boolean;
  /** 清理过期的 pending 候选与 save-target（TTL 定时器的任务）。 */
  expire(): void;
}

export interface SaveIpcHandlers<W> {
  requestSaveTarget(ownerId: number, window: W, request: RequestSaveTargetRequest): Promise<RequestSaveTargetReply>;
  saveDocument(ownerId: number, window: W, parsed: ParsedSaveDocument): Promise<SaveDocumentReply>;
}

/** 提交事实（勘误 §3.1）：只能由 `false` 单向变为 `true`。 */
interface CommitFact {
  crossed: boolean;
}

/** 包装写 port 的两个提交原语：成功返回后同一同步帧内置位；抛出时不置位。其余方法原样委托。 */
export function trackCommits(fs: WriteFileSystem, fact: CommitFact): WriteFileSystem {
  return {
    ...fs,
    renameSync: (from, to) => {
      fs.renameSync(from, to);
      fact.crossed = true;
    },
    linkSync: (existing, created) => {
      fs.linkSync(existing, created);
      fact.crossed = true;
    },
  };
}

const factsOf = (record: ActiveOpenRecord | TombstoneRecord): SaveFileFacts => ({
  realpath: record.realpath,
  identity: record.identity,
  writeEncoding: record.writeEncoding,
  encodingRoundTrip: record.encodingRoundTrip,
  lastKnownDiskFingerprint: record.lastKnownDiskFingerprint,
});

const refused = (code: SaveErrorCode): RequestSaveTargetReply => ({ kind: 'refused', error: saveError(code) });
const notCommitted = (code: SaveErrorCode): SaveDocumentReply => ({ outcome: 'not-committed', error: saveError(code) });

/** 一次保存请求在管线之后需要的事实。 */
interface Prepared {
  readonly operation: SaveOperation;
  readonly request: SaveRequest;
  readonly stillCurrent: () => boolean;
  /** 写入的是锚点文件时要刷新的记录 token（Save As 只在 `sameAsAnchor` 时）。 */
  readonly refreshToken: (result: Extract<SavePipelineResult, { written: WrittenFacts }>) => string | null;
  readonly candidate: { readonly documentId: number; readonly requestSeq: number } | null;
  readonly displayName: string;
  readonly displayPath: string;
}

export function createSaveIpcHandlers<S extends SenderLike, W>(ctx: SaveIpcContext<S, W>): SaveIpcHandlers<W> {
  const { deps } = ctx;

  // releaseSaveOperation 是纯函数（CAS），不会抛出。
  const release = (ownerId: number, operation: SaveOperation): void => ctx.setState(releaseSaveOperation(ctx.getState(), ownerId, operation));

  const log = (event: SaveIpcEvent): void => {
    try {
      deps.logSave?.(event);
    } catch {} // 诊断失败不影响结果
  };

  // 只做清理（消费与激活都按 expiresAt fail closed）；调度失败也不改变已提交的状态与回复。
  const scheduleExpiry = (delayMs: number): void => {
    try {
      deps.schedule(delayMs, () => {
        try {
          ctx.expire();
        } catch {} // 时钟异常时不清理
      });
    } catch {} // 调度失败：记录保留到 TTL 之后的下一次清理或 Open
  };

  async function requestSaveTarget(ownerId: number, window: W, request: RequestSaveTargetRequest): Promise<RequestSaveTargetReply> {
    // F1：物理所有权先于逻辑锁——旧对话框未 settle 时不进入协调器。
    if (ctx.hasNativeDialog(window)) return refused('busy');
    const begun = beginSaveTarget(ctx.getState(), ownerId, request.sourceCapabilityId);
    ctx.setState(begun.state);
    if (!begun.result.ok) return refused(begun.result.code);
    const { operation, anchor, anchorFacts } = begun.result;
    try {
      const name = sanitizeSuggestedName(request.suggestedName);
      const defaultPath = anchorFacts === null ? name : join(dirname(anchorFacts.realpath), name);
      let chosen: string | null;
      try {
        chosen = await ctx.chooseSavePath(ownerId, window, defaultPath);
      } catch {
        chosen = null;
      }
      // 发起请求的窗口实例已不再登记，或逻辑锁已被 reload / 新操作取代：旧回调不得登记任何能力。
      if (!ctx.isCurrentWindow(ownerId, window) || !holdsSaveOperation(ctx.getState(), ownerId, operation)) return refused('capability-invalid');
      if (chosen === null || !isAbsolute(chosen)) return { kind: 'canceled' };

      const target = await resolveTarget(deps.fs, deps.writeFs, chosen, deps.platform);
      if (target.kind === 'unknown') return refused('identity-unknown');
      if (target.kind === 'occupied') return refused('not-a-regular-file');
      if (target.kind === 'parent-missing') return refused('not-found');
      let sameAsCurrent = false;
      if (anchorFacts !== null) {
        const current = await resolveCurrentFile(deps.fs, anchorFacts.realpath, deps.platform);
        const same = compareWithAnchor(current, factsOf(anchorFacts), target);
        // M37：unknown 不得当作「不是同一文件」。
        if (same === 'unknown') return refused('identity-unknown');
        sameAsCurrent = same === 'same';
      }
      const grant: SaveTargetGrant =
        target.kind === 'existing'
          ? { kind: 'existing', realpath: target.realpath, identity: target.identity, size: target.size, mtimeNs: target.mtimeNs }
          : { kind: 'absent', parentRealpath: target.parentRealpath, basename: target.basename };
      const displayPath = resolve(chosen);
      const token = deps.issueToken();
      // F2：登记之前在最新状态上重新验证票据、R19 与锚点（grantSaveTarget 内）。
      if (!ctx.isCurrentWindow(ownerId, window)) return refused('capability-invalid'); // 与 Open 对称：fs await 之后复查实例
      const granted = grantSaveTarget(
        ctx.getState(),
        ownerId,
        operation,
        { token, sourceCapabilityId: request.sourceCapabilityId, anchorAtBegin: anchor, encoding: request.encoding, target: grant, requestedPath: chosen, displayName: basename(displayPath), displayPath },
        deps.now(),
      );
      ctx.setState(granted.state);
      if (!granted.result.ok) return refused(granted.result.code);
      scheduleExpiry(SAVE_TARGET_TTL_MS);
      return { kind: 'granted', capabilityId: token, displayName: basename(displayPath), displayPath, sameAsCurrent };
    } catch {
      return refused('capability-invalid');
    } finally {
      release(ownerId, operation);
    }
  }

  /** 授权（同步）：成功时持有保存逻辑锁，并给出管线请求与之后的 A9 所需事实。 */
  function prepare(ownerId: number, parsed: ParsedSaveDocument): Prepared | { readonly refused: SaveErrorCode } {
    const { request } = parsed;
    if (parsed.kind === 'save') {
      const begun = beginSave(ctx.getState(), ownerId, { capabilityId: request.capabilityId, documentId: request.documentId, encoding: request.encoding });
      ctx.setState(begun.state);
      if (!begun.result.ok) return { refused: begun.result.code };
      const { record, operation } = begun.result;
      return {
        operation,
        request: { kind: 'save', current: factsOf(record), source: request.source, encoding: request.encoding },
        stillCurrent: () => saveStillCurrent(ctx.getState(), ownerId, operation, record.token),
        refreshToken: () => record.token,
        candidate: null,
        displayName: record.displayName,
        displayPath: record.displayPath,
      };
    }
    const consumed = consumeSaveTarget(ctx.getState(), ownerId, parsed.request, deps.now());
    ctx.setState(consumed.state);
    if (!consumed.result.ok) return { refused: consumed.result.code };
    const { target, operation, anchor, anchorFacts, requestSeq } = consumed.result;
    return {
      operation,
      request: {
        kind: 'saveAs',
        requestedPath: target.requestedPath,
        granted: target.target,
        anchor: anchorFacts === null ? null : factsOf(anchorFacts),
        source: request.source,
        encoding: request.encoding,
      },
      stillCurrent: () => saveAsStillCurrent(ctx.getState(), ownerId, operation, anchor),
      refreshToken: (result) => (result.sameAsAnchor && anchorFacts !== null ? anchorFacts.token : null),
      candidate: { documentId: target.boundDocumentId, requestSeq },
      displayName: target.displayName,
      displayPath: target.displayPath,
    };
  }

  /** 已越过提交点：A9（一次赋值）+ 回复。任何异常都只会把结果降为 `committed-unconfirmed`，绝不报为未提交。 */
  function settleCommitted(ownerId: number, prepared: Prepared, result: SavePipelineResult | null): SaveDocumentReply {
    if (result === null || result.outcome === 'not-committed') {
      // 矛盾：原语已成功返回，管线却报告未提交（或 reject）。拿不到 WrittenFacts，不刷新；锚点保持旧指纹，下次 fail closed。
      log('commit-state-mismatch');
      const { displayName, displayPath } = prepared;
      // 编码事实未知：报 unsafe / 无 BOM（保守值）；committed-unconfirmed 下 renderer 不得据此提交会话切换。
      return { outcome: 'committed-unconfirmed', writeEncoding: prepared.request.encoding, byteBom: 'none', encodingRoundTrip: 'unsafe', displayName, displayPath, ticket: null };
    }
    const written = result.written;
    let outcome: 'saved' | 'committed-unconfirmed' = result.outcome === 'saved' && prepared.stillCurrent() ? 'saved' : 'committed-unconfirmed';
    let ticket: DocumentActivationTicket | null = null;
    try {
      const candidate =
        outcome === 'saved' && prepared.candidate !== null
          ? { token: deps.issueToken(), documentId: prepared.candidate.documentId, requestSeq: prepared.candidate.requestSeq, displayName: prepared.displayName, displayPath: prepared.displayPath }
          : null;
      const next = settleSave(ctx.getState(), ownerId, { operation: prepared.operation, written, refreshToken: prepared.refreshToken(result), candidate, now: deps.now() });
      ctx.setState(next);
      if (candidate !== null) {
        ticket = { capabilityId: candidate.token, documentId: candidate.documentId };
        scheduleExpiry(ctx.getState().ttlMs);
      }
    } catch {
      log('settle-failed');
      outcome = 'committed-unconfirmed';
      ticket = null;
    }
    // 回复只做字段拷贝（全函数）；万一抛出，由 saveDocument 的外层 catch 按「已提交」兜底。
    return {
      outcome,
      writeEncoding: written.writeEncoding,
      byteBom: written.byteBom,
      encodingRoundTrip: written.encodingRoundTrip,
      displayName: prepared.displayName,
      displayPath: prepared.displayPath,
      ticket,
    };
  }

  async function saveDocument(ownerId: number, window: W, parsed: ParsedSaveDocument): Promise<SaveDocumentReply> {
    // F1：该窗口实例的原生对话框尚未 settle（含 reload 前打开的 Save As 对话框）→ 普通 Save 同样 busy。
    // F2：任何业务拒绝之前先消费同 owner 的 save-target（两个分支都是：普通 Save 误用 save-target 也消费）。
    if (ctx.hasNativeDialog(window)) {
      ctx.setState(discardSaveTarget(ctx.getState(), ownerId, parsed.request.capabilityId));
      return notCommitted('busy');
    }
    let prepared: Prepared | { readonly refused: SaveErrorCode };
    try {
      prepared = prepare(ownerId, parsed);
    } catch {
      return notCommitted('write-failed'); // 授权阶段的意外异常（如时钟非有限）：尚未写盘，状态未提交任何变更
    }
    if ('refused' in prepared) return notCommitted(prepared.refused);
    const fact: CommitFact = { crossed: false };
    try {
      let result: SavePipelineResult | null;
      try {
        result = await runSavePipeline(
          {
            readFs: deps.fs,
            writeFs: trackCommits(deps.writeFs, fact),
            platform: deps.platform,
            tempName: () => deps.tempName(),
            stillCurrent: () => prepared.stillCurrent(),
            log: (event) => log(event),
          },
          prepared.request,
        );
      } catch {
        result = null;
      }
      if (!fact.crossed) {
        if (result !== null && result.outcome !== 'not-committed') log('commit-state-mismatch');
        return result !== null && result.outcome === 'not-committed' ? { outcome: 'not-committed', error: result.error } : notCommitted('write-failed');
      }
      return settleCommitted(ownerId, prepared, result);
    } catch {
      if (!fact.crossed) return notCommitted('write-failed');
      log('reply-failed');
      return settleCommitted(ownerId, prepared, null);
    } finally {
      release(ownerId, prepared.operation);
    }
  }

  return { requestSaveTarget, saveDocument };
}

/** 在 Open 的同一次注册中挂上两条保存通道（同步段鉴权 + 解析，失败抛出 `Request rejected`）。 */
export function registerSaveIpc<S extends SenderLike, W>(ctx: SaveIpcContext<S, W>): SaveIpcHandlers<W> {
  const handlers = createSaveIpcHandlers(ctx);
  ctx.deps.ipc.handle(IPC.requestSaveTarget, (event, payload) => {
    const { ownerId, window } = ctx.authenticate(event);
    const request = parseRequestSaveTarget(payload);
    if (request === null) throw new Error('Request rejected');
    return handlers.requestSaveTarget(ownerId, window, request);
  });
  ctx.deps.ipc.handle(IPC.saveDocument, (event, payload) => {
    const { ownerId, window } = ctx.authenticate(event);
    const parsed = parseSaveDocument(payload);
    if (parsed === null) throw new Error('Request rejected');
    return handlers.saveDocument(ownerId, window, parsed);
  });
  return handlers;
}
