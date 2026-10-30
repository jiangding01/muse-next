/**
 * M3 T4 B3a-1：文件操作准入租约（`src/renderer/app/fileIntentGate.ts`；B3 r0.1 勘误 §1）。
 *
 * 同步获取与拒绝、CAS 释放、旧租约的迟到释放无效（L-4）、id 不复用；随机交错下任一时刻至多一个持有者。
 */

import { describe, expect, it } from 'vitest';

import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import type { FileIntentLease } from '../../../src/renderer/app/fileIntentGate';
import { createPrng } from '../editor/prng';

describe('fileIntentGate', () => {
  it('同步获取：空闲时得到冻结的租约；已有持有者时返回 null（L-1）', () => {
    const gate = createFileIntentGate();
    const first = gate.tryAcquire('save', 7);
    expect(first).toEqual({ id: 1, kind: 'save', documentId: 7 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(gate.tryAcquire('saveAs', 7)).toBeNull();
    expect(gate.tryAcquire('open', 7)).toBeNull();
    expect(gate.current()).toBe(first);
  });

  it('只有持有者能释放；旧租约的迟到释放是空操作，不放掉新持有者（L-4）', () => {
    const gate = createFileIntentGate();
    const a = gate.tryAcquire('save', 1);
    if (a === null) throw new Error('acquire failed');
    gate.release(a);
    const b = gate.tryAcquire('save', 1);
    if (b === null) throw new Error('acquire failed');
    gate.release(a);
    expect(gate.holds(b)).toBe(true);
    expect(gate.holds(a)).toBe(false);
    expect(gate.tryAcquire('open', 1)).toBeNull();
    // 结构相同但不是同一对象的「伪造」租约同样不能释放。
    gate.release({ ...b });
    expect(gate.holds(b)).toBe(true);
    gate.release(b);
    expect(gate.current()).toBeNull();
  });

  it('id 单调递增、从不复用', () => {
    const gate = createFileIntentGate();
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const lease = gate.tryAcquire('open', 1);
      if (lease === null) throw new Error('acquire failed');
      ids.push(lease.id);
      gate.release(lease);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5]);
  });

  it('性质：随机的获取 / 释放 / 迟到释放下，任一时刻至多一个持有者，只有持有者能清空', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const prng = createPrng(seed);
      const gate = createFileIntentGate();
      const issued: FileIntentLease[] = [];
      let model: FileIntentLease | null = null;
      for (let step = 0; step < 60; step += 1) {
        const where = `seed ${String(seed)}, step ${String(step)}`;
        if (prng.int(2) === 0) {
          const lease = gate.tryAcquire(prng.pick(['open', 'save', 'saveAs'] as const), prng.int(3));
          if (model === null) {
            expect(lease, where).not.toBeNull();
            if (lease !== null) issued.push(lease);
            model = lease;
          } else {
            expect(lease, where).toBeNull();
          }
        } else if (issued.length > 0) {
          const target = prng.pick(issued);
          gate.release(target);
          if (model === target) model = null;
        }
        expect(gate.current(), where).toBe(model);
      }
      expect(new Set(issued.map((lease) => lease.id)).size).toBe(issued.length);
    }
  });
});
