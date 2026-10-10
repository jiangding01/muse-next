/**
 * Open IPC 接线（M3 T1b-2a，`docs/M3_EDITOR_CORE_PLAN.md` §13；T1b preflight 裁决 1–10，T1b-2 preflight 裁决 1–8）。
 *
 * 注册 `muse:open-document` / `muse:activate-document` / `muse:reject-document` 三个 handler，持有进程内唯一的协调器状态、
 * documentId 分配器与 TTL 清理定时器。**本模块不 import electron**：`ipcMain`、`BrowserWindow.fromWebContents`、原生对话框、
 * 文件系统、单调时钟、定时器与 token 生成都由 main 注入，因此整个异常边界可以用 fake 精确测试；main 只负责把窗口事件转发进来。
 *
 * 不变的规则：
 * - **最新状态**：协调器状态只存在闭包变量 `state` 中，每次迁移都读它、写它；任何 `await` 之后都不使用 await 之前的状态对象。
 * - **同步校验**：每个 handler 在第一个 `await` 之前用 `authenticate` 把 Electron 事件转换成可信快照并校验（登记窗口、未销毁、
 *   主 frame、页面身份），再校验 payload；任一失败都抛出固定文案的 `Request rejected`，不改任何状态、不泄露细节。
 * - **对话框锁**：`beginOpen` 置 `dialogOpen`；选择器结束（选中 / 取消 / 抛错）后在 `finally` 中对最新状态 `endDialog(ticket)`。
 *   主 frame 跨文档导航**开始**与**提交**时、以及渲染进程退出时，都先 `resetOwner`（作废能力、generation + 1），再用该窗口
 *   进行中的票据 `endDialog` 释放逻辑锁。提交时再失效一次是必要的：导航开始到提交之间旧文档仍然存活，它发出的 Open 会拿到
 *   开始时 reset 之后的新 generation（实测）；提交时的失效把这类请求一并作废，并释放它占用的
 *   **逻辑**锁——这不表示原生对话框已关闭（实测 reload 后 sheet 仍挂在原窗口上，destroy 后 promise 永不结束）。
 *   旧请求之后即使返回，也只会因 generation 不符被判 `superseded`；旧 handler 的 `finally` 只会对旧票据 `endDialog`，
 *   而协调器只在票据仍是最新请求时才清锁，所以不会清掉新请求的锁。
 * - **物理对话框所有权**（T1b-2b preflight 裁决 Q1，独立于协调器的 `dialogOpen` 逻辑锁）：每个登记的**窗口实例**同时最多
 *   一个尚未 settle 的 `chooseOpenPath` 操作。macOS 实测：同一窗口已有 sheet 时再弹对话框，新面板不会挂成 sheet，而是成为
 *   用户无法触达的离屏面板，永不结束。所以只要该窗口实例的选择器尚未 settle（即使 reload / 渲染进程退出已释放逻辑锁），
 *   同窗口的 Open 直接回复 `busy`——**不调用** `beginOpen`、不占请求代次、不丢弃任何 pending。所有权按窗口实例对象登记，
 *   不按 ownerId：旧实例的迟到 settle 只能删除它自己的记录，不会清掉同一 ownerId 新登记实例的记录。
 *   所有权只在 `chooseOpenPath` resolve / reject 时释放；reload、`resetOwner`、`disposeWindow` 与逻辑 `endDialog` 都不释放它，
 *   也没有任何定时强制释放。窗口销毁后仍未 settle 的操作保留为真实的未完成记录，计入 `orphanedNativeDialogs`（诊断），
 *   它只属于已销毁的实例，不影响其它窗口的 Open。进程级总数只用于诊断，不作为准入条件。
 *   发起请求的窗口实例在选择器 settle 或读取结束时已不再登记（销毁后同一 ownerId 重新登记、或被替换）：迟到结果直接回复
 *   `superseded`，不调用 `completeOpen`；逻辑锁也只在票据仍是该窗口登记的进行中票据时才释放——新实例的请求可能与旧票据
 *   seq / generation 相同，旧请求不得清掉它的锁、消费它的票据或替它登记候选。
 * - **失败不外泄**：选择器异常、相对路径、T1a 管线异常、协调器编程错误都回复 `failed: read-failed`（固定文案），不透传原始错误。
 * - **授权 fail closed**：只有 `authorize`（T1a `lookupActive`）能用于授权；pending 永不授权；TTL 由协调器按注入时钟判定，
 *   定时器只做清理。
 */

