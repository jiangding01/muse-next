/**
 * M3 T1b-1：Open 激活协调器（requestSeq 严格最新、generation、TTL、跨窗口隔离、单一事实来源）。
 *
 * 每个场景在每一步迁移后都断言 `coordinatorInvariantViolations` 为空；授权只经 `authorizeCapability`（只认 active）。
 */

import { describe, expect, it } from 'vitest';

import {
  activateDocument,
  authorizeCapability,
  beginOpen,
  completeOpen,
  createOpenCoordinator,
  disposeOwner,
  endDialog,
  registerOwner,
  resetOwner,
} from '../../../src/main/open/openCoordinator';
import type { OpenCoordinatorState } from '../../../src/main/open/openCoordinator';
import { acceptedTicket, decodeFailure, expectConsistent, opened, tokensOf } from './coordinatorFixtures';

const W = 1;
const OTHER = 2;
const T0 = 1_000;

function fresh(): OpenCoordinatorState {
  return registerOwner(registerOwner(createOpenCoordinator(), W), OTHER);
}

/** 完整走一遍 Open → activate，返回状态（断言每步一致）。 */
function openAndActivate(state: OpenCoordinatorState, token: string, documentId: number, now = T0): OpenCoordinatorState {
  const begun = beginOpen(state, W);
  const ticket = acceptedTicket(begun.result);
  const file = opened(W, token, documentId);
  const done = completeOpen(endDialog(begun.state, ticket), ticket, file.completion, now);
  expectConsistent(done.state);
  const active = activateDocument(done.state, W, file.ticket, now);
  expect(active.result.reply).toEqual({ ok: true });
  expectConsistent(active.state);
  return active.state;
}

describe('openCoordinator —— 基本生命周期', () => {
  it('pending 不可授权；激活后才可授权；回复只表示 main 已激活', () => {
    const begun = beginOpen(fresh(), W);
    const ticket = acceptedTicket(begun.result);
    expect(ticket).toEqual({ ownerId: W, requestSeq: 1, generation: 1 });
    const file = opened(W, 'a', 11);
    const done = completeOpen(begun.state, ticket, file.completion, T0);
    expect(done.result).toEqual({ kind: 'opened', document: file.completion.document });
    expect(authorizeCapability(done.state, W, 'a')).toBeNull();
    expectConsistent(done.state);

    const active = activateDocument(done.state, W, file.ticket, T0);
    // 回复不含任何「renderer 已提交」之类的字段；协调器状态里也没有这种事实。
    expect(active.result.reply).toEqual({ ok: true });
    expect(Object.keys(active.state.owners.get(W) ?? {}).sort()).toEqual(['candidates', 'dialogOpen', 'generation', 'inFlightSeq', 'latestRequestSeq']);
    expect(authorizeCapability(active.state, W, 'a')?.state).toBe('active');
    expectConsistent(active.state);
  });

  it('未登记的 owner：beginOpen 返回 unknown-owner，状态不变', () => {
    const state = fresh();
    const result = beginOpen(state, 99);
    expect(result.result).toEqual({ kind: 'unknown-owner' });
    expect(result.state).toBe(state);
  });

  it('迁移不修改入参状态', () => {
    const state = openAndActivate(fresh(), 'a', 11);
    const snapshot = JSON.stringify([...state.table.keys()]);
    beginOpen(state, W);
    resetOwner(state, W);
    disposeOwner(state, W);
    expect(JSON.stringify([...state.table.keys()])).toBe(snapshot);
    expect(authorizeCapability(state, W, 'a')?.state).toBe('active');
  });

  it('非法 ttl / now 是编程错误', () => {
    expect(() => createOpenCoordinator(0)).toThrow(RangeError);
    const begun = beginOpen(fresh(), W);
    expect(() => completeOpen(begun.state, acceptedTicket(begun.result), { kind: 'canceled' }, Number.NaN)).toThrow(RangeError);
  });

  it('completeOpen 拒绝不属于该请求的能力记录', () => {
    const begun = beginOpen(fresh(), W);
    const foreign = opened(OTHER, 'x', 5);
    expect(() => completeOpen(begun.state, acceptedTicket(begun.result), foreign.completion, T0)).toThrow();
  });
});

