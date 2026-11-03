/**
 * M3 T4 B3a-1：未确认 reject 账本（`src/renderer/app/save/rejectLedger.ts`；r1.2 ERRATA §2.2 R20，B3 r0.1 勘误 §2）。
 *
 * 覆盖时序 R-2 / R-3 / R-5 / R-6 / R-7 与 flush 期间入账；性质测试：条目只会因「当前尝试」成功而出账，迟到应答不误删。
 */

import { describe, expect, it } from 'vitest';

import { createRejectLedger, REJECT_BATCH_LIMIT } from '../../../src/renderer/app/save/rejectLedger';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';
import { createPrng } from '../editor/prng';

interface Call {
  readonly ticket: DocumentActivationTicket;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

function harness() {
  const calls: Call[] = [];
  const timers: { task: () => void; cancelled: boolean }[] = [];
  const ledger = createRejectLedger({
    reject: (ticket) =>
      new Promise((resolve, reject) => {
        calls.push({ ticket, resolve, reject });
      }),
    schedule: (_delay, task) => {
      const timer = { task, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const fire = (index: number): void => {
    const timer = timers[index];
    if (timer === undefined) throw new Error(`no timer #${String(index)}`);
    if (!timer.cancelled) timer.task();
  };
  return { ledger, calls, timers, fire };
}

const tick = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/** 只让出微任务：账本的推进只依赖 Promise（性质测试用，避免大量宏任务）。 */
const microtasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

const T = (id: string, documentId = 1): DocumentActivationTicket => ({ capabilityId: id, documentId });
const OK = { ok: true };

describe('rejectLedger', () => {
  it('R-7：空账本 flush 立即 delivered', async () => {
    const { ledger, calls } = harness();
    expect(await ledger.flush()).toBe('delivered');
    expect(calls).toHaveLength(0);
  });

  it('send 先入账再立即发出；当前尝试成功返回才出账', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    expect(ledger.pending()).toBe(1);
    expect(calls.map((c) => c.ticket)).toEqual([T('a')]);
    calls[0]?.resolve(OK);
    await tick();
    expect(ledger.pending()).toBe(0);
  });

  it('不是 `{ ok: true }` 的应答不算送达（fail closed）', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    calls[0]?.resolve({ ok: false });
    await tick();
    expect(ledger.pending()).toBe(1);
  });

  it('R-6：invoke 抛错 → 条目保留；之后的 flush 重发，成功才出账', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    calls[0]?.reject(new Error('ipc down'));
    await tick();
    expect(ledger.pending()).toBe(1);
    const flushing = ledger.flush();
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(OK);
    expect(await flushing).toBe('delivered');
    expect(ledger.pending()).toBe(0);
  });

  it('R-2：尝试超时之后才到达的成功应答不出账；下一次 flush 发起新尝试，新尝试成功才出账', async () => {
    const { ledger, calls, fire } = harness();
    ledger.send(T('a'));
    fire(0);
    await tick();
    calls[0]?.resolve(OK); // 迟到
    await tick();
    expect(ledger.pending()).toBe(1);
    const flushing = ledger.flush();
    await tick();
    expect(calls).toHaveLength(2);
    calls[1]?.resolve(OK);
    expect(await flushing).toBe('delivered');
  });

  it('R-3：同票重发不新建条目；有尝试在进行时不重复发出，flush 复用它', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    ledger.send(T('a'));
    expect(ledger.pending()).toBe(1);
    expect(calls).toHaveLength(1);
    const flushing = ledger.flush();
    await tick();
    expect(calls).toHaveLength(1);
    calls[0]?.resolve(OK);
    expect(await flushing).toBe('delivered');
    // 不同 documentId 的同一 capabilityId 是另一张票。
    ledger.send(T('a', 1));
    ledger.send(T('a', 2));
    expect(ledger.pending()).toBe(2);
  });

  it('flush 进行中新入账：已遍历的送达了，但账本非空 → undelivered（不把新条目当作已送达）', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    const flushing = ledger.flush();
    ledger.send(T('b'));
    calls[0]?.resolve(OK);
    expect(await flushing).toBe('undelivered');
    expect(ledger.tickets()).toEqual([T('b')]);
  });

  it('任一条未送达即停止并返回 undelivered；条目全部保留', async () => {
    const { ledger, calls } = harness();
    ledger.send(T('a'));
    ledger.send(T('b'));
    calls[0]?.reject(new Error('x'));
    calls[1]?.reject(new Error('x'));
    await tick();
    const flushing = ledger.flush();
    await tick();
    calls[2]?.reject(new Error('still down'));
    expect(await flushing).toBe('undelivered');
    expect(ledger.pending()).toBe(2);
    expect(calls).toHaveLength(3); // 第一条失败即停止：本轮不再重发 b
  });

  it('超时同样即停止（main 不响应时一次 flush 最多等一个超时）；超时不算送达，条目保留', async () => {
    const { ledger, calls, timers, fire } = harness();
    ledger.send(T('a'));
    ledger.send(T('b'));
    fire(0);
    fire(1);
    await tick();
    const flushing = ledger.flush();
    await tick();
    expect(calls).toHaveLength(3);
    fire(timers.length - 1);
    expect(await flushing).toBe('undelivered');
    expect(calls).toHaveLength(3);
    expect(ledger.tickets()).toEqual([T('a'), T('b')]);
  });

  it('R-5：17 条——单次 flush 最多处理 16 条并返回 undelivered，从不丢弃；多轮 flush 最终收敛', async () => {
    const calls: Call[] = [];
    let healthy = false;
    const ledger = createRejectLedger({
      reject: (ticket) =>
        healthy
          ? Promise.resolve(OK)
          : new Promise((resolve, reject) => {
              calls.push({ ticket, resolve, reject });
            }),
    });
    for (let i = 0; i < REJECT_BATCH_LIMIT + 1; i += 1) ledger.send(T(`t${String(i)}`));
    for (const call of calls) call.reject(new Error('down'));
    await tick();
    expect(ledger.pending()).toBe(17);
    healthy = true;
    expect(await ledger.flush()).toBe('undelivered');
    expect(ledger.pending()).toBe(1);
    expect(ledger.tickets()).toEqual([T('t16')]);
    expect(await ledger.flush()).toBe('delivered');
    expect(ledger.pending()).toBe(0);
  });

  it('定时器挂载同步抛错：本次尝试判为未送达且不发出，不外泄、无未处理 rejection；条目保留，之后可正常送达', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      let broken = true;
      const sent: DocumentActivationTicket[] = [];
      const ledger = createRejectLedger({
        reject: (ticket) => {
          sent.push(ticket);
          return Promise.resolve(OK);
        },
        schedule: (_delay, _task) => {
          if (broken) throw new Error('timer unavailable');
          return () => undefined;
        },
      });
      expect(() => {
        ledger.send(T('a'));
      }).not.toThrow();
      expect(await ledger.flush()).toBe('undelivered');
      await tick();
      expect(sent).toEqual([]);
      expect(ledger.pending()).toBe(1);
      broken = false;
      expect(await ledger.flush()).toBe('delivered');
      expect(sent).toEqual([T('a')]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('同步抛错的发送函数按失败处理，不向外抛出', async () => {
    const ledger = createRejectLedger({
      reject: () => {
        throw new Error('bridge missing');
      },
    });
    expect(() => ledger.send(T('a'))).not.toThrow();
    expect(await ledger.flush()).toBe('undelivered');
    expect(ledger.pending()).toBe(1);
  });
});

describe('rejectLedger —— 性质：只有当前尝试成功才出账', () => {
  it('随机的发送 / 成功 / 失败 / 超时 / 迟到应答 / flush 交错下，条目集合与模型一致', async () => {
    for (let seed = 1; seed <= 80; seed += 1) {
      const prng = createPrng(seed);
      const { ledger, calls, fire, timers } = harness();
      /** 每个调用：所属票据、是否已结束（含超时）、是否是该票据的当前尝试由「最后一个调用」判定。 */
      const status: ('open' | 'ended')[] = [];
      const model = new Set<string>();
      const keyOf = (t: DocumentActivationTicket): string => `${t.capabilityId}/${String(t.documentId)}`;
      const lastCallOf = (key: string): number => {
        for (let i = calls.length - 1; i >= 0; i -= 1) if (keyOf(calls[i]?.ticket ?? T('?')) === key) return i;
        return -1;
      };
      for (let step = 0; step < 40; step += 1) {
        const where = `seed ${String(seed)}, step ${String(step)}`;
        const action = prng.int(5);
        if (action === 0) {
          const ticket = T(prng.pick(['a', 'b', 'c']));
          ledger.send(ticket);
          model.add(keyOf(ticket));
        } else if (action === 1 && calls.length > 0) {
          const index = prng.int(calls.length);
          const call = calls[index];
          if (call !== undefined && status[index] !== 'ended') {
            const key = keyOf(call.ticket);
            const current = lastCallOf(key) === index && status[index] === undefined;
            call.resolve(OK);
            status[index] = 'ended';
            if (current) model.delete(key);
          } else if (call !== undefined) {
            call.resolve(OK); // 迟到：已超时或已结束的调用
          }
        } else if (action === 2 && calls.length > 0) {
          const index = prng.int(calls.length);
          if (status[index] === undefined) {
            calls[index]?.reject(new Error('x'));
            status[index] = 'ended';
          }
        } else if (action === 3 && timers.length > 0) {
          const index = prng.int(timers.length);
          if (status[index] === undefined && timers[index]?.cancelled === false) {
            fire(index);
            status[index] = 'ended';
          }
        } else {
          void ledger.flush();
        }
        await microtasks();
        // 新发出的调用（send / flush）记为进行中。
        for (let i = 0; i < calls.length; i += 1) if (status[i] === undefined && timers[i]?.cancelled === true) status[i] = 'ended';
        expect(new Set(ledger.tickets().map(keyOf)), where).toEqual(model);
      }
    }
  });
});
