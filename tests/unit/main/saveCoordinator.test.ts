/**
 * M3 T4 B2：保存协调器纯函数（`src/main/open/saveCoordinator.ts`）。
 *
 * 覆盖：保存操作票据（勘误 §2，T-OP-1～7 的协调器部分）、普通 Save 授权、Save As 阶段 1 开始与授予（含 F2：对话框返回后
 * 重新验证 R19 / 锚点 / generation / 票据）、阶段 2 一次性消费（F2）与错误优先级（Q-B2-5）、R19 的 main 侧（T-H7）、
 * TTL、跨 owner 隔离与 A9（勘误 §3.3）。
 */

import { describe, expect, it } from 'vitest';

import type { SaveTargetGrant, WrittenFacts } from '../../../src/main/document/savePipeline';
import { anchorTo, NO_ANCHOR } from '../../../src/main/open/anchorChain';
import {
  activateDocument,
  authorizeCapability,
  beginOpen,
  completeOpen,
  createOpenCoordinator,
  disposeOwner,
  rebuildOwner,
  registerOwner,
  rejectDocument,
  resetOwner,
} from '../../../src/main/open/openCoordinator';
import type { OpenCoordinatorState, SaveOperation } from '../../../src/main/open/openCoordinator';
import {
  acquireSaveOperation,
  beginSave,
  beginSaveTarget,
  consumeSaveTarget,
  grantSaveTarget,
  holdsSaveOperation,
  releaseSaveOperation,
  SAVE_TARGET_TTL_MS,
  saveAsStillCurrent,
  saveStillCurrent,
  settleSave,
} from '../../../src/main/open/saveCoordinator';
import type { SaveAsTicket } from '../../../src/main/open/saveCoordinator';
import { acceptedTicket, expectConsistent, opened } from './coordinatorFixtures';

const W = 1;
const OTHER = 2;
const T0 = 1_000;
const GRANT: SaveTargetGrant = { kind: 'absent', parentRealpath: '/docs', basename: 'new.jcx' };
const WRITTEN: WrittenFacts = {
  realpath: '/docs/new.jcx',
  identity: { dev: 1n, ino: 77n },
  lastKnownDiskFingerprint: 'f'.repeat(64),
  writeEncoding: 'utf-8',
  byteBom: 'none',
  encodingRoundTrip: 'exact',
};

function fresh(): OpenCoordinatorState {
  return registerOwner(registerOwner(createOpenCoordinator(), W), OTHER);
}

function openActive(state: OpenCoordinatorState, token: string, documentId: number, ownerId = W): OpenCoordinatorState {
  const begun = beginOpen(state, ownerId);
  const file = opened(ownerId, token, documentId);
  const done = completeOpen(begun.state, acceptedTicket(begun.result), file.completion, T0);
  return activateDocument(done.state, ownerId, file.ticket, T0).state;
}

function acquired(state: OpenCoordinatorState, kind: SaveOperation['kind'] = 'save', ownerId = W): { state: OpenCoordinatorState; operation: SaveOperation } {
  const step = acquireSaveOperation(state, ownerId, kind);
  if (step.result.kind !== 'acquired') throw new Error(`expected acquired, got ${step.result.kind}`);
  return { state: step.state, operation: step.result.operation };
}

/** 阶段 1 全流程：开始 → 授予 → 释放；返回 G 的 token。 */
function granted(state: OpenCoordinatorState, source: string | null, token = 'G', ownerId = W, encoding: 'utf-8' | 'gb18030' = 'utf-8'): OpenCoordinatorState {
  const begun = beginSaveTarget(state, ownerId, source);
  if (!begun.result.ok) throw new Error(`begin refused: ${begun.result.code}`);
  const grant = grantSaveTarget(
    begun.state,
    ownerId,
    begun.result.operation,
    { token, sourceCapabilityId: source, anchorAtBegin: begun.result.anchor, encoding, target: GRANT, requestedPath: '/docs/new.jcx', displayName: 'new.jcx', displayPath: '/docs/new.jcx' },
    T0,
  );
  if (!grant.result.ok) throw new Error(`grant refused: ${grant.result.code}`);
  return releaseSaveOperation(grant.state, ownerId, begun.result.operation);
}