import { isAbsolute } from 'node:path';

import { createDocumentIdAllocator } from '../document/documentIds';
import type { ReadOnlyFileSystem } from '../document/fileSystemPort';
import { openDocumentAtPath, openDocumentError } from '../document/openDocument';
import type { OpenAtPathResult } from '../document/openDocument';
import type { OpenCapabilityRecord } from '../document/capabilities';
import {
  activateDocument,
  authorizeCapability,
  beginOpen,
  completeOpen,
  createOpenCoordinator,
  disposeOwner,
  endDialog,
  expireCandidates,
  PENDING_TTL_MS,
  registerOwner,
  rejectDocument,
  resetOwner,
} from '../open/openCoordinator';
import type { OpenCompletion, OpenCoordinatorState, OpenTicket } from '../open/openCoordinator';
import { parseActivationTicket, parseOpenRequest, validateSender } from '../open/ipcValidation';
import type { PageIdentity } from '../open/ipcValidation';
import type { ActivateDocumentReply, OpenDocumentReply, RejectDocumentReply } from '../../shared/activationContracts';
import { IPC } from '../../shared/ipc';

/** `event.senderFrame` / `webContents.mainFrame` 中本模块用到的部分。 */
export interface FrameLike {
  readonly url: string;
}

/** `event.sender`（WebContents）中本模块用到的部分。 */
export interface SenderLike {
  readonly id: number;
  isDestroyed(): boolean;
  readonly mainFrame: FrameLike;
}

/** `IpcMainInvokeEvent` 中本模块用到的部分。 */
export interface InvokeEventLike<S extends SenderLike> {
  readonly sender: S;
  readonly senderFrame: FrameLike | null;
}

export interface IpcRegistrarLike<S extends SenderLike> {
  handle(channel: string, listener: (event: InvokeEventLike<S>, payload: unknown) => unknown): void;
}

export interface OpenIpcDeps<S extends SenderLike, W> {
  readonly ipc: IpcRegistrarLike<S>;
  /** `BrowserWindow.fromWebContents`；只在 handler 同步段、sender 未销毁时调用。 */
  windowForSender(sender: S): W | null;
  /** main 配置的可信页面身份（`resolvePageEntry`）。 */
  readonly pageIdentity: PageIdentity;
  /** 父窗口模态的原生打开对话框；取消返回 null。 */
  chooseOpenPath(parent: W): Promise<string | null>;
  readonly fs: ReadOnlyFileSystem;
  readonly platform: string;
  /** 单调时钟（毫秒）。 */
  now(): number;
  /** 不透明能力 token（生产为 `crypto.randomUUID`）。 */
  issueToken(): string;
  /** 一次性定时器（生产为 unref 的 `setTimeout`），只用于 TTL 清理。 */
  schedule(delayMs: number, task: () => void): void;
  /** 默认 `PENDING_TTL_MS`（120 s）。 */
  readonly ttlMs?: number;
}

export interface OpenIpcHandle<W> {
  /** 窗口创建后登记（webContents id → 窗口）；同一 id 重复登记以最后一次为准。 */
  attachWindow(ownerId: number, window: W): void;
  /** `did-start-navigation` 转发：只有主 frame 的跨文档导航才 reset。 */
  handleNavigation(ownerId: number, navigation: { readonly isMainFrame: boolean; readonly isSameDocument: boolean }): void;
  /** `did-navigate` 转发（主 frame 跨文档导航已提交）：再次 reset，作废导航期间旧文档发出的请求。 */
  handleNavigationCommitted(ownerId: number): void;
  /** `render-process-gone` 转发。 */
  handleRendererGone(ownerId: number): void;
  /** `closed` / `destroyed` 转发（幂等）。 */
  disposeWindow(ownerId: number): void;
  /** 授权查询（T4 Save 使用）：只认 active。 */
  authorize(ownerId: number, token: string): OpenCapabilityRecord | null;
  /** 只读诊断快照（测试与日志）；不是授权入口。 */
  currentState(): OpenCoordinatorState;
  /** 进程内尚未 settle 的原生对话框操作数（诊断，不是准入条件）。 */
  pendingNativeDialogs(): number;
  /** 其中所属窗口实例已不再登记（已销毁或被同 ownerId 的新实例替换）的操作数（诊断）；它们仍未 settle，不是已释放。 */
  orphanedNativeDialogs(): number;
}

