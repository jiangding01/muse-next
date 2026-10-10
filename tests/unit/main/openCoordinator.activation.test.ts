/**
 * M3 T1b-1：激活 / 拒绝的边界——TTL、重复与不确定结果、documentId 不符、跨窗口隔离、拒绝语义，以及不变量自检。
 */

import { describe, expect, it } from 'vitest';

import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
import {
  activateDocument,
  authorizeCapability,
  beginOpen,
  completeOpen,
  createOpenCoordinator,
  endDialog,
  expireCandidates,
  PENDING_TTL_MS,
  registerOwner,
  rejectDocument,
} from '../../../src/main/open/openCoordinator';
import type { OpenCoordinatorState } from '../../../src/main/open/openCoordinator';
import { acceptedTicket, expectConsistent, opened, tokensOf } from './coordinatorFixtures';
import type { Opened } from './coordinatorFixtures';

const W = 1;
const OTHER = 2;
const T0 = 5_000;

function pendingFor(token: string, documentId: number, state: OpenCoordinatorState = registerOwner(registerOwner(createOpenCoordinator(), W), OTHER)): { state: OpenCoordinatorState; file: Opened } {
  const begun = beginOpen(state, W);
  const file = opened(W, token, documentId);
  return { state: completeOpen(begun.state, acceptedTicket(begun.result), file.completion, T0).state, file };
}

