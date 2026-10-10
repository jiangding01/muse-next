/**
 * M3 T1a：能力表纯状态机（pending / active，不固化撤销时机）与 documentId 分配器。
 */

import { describe, expect, it } from 'vitest';

import {
  activate,
  addPending,
  createCapabilityTable,
  discardPending,
  lookupActive,
  revoke,
  revokeOwner,
} from '../../../src/main/document/capabilities';
import type { CapabilityTable, OpenCapabilityRecord } from '../../../src/main/document/capabilities';
import { createDocumentIdAllocator } from '../../../src/main/document/documentIds';

function record(token: string, ownerId = 1, documentId = 1): OpenCapabilityRecord {
  return {
    token,
    ownerId,
    documentId,
    purpose: 'open',
    state: 'pending',
    realpath: `/real/${token}.jcx`,
    displayName: `${token}.jcx`,
    displayPath: `/shown/${token}.jcx`,
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    lastKnownDiskFingerprint: '0'.repeat(64),
    identity: null,
  };
}

function mustAdd(table: CapabilityTable, rec: OpenCapabilityRecord): CapabilityTable {
  const result = addPending(table, rec);
  if (!result.ok) throw new Error(result.reason);
  return result.table;
}

function mustActivate(table: CapabilityTable, ownerId: number, token: string): { table: CapabilityTable; superseded: readonly string[] } {
  const result = activate(table, ownerId, token);
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe('能力表 —— addPending / lookupActive', () => {
  it('pending 能力不可用于授权；原表不被修改', () => {
    const empty = createCapabilityTable();
    const table = mustAdd(empty, record('t1'));
    expect(empty.size).toBe(0);
    expect(table.get('t1')?.state).toBe('pending');
    expect(lookupActive(table, 1, 't1')).toBeNull();
  });

  it('token 重复（任何 owner / 状态）→ duplicate-token；非 pending 记录 → not-pending', () => {
    const table = mustAdd(createCapabilityTable(), record('t1', 1));
    expect(addPending(table, record('t1', 2))).toEqual({ ok: false, reason: 'duplicate-token' });
    expect(addPending(table, { ...record('t2'), state: 'active' })).toEqual({ ok: false, reason: 'not-pending' });
  });

  it('登记的记录被冻结', () => {
    const table = mustAdd(createCapabilityTable(), record('t1'));
    expect(Object.isFrozen(table.get('t1'))).toBe(true);
  });
});

describe('能力表 —— activate', () => {
  it('同 owner pending → active，可 lookupActive；跨 owner lookup 无效', () => {
    const base = mustAdd(createCapabilityTable(), record('t1', 1));
    const { table, superseded } = mustActivate(base, 1, 't1');
    expect(superseded).toEqual([]);
    expect(base.get('t1')?.state).toBe('pending');
    expect(lookupActive(table, 1, 't1')?.state).toBe('active');
    expect(lookupActive(table, 2, 't1')).toBeNull();
    expect(lookupActive(table, 1, 'missing')).toBeNull();
  });

  it('跨 owner 激活与不存在都报告 not-found；重复激活报告 not-pending', () => {
    const base = mustAdd(createCapabilityTable(), record('t1', 1));
    expect(activate(base, 2, 't1')).toEqual({ ok: false, reason: 'not-found' });
    expect(activate(base, 1, 'nope')).toEqual({ ok: false, reason: 'not-found' });
    const { table } = mustActivate(base, 1, 't1');
    expect(activate(table, 1, 't1')).toEqual({ ok: false, reason: 'not-pending' });
  });

  it('激活不自动吊销：同 owner 旧 active 作为 superseded 返回且仍然有效；其它 owner 与 pending 不在其中', () => {
    let table = mustAdd(createCapabilityTable(), record('old', 1));
    table = mustActivate(table, 1, 'old').table;
    table = mustAdd(table, record('other-owner', 2));
    table = mustActivate(table, 2, 'other-owner').table;
    table = mustAdd(table, record('still-pending', 1));
    table = mustAdd(table, record('new', 1));
    const result = mustActivate(table, 1, 'new');
    expect(result.superseded).toEqual(['old']);
    expect(lookupActive(result.table, 1, 'old')).not.toBeNull();
    expect(lookupActive(result.table, 1, 'new')).not.toBeNull();
    const revoked = revoke(result.table, 1, result.superseded);
    expect(revoked.removed).toEqual(['old']);
    expect(lookupActive(revoked.table, 1, 'old')).toBeNull();
    expect(lookupActive(revoked.table, 2, 'other-owner')).not.toBeNull();
    expect(revoked.table.get('still-pending')?.state).toBe('pending');
  });
});

describe('能力表 —— revoke / discardPending / revokeOwner', () => {
  it('revoke 只吊销同 owner 的指定 token；原表不变', () => {
    let table = mustAdd(createCapabilityTable(), record('a', 1));
    table = mustAdd(table, record('b', 2));
    const result = revoke(table, 1, ['a', 'b']);
    expect(result.removed).toEqual(['a']);
    expect([...result.table.keys()]).toEqual(['b']);
    expect(table.size).toBe(2);
  });

  it('discardPending 只丢弃同 owner 的 pending；active 与跨 owner 不受影响', () => {
    let table = mustAdd(createCapabilityTable(), record('p', 1));
    table = mustAdd(table, record('a', 1));
    table = mustActivate(table, 1, 'a').table;
    expect(discardPending(table, 2, 'p').removed).toEqual([]);
    expect(discardPending(table, 1, 'a').removed).toEqual([]);
    const result = discardPending(table, 1, 'p');
    expect(result.removed).toEqual(['p']);
    expect([...result.table.keys()]).toEqual(['a']);
  });

  it('revokeOwner 清空该 owner 的 pending 与 active，保留其它 owner', () => {
    let table = mustAdd(createCapabilityTable(), record('p', 1));
    table = mustAdd(table, record('a', 1));
    table = mustActivate(table, 1, 'a').table;
    table = mustAdd(table, record('x', 2));
    const result = revokeOwner(table, 1);
    expect(result.removed).toEqual(['p', 'a']);
    expect([...result.table.keys()]).toEqual(['x']);
  });
});

describe('documentId 分配器（D2）', () => {
  it('从 1 开始严格递增；各分配器互相独立', () => {
    const first = createDocumentIdAllocator();
    expect([first.next(), first.next(), first.next()]).toEqual([1, 2, 3]);
    expect(createDocumentIdAllocator().next()).toBe(1);
  });

  it('到达 Number.MAX_SAFE_INTEGER 后抛 RangeError，不回绕、不重复', () => {
    const near = createDocumentIdAllocator(Number.MAX_SAFE_INTEGER - 1);
    expect(near.next()).toBe(Number.MAX_SAFE_INTEGER);
    expect(() => near.next()).toThrow(RangeError);
    expect(() => near.next()).toThrow(RangeError);
  });

  it('非法起点是编程错误', () => {
    expect(() => createDocumentIdAllocator(-1)).toThrow(RangeError);
    expect(() => createDocumentIdAllocator(0.5)).toThrow(RangeError);
  });
});
