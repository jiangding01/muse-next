/**
 * M3 T4 B2：锚点链（`src/main/open/anchorChain.ts` 与协调器的 A1 / A2 / A2' / A4 / A5 / A6，B2 r0.1 勘误 §1）。
 *
 * 覆盖：连续回退 X → Y → Z → reject Z → reject Y（勘误 §1.4）、A4 与 A5 的区分（§1.5）、修剪与悬空引用改写（§1.2）、
 * R19 等值核对的三态（§1.1），以及随机迁移序列上的性质测试（§1.7）。
 */

import { describe, expect, it } from 'vitest';

import { anchorMatchesSource, anchorTo, NO_ANCHOR, pruneAnchors, sameAnchor, UNRESOLVED_ANCHOR } from '../../../src/main/open/anchorChain';
import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
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
import type { OpenCoordinatorState } from '../../../src/main/open/openCoordinator';
import type { AnchorRef, CapabilityTable } from '../../../src/main/document/capabilities';
import { createPrng } from '../editor/prng';
import { acceptedTicket, expectConsistent, opened } from './coordinatorFixtures';

const W = 1;
const OTHER = 2;
const T0 = 1_000;

function fresh(): OpenCoordinatorState {
  return registerOwner(registerOwner(createOpenCoordinator(), W), OTHER);
}

/** Open → 完成 → 激活；返回新状态与票据。 */
function openActive(state: OpenCoordinatorState, token: string, documentId: number, ownerId = W): OpenCoordinatorState {
  const begun = beginOpen(state, ownerId);
  const file = opened(ownerId, token, documentId);
  const done = completeOpen(begun.state, acceptedTicket(begun.result), file.completion, T0);
  const active = activateDocument(done.state, ownerId, file.ticket, T0);
  expect(active.result.reply).toEqual({ ok: true });
  return active.state;
}

const committedOf = (state: OpenCoordinatorState, ownerId = W): AnchorRef | undefined => state.owners.get(ownerId)?.committed;
const rowsOf = (state: OpenCoordinatorState, ownerId = W): [string, string, string][] =>
  [...state.table.values()]
    .filter((record) => record.ownerId === ownerId)
    .map((record) => {
      const prev = record.purpose === 'save-target' || (record.purpose === 'open' && record.state === 'pending') ? '-' : describePrev(record.prevCommitted);
      return [record.token, record.purpose === 'open' ? record.state : record.purpose, prev];
    });
const describePrev = (anchor: AnchorRef): string => (anchor.kind === 'record' ? anchor.token : anchor.kind);

const DOC = { X: 11, Y: 12, Z: 13, W: 14 } as const;
const reject = (state: OpenCoordinatorState, token: keyof typeof DOC): OpenCoordinatorState => {
  const step = rejectDocument(state, W, { capabilityId: token, documentId: DOC[token] });
  expect(step.result.reply).toEqual({ ok: true });
  return step.state;
};

