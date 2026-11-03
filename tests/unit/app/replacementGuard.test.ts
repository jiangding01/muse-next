/**
 * M3 T4 B3b：替换守卫的纯状态机与批准判据（`src/renderer/app/guard/replacementGuard.ts`；r0 §4、r0.1 勘误 §4）。
 */

import { describe, expect, it } from 'vitest';

import { IDLE_GUARD, replacementBlocked, stepGuard } from '../../../src/renderer/app/guard/replacementGuard';
import type { GuardEvent, GuardState, ReplacementApproval } from '../../../src/renderer/app/guard/replacementGuard';

function drive(events: readonly GuardEvent[], start: GuardState = IDLE_GUARD) {
  let state = start;
  const effects: unknown[] = [];
  for (const event of events) {
    const step = stepGuard(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const ASK: GuardEvent = { type: 'ask', intentId: 1, documentId: 5 };

describe('replacementGuard —— 状态机', () => {
  it('保存：ok && clean → 批准 proceed；ok && !clean → 重新询问；!ok → 中止', () => {
    const toSaving = [ASK, { type: 'chose', intentId: 1, choice: 'save', sourceVersion: 10 } as const];
    expect(drive(toSaving).effects).toEqual([{ type: 'start-save', intentId: 1 }]);
    expect(drive([...toSaving, { type: 'saved', intentId: 1, result: { ok: true, clean: true } }]).effects.at(-1)).toEqual({
      type: 'approve',
      approval: { decision: 'proceed', intentId: 1, documentId: 5, sourceVersion: null },
    });
    const dirtyAgain = drive([...toSaving, { type: 'saved', intentId: 1, result: { ok: true, clean: false } }]);
    expect(dirtyAgain.state).toEqual({ phase: 'asking', intentId: 1, documentId: 5 });
    expect(dirtyAgain.effects).toEqual([{ type: 'start-save', intentId: 1 }]);
    expect(drive([...toSaving, { type: 'saved', intentId: 1, result: { ok: false, clean: false } }]).effects.at(-1)).toEqual({ type: 'abort', intentId: 1, reason: 'save-failed' });
  });

  it('不保存：批准 discard，基线为选择时的 documentId 与 sourceVersion；取消：中止', () => {
    expect(drive([ASK, { type: 'chose', intentId: 1, choice: 'discard', sourceVersion: 12 }]).effects).toEqual([
      { type: 'approve', approval: { decision: 'discard', intentId: 1, documentId: 5, sourceVersion: 12 } },
    ]);
    expect(drive([ASK, { type: 'chose', intentId: 1, choice: 'cancel', sourceVersion: 12 }])).toEqual({ state: IDLE_GUARD, effects: [{ type: 'abort', intentId: 1, reason: 'canceled' }] });
  });

  it('宿主卸载：询问中立即中止；保存中则等保存结果到达后中止（即使 ok && clean 也不批准）', () => {
    expect(drive([ASK, { type: 'host-gone' }]).effects).toEqual([{ type: 'abort', intentId: 1, reason: 'host-gone' }]);
    const saving = drive([ASK, { type: 'chose', intentId: 1, choice: 'save', sourceVersion: 1 }, { type: 'host-gone' }]);
    expect(saving.state).toMatchObject({ phase: 'saving', hostGone: true });
    expect(drive([{ type: 'saved', intentId: 1, result: { ok: true, clean: true } }], saving.state).effects).toEqual([{ type: 'abort', intentId: 1, reason: 'host-gone' }]);
  });

  it('迟到 / 不属于当前 intent 的事件被忽略；进行中再询问不改变状态', () => {
    const asking = drive([ASK]).state;
    expect(stepGuard(asking, { type: 'chose', intentId: 2, choice: 'discard', sourceVersion: 1 }).effects).toEqual([]);
    expect(stepGuard(asking, { type: 'saved', intentId: 1, result: { ok: true, clean: true } }).effects).toEqual([]);
    expect(stepGuard(asking, { type: 'ask', intentId: 2, documentId: 5 }).state).toBe(asking);
    expect(stepGuard(IDLE_GUARD, { type: 'host-gone' }).state).toBe(IDLE_GUARD);
  });
});

describe('replacementBlocked —— 批准判据（r0.1 勘误 §4）', () => {
  const facts = { intentId: 1, documentId: 5, sourceVersion: 10 };
  const discard: ReplacementApproval = { decision: 'discard', intentId: 1, documentId: 5, sourceVersion: 10 };
  const proceed: ReplacementApproval = { decision: 'proceed', intentId: 1, documentId: 5, sourceVersion: null };
  it.each([
    ['未经守卫：clean 放行', null, false, 10, false],
    ['未经守卫：dirty 被拒', null, true, 10, true],
    ['proceed：clean 放行', proceed, false, 10, false],
    ['proceed：又变 dirty 被拒', proceed, true, 10, true],
    ['discard：版本未变（即使 dirty）放行', discard, true, 10, false],
    ['discard：版本变化（编辑 / undo / redo）被拒', discard, true, 11, true],
    ['discard：版本变化后又回到 clean 也被拒（批准已失效）', discard, false, 11, true],
    ['intentId 不符：视为未批准（dirty 被拒）', { ...discard, intentId: 2 }, true, 10, true],
    ['documentId 不符：视为未批准（dirty 被拒）', { ...discard, documentId: 6 }, true, 10, true],
    ['intentId 不符但 clean：等同未经守卫，放行', { ...discard, intentId: 2 }, false, 10, false],
  ] as const)('%s', (_name, approval, dirty, sourceVersion, blocked) => {
    expect(replacementBlocked(approval, { ...facts, sourceVersion, dirty })).toBe(blocked);
  });
});
