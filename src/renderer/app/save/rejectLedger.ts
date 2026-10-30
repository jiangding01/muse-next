/**
 * 未确认 reject 账本（M3 T4 B3a-1；r1.2 ERRATA §2.2 R20，B3 r0.1 勘误 §2，H-B3-2）。
 *
 * - renderer 中 `rejectDocument` 只在本模块调用（`architecture.m3t4b3` 钉住）：Open 与 Save As 的全部 reject 先入账再 invoke。
 * - 条目以完整票据 `(capabilityId, documentId)` 为键；同票重发不新建条目，有尝试在进行时复用它。
 * - **只有当前尝试成功返回才出账**：超时（`timeoutMs`）或抛错时条目保留；超时之后才到达的旧尝试应答一律忽略（不误删）。
 *   main 的 reject 是幂等的，因此保留的条目在下一次 `flush` 时安全重发。
 * - `flush()` 按入账顺序逐条重发并等待，单次最多处理 `batchLimit` 条（16）；仍有条目未处理或任一条未送达都返回
 *   `undelivered`（fail closed）。**从不丢弃条目**：多轮 `flush` 会逐步收敛。
 * - 账本只表示「main 已处理该 reject 请求」，不推断锚点已收敛，也不缓存或放宽任何核对；收敛与否只由 main 的 R19 决定。
 *   调用方在 `flush` 之后必须同步核对 `pending() === 0` 才能进入文件操作（flush 期间的新入账不会被当作已送达）。
 */

import type { DocumentActivationTicket } from '../../../shared/activationContracts';
import type { MuseDesktopApi } from '../../../shared/ipc';

/** reject 单次尝试的超时（与激活单次尝试相同）。 */
export const REJECT_TIMEOUT_MS = 5_000;
/** 单次 flush 的批次上限。 */
export const REJECT_BATCH_LIMIT = 16;

export type FlushOutcome = 'delivered' | 'undelivered';

export interface RejectLedgerDeps {
  /** 发出 reject（产品为 `window.museDesktop.rejectDocument`）。 */
  readonly reject: (ticket: DocumentActivationTicket) => Promise<unknown>;
  /** 一次性定时器；返回取消函数。缺省时不计超时（尝试一直等到 invoke settle）。 */
  readonly schedule?: (delayMs: number, task: () => void) => () => void;
  readonly timeoutMs?: number;
  readonly batchLimit?: number;
}

export interface RejectLedger {
  /** 入账并立即发出一次尝试（已有条目时不新建，有尝试在进行时不重复发出）。 */
  send(ticket: DocumentActivationTicket): void;
  /** 按入账顺序重发并等待（单次最多 `batchLimit` 条）。 */
  flush(): Promise<FlushOutcome>;
  /** 未确认的条目数。 */
  pending(): number;
  /** 只读诊断：未确认的票据（入账顺序）。 */
  tickets(): readonly DocumentActivationTicket[];
}

interface Entry {
  readonly ticket: DocumentActivationTicket;
  /** 当前尝试号（单调递增）。 */
  attempt: number;
  inFlight: Promise<boolean> | null;
}

const keyOf = (ticket: DocumentActivationTicket): string => `${ticket.capabilityId}\u0000${String(ticket.documentId)}`;

const isDelivered = (reply: unknown): boolean => typeof reply === 'object' && reply !== null && (reply as { ok?: unknown }).ok === true;

export function createRejectLedger(deps: RejectLedgerDeps): RejectLedger {
  const entries = new Map<string, Entry>();
  const timeoutMs = deps.timeoutMs ?? REJECT_TIMEOUT_MS;
  const batchLimit = deps.batchLimit ?? REJECT_BATCH_LIMIT;

  /** 发起一次新尝试；返回它是否被确认送达（成功即出账）。 */
  function attempt(key: string, entry: Entry): Promise<boolean> {
    entry.attempt += 1;
    const id = entry.attempt;
    let done = false;
    const run = new Promise<boolean>((resolve) => {
      // 每条结束路径都同步清掉「进行中」：之后的 flush 必须发起新尝试，而不是复用已失败的结果。
      const finish = (delivered: boolean): void => {
        done = true;
        if (entry.attempt === id) entry.inFlight = null;
        resolve(delivered);
      };
      let cancel: () => void = () => undefined;
      if (deps.schedule !== undefined) {
        try {
          cancel = deps.schedule(timeoutMs, () => {
            if (!done) finish(false);
          });
        } catch {
          // 无法计时就不发出：判为未送达（条目保留，下一次 flush 重试），不留下可能永久挂起的尝试。
          finish(false);
          return;
        }
      }
      let sent: Promise<unknown>;
      try {
        sent = Promise.resolve(deps.reject(entry.ticket));
      } catch (error) {
        sent = Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      sent.then(
        (reply) => {
          // 超时之后才到达的应答：本次尝试已判为未送达，不出账、不改条目（不误删）。
          if (done) return;
          cancel();
          const delivered = isDelivered(reply);
          if (delivered && entries.get(key) === entry && entry.attempt === id) entries.delete(key);
          finish(delivered);
        },
        () => {
          if (done) return;
          cancel();
          finish(false);
        },
      );
    });
    // 执行器内同步结束（例如定时器替身立即触发）时不留下过期的「进行中」。
    if (!done) entry.inFlight = run;
    return run;
  }

  return {
    send(ticket) {
      const key = keyOf(ticket);
      const existing = entries.get(key);
      if (existing !== undefined) {
        if (existing.inFlight === null) void attempt(key, existing);
        return;
      }
      const entry: Entry = { ticket: Object.freeze({ capabilityId: ticket.capabilityId, documentId: ticket.documentId }), attempt: 0, inFlight: null };
      entries.set(key, entry);
      void attempt(key, entry);
    },
    async flush() {
      const batch = [...entries].slice(0, batchLimit);
      for (const [key, entry] of batch) {
        if (entries.get(key) !== entry) continue;
        const delivered = await (entry.inFlight ?? attempt(key, entry));
        if (!delivered) return 'undelivered';
      }
      return entries.size === 0 ? 'delivered' : 'undelivered';
    },
    pending: () => entries.size,
    tickets: () => [...entries.values()].map((entry) => entry.ticket),
  };
}

/** 经注入的桥发送、不计超时的私有账本：Open 控制器未注入账本时的缺省值（既有协议测试）；产品注入 `museRejectLedger`。 */
export function createBridgeRejectLedger(bridge: () => Pick<MuseDesktopApi, 'rejectDocument'>): RejectLedger {
  return createRejectLedger({ reject: (ticket) => bridge().rejectDocument(ticket) });
}

/** 产品使用的模块级账本（Open 与保存共用）。 */
export const museRejectLedger: RejectLedger = createRejectLedger({
  reject: (ticket) => window.museDesktop.rejectDocument(ticket),
  schedule: (delayMs, task) => {
    const timer = setTimeout(task, delayMs);
    return () => clearTimeout(timer);
  },
});