describe('连续回退 X → Y → Z → reject Z → reject Y（勘误 §1.4）', () => {
  it('超出保留窗口的祖先被修剪；回退无法安全完成时 committed = unresolved，R19 对任何载荷都不成立', () => {
    let s = openActive(fresh(), 'X', DOC.X);
    expect(rowsOf(s)).toEqual([['X', 'active', 'none']]);
    expect(committedOf(s)).toEqual(anchorTo('X'));

    s = openActive(s, 'Y', DOC.Y);
    expect(rowsOf(s)).toEqual([
      ['X', 'tombstone', 'none'],
      ['Y', 'active', 'X'],
    ]);

    s = openActive(s, 'Z', DOC.Z);
    // X 被修剪；Y.prevCommitted 改写为 unresolved（不留悬空引用）。
    expect(rowsOf(s)).toEqual([
      ['Y', 'tombstone', 'unresolved'],
      ['Z', 'active', 'Y'],
    ]);
    expect(committedOf(s)).toEqual(anchorTo('Z'));
    expectConsistent(s);

    s = reject(s, 'Z');
    expect(rowsOf(s)).toEqual([['Y', 'tombstone', 'unresolved']]);
    expect(committedOf(s)).toEqual(anchorTo('Y'));
    expect(authorizeCapability(s, W, 'Y')).toBeNull();
    expectConsistent(s);

    s = reject(s, 'Y');
    expect(rowsOf(s)).toEqual([]);
    expect(committedOf(s)).toEqual(UNRESOLVED_ANCHOR);
    expectConsistent(s);

    // 之后对 X / Y / Z 的 reject 都找不到记录：无状态变化，恒 { ok: true }。
    for (const token of ['X', 'Y', 'Z'] as const) {
      const step = rejectDocument(s, W, { capabilityId: token, documentId: DOC[token] });
      expect(step.result).toEqual({ reply: { ok: true }, removed: [] });
      expect(step.state).toBe(s);
    }
    // R19：null、X、Y、Z 都不等于 unresolved（fail closed）；普通 Save 也没有 active 可授权。
    const committed = committedOf(s) ?? NO_ANCHOR;
    for (const source of [null, 'X', 'Y', 'Z']) expect(anchorMatchesSource(committed, source)).toBe(false);
    for (const token of ['X', 'Y', 'Z']) expect(authorizeCapability(s, W, token)).toBeNull();

    // 恢复方式一：新的 Open 激活 W。
    const reopened = openActive(s, 'W', DOC.W);
    expect(committedOf(reopened)).toEqual(anchorTo('W'));
    expect(rowsOf(reopened)).toEqual([['W', 'active', 'unresolved']]);
    expectConsistent(reopened);
    // 恢复方式二：页面重建（A5）→ none，demo 可以 Save As（null 通过 R19）。
    const rebuilt = rebuildOwner(s, W).state;
    expect(committedOf(rebuilt)).toEqual(NO_ANCHOR);
    expect(anchorMatchesSource(NO_ANCHOR, null)).toBe(true);
    expectConsistent(rebuilt);
  });

  it('只回退一层时直接 prevCommitted 仍在窗口内：X → Y → reject Y → committed = X（墓碑，不恢复授权）', () => {
    let s = openActive(openActive(fresh(), 'X', DOC.X), 'Y', DOC.Y);
    s = reject(s, 'Y');
    expect(rowsOf(s)).toEqual([['X', 'tombstone', 'none']]);
    expect(committedOf(s)).toEqual(anchorTo('X'));
    expect(authorizeCapability(s, W, 'X')).toBeNull();
    expect(anchorMatchesSource(committedOf(s) ?? NO_ANCHOR, 'X')).toBe(true);
    // 再 reject X（当前锚点墓碑，A2'）→ 回到 none。
    s = reject(s, 'X');
    expect(committedOf(s)).toEqual(NO_ANCHOR);
    expect(rowsOf(s)).toEqual([]);
    expectConsistent(s);
  });
});