const ticketFor = (overrides: Partial<SaveAsTicket> = {}): SaveAsTicket => ({ capabilityId: 'G', documentId: 11, encoding: 'utf-8', sourceCapabilityId: 'X', ...overrides });

describe('保存操作票据（勘误 §2）', () => {
  it('T-OP-1：Save A → A4 → Save B → A 迟到释放 → Save C：A 的释放无效，C 得到 busy；B 完成后正常释放', () => {
    const a = acquired(fresh());
    const reset = resetOwner(a.state, W).state;
    expect(holdsSaveOperation(reset, W, a.operation)).toBe(false);
    const b = acquired(reset);
    expect(b.operation.id).toBeGreaterThan(a.operation.id);
    const lateRelease = releaseSaveOperation(b.state, W, a.operation);
    expect(lateRelease).toBe(b.state);
    expect(acquireSaveOperation(lateRelease, W, 'save').result).toEqual({ kind: 'busy' });
    const released = releaseSaveOperation(lateRelease, W, b.operation);
    expect(released.owners.get(W)?.saveOperation).toBeNull();
    expect(acquireSaveOperation(released, W, 'save').result.kind).toBe('acquired');
    expectConsistent(released);
  });

  it('T-OP-2：A5 同样清锁且旧操作不能释放新锁', () => {
    const a = acquired(fresh());
    const b = acquired(rebuildOwner(a.state, W).state);
    expect(releaseSaveOperation(b.state, W, a.operation)).toBe(b.state);
    expect(acquireSaveOperation(b.state, W, 'save').result).toEqual({ kind: 'busy' });
  });

  it('T-OP-3：A6（窗口销毁）后迟到释放：不抛出、不重新创建 owner 元数据', () => {
    const a = acquired(fresh());
    const disposed = disposeOwner(a.state, W).state;
    const late = releaseSaveOperation(disposed, W, a.operation);
    expect(late).toBe(disposed);
    expect(late.owners.has(W)).toBe(false);
  });

  it('T-OP-6：同 id、旧 generation 的伪造票据不能释放新锁；id 不随 reset 归零（不复用）', () => {
    const a = acquired(fresh());
    const reset = resetOwner(a.state, W).state;
    const b = acquired(reset);
    const forged: SaveOperation = { ...b.operation, generation: a.operation.generation };
    expect(releaseSaveOperation(b.state, W, forged)).toBe(b.state);
    expect(holdsSaveOperation(b.state, W, forged)).toBe(false);
    const ids = new Set<number>();
    let state = fresh();
    for (let i = 0; i < 5; i += 1) {
      const op = acquired(state);
      ids.add(op.operation.id);
      state = resetOwner(op.state, W).state;
    }
    expect(ids.size).toBe(5);
  });

  it('T-OP-7：保存中 Open → busy；Open 对话框 / Open 进行中 → 保存 busy；两次保存 → busy', () => {
    const a = acquired(fresh());
    expect(beginOpen(a.state, W).result).toEqual({ kind: 'busy' });
    const opening = beginOpen(fresh(), W).state;
    expect(acquireSaveOperation(opening, W, 'save').result).toEqual({ kind: 'busy' });
    expect(acquireSaveOperation(a.state, W, 'save-as-dialog').result).toEqual({ kind: 'busy' });
    // 其它窗口不受影响。
    expect(acquireSaveOperation(a.state, OTHER, 'save').result.kind).toBe('acquired');
  });
});

