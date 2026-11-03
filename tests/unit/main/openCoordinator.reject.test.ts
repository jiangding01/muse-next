/**
 * M3 T4 B2：reject 的幂等应答与锚点（Gate A 补充要求；B1 CHANGE-LIST §6.1；B2 r0 §3.6）。
 *
 * `rejectDocument` 恒回 `{ ok: true }`。只有票据指向当前锚点（`committed = record(t)`，active 或墓碑）时才回退锚点；
 * pending 走 A3（丢弃、锚点不变）；其它情形一律**无状态变化**——这里逐类断言锚点与表都没有被错误改变。
 */

import { describe, expect, it } from 'vitest';

import { anchorTo } from '../../../src/main/open/anchorChain';
import {
  activateDocument,
  beginOpen,
  completeOpen,
  createOpenCoordinator,
  rebuildOwner,
  registerOwner,
  rejectDocument,
  resetOwner,
} from '../../../src/main/open/openCoordinator';
import type { OpenCoordinatorState } from '../../../src/main/open/openCoordinator';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';
import { acceptedTicket, expectConsistent, opened } from './coordinatorFixtures';

const W = 1;
const OTHER = 2;
const T0 = 1_000;

function fresh(): OpenCoordinatorState {
  return registerOwner(registerOwner(createOpenCoordinator(), W), OTHER);
}

function openPending(state: OpenCoordinatorState, token: string, documentId: number): { state: OpenCoordinatorState; ticket: DocumentActivationTicket } {
  const begun = beginOpen(state, W);
  const file = opened(W, token, documentId);
  return { state: completeOpen(begun.state, acceptedTicket(begun.result), file.completion, T0).state, ticket: file.ticket };
}

function openActive(state: OpenCoordinatorState, token: string, documentId: number): OpenCoordinatorState {
  const pending = openPending(state, token, documentId);
  return activateDocument(pending.state, W, pending.ticket, T0).state;
}

/** reject 之后状态对象原样返回（零修改），应答为 `{ ok: true }`。 */
function expectUnchanged(state: OpenCoordinatorState, ownerId: number, ticket: DocumentActivationTicket): void {
  const step = rejectDocument(state, ownerId, ticket);
  expect(step.result).toEqual({ reply: { ok: true }, removed: [] });
  expect(step.state).toBe(state);
}

describe('reject：锚点不会被错误改变', () => {
  const base = (): OpenCoordinatorState => openActive(openActive(fresh(), 'X', 11), 'Y', 12);

  it('未知票据', () => {
    expectUnchanged(base(), W, { capabilityId: 'never-issued', documentId: 12 });
  });

  it('跨窗口：另一个 owner 发来当前锚点的票据', () => {
    expectUnchanged(base(), OTHER, { capabilityId: 'Y', documentId: 12 });
  });

  it('documentId 不符', () => {
    expectUnchanged(base(), W, { capabilityId: 'Y', documentId: 99 });
  });

  it('不是当前锚点的墓碑（被取代的 X，committed = Y）', () => {
    const state = base();
    expect(state.owners.get(W)?.committed).toEqual(anchorTo('Y'));
    expect(state.table.get('X')?.purpose).toBe('tombstone');
    expectUnchanged(state, W, { capabilityId: 'X', documentId: 11 });
  });

  it('旧代次：A4 丢弃了 pending 候选之后，旧页面 reject 该候选', () => {
    const pending = openPending(base(), 'P', 13);
    const reset = resetOwner(pending.state, W).state;
    expect(reset.table.has('P')).toBe(false);
    expectUnchanged(reset, W, pending.ticket);
    expect(reset.owners.get(W)?.committed).toEqual(anchorTo('Y'));
  });

  it('已被 A5 处理：页面重建之后旧页面 reject 原锚点', () => {
    const rebuilt = rebuildOwner(base(), W).state;
    expectUnchanged(rebuilt, W, { capabilityId: 'Y', documentId: 12 });
    expectUnchanged(rebuilt, W, { capabilityId: 'X', documentId: 11 });
    expect(rebuilt.owners.get(W)?.committed).toEqual({ kind: 'none' });
  });

  it('已被修剪的祖先（X → Y → Z 之后 reject X）', () => {
    const state = openActive(base(), 'Z', 13);
    expect(state.table.has('X')).toBe(false);
    expectUnchanged(state, W, { capabilityId: 'X', documentId: 11 });
  });
});

describe('reject：合法的状态变化', () => {
  it('pending（A3）：丢弃候选，锚点与 active 不变', () => {
    const pending = openPending(openActive(fresh(), 'X', 11), 'P', 12);
    const step = rejectDocument(pending.state, W, pending.ticket);
    expect(step.result).toEqual({ reply: { ok: true }, removed: ['P'] });
    expect(step.state.table.has('P')).toBe(false);
    expect(step.state.owners.get(W)?.committed).toEqual(anchorTo('X'));
    expectConsistent(step.state);
  });

  it('当前锚点 active（A2）：转墓碑、回退到 prevCommitted；被取代的记录不恢复授权', () => {
    const state = openActive(openActive(fresh(), 'X', 11), 'Y', 12);
    const step = rejectDocument(state, W, { capabilityId: 'Y', documentId: 12 });
    expect(step.result).toEqual({ reply: { ok: true }, removed: ['Y'] });
    expect(step.state.owners.get(W)?.committed).toEqual(anchorTo('X'));
    expect(step.state.table.get('X')?.purpose).toBe('tombstone');
    expectConsistent(step.state);
  });

  it(`当前锚点墓碑（A2'，A4 之后页面仍存活）：回退，removed 为空（墓碑本就不授权）`, () => {
    const reset = resetOwner(openActive(openActive(fresh(), 'X', 11), 'Y', 12), W).state;
    const step = rejectDocument(reset, W, { capabilityId: 'Y', documentId: 12 });
    expect(step.result).toEqual({ reply: { ok: true }, removed: [] });
    expect(step.state.owners.get(W)?.committed).toEqual(anchorTo('X'));
    expectConsistent(step.state);
  });
});