describe('A4 与 A5 的区分（勘误 §1.5）', () => {
  it('A4（页面仍存活）：active 转墓碑、committed 不变；随后 reject 当前墓碑合法回退到其 prevCommitted', () => {
    let s = openActive(openActive(fresh(), 'X', DOC.X), 'Y', DOC.Y);
    const reset = resetOwner(s, W);
    expect(reset.result).toEqual(['Y']);
    s = reset.state;
    expect(rowsOf(s)).toEqual([
      ['X', 'tombstone', 'none'],
      ['Y', 'tombstone', 'X'],
    ]);
    expect(committedOf(s)).toEqual(anchorTo('Y'));
    expect(s.owners.get(W)?.generation).toBe(2);
    expectConsistent(s);
    s = reject(s, 'Y');
    expect(committedOf(s)).toEqual(anchorTo('X'));
    expect(rowsOf(s)).toEqual([['X', 'tombstone', 'none']]);
    expectConsistent(s);
  });

  it('A5（页面已重建）：墓碑全部删除、committed = none；旧页面的迟到 reject 不改变任何状态', () => {
    let s = openActive(openActive(fresh(), 'X', DOC.X), 'Z', DOC.Z);
    s = rebuildOwner(s, W).state;
    expect(rowsOf(s)).toEqual([]);
    expect(committedOf(s)).toEqual(NO_ANCHOR);
    const late = rejectDocument(s, W, { capabilityId: 'Z', documentId: DOC.Z });
    expect(late.result).toEqual({ reply: { ok: true }, removed: [] });
    expect(late.state).toBe(s);
    expect(anchorMatchesSource(NO_ANCHOR, null)).toBe(true);
    expect(anchorMatchesSource(NO_ANCHOR, 'Z')).toBe(false);
    expectConsistent(s);
  });

  it('A6（窗口销毁）：删除该 owner 全部记录与元数据，不影响其它 owner', () => {
    let s = openActive(openActive(fresh(), 'X', DOC.X), 'Y', DOC.Y);
    s = openActive(s, 'other', 21, OTHER);
    const disposed = disposeOwner(s, W).state;
    expect(rowsOf(disposed)).toEqual([]);
    expect(disposed.owners.has(W)).toBe(false);
    expect(rowsOf(disposed, OTHER)).toEqual([['other', 'active', 'none']]);
    expectConsistent(disposed);
  });

  it('A4 重复发生（导航开始后又被拦截）：墓碑数仍 ≤ 2，committed 不变', () => {
    let s = openActive(openActive(openActive(fresh(), 'X', DOC.X), 'Y', DOC.Y), 'Z', DOC.Z);
    for (let i = 0; i < 3; i += 1) s = resetOwner(s, W).state;
    expect(rowsOf(s)).toEqual([
      ['Y', 'tombstone', 'unresolved'],
      ['Z', 'tombstone', 'Y'],
    ]);
    expect(committedOf(s)).toEqual(anchorTo('Z'));
    expectConsistent(s);
  });
});

describe('修剪与锚点引用（勘误 §1.1 / §1.2）', () => {
  it('committed 指向不存在的记录时按回退失败处理（unresolved），不悬空', () => {
    const table: CapabilityTable = new Map();
    expect(pruneAnchors(table, W, anchorTo('ghost'))).toEqual({ table, committed: UNRESOLVED_ANCHOR });
  });

  it('sameAnchor / anchorMatchesSource 的真值表', () => {
    expect(sameAnchor(NO_ANCHOR, NO_ANCHOR)).toBe(true);
    expect(sameAnchor(UNRESOLVED_ANCHOR, UNRESOLVED_ANCHOR)).toBe(true);
    expect(sameAnchor(NO_ANCHOR, UNRESOLVED_ANCHOR)).toBe(false);
    expect(sameAnchor(anchorTo('a'), anchorTo('a'))).toBe(true);
    expect(sameAnchor(anchorTo('a'), anchorTo('b'))).toBe(false);
    expect(sameAnchor(anchorTo('a'), NO_ANCHOR)).toBe(false);
    expect(anchorMatchesSource(NO_ANCHOR, null)).toBe(true);
    expect(anchorMatchesSource(NO_ANCHOR, 'a')).toBe(false);
    expect(anchorMatchesSource(anchorTo('a'), 'a')).toBe(true);
    expect(anchorMatchesSource(anchorTo('a'), null)).toBe(false);
    expect(anchorMatchesSource(anchorTo('a'), 'b')).toBe(false);
    expect(anchorMatchesSource(UNRESOLVED_ANCHOR, null)).toBe(false);
    expect(anchorMatchesSource(UNRESOLVED_ANCHOR, 'a')).toBe(false);
  });
});