/** 一次尚未 settle 的 `chooseOpenPath` 调用；以对象身份区分每次调用。 */
interface NativeDialogOperation<W> {
  readonly ownerId: number;
  readonly window: W;
}

const REJECTED_MESSAGE = 'Request rejected';

function rejected(): Error {
  return new Error(REJECTED_MESSAGE);
}

const readFailed = (): OpenCompletion => ({ kind: 'failed', error: openDocumentError('read-failed') });

export function registerOpenIpc<S extends SenderLike, W>(deps: OpenIpcDeps<S, W>): OpenIpcHandle<W> {
  let state = createOpenCoordinator(deps.ttlMs ?? PENDING_TTL_MS);
  const ttlMs = state.ttlMs;
  const allocator = createDocumentIdAllocator();
  const windows = new Map<number, W>();
  /** 每个窗口当前持有对话框锁的票据（只用于 reload 时释放逻辑锁）。 */
  const dialogTickets = new Map<number, OpenTicket>();
  /** 每个窗口实例当前尚未 settle 的选择器操作（按实例对象登记）。 */
  const dialogByWindow = new Map<W, NativeDialogOperation<W>>();
  /** 进程内全部尚未 settle 的选择器操作（含孤儿）。 */
  const unsettledDialogs = new Set<NativeDialogOperation<W>>();

  /** 同步段：Electron 事件 → 可信快照 → 校验；通过时返回 owner 与登记窗口。 */
  function authenticate(event: InvokeEventLike<S>): { readonly ownerId: number; readonly window: W } {
    const sender = event.sender;
    const destroyed = sender.isDestroyed();
    const registered = destroyed ? undefined : windows.get(sender.id);
    let resolved: W | null = null;
    if (registered !== undefined) {
      try {
        resolved = deps.windowForSender(sender);
      } catch {
        resolved = null;
      }
    }
    const frame = event.senderFrame;
    const verdict = validateSender(
      {
        webContentsId: sender.id,
        destroyed,
        isRegisteredWindow: registered !== undefined && resolved === registered,
        isMainFrame: frame !== null && frame === sender.mainFrame,
        frameUrl: frame === null ? null : frame.url,
      },
      deps.pageIdentity,
    );
    if (!verdict.ok || registered === undefined) throw rejected();
    return { ownerId: verdict.ownerId, window: registered };
  }

  /**
   * 选择器已经 settle：只删除这一次操作自己的记录。身份比对是防御性的——同一窗口实例不会同时有两次操作（准入保证），
   * 旧实例与新实例的隔离靠以实例对象为键，而不是靠这行比对。
   */
  function releaseNativeDialog(operation: NativeDialogOperation<W>): void {
    unsettledDialogs.delete(operation);
    if (dialogByWindow.get(operation.window) === operation) dialogByWindow.delete(operation.window);
  }

  function isCurrentWindow(ownerId: number, window: W): boolean {
    return windows.get(ownerId) === window;
  }

  function releaseDialog(ticket: OpenTicket): void {
    state = endDialog(state, ticket);
    if (dialogTickets.get(ticket.ownerId) === ticket) dialogTickets.delete(ticket.ownerId);
  }

  async function runPipeline(ownerId: number, path: string): Promise<OpenCompletion> {
    if (!isAbsolute(path)) return readFailed();
    try {
      const result: OpenAtPathResult = await openDocumentAtPath(
        { fs: deps.fs, platform: deps.platform, ownerId, allocateDocumentId: () => allocator.next(), issueToken: () => deps.issueToken() },
        path,
      );
      return result;
    } catch {
      return readFailed();
    }
  }

  function settle(ticket: OpenTicket, completion: OpenCompletion): OpenDocumentReply {
    let reply: OpenDocumentReply | null;
    try {
      const step = completeOpen(state, ticket, completion, deps.now());
      state = step.state;
      reply = step.result;
    } catch {
      return { kind: 'failed', error: openDocumentError('read-failed') };
    }
    if (reply === null) return { kind: 'rejected', reason: 'superseded' };
    if (reply.kind === 'opened') {
      deps.schedule(ttlMs, () => {
        try {
          state = expireCandidates(state, deps.now()).state;
        } catch {
          // 时钟异常（非有限值）时不清理；激活仍按时钟 fail closed，状态保持不变。
        }
      });
    }
    return reply;
  }

  async function openDocument(event: InvokeEventLike<S>, payload: unknown): Promise<OpenDocumentReply> {
    const { ownerId, window } = authenticate(event);
    if (parseOpenRequest(payload) === null) throw rejected();
    // 物理所有权先于逻辑锁判定（鉴权之后）：该窗口实例的选择器尚未 settle 时不进入协调器，不占代次、不作废任何 pending。
    if (dialogByWindow.has(window)) return { kind: 'rejected', reason: 'busy' };
    const begun = beginOpen(state, ownerId);
    state = begun.state;
    if (begun.result.kind === 'busy') return { kind: 'rejected', reason: 'busy' };
    if (begun.result.kind === 'unknown-owner') throw rejected();
    const ticket = begun.result.ticket;
    dialogTickets.set(ownerId, ticket);

    // 选择器结束（含抛错）后先释放对话框锁，再基于最新状态完成请求。
    let chosen: { readonly path: string | null } | null = null;
    const operation: NativeDialogOperation<W> = { ownerId, window };
    dialogByWindow.set(window, operation);
    unsettledDialogs.add(operation);
    try {
      chosen = { path: await deps.chooseOpenPath(window) };
    } catch {
      chosen = null;
    } finally {
      // 这里是物理所有权唯一的释放点：选择器已经 settle。
      releaseNativeDialog(operation);
      // 只释放仍由本请求持有的逻辑锁：窗口销毁后同一 ownerId 重新登记时，新请求可能与旧票据的 seq / generation 相同。
      if (dialogTickets.get(ownerId) === ticket) releaseDialog(ticket);
    }
    // 发起请求的窗口实例已不再登记（销毁或被替换）：迟到结果不进入协调器，不影响新实例的逻辑请求。
    if (!isCurrentWindow(ownerId, window)) return { kind: 'rejected', reason: 'superseded' };
    if (chosen === null) return settle(ticket, readFailed());
    if (chosen.path === null) return settle(ticket, { kind: 'canceled' });
    const completion = await runPipeline(ownerId, chosen.path);
    if (!isCurrentWindow(ownerId, window)) return { kind: 'rejected', reason: 'superseded' };
    return settle(ticket, completion);
  }

  function activate(event: InvokeEventLike<S>, payload: unknown): ActivateDocumentReply {
    const { ownerId } = authenticate(event);
    const ticket = parseActivationTicket(payload);
    if (ticket === null) throw rejected();
    const step = activateDocument(state, ownerId, ticket, deps.now());
    state = step.state;
    return step.result.reply;
  }

  function reject(event: InvokeEventLike<S>, payload: unknown): RejectDocumentReply {
    const { ownerId } = authenticate(event);
    const ticket = parseActivationTicket(payload);
    if (ticket === null) throw rejected();
    const step = rejectDocument(state, ownerId, ticket);
    state = step.state;
    return step.result.reply;
  }

  /** 页面代次失效：作废能力，并释放该窗口进行中对话框的逻辑锁。 */
  function invalidateOwner(ownerId: number): void {
    state = resetOwner(state, ownerId).state;
    const ticket = dialogTickets.get(ownerId);
    if (ticket !== undefined) releaseDialog(ticket);
  }

  deps.ipc.handle(IPC.openDocument, (event, payload) => openDocument(event, payload));
  deps.ipc.handle(IPC.activateDocument, (event, payload) => activate(event, payload));
  deps.ipc.handle(IPC.rejectDocument, (event, payload) => reject(event, payload));

  return {
    attachWindow(ownerId, window) {
      windows.set(ownerId, window);
      state = registerOwner(state, ownerId);
    },
    handleNavigation(ownerId, navigation) {
      if (navigation.isMainFrame && !navigation.isSameDocument) invalidateOwner(ownerId);
    },
    handleNavigationCommitted(ownerId) {
      invalidateOwner(ownerId);
    },
    handleRendererGone(ownerId) {
      invalidateOwner(ownerId);
    },
    disposeWindow(ownerId) {
      windows.delete(ownerId);
      dialogTickets.delete(ownerId);
      state = disposeOwner(state, ownerId).state;
    },
    authorize: (ownerId, token) => authorizeCapability(state, ownerId, token),
    currentState: () => state,
    pendingNativeDialogs: () => unsettledDialogs.size,
    orphanedNativeDialogs: () => [...unsettledDialogs].filter((operation) => windows.get(operation.ownerId) !== operation.window).length,
  };
}
