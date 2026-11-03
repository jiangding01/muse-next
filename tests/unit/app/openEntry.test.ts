/**
 * M3 T4 B3a-1：Open 准入入口（`src/renderer/app/editor/openEntry.ts`；B3 r0.1 勘误 §1 / §2）。
 *
 * 同步获取租约；会话上已有文件操作或租约被占用即同步拒绝；账本为空时同步开始（不让出事件循环）；账本非空时 flush 之后做
 * 最终同步核对（R-1 flush 期间入账、R-4 租约失效、文档改变、入口门复核失败都拒绝并释放租约）；回调抛错不外泄。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import type { FileIntentLease } from '../../../src/renderer/app/fileIntentGate';
import { admissionNotice, createOpenAdmission } from '../../../src/renderer/app/editor/openEntry';
import type { OpenAdmissionRefusal } from '../../../src/renderer/app/editor/openEntry';
import type { FlushOutcome } from '../../../src/renderer/app/save/rejectLedger';

function setup(options: { pending?: number; flush?: () => Promise<FlushOutcome> } = {}) {
  const gate = createFileIntentGate();
  const doc = { documentId: 3, fileBusy: false };
  const ledger = { count: options.pending ?? 0, flushes: 0 };
  let resolveFlush: (outcome: FlushOutcome) => void = () => undefined;
  const admission = createOpenAdmission({
    gate,
    ledger: {
      pending: () => ledger.count,
      flush: () => {
        ledger.flushes += 1;
        if (options.flush !== undefined) return options.flush();
        return new Promise<FlushOutcome>((resolve) => {
          resolveFlush = resolve;
        });
      },
    },
    document: () => doc,
  });
  const events: string[] = [];
  const begun: FileIntentLease[] = [];
  let allowed = true;
  const handlers = {
    begin: (lease: FileIntentLease) => {
      events.push('begin');
      begun.push(lease);
    },
    refuse: (reason: OpenAdmissionRefusal) => events.push(`refuse:${reason}`),
    stillAllowed: () => allowed,
  };
  return {
    gate,
    doc,
    ledger,
    admission,
    events,
    begun,
    handlers,
    resolveFlush: (outcome: FlushOutcome) => resolveFlush(outcome),
    disallow: () => {
      allowed = false;
    },
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
beforeEach(() => {
  unhandled.length = 0;
  process.on('unhandledRejection', onUnhandled);
});
afterEach(() => {
  process.off('unhandledRejection', onUnhandled);
  expect(unhandled).toEqual([]);
});

describe('openEntry —— 同步准入', () => {
  it('账本为空：同步获取租约并同步开始（不让出事件循环），租约由调用方持有', () => {
    const s = setup();
    s.admission.admit(s.handlers);
    expect(s.events).toEqual(['begin']);
    expect(s.gate.current()).toBe(s.begun[0]);
    expect(s.gate.current()).toMatchObject({ kind: 'open', documentId: 3 });
    expect(s.ledger.flushes).toBe(0);
  });

  it('租约被占用（另一项文件操作）→ 同步拒绝 busy，不 flush', () => {
    const s = setup({ pending: 1 });
    const other = s.gate.tryAcquire('save', 3);
    s.admission.admit(s.handlers);
    expect(s.events).toEqual(['refuse:busy']);
    expect(s.gate.current()).toBe(other);
    expect(s.ledger.flushes).toBe(0);
  });

  it('会话上已有进行中的文件操作（fileOp）→ 同步拒绝 busy，不获取租约', () => {
    const s = setup();
    s.doc.fileBusy = true;
    s.admission.admit(s.handlers);
    expect(s.events).toEqual(['refuse:busy']);
    expect(s.gate.current()).toBeNull();
  });
});

describe('openEntry —— 送达门与最终核对（H-B3-2）', () => {
  it('账本非空：先 flush；flush 期间租约已持有，另一次准入同步得到 busy；送达且核对通过才开始', async () => {
    const s = setup({ pending: 1 });
    s.admission.admit(s.handlers);
    expect(s.events).toEqual([]);
    const held = s.gate.current();
    expect(held).not.toBeNull();
    s.admission.admit({ ...s.handlers, refuse: (reason) => s.events.push(`second:${reason}`) });
    expect(s.events).toEqual(['second:busy']);
    s.ledger.count = 0;
    s.resolveFlush('delivered');
    await settle();
    expect(s.events).toEqual(['second:busy', 'begin']);
    expect(s.begun[0]).toBe(held);
  });

  it('flush 未送达 → reject-pending，租约释放', async () => {
    const s = setup({ pending: 1 });
    s.admission.admit(s.handlers);
    s.resolveFlush('undelivered');
    await settle();
    expect(s.events).toEqual(['refuse:reject-pending']);
    expect(s.gate.current()).toBeNull();
  });

  it('R-1：flush 返回 delivered，但最终核对时账本又有条目 → reject-pending', async () => {
    const s = setup({ pending: 1 });
    s.admission.admit(s.handlers);
    s.resolveFlush('delivered');
    await settle();
    expect(s.events).toEqual(['refuse:reject-pending']);
    expect(s.gate.current()).toBeNull();
  });

  it('R-4：flush 期间租约失效 → changed；不释放别人的租约', async () => {
    const s = setup({ pending: 1 });
    s.admission.admit(s.handlers);
    const mine = s.gate.current();
    if (mine === null) throw new Error('no lease');
    s.gate.release(mine);
    const intruder = s.gate.tryAcquire('save', 3);
    s.ledger.count = 0;
    s.resolveFlush('delivered');
    await settle();
    expect(s.events).toEqual(['refuse:changed']);
    expect(s.gate.current()).toBe(intruder);
  });

  it('flush 期间文档被替换、出现文件操作、入口门复核失败 → changed，租约释放', async () => {
    for (const change of ['document', 'fileOp', 'gate'] as const) {
      const s = setup({ pending: 1 });
      s.admission.admit(s.handlers);
      if (change === 'document') s.doc.documentId = 4;
      if (change === 'fileOp') s.doc.fileBusy = true;
      if (change === 'gate') s.disallow();
      s.ledger.count = 0;
      s.resolveFlush('delivered');
      await settle();
      expect(s.events, change).toEqual(['refuse:changed']);
      expect(s.gate.current(), change).toBeNull();
    }
  });

  it('flush 同步抛错或 reject → 按未送达处理；回调抛错不外泄，开始失败即释放租约', async () => {
    const throwing = setup({
      pending: 1,
      flush: () => {
        throw new Error('ledger broken');
      },
    });
    throwing.admission.admit(throwing.handlers);
    await settle();
    expect(throwing.events).toEqual(['refuse:reject-pending']);
    const rejecting = setup({ pending: 1, flush: () => Promise.reject(new Error('x')) });
    rejecting.admission.admit(rejecting.handlers);
    await settle();
    expect(rejecting.events).toEqual(['refuse:reject-pending']);
    const failingBegin = setup();
    failingBegin.admission.admit({
      ...failingBegin.handlers,
      begin: () => {
        throw new Error('begin failed');
      },
    });
    expect(failingBegin.gate.current()).toBeNull();
    const failingRefuse = setup({ pending: 1 });
    failingRefuse.admission.admit({
      ...failingRefuse.handlers,
      refuse: () => {
        throw new Error('notify failed');
      },
    });
    failingRefuse.resolveFlush('undelivered');
    await settle();
    expect(failingRefuse.gate.current()).toBeNull();
  });
});

describe('openEntry —— holds 与同步路径的异常', () => {
  it('holds：租约仍由本次持有且文档号未变才为真（await 恢复后的复核，勘误 §1.3）', () => {
    const s = setup();
    s.admission.admit(s.handlers);
    const lease = s.begun[0];
    if (lease === undefined) throw new Error('no lease');
    expect(s.admission.holds(lease)).toBe(true);
    s.doc.documentId = 4;
    expect(s.admission.holds(lease)).toBe(false);
    s.doc.documentId = 3;
    s.gate.release(lease);
    s.gate.tryAcquire('save', 3);
    expect(s.admission.holds(lease)).toBe(false);
  });

  it('同步 busy 拒绝的提示抛错不外泄；获取之后 pending() 抛错按未送达收束并释放租约', async () => {
    const busy = setup();
    busy.gate.tryAcquire('save', 3);
    expect(() =>
      busy.admission.admit({
        ...busy.handlers,
        refuse: () => {
          throw new Error('notify failed');
        },
      }),
    ).not.toThrow();
    const gate = createFileIntentGate();
    const events: string[] = [];
    const admission = createOpenAdmission({
      gate,
      ledger: {
        pending: () => {
          throw new Error('ledger broken');
        },
        flush: () => Promise.resolve('delivered'),
      },
      document: () => ({ documentId: 3, fileBusy: false }),
    });
    expect(() => admission.admit({ begin: () => events.push('begin'), refuse: (reason) => events.push(reason), stillAllowed: () => true })).not.toThrow();
    await settle();
    expect(events).toEqual(['reject-pending']);
    expect(gate.current()).toBeNull();
  });
});

describe('admissionNotice', () => {
  it('未送达优先；否则按 dirty / 组字给出具体原因，其余为另一项文件操作进行中', () => {
    expect(admissionNotice('reject-pending', { dirty: true, composing: true })).toBe('open-refused-reject-pending');
    expect(admissionNotice('changed', { dirty: true, composing: false })).toBe('open-refused-dirty');
    expect(admissionNotice('changed', { dirty: false, composing: true })).toBe('open-refused-composing');
    expect(admissionNotice('busy', { dirty: false, composing: false })).toBe('open-refused-busy');
  });
});