describe('性质测试：随机迁移序列（勘误 §1.7）', () => {
  it('每一步 I1–I8 成立；committed 从不指向不存在或已被修剪的记录；unresolved 期间 R19 恒不成立', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const prng = createPrng(seed);
      let state = fresh();
      let next = 1;
      const issued: { token: string; documentId: number; ownerId: number }[] = [];
      const pruned = new Set<string>();
      for (let step = 0; step < 200; step += 1) {
        const where = `seed ${String(seed)}, step ${String(step)}`;
        const ownerId = prng.int(4) === 0 ? OTHER : W;
        const action = prng.int(7);
        if (action <= 1) {
          const token = `t${String(next)}`;
          const documentId = next;
          next += 1;
          const begun = beginOpen(state, ownerId);
          state = begun.state;
          if (begun.result.kind === 'accepted') {
            const file = opened(ownerId, token, documentId);
            state = completeOpen(state, begun.result.ticket, file.completion, T0).state;
            issued.push({ token, documentId, ownerId });
            if (action === 0) state = activateDocument(state, ownerId, file.ticket, T0).state;
          }
        } else if (action <= 3 && issued.length > 0) {
          const target = prng.pick(issued);
          const documentId = prng.int(5) === 0 ? target.documentId + 1 : target.documentId;
          const sender = prng.int(5) === 0 ? (target.ownerId === W ? OTHER : W) : target.ownerId;
          const before = state;
          const result = rejectDocument(state, sender, { capabilityId: target.token, documentId });
          expect(result.result.reply, where).toEqual({ ok: true });
          if (sender !== target.ownerId || documentId !== target.documentId) expect(result.state, where).toBe(before);
          state = result.state;
        } else if (action === 4) {
          state = resetOwner(state, ownerId).state;
        } else if (action === 5) {
          state = rebuildOwner(state, ownerId).state;
        } else if (issued.length > 0) {
          const target = prng.pick(issued);
          state = activateDocument(state, target.ownerId, { capabilityId: target.token, documentId: target.documentId }, T0).state;
        }

        expect(coordinatorInvariantViolations(state), where).toEqual([]);
        for (const { token } of issued) if (!state.table.has(token)) pruned.add(token);
        for (const [owner, meta] of state.owners) {
          const committed = meta.committed;
          if (committed.kind === 'record') {
            expect(state.table.get(committed.token)?.ownerId, where).toBe(owner);
            expect(pruned.has(committed.token), where).toBe(false);
          }
          if (committed.kind === 'unresolved') {
            expect(anchorMatchesSource(committed, null), where).toBe(false);
            for (const { token } of issued) expect(anchorMatchesSource(committed, token), where).toBe(false);
          }
        }
      }
    }
  });
});

describe('不变量自检：能识别锚点链与保存锁的分叉（G-16 #14）', () => {
  const corrupt = (state: OpenCoordinatorState, patch: (meta: NonNullable<ReturnType<OpenCoordinatorState['owners']['get']>>) => object, table = state.table): OpenCoordinatorState => {
    const meta = state.owners.get(W);
    if (meta === undefined) throw new Error('owner missing');
    return { ...state, table, owners: new Map([...state.owners, [W, { ...meta, ...patch(meta) }]]) };
  };

  it('active 与 committed 不一致（I3 / I8）、committed 悬空（I4′）、prevCommitted 悬空、墓碑在链外（I5′）', () => {
    const state = openActive(openActive(fresh(), 'X', DOC.X), 'Y', DOC.Y);
    expect(coordinatorInvariantViolations(corrupt(state, () => ({ committed: anchorTo('X') })))).toContain('owner 1 has active Y but committed is record X');
    expect(coordinatorInvariantViolations(corrupt(state, () => ({ committed: NO_ANCHOR })))).toContain('owner 1 has an active capability while committed is none');
    const withoutX = new Map(state.table);
    withoutX.delete('X');
    expect(coordinatorInvariantViolations({ ...state, table: withoutX })).toContain('record Y prevCommitted X is dangling');
    const ghost = corrupt(rebuildOwner(state, W).state, () => ({ committed: anchorTo('ghost') }));
    expect(coordinatorInvariantViolations(ghost)).toContain('owner 1 committed ghost is not a live anchor');
    const z = openActive(state, 'Z', DOC.Z);
    const x = state.table.get('X');
    if (x === undefined) throw new Error('X missing');
    const extra = new Map(z.table);
    extra.set('X', x);
    expect(coordinatorInvariantViolations({ ...z, table: extra })).toContain('tombstone X is outside the anchor chain');
  });

  it('保存锁来自旧 generation、或 id 尚未签发', () => {
    const state = fresh();
    expect(coordinatorInvariantViolations(corrupt(state, () => ({ saveOperation: { id: 1, generation: 9, kind: 'save' } })))).toEqual([
      'owner 1 holds a save operation from an old generation',
      'owner 1 holds a save operation with an unissued id',
    ]);
  });
});
