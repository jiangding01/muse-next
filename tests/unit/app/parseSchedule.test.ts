/**
 * M3 T3a：解析调度状态机（`src/renderer/app/editor/parseSchedule.ts`；方案 §8.2，T3 Preflight r3 §6，外部审查 H3-3）。
 *
 * 重点：源码变化按新令牌重新计时 500ms；旧令牌的回调被忽略；flush 取消定时器并立即解析，只有 Reparse 为 force；
 * 组字中不计时、flush 被忽略，组字结束后补计时；文档替换清空一切。
 */

import { describe, expect, it } from 'vitest';

import { initialParseSchedule, PARSE_DEBOUNCE_MS, stepParseSchedule } from '../../../src/renderer/app/editor/parseSchedule';
import type { ParseScheduleEffect, ParseScheduleEvent, ParseScheduleState } from '../../../src/renderer/app/editor/parseSchedule';

function run(events: readonly ParseScheduleEvent[], start: ParseScheduleState = initialParseSchedule()) {
  let state = start;
  const effects: ParseScheduleEffect[] = [];
  let ignored = 0;
  for (const event of events) {
    const step = stepParseSchedule(state, event);
    state = step.state;
    effects.push(...step.effects);
    if (step.ignoredWhileComposing) ignored += 1;
  }
  return { state, effects, ignored };
}

const CHANGED: ParseScheduleEvent = { type: 'source-changed' };

describe('parseSchedule —— debounce', () => {
  it('debounce 常量为 500ms', () => {
    expect(PARSE_DEBOUNCE_MS).toBe(500);
  });

  it('源码变化：发出令牌 1 的 500ms 定时器；再次变化取消 1、发出 2', () => {
    const { state, effects } = run([CHANGED, CHANGED]);
    expect(effects).toEqual([
      { type: 'arm-timer', token: 1, delayMs: 500 },
      { type: 'cancel-timer', token: 1 },
      { type: 'arm-timer', token: 2, delayMs: 500 },
    ]);
    expect(state.armed).toBe(2);
  });

  it('当前令牌到期 → 自动解析（force false）；旧令牌与重复到期被忽略', () => {
    const { effects, state } = run([CHANGED, CHANGED, { type: 'timer-fired', token: 1 }, { type: 'timer-fired', token: 2 }, { type: 'timer-fired', token: 2 }]);
    expect(effects.filter((effect) => effect.type === 'parse-now')).toEqual([{ type: 'parse-now', force: false }]);
    expect(state.armed).toBeNull();
  });
});

describe('parseSchedule —— flush 与显式 Reparse（H3-3）', () => {
  it('Reparse：取消定时器并立即解析，force 为 true；之后旧定时器到期被忽略', () => {
    const { effects } = run([CHANGED, { type: 'flush', reason: 'reparse' }, { type: 'timer-fired', token: 1 }]);
    expect(effects).toEqual([
      { type: 'arm-timer', token: 1, delayMs: 500 },
      { type: 'cancel-timer', token: 1 },
      { type: 'parse-now', force: true },
    ]);
  });

  it('没有定时器时 Reparse 仍立即解析（同版本也要重新解析）', () => {
    expect(run([{ type: 'flush', reason: 'reparse' }]).effects).toEqual([{ type: 'parse-now', force: true }]);
  });

  it.each(['blur', 'undo', 'redo'] as const)('%s：立即解析但 force 为 false（由控制器按是否 stale 去重）', (reason) => {
    expect(run([CHANGED, { type: 'flush', reason }]).effects.at(-1)).toEqual({ type: 'parse-now', force: false });
  });
});

describe('parseSchedule —— 输入法组字', () => {
  it('组字开始取消定时器；组字中源码变化不计时；组字结束补计时', () => {
    const { effects, state } = run([CHANGED, { type: 'composition-start' }, CHANGED, { type: 'composition-end' }]);
    expect(effects).toEqual([
      { type: 'arm-timer', token: 1, delayMs: 500 },
      { type: 'cancel-timer', token: 1 },
      { type: 'arm-timer', token: 2, delayMs: 500 },
    ]);
    expect(state).toEqual({ lastToken: 2, armed: 2, composing: false, pending: false });
  });

  it('组字中 flush 一律忽略（IME 期间不解析），并报告忽略', () => {
    const { effects, ignored } = run([{ type: 'composition-start' }, { type: 'flush', reason: 'reparse' }, { type: 'flush', reason: 'blur' }]);
    expect(effects.filter((effect) => effect.type === 'parse-now')).toEqual([]);
    expect(ignored).toBe(2);
  });

  it('组字前后都没有变化：结束时不计时', () => {
    expect(run([{ type: 'composition-start' }, { type: 'composition-end' }]).effects).toEqual([]);
  });
});

describe('parseSchedule —— 文档替换', () => {
  it('取消定时器、清除待解析与组字标记；之后旧令牌到期被忽略', () => {
    const { effects, state } = run([CHANGED, { type: 'composition-start' }, { type: 'document-replaced' }, { type: 'timer-fired', token: 1 }]);
    expect(effects.filter((effect) => effect.type === 'parse-now')).toEqual([]);
    expect(state).toEqual({ lastToken: 1, armed: null, composing: false, pending: false });
  });
});

describe('parseSchedule —— 令牌与组字中的旧定时器（变异 M15 / M16 补测）', () => {
  it('第二次变化后，第一个定时器到期：不解析，当前定时器仍有效；随后当前定时器到期才解析', () => {
    const afterOld = run([CHANGED, CHANGED, { type: 'timer-fired', token: 1 }]);
    expect(afterOld.effects.filter((effect) => effect.type === 'parse-now')).toEqual([]);
    expect(afterOld.state.armed).toBe(2);
    const afterCurrent = run([{ type: 'timer-fired', token: 2 }], afterOld.state);
    expect(afterCurrent.effects).toEqual([{ type: 'parse-now', force: false }]);
  });

  it('组字开始后，组字前发出的定时器到期：不解析（IME 期间不解析），且定时器已被取消', () => {
    const composing = run([CHANGED, { type: 'composition-start' }]);
    expect(composing.state.armed).toBeNull();
    expect(composing.effects.at(-1)).toEqual({ type: 'cancel-timer', token: 1 });
    expect(run([{ type: 'timer-fired', token: 1 }], composing.state).effects).toEqual([]);
  });
});