describe('openCoordinator —— 替换、取消、失败', () => {
  it('第二次 Open 激活后才吊销旧 active；读取成功时不吊销', () => {
    const withA = openAndActivate(fresh(), 'a', 11);
    const begun = beginOpen(withA, W);
    const ticket = acceptedTicket(begun.result);
    const b = opened(W, 'b', 12);
    const done = completeOpen(begun.state, ticket, b.completion, T0);
    expect(authorizeCapability(done.state, W, 'a')?.state).toBe('active');
    const active = activateDocument(done.state, W, b.ticket, T0);
    expect(active.result.revoked).toEqual(['a']);
    expect(authorizeCapability(active.state, W, 'a')).toBeNull();
    expect(tokensOf(active.state, W, 'active')).toEqual(['b']);
    expectConsistent(active.state);
  });

  it('取消与解码失败：原样回复，旧 active 保持，不登记任何能力', () => {
    const withA = openAndActivate(fresh(), 'a', 11);
    for (const completion of [{ kind: 'canceled' } as const, decodeFailure]) {
      const begun = beginOpen(withA, W);
      const done = completeOpen(begun.state, acceptedTicket(begun.result), completion, T0);
      expect(done.result).toEqual(completion);
      expect(tokensOf(done.state, W, 'active')).toEqual(['a']);
      expect(tokensOf(done.state, W, 'pending')).toEqual([]);
      expect(done.state.owners.get(W)?.dialogOpen).toBe(false);
      expectConsistent(done.state);
    }
  });

  it('A pending → B 被接受并取消：A 已失效、能力表与元数据无遗留', () => {
    const begunA = beginOpen(fresh(), W);
    const a = opened(W, 'a', 11);
    const pendingA = completeOpen(begunA.state, acceptedTicket(begunA.result), a.completion, T0).state;
    const begunB = beginOpen(pendingA, W);
    expect(begunB.result.kind === 'accepted' && begunB.result.discarded).toEqual(['a']);
    const canceled = completeOpen(begunB.state, acceptedTicket(begunB.result), { kind: 'canceled' }, T0).state;
    expect(canceled.table.size).toBe(0);
    expect(canceled.owners.get(W)?.candidates.size).toBe(0);
    expect(activateDocument(canceled, W, a.ticket, T0).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expectConsistent(canceled);
  });
});

describe('openCoordinator —— requestSeq 严格最新', () => {
  it('Open A → Open B → B 先完成 → A 迟到：A 被 superseded，不登记', () => {
    const begunA = beginOpen(fresh(), W);
    const ticketA = acceptedTicket(begunA.result);
    const afterDialogA = endDialog(begunA.state, ticketA);
    const begunB = beginOpen(afterDialogA, W);
    const ticketB = acceptedTicket(begunB.result);
    const b = opened(W, 'b', 12);
    const doneB = completeOpen(begunB.state, ticketB, b.completion, T0);
    const lateA = completeOpen(doneB.state, ticketA, opened(W, 'a', 11).completion, T0);
    expect(lateA.result).toEqual({ kind: 'rejected', reason: 'superseded' });
    expect(lateA.state.table.has('a')).toBe(false);
    expect(activateDocument(lateA.state, W, b.ticket, T0).result.reply).toEqual({ ok: true });
    expectConsistent(lateA.state);
  });

  it('A pending → B 已激活 → A 迟到确认：被拒绝，且不吊销 B', () => {
    const begunA = beginOpen(fresh(), W);
    const a = opened(W, 'a', 11);
    const pendingA = completeOpen(begunA.state, acceptedTicket(begunA.result), a.completion, T0).state;
    const withB = openAndActivate(pendingA, 'b', 12);
    const lateAck = activateDocument(withB, W, a.ticket, T0);
    expect(lateAck.result).toEqual({ reply: { ok: false, code: 'capability-invalid' }, revoked: [] });
    expect(tokensOf(lateAck.state, W, 'active')).toEqual(['b']);
    expectConsistent(lateAck.state);
  });

  it('busy：对话框打开期间的新请求被拒绝、不占代次，当前请求照常完成与激活', () => {
    const begunA = beginOpen(fresh(), W);
    const ticketA = acceptedTicket(begunA.result);
    const busy = beginOpen(begunA.state, W);
    expect(busy.result).toEqual({ kind: 'busy' });
    expect(busy.state).toBe(begunA.state);
    expect(busy.state.owners.get(W)?.latestRequestSeq).toBe(1);
    const a = opened(W, 'a', 11);
    const done = completeOpen(busy.state, ticketA, a.completion, T0);
    expect(done.result?.kind).toBe('opened');
    expect(activateDocument(done.state, W, a.ticket, T0).result.reply).toEqual({ ok: true });
  });

  it('对话框关闭后、读取完成前允许新请求，它取代仍在读取的旧请求', () => {
    const begunA = beginOpen(fresh(), W);
    const ticketA = acceptedTicket(begunA.result);
    const begunB = beginOpen(endDialog(begunA.state, ticketA), W);
    expect(begunB.result.kind).toBe('accepted');
    expect(completeOpen(begunB.state, ticketA, opened(W, 'a', 11).completion, T0).result).toEqual({ kind: 'rejected', reason: 'superseded' });
  });

  it('endDialog 对过期票据无效（不清除较新请求的 dialogOpen）', () => {
    const begunA = beginOpen(fresh(), W);
    const ticketA = acceptedTicket(begunA.result);
    const begunB = beginOpen(endDialog(begunA.state, ticketA), W);
    expect(endDialog(begunB.state, ticketA).owners.get(W)?.dialogOpen).toBe(true);
  });
});

describe('openCoordinator —— generation（reload / 渲染进程退出 / 窗口销毁）', () => {
  it('Open A → reload：A 完成时 superseded；reload 清空 pending 与 active；dialogOpen 随 A 的对话框结束而清除', () => {
    const withOld = openAndActivate(fresh(), 'old', 10);
    const begunA = beginOpen(withOld, W);
    const ticketA = acceptedTicket(begunA.result);
    const reset = resetOwner(begunA.state, W);
    expect(reset.result).toEqual(['old']);
    expect(reset.state.owners.get(W)?.generation).toBe(2);
    expect(reset.state.owners.get(W)?.dialogOpen).toBe(true);
    const late = completeOpen(reset.state, ticketA, opened(W, 'a', 11).completion, T0);
    expect(late.result).toEqual({ kind: 'rejected', reason: 'superseded' });
    expect(late.state.table.size).toBe(0);
    expect(late.state.owners.get(W)?.dialogOpen).toBe(false);
    expectConsistent(late.state);
  });

  it('pending 之后 reload：迟到确认被拒绝', () => {
    const begun = beginOpen(fresh(), W);
    const a = opened(W, 'a', 11);
    const pending = completeOpen(begun.state, acceptedTicket(begun.result), a.completion, T0).state;
    const reset = resetOwner(pending, W).state;
    expect(activateDocument(reset, W, a.ticket, T0).result.reply).toEqual({ ok: false, code: 'capability-invalid' });
    expectConsistent(reset);
  });

  it('窗口销毁：清空该窗口能力并移除 owner；迟到完成无回复；其它窗口不受影响；幂等', () => {
    const begunOther = beginOpen(fresh(), OTHER);
    const otherFile = opened(OTHER, 'o', 20);
    let state = completeOpen(begunOther.state, acceptedTicket(begunOther.result), otherFile.completion, T0).state;
    state = activateDocument(state, OTHER, otherFile.ticket, T0).state;
    state = openAndActivate(state, 'a', 11);
    const begun = beginOpen(state, W);
    const ticket = acceptedTicket(begun.result);
    const disposed = disposeOwner(disposeOwner(begun.state, W).state, W).state;
    expect(disposed.owners.has(W)).toBe(false);
    expect(tokensOf(disposed, W, 'active')).toEqual([]);
    expect(completeOpen(disposed, ticket, opened(W, 'b', 12).completion, T0).result).toBeNull();
    expect(authorizeCapability(disposed, OTHER, 'o')?.state).toBe('active');
    expectConsistent(disposed);
  });
});