describe('普通 Save 授权', () => {
  const base = (): OpenCoordinatorState => openActive(fresh(), 'X', 11);

  it('active + documentId + 编码一致 → 通过，持锁；stillCurrent 随 A4 / 被取代失效', () => {
    const step = beginSave(base(), W, { capabilityId: 'X', documentId: 11, encoding: 'utf-8' });
    if (!step.result.ok) throw new Error(step.result.code);
    const op = step.result.operation;
    expect(saveStillCurrent(step.state, W, op, 'X')).toBe(true);
    expect(saveStillCurrent(resetOwner(step.state, W).state, W, op, 'X')).toBe(false);
  });

  it.each([
    ['墓碑（M45）', 'X0', 10, 'utf-8', 'capability-invalid'],
    ['未知', 'nope', 11, 'utf-8', 'capability-invalid'],
    ['documentId 不符', 'X', 99, 'utf-8', 'document-mismatch'],
    ['编码不符', 'X', 11, 'gb18030', 'encoding-mismatch'],
  ] as const)('%s → %s，并释放锁', (_label, capabilityId, documentId, encoding, code) => {
    const state = openActive(openActive(fresh(), 'X0', 10), 'X', 11);
    const step = beginSave(state, W, { capabilityId, documentId, encoding });
    expect(step.result).toEqual({ ok: false, code });
    expect(step.state.owners.get(W)?.saveOperation).toBeNull();
  });

  it('跨窗口：另一个 owner 用 X 的 token → capability-invalid', () => {
    expect(beginSave(base(), OTHER, { capabilityId: 'X', documentId: 11, encoding: 'utf-8' }).result).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it('Q-B2-11 / F2：save-target token 误用于普通 Save → 先消费 G 再 capability-invalid；G 之后不可用', () => {
    const withG = granted(base(), 'X');
    const step = beginSave(withG, W, { capabilityId: 'G', documentId: 11, encoding: 'utf-8' });
    expect(step.result).toEqual({ ok: false, code: 'capability-invalid' });
    expect(step.state.table.has('G')).toBe(false);
  });
});

describe('Save As 阶段 1', () => {
  it('授予：anchor = committed、boundDocumentId = 锚点 documentId、generation = 当前、TTL 120 s；旧 G 被替换', () => {
    const state = granted(granted(openActive(fresh(), 'X', 11), 'X', 'G0'), 'X', 'G');
    expect(state.table.has('G0')).toBe(false);
    const g = state.table.get('G');
    expect(g).toMatchObject({ purpose: 'save-target', anchor: anchorTo('X'), boundDocumentId: 11, generation: 1, expiresAt: T0 + SAVE_TARGET_TTL_MS });
    expectConsistent(state);
  });

  it('demo（锚点 none）：source null 通过，boundDocumentId = 0；source 非 null 被拒（M67）', () => {
    expect(granted(fresh(), null).table.get('G')).toMatchObject({ anchor: NO_ANCHOR, boundDocumentId: 0 });
    expect(beginSaveTarget(fresh(), W, 'X').result).toEqual({ ok: false, code: 'source-mismatch' });
  });

  it('R19：分叉（renderer 持 X，main committed = Y）→ source-mismatch；接受 prevCommitted 也不行（M64）；锁已释放', () => {
    const state = openActive(openActive(fresh(), 'X', 11), 'Y', 12);
    const step = beginSaveTarget(state, W, 'X');
    expect(step.result).toEqual({ ok: false, code: 'source-mismatch' });
    expect(step.state.owners.get(W)?.saveOperation).toBeNull();
  });

  it('F2：对话框返回前锁被 A4 / A5 清理 → 不登记 G（旧回调不得给新会话登记，也不释放新锁）', () => {
    for (const invalidate of [resetOwner, rebuildOwner]) {
      const begun = beginSaveTarget(openActive(fresh(), 'X', 11), W, 'X');
      if (!begun.result.ok) throw new Error('begin refused');
      const old = begun.result;
      const next = acquired(invalidate(begun.state, W).state, 'save-as-dialog');
      const late = grantSaveTarget(
        next.state,
        W,
        old.operation,
        { token: 'G', sourceCapabilityId: 'X', anchorAtBegin: old.anchor, encoding: 'utf-8', target: GRANT, requestedPath: '/x', displayName: 'x', displayPath: '/x' },
        T0,
      );
      expect(late.result).toEqual({ ok: false, code: 'capability-invalid' });
      expect(late.state.table.has('G')).toBe(false);
      expect(releaseSaveOperation(late.state, W, old.operation).owners.get(W)?.saveOperation).toEqual(next.operation);
    }
  });

  it('F2：对话框期间锚点被 reject 改变 → 重新验证 R19 失败，不登记', () => {
    const state = openActive(openActive(fresh(), 'X', 11), 'Y', 12);
    const begun = beginSaveTarget(state, W, 'Y');
    if (!begun.result.ok) throw new Error('begin refused');
    const rolledBack = rejectDocument(begun.state, W, { capabilityId: 'Y', documentId: 12 }).state;
    const late = grantSaveTarget(
      rolledBack,
      W,
      begun.result.operation,
      { token: 'G', sourceCapabilityId: 'Y', anchorAtBegin: begun.result.anchor, encoding: 'utf-8', target: GRANT, requestedPath: '/x', displayName: 'x', displayPath: '/x' },
      T0,
    );
    expect(late.result).toEqual({ ok: false, code: 'source-mismatch' });
    expect(late.state.table.has('G')).toBe(false);
  });
});

describe('Save As 阶段 2：一次性消费（F2）与错误优先级（Q-B2-5）', () => {
  const withG = (): OpenCoordinatorState => granted(openActive(fresh(), 'X', 11), 'X');

  it('全部通过：持 save-as-write 锁，占用新的请求序号；之后 G 不可再用（M22）', () => {
    const step = consumeSaveTarget(withG(), W, ticketFor(), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    expect(step.result.operation.kind).toBe('save-as-write');
    expect(step.result.requestSeq).toBe(2);
    expect(step.state.table.has('G')).toBe(false);
    expect(saveAsStillCurrent(step.state, W, step.result.operation, step.result.anchor)).toBe(true);
    const released = releaseSaveOperation(step.state, W, step.result.operation);
    expect(consumeSaveTarget(released, W, ticketFor(), T0).result).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it.each([
    ['busy', 'busy'],
    ['source-mismatch', 'source-mismatch'],
    ['document-mismatch', 'document-mismatch'],
    ['encoding-mismatch', 'encoding-mismatch'],
  ] as const)('%s 之后 G 已被消费，重试得到 capability-invalid', (kind, code) => {
    let state = withG();
    let ticket = ticketFor();
    if (kind === 'busy') state = acquired(state, 'save').state;
    if (kind === 'source-mismatch') ticket = ticketFor({ sourceCapabilityId: 'other' });
    if (kind === 'document-mismatch') ticket = ticketFor({ documentId: 99 });
    if (kind === 'encoding-mismatch') ticket = ticketFor({ encoding: 'gb18030' });
    const first = consumeSaveTarget(state, W, ticket, T0);
    expect(first.result).toEqual({ ok: false, code });
    expect(first.state.table.has('G')).toBe(false);
    const cleared = kind === 'busy' ? releaseSaveOperation(first.state, W, state.owners.get(W)?.saveOperation as SaveOperation) : first.state;
    expect(consumeSaveTarget(cleared, W, ticketFor(), T0).result).toEqual({ ok: false, code: 'capability-invalid' });
  });

  it('优先级：多个错误同时成立时按 busy → capability-invalid → source-mismatch → document-mismatch → encoding-mismatch', () => {
    const all = ticketFor({ sourceCapabilityId: 'other', documentId: 99, encoding: 'gb18030' });
    expect(consumeSaveTarget(acquired(withG(), 'save').state, W, all, T0).result).toEqual({ ok: false, code: 'busy' });
    expect(consumeSaveTarget(withG(), W, all, T0 + SAVE_TARGET_TTL_MS).result).toEqual({ ok: false, code: 'capability-invalid' });
    expect(consumeSaveTarget(withG(), W, all, T0).result).toEqual({ ok: false, code: 'source-mismatch' });
    expect(consumeSaveTarget(withG(), W, { ...all, sourceCapabilityId: 'X' }, T0).result).toEqual({ ok: false, code: 'document-mismatch' });
    expect(consumeSaveTarget(withG(), W, { ...all, sourceCapabilityId: 'X', documentId: 11 }, T0).result).toEqual({ ok: false, code: 'encoding-mismatch' });
  });

  it('F2：跨 owner、未知、伪造 token 不删除任何其它 owner 的记录', () => {
    const state = granted(withG(), null, 'G2', OTHER);
    const cross = consumeSaveTarget(state, OTHER, ticketFor({ capabilityId: 'G', sourceCapabilityId: null, documentId: 0 }), T0);
    expect(cross.result).toEqual({ ok: false, code: 'capability-invalid' });
    expect(cross.state.table.has('G')).toBe(true);
    expect(cross.state.table.has('G2')).toBe(true);
    for (const forged of ['never-issued', 'X']) {
      const step = consumeSaveTarget(state, W, ticketFor({ capabilityId: forged }), T0);
      expect(step.result).toEqual({ ok: false, code: 'capability-invalid' });
      expect(step.state.table.has('G')).toBe(true);
      expect(step.state.table.has('X')).toBe(true);
    }
  });

  it('M45 / M47 / M46：墓碑不能当 G；锚点在授予后被改变 → capability-invalid；documentId 只与 boundDocumentId 比较', () => {
    const tomb = openActive(withG(), 'Y', 12);
    // 激活 Y（A1）删除了 G，X 转墓碑。
    expect(consumeSaveTarget(tomb, W, ticketFor({ capabilityId: 'X' }), T0).result).toEqual({ ok: false, code: 'capability-invalid' });
    const anchorChanged = rejectDocument(granted(openActive(openActive(fresh(), 'X', 11), 'Y', 12), 'Y'), W, { capabilityId: 'Y', documentId: 12 }).state;
    expect(consumeSaveTarget(anchorChanged, W, ticketFor({ sourceCapabilityId: 'X' }), T0).result).toEqual({ ok: false, code: 'capability-invalid' });
    const demo = granted(fresh(), null);
    expect(consumeSaveTarget(demo, W, ticketFor({ sourceCapabilityId: null, documentId: 5 }), T0).result).toEqual({ ok: false, code: 'document-mismatch' });
  });

  it('R19 阶段 2 独立核对（M66）：阶段 1 的 source 正确、阶段 2 换成另一个 token → source-mismatch', () => {
    expect(consumeSaveTarget(withG(), W, ticketFor({ sourceCapabilityId: 'Y' }), T0).result).toEqual({ ok: false, code: 'source-mismatch' });
  });

  it('Q-B2-7：Save As 的 stillCurrent 在锚点被改变或 A4 后为假', () => {
    const step = consumeSaveTarget(withG(), W, ticketFor(), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    const { operation, anchor } = step.result;
    expect(saveAsStillCurrent(resetOwner(step.state, W).state, W, operation, anchor)).toBe(false);
    const rolled = rejectDocument(step.state, W, { capabilityId: 'X', documentId: 11 }).state;
    expect(saveAsStillCurrent(rolled, W, operation, anchor)).toBe(false);
  });

  it('DR1 Q6：Open 开始即删除 save-target', () => {
    expect(beginOpen(withG(), W).state.table.has('G')).toBe(false);
  });

  it('Open 的 pending 候选在消费成功时被丢弃（占用新的请求序号）', () => {
    const begun = beginOpen(openActive(fresh(), 'X', 11), W);
    const file = opened(W, 'P', 20);
    const withPending = granted(completeOpen(begun.state, acceptedTicket(begun.result), file.completion, T0).state, 'X');
    expect(withPending.table.has('P')).toBe(true);
    const step = consumeSaveTarget(withPending, W, ticketFor({ capabilityId: 'G' }), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    expect(step.state.table.has('P')).toBe(false);
    expectConsistent(step.state);
  });
});

describe('A9 settleSave（勘误 §3.3）', () => {
  it('Save As 写入其它文件：登记 pending 候选（documentId = bound），激活后旧 active 转墓碑（M21）', () => {
    const step = consumeSaveTarget(granted(openActive(fresh(), 'X', 11), 'X'), W, ticketFor(), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    const settled = settleSave(step.state, W, {
      operation: step.result.operation,
      written: WRITTEN,
      refreshToken: null,
      candidate: { token: 'N', documentId: 11, requestSeq: step.result.requestSeq, displayName: 'new.jcx', displayPath: '/docs/new.jcx' },
      now: T0,
    });
    expect(settled.table.get('N')).toMatchObject({ purpose: 'open', state: 'pending', documentId: 11, realpath: WRITTEN.realpath, lastKnownDiskFingerprint: WRITTEN.lastKnownDiskFingerprint });
    const released = releaseSaveOperation(settled, W, step.result.operation);
    const active = activateDocument(released, W, { capabilityId: 'N', documentId: 11 }, T0);
    expect(active.result.reply).toEqual({ ok: true });
    expect(authorizeCapability(active.state, W, 'X')).toBeNull();
    expect(active.state.table.get('X')?.purpose).toBe('tombstone');
    expectConsistent(active.state);
  });

  it('写入锚点文件：按 token 刷新锚点记录（含墓碑）的 realpath / identity / 指纹，编码事实不变（M53）', () => {
    const state = resetOwner(openActive(fresh(), 'X', 11), W).state;
    const op = acquired(state).operation;
    const held = acquired(state).state;
    const settled = settleSave(held, W, { operation: op, written: { ...WRITTEN, writeEncoding: 'gb18030' }, refreshToken: 'X', candidate: null, now: T0 });
    expect(settled.table.get('X')).toMatchObject({ purpose: 'tombstone', realpath: WRITTEN.realpath, lastKnownDiskFingerprint: WRITTEN.lastKnownDiskFingerprint, writeEncoding: 'utf-8' });
    expect(settled.table.get('X')).toMatchObject({ identity: WRITTEN.identity });
  });

  it('原子性（T-CS-7 / T-CS-8 的协调器部分）：候选登记失败时整体抛出，入参状态不变', () => {
    const step = consumeSaveTarget(granted(openActive(fresh(), 'X', 11), 'X'), W, ticketFor(), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    const before = step.state;
    const input = {
      operation: step.result.operation,
      written: WRITTEN,
      refreshToken: 'X',
      candidate: { token: 'X', documentId: 11, requestSeq: step.result.requestSeq, displayName: 'n', displayPath: '/n' },
      now: T0,
    };
    expect(() => settleSave(before, W, input)).toThrow(/duplicate token/);
    expect(before.table.get('X')).toMatchObject({ lastKnownDiskFingerprint: '0'.repeat(64) });
    expect(() => settleSave(before, W, { ...input, candidate: { ...input.candidate, token: 'N', requestSeq: 99 } })).toThrow(/request sequence/);
    expect(() => settleSave(resetOwner(before, W).state, W, { ...input, candidate: { ...input.candidate, token: 'N' } })).toThrow(/no longer held/);
  });

  it('M38：锁已失效时不得登记候选（由 settleSave 拒绝）', () => {
    const step = consumeSaveTarget(granted(openActive(fresh(), 'X', 11), 'X'), W, ticketFor(), T0);
    if (!step.result.ok) throw new Error(step.result.code);
    const invalidated = rebuildOwner(step.state, W).state;
    expect(() =>
      settleSave(invalidated, W, {
        operation: step.result.ok ? step.result.operation : (undefined as never),
        written: WRITTEN,
        refreshToken: null,
        candidate: { token: 'N', documentId: 11, requestSeq: 2, displayName: 'n', displayPath: '/n' },
        now: T0,
      }),
    ).toThrow();
  });
});
