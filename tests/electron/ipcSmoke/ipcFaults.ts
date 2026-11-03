/**
 * 真实窗口 smoke 的激活 / reject 应答故障（M3 T1c-2；M3 T4 B3a-1 增加 reject；只在测试 harness，产品没有任何对应通道或开关）。
 *
 * 包装交给**生产** `registerOpenIpc` 的 registrar：每个通道仍由生产 handler 处理。只有 `muse:activate-document` 与
 * `muse:reject-document` 受影响：
 * - activate 扣留：生产 handler **照常执行**（main 的能力状态真实改变），应答换成永不 settle 的 Promise，renderer 收不到。
 * - reject `hold`：生产 handler **照常执行**（main 已处理），应答永不 settle——renderer 账本无法确认送达。
 * - reject `swallow`：生产 handler **不执行**（main 未处理），应答永不 settle——相当于请求丢失。
 * 不改写 payload、不改写结果、不注册额外通道、不拦截其它通道；未布置故障时完全透明。
 */

import type { InvokeEventLike, IpcRegistrarLike, SenderLike } from '../../../src/main/ipc/registerOpenIpc';
import { IPC } from '../../../src/shared/ipc';

export interface ActivationRecord {
  /** 第几次激活调用（从 1 开始，跨窗口累计）。 */
  readonly call: number;
  readonly held: boolean;
  readonly payload: unknown;
  /** 生产 handler 的结果（抛错时为 `{ threw: true }`）。 */
  readonly result: unknown;
}

/** reject 故障模式：`none` 透明；`hold` 执行但扣留应答；`swallow` 不执行并吞没。 */
export type RejectFault = 'none' | 'hold' | 'swallow';

export interface RejectRecord {
  /** 第几次 reject 调用（从 1 开始，跨窗口累计）。 */
  readonly call: number;
  readonly fault: RejectFault;
  /** 生产 handler 是否执行。 */
  readonly executed: boolean;
  readonly payload: unknown;
  /** 生产 handler 的结果（未执行为 null；抛错时为 `{ threw: true }`）。 */
  readonly result: unknown;
}

export interface ActivationFaults {
  registrar<S extends SenderLike>(inner: IpcRegistrarLike<S>): IpcRegistrarLike<S>;
  /** 之后的 count 次激活：main 照常执行，应答扣留不交给 renderer。 */
  holdNextActivations(count: number): void;
  records(): readonly ActivationRecord[];
  /** 之后的全部 reject 按该模式处理，直到再次设置（`none` 恢复透明）。 */
  setRejectFault(fault: RejectFault): void;
  rejectRecords(): readonly RejectRecord[];
  /** 用例收尾：取消尚未消耗的扣留与 reject 故障并清空记录。 */
  reset(): void;
}

export function createActivationFaults(): ActivationFaults {
  let remaining = 0;
  let calls = 0;
  const records: ActivationRecord[] = [];
  let rejectFault: RejectFault = 'none';
  let rejectCalls = 0;
  const rejectRecords: RejectRecord[] = [];

  function wrapActivate<S extends SenderLike>(listener: (event: InvokeEventLike<S>, payload: unknown) => unknown): (event: InvokeEventLike<S>, payload: unknown) => unknown {
    return (event, payload) => {
      calls += 1;
      let result: unknown;
      try {
        result = listener(event, payload);
      } catch (error) {
        // 被拒绝的调用没有应答可扣留，不消耗布置的扣留次数。
        records.push({ call: calls, held: false, payload, result: { threw: true } });
        throw error;
      }
      const held = remaining > 0;
      if (held) remaining -= 1;
      records.push({ call: calls, held, payload, result });
      return held ? new Promise<never>(() => undefined) : result;
    };
  }

  function wrapReject<S extends SenderLike>(listener: (event: InvokeEventLike<S>, payload: unknown) => unknown): (event: InvokeEventLike<S>, payload: unknown) => unknown {
    return (event, payload) => {
      rejectCalls += 1;
      const fault = rejectFault;
      if (fault === 'swallow') {
        rejectRecords.push({ call: rejectCalls, fault, executed: false, payload, result: null });
        return new Promise<never>(() => undefined);
      }
      let result: unknown;
      try {
        result = listener(event, payload);
      } catch (error) {
        rejectRecords.push({ call: rejectCalls, fault, executed: true, payload, result: { threw: true } });
        throw error;
      }
      rejectRecords.push({ call: rejectCalls, fault, executed: true, payload, result });
      return fault === 'hold' ? new Promise<never>(() => undefined) : result;
    };
  }

  return {
    registrar: (inner) => ({
      handle(channel, listener) {
        if (channel === IPC.activateDocument) inner.handle(channel, wrapActivate(listener));
        else if (channel === IPC.rejectDocument) inner.handle(channel, wrapReject(listener));
        else inner.handle(channel, listener);
      },
    }),
    holdNextActivations(count) {
      remaining = count;
    },
    records: () => records,
    setRejectFault(fault) {
      rejectFault = fault;
    },
    rejectRecords: () => rejectRecords,
    reset() {
      remaining = 0;
      records.length = 0;
      rejectFault = 'none';
      rejectRecords.length = 0;
    },
  };
}