describe('TTL（120 s，从 pending 登记时计时）', () => {
  it('默认 TTL 为 120 秒，候选的 expiresAt = 登记时刻 + TTL', () => {
    expect(PENDING_TTL_MS).toBe(120_000);
    const { state } = pendingFor('a', 11);
    expect(state.owners.get(W)?.candidates.get('a')?.expiresAt).toBe(T0 + 120_000);
  });

  it('到期前一刻可以激活；到期时刻被拒绝并丢弃候选', () => {
    const { state, file } = pendingFor('a', 11);
    expect(activateDocument(state, W, file.ticket, T0 + PENDING_TTL_MS - 1).result.reply).toEqual({ ok: true });
    const expired = activateDocument(state, W, file.ticket, T0 + PENDING_TTL_MS);
    expect(expired.result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expect(expired.state.table.has('a')).toBe(false);
    expectConsistent(expired.state);
  });

  it('documentId 不符的确认、重复确认都不会续期', () => {
    const { state, file } = pendingFor('a', 11);
    let current = state;
    for (const at of [T0 + 1, T0 + 60_000, T0 + 119_999]) {
      current = activateDocument(current, W, { ...file.ticket, documentId: 99 }, at).state;
    }
    expect(current.owners.get(W)?.candidates.get('a')?.expiresAt).toBe(T0 + PENDING_TTL_MS);
    expect(activateDocument(current, W, file.ticket, T0 + PENDING_TTL_MS).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it('expireCandidates 清理所有窗口的全部过期候选（不只第一个）', () => {
    const first = pendingFor('a', 11);
    const begunOther = beginOpen(first.state, OTHER);
    const other = opened(OTHER, 'o', 21);
    const both = completeOpen(begunOther.state, acceptedTicket(begunOther.result), other.completion, T0).state;
    const swept = expireCandidates(both, T0 + PENDING_TTL_MS);
    expect([...swept.result].sort()).toEqual(['a', 'o']);
    expect(swept.state.table.size).toBe(0);
    expectConsistent(swept.state);
  });

  it('expireCandidates 以 now >= expiresAt 为界清理，迟到确认随后被拒绝', () => {
    const { state, file } = pendingFor('a', 11);
    expect(expireCandidates(state, T0 + PENDING_TTL_MS - 1).result).toEqual([]);
    const swept = expireCandidates(state, T0 + PENDING_TTL_MS);
    expect(swept.result).toEqual(['a']);
    expect(activateDocument(swept.state, W, file.ticket, T0).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expectConsistent(swept.state);
  });

  it('过期的候选不恢复旧 active，也不吊销它', () => {
    const base = pendingFor('old', 10);
    const withOld = activateDocument(base.state, W, base.file.ticket, T0).state;
    const { state, file } = pendingFor('a', 11, withOld);
    const late = activateDocument(state, W, file.ticket, T0 + PENDING_TTL_MS);
    expect(tokensOf(late.state, W, 'active')).toEqual(['old']);
    expect(late.result.revoked).toEqual([]);
  });
});

describe('重复确认与不确定结果（T1c fail-closed 恢复合同）', () => {
  it('激活成功后重复确认幂等：仍为 ok、不吊销、状态不变——不确定的调用方据此得到确定答案', () => {
    const { state, file } = pendingFor('a', 11);
    const first = activateDocument(state, W, file.ticket, T0);
    const again = activateDocument(first.state, W, file.ticket, T0 + PENDING_TTL_MS * 10);
    expect(again.result).toEqual({ reply: { ok: true }, revoked: [] });
    expect(again.state).toBe(first.state);
  });

  it('激活成功但调用方未观察到应答：协议只表达「已 active」，调用方放弃时 reject 吊销它，且不恢复被取代的旧能力', () => {
    const base = pendingFor('old', 10);
    const withOld = activateDocument(base.state, W, base.file.ticket, T0).state;
    const { state, file } = pendingFor('a', 11, withOld);
    const activated = activateDocument(state, W, file.ticket, T0).state;
    expect(authorizeCapability(activated, W, 'old')).toBeNull();
    const abandoned = rejectDocument(activated, W, file.ticket);
    expect(abandoned.result).toEqual({ reply: { ok: true }, removed: ['a'] });
    expect(authorizeCapability(abandoned.state, W, 'a')).toBeNull();
    expect(authorizeCapability(abandoned.state, W, 'old')).toBeNull();
    expect(abandoned.state.table.size).toBe(0);
    expectConsistent(abandoned.state);
  });

  it('未激活的候选被拒绝后再确认 → capability-invalid（确定的失败）', () => {
    const { state, file } = pendingFor('a', 11);
    const rejected = rejectDocument(state, W, file.ticket).state;
    expect(activateDocument(rejected, W, file.ticket, T0).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
  });
});

describe('documentId 与跨窗口隔离', () => {
  it('documentId 不符 → document-mismatch，不改状态，候选仍可被正确确认', () => {
    const { state, file } = pendingFor('a', 11);
    const mismatch = activateDocument(state, W, { capabilityId: 'a', documentId: 12 }, T0);
    expect(mismatch.result.reply).toEqual({ ok: false, code: 'document-mismatch' });
    expect(mismatch.state).toBe(state);
    expect(activateDocument(state, W, file.ticket, T0).result.reply).toEqual({ ok: true });
  });

  it('已 active 能力的 documentId 不符同样 document-mismatch', () => {
    const { state, file } = pendingFor('a', 11);
    const active = activateDocument(state, W, file.ticket, T0).state;
    expect(activateDocument(active, W, { capabilityId: 'a', documentId: 12 }, T0).result.reply).toEqual({ ok: false, code: 'document-mismatch' });
  });

  it('其它窗口用本窗口的 token 激活 / 拒绝 / 授权：一律无效且零状态修改；未知 token 同样', () => {
    const { state, file } = pendingFor('a', 11);
    const crossActivate = activateDocument(state, OTHER, file.ticket, T0);
    expect(crossActivate.result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expect(crossActivate.state).toBe(state);
    expect(rejectDocument(state, OTHER, file.ticket).state).toBe(state);
    expect(activateDocument(state, W, { capabilityId: 'nope', documentId: 11 }, T0).state).toBe(state);
    const active = activateDocument(state, W, file.ticket, T0).state;
    expect(authorizeCapability(active, OTHER, 'a')).toBeNull();
    expect(rejectDocument(active, OTHER, file.ticket).state).toBe(active);
    expect(activateDocument(active, 99, file.ticket, T0).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it('documentId 不符的 reject 不改状态；重复 reject 幂等', () => {
    const { state, file } = pendingFor('a', 11);
    expect(rejectDocument(state, W, { capabilityId: 'a', documentId: 12 }).state).toBe(state);
    const once = rejectDocument(state, W, file.ticket).state;
    const twice = rejectDocument(once, W, file.ticket);
    expect(twice.state).toBe(once);
    expect(twice.result).toEqual({ reply: { ok: true }, removed: [] });
  });
});

describe('票据只能完成一次，异常路径可恢复', () => {
  it('同一张票重复完成 → superseded，不登记第二个候选', () => {
    const begun = beginOpen(registerOwner(createOpenCoordinator(), W), W);
    const ticket = acceptedTicket(begun.result);
    const first = completeOpen(begun.state, ticket, opened(W, 'a', 11).completion, T0);
    const second = completeOpen(first.state, ticket, opened(W, 'b', 12).completion, T0);
    expect(second.result).toEqual({ kind: 'rejected', reason: 'superseded' });
    expect(tokensOf(second.state, W, 'pending')).toEqual(['a']);
    expectConsistent(second.state);
  });

  it('激活之后同一张票再完成一次 → superseded，不能借此吊销已激活的能力', () => {
    const begun = beginOpen(registerOwner(createOpenCoordinator(), W), W);
    const ticket = acceptedTicket(begun.result);
    const a = opened(W, 'a', 11);
    const pending = completeOpen(begun.state, ticket, a.completion, T0).state;
    const active = activateDocument(pending, W, a.ticket, T0).state;
    const replay = completeOpen(active, ticket, opened(W, 'b', 12).completion, T0);
    expect(replay.result).toEqual({ kind: 'rejected', reason: 'superseded' });
    expect(replay.state.table.has('b')).toBe(false);
    expect(tokensOf(replay.state, W, 'active')).toEqual(['a']);
  });

  it('completeOpen 因编程错误抛出后，对最新状态调用 endDialog 即可恢复（T1b-2 finally 约束）', () => {
    const base = pendingFor('x', 20);
    const begun = beginOpen(registerOwner(base.state, OTHER), OTHER);
    const ticket = acceptedTicket(begun.result);
    // token 与 W 的候选重复 → addPending 失败 → 抛出；调用方手里仍是 beginOpen 之后的状态。
    expect(() => completeOpen(begun.state, ticket, opened(OTHER, 'x', 21).completion, T0)).toThrow(/duplicate-token/);
    expect(beginOpen(begun.state, OTHER).result).toEqual({ kind: 'busy' });
    const recovered = endDialog(begun.state, ticket);
    expect(beginOpen(recovered, OTHER).result.kind).toBe('accepted');
    expectConsistent(recovered);
  });
});

describe('纵深防御：元数据被破坏时激活仍然拒绝旧代次 / 旧请求', () => {
  // 正常迁移下 beginOpen / resetOwner 已清除所有过期候选，这里直接构造违反不变量的状态，证明激活本身也会把关。
  it.each([
    ['候选属于旧 generation', { generation: 1, requestSeq: 1 }, { generation: 2, latestRequestSeq: 1 }],
    ['候选不是最新请求', { generation: 1, requestSeq: 1 }, { generation: 1, latestRequestSeq: 2 }],
  ] as const)('%s → capability-invalid 且丢弃候选', (_label, candidate, owner) => {
    const { state, file } = pendingFor('a', 11);
    const meta = state.owners.get(W);
    if (meta === undefined) throw new Error('owner missing');
    const corrupted: OpenCoordinatorState = {
      ...state,
      owners: new Map([
        ...state.owners,
        [W, { ...meta, ...owner, candidates: new Map([['a', { ...candidate, expiresAt: T0 + PENDING_TTL_MS }]]) }],
      ]),
    };
    const result = activateDocument(corrupted, W, file.ticket, T0);
    expect(result.result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expect(result.state.table.has('a')).toBe(false);
  });
});

describe('coordinatorInvariantViolations 自检（能识别分叉）', () => {
  it('pending 记录缺少候选元数据、候选缺少 pending 记录、未登记的 owner 都会被报告', () => {
    const { state } = pendingFor('a', 11);
    const meta = state.owners.get(W);
    if (meta === undefined) throw new Error('owner missing');
    const noMeta: OpenCoordinatorState = { ...state, owners: new Map([...state.owners, [W, { ...meta, candidates: new Map() }]]) };
    expect(coordinatorInvariantViolations(noMeta)).toContain('pending a has no candidate metadata');
    const noRecord: OpenCoordinatorState = { ...state, table: new Map() };
    expect(coordinatorInvariantViolations(noRecord)).toContain('candidate a has no pending record');
    const orphan: OpenCoordinatorState = { ...state, owners: new Map([[OTHER, state.owners.get(OTHER) ?? meta]]) };
    expect(coordinatorInvariantViolations(orphan).some((v) => v.includes('unregistered owner'))).toBe(true);
  });

  it('旧 generation 的候选、非最新请求的候选、两个 active 都会被报告', () => {
    const { state } = pendingFor('a', 11);
    const meta = state.owners.get(W);
    if (meta === undefined) throw new Error('owner missing');
    const aged: OpenCoordinatorState = { ...state, owners: new Map([...state.owners, [W, { ...meta, generation: 2, latestRequestSeq: 2 }]]) };
    const violations = coordinatorInvariantViolations(aged);
    expect(violations).toContain('candidate a belongs to an old generation');
    expect(violations).toContain('candidate a is not the latest request');
    const record = state.table.get('a');
    if (record === undefined) throw new Error('record missing');
    const twoActive: OpenCoordinatorState = {
      ...state,
      owners: new Map([...state.owners, [W, { ...meta, candidates: new Map() }]]),
      table: new Map([
        ['a', { ...record, state: 'active' }],
        ['b', { ...record, token: 'b', state: 'active' }],
      ]),
    };
    expect(coordinatorInvariantViolations(twoActive)).toContain('owner 1 has more than one active capability');
  });
});
