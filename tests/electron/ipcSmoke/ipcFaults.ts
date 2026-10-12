/**
 * 真实窗口 smoke 的激活应答扣留（M3 T1c-2；只在测试 harness，产品没有任何对应通道或开关）。
 *
 * 包装交给**生产** `registerOpenIpc` 的 registrar：每个通道仍由生产 handler 处理。只有 `muse:activate-document` 受影响——
 * 布置了扣留时，生产 handler **照常执行**（main 的能力状态真实改变），但它的应答被换成永不 settle 的 Promise，renderer 收不到。
 * 不改写 payload、不改写结果、不注册额外通道、不拦截其它通道；未布置扣留时完全透明。
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

export interface ActivationFaults {
  registrar<S extends SenderLike>(inner: IpcRegistrarLike<S>): IpcRegistrarLike<S>;
  /** 之后的 count 次激活：main 照常执行，应答扣留不交给 renderer。 */
  holdNextActivations(count: number): void;
  records(): readonly ActivationRecord[];
  /** 用例收尾：取消尚未消耗的扣留并清空记录。 */
  reset(): void;
}

export function createActivationFaults(): ActivationFaults {
  let remaining = 0;
  let calls = 0;
  const records: ActivationRecord[] = [];

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

  return {
    registrar: (inner) => ({
      handle(channel, listener) {
        inner.handle(channel, channel === IPC.activateDocument ? wrapActivate(listener) : listener);
      },
    }),
    holdNextActivations(count) {
      remaining = count;
    },
    records: () => records,
    reset() {
      remaining = 0;
      records.length = 0;
    },
  };
}
