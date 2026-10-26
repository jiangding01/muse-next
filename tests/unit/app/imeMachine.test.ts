/**
 * M3 T3c：输入法组字状态机（`src/renderer/app/editor/imeMachine.ts`；Preflight r1 §3、r1.1 §1 / §4、勘误 E-1 / E-3；Q8-B′）。
 *
 * 纯状态迁移：组字开始与重复开始、提交过渡态与一次性授权（结果在授权时确定）、回滚 / 取消 / 孤立 end / discarded、卡死出口、
 * 诊断窗口的退出与诊断谓词 D1–D3（Q-D3 的纯状态机部分：版本不变时每窗口至多 3 条）。没有任何吸收分支、没有时钟。
 */

import { describe, expect, it } from 'vitest';

import {
  IDLE,
  MAX_DIAGNOSTICS,
  abortCommit,
  authorizationOf,
  beginCommit,
  consumeCommit,
  diagnose,
  discardComposition,
  endCommitUnverified,
  endWithoutCommit,
  exitSettled,
  expectedViewAfter,
  imeViewOf,
  noteStoreChange,
  startComposition,
  stuckExit,
} from '../../../src/renderer/app/editor/imeMachine';
import type { CommitAuthorization, ImeState } from '../../../src/renderer/app/editor/imeMachine';

const start = (state: ImeState = IDLE, replacing = false): ImeState =>
  startComposition(state, { id: 7, documentId: 1, version: 3, view: 'abc', base: { start: 3, end: 3 }, replacing });

const auth = (outcome: 'committed' | 'unchanged' = 'committed'): CommitAuthorization => ({
  token: 11,
  documentId: 1,
  authorizedVersion: outcome === 'committed' ? 4 : 3,
  expectedView: 'abc好',
  outcome,
  committedText: '好',
});

const facts = { versionAfter: 4, caretView: 4, endSeq: 20 };

function settled(outcome: 'committed' | 'unchanged' = 'committed'): ImeState {
  const step = consumeCommit(beginCommit(start(), auth(outcome)), 11, facts);
  if (!step.ok) throw new Error('consume');
  return step.state;
}

describe('imeMachine —— 组字开始', () => {
  it('idle → composing，捕获文档、版本、view 与基线；对外视图 composing', () => {
    const state = start();
    expect(state).toMatchObject({ kind: 'composing', id: 7, documentId: 1, versionAtStart: 3, viewAtStart: 'abc', base: { start: 3, end: 3 } });
    expect(imeViewOf(state)).toBe('composing');
  });

  it('重复 compositionstart 保留第一次基线；committing 中的 start 无效', () => {
    const first = start();
    expect(startComposition(first, { id: 8, documentId: 1, version: 9, view: 'zzz', base: { start: 0, end: 0 }, replacing: false })).toBe(first);
    const committing = beginCommit(first, auth());
    expect(startComposition(committing, { id: 9, documentId: 1, version: 4, view: 'x', base: { start: 0, end: 0 }, replacing: false })).toBe(committing);
  });

  it('Open 进行中（replacing）→ 直接 discarded', () => {
    expect(start(IDLE, true)).toEqual({ kind: 'discarded', id: 7 });
  });

  it('expected view：开始时的 view 中基线被规范化后的组字结果替换', () => {
    const state = startComposition(IDLE, { id: 1, documentId: 1, version: 1, view: 'abcd', base: { start: 1, end: 3 }, replacing: false });
    if (state.kind !== 'composing') throw new Error('kind');
    expect(expectedViewAfter(state, '你\r\n')).toBe('a你\nd');
  });
});

describe('imeMachine —— 提交过渡态与一次性授权（勘误 E-1）', () => {
  it('composing → committing：对外仍视为 composing；授权可读出', () => {
    const committing = beginCommit(start(), auth());
    expect(committing.kind).toBe('committing');
    expect(imeViewOf(committing)).toBe('composing');
    expect(authorizationOf(committing)).toEqual(auth());
  });

  it('只有 composing 可以开始提交', () => {
    expect(beginCommit(IDLE, auth())).toBe(IDLE);
    expect(beginCommit(settled(), auth()).kind).toBe('settled');
  });

  it.each(['committed', 'unchanged'] as const)('消费授权：结果取自授权（%s），与消费方无关', (outcome) => {
    const state = settled(outcome);
    expect(state).toMatchObject({ kind: 'settled', id: 7, outcome, documentId: 1, versionAfter: 4, committedText: '好', caretView: 4, endSeq: 20, diagnostics: 0 });
  });

  it('token 只能消费一次；不匹配的 token 不改变状态', () => {
    const committing = beginCommit(start(), auth());
    expect(consumeCommit(committing, 99, facts)).toEqual({ ok: false, state: committing });
    const first = consumeCommit(committing, 11, facts);
    expect(first.ok).toBe(true);
    expect(consumeCommit(first.state, 11, facts).ok).toBe(false);
  });

  it('CAS 拒绝 → settled{rolled-back}；授权外变化 → settled{committed-unverified}；二者都不保留提交文本', () => {
    const committing = beginCommit(start(), auth());
    const aborted = abortCommit(committing, 11, facts);
    expect(aborted.state).toMatchObject({ kind: 'settled', outcome: 'rolled-back', committedText: '' });
    const unverified = endCommitUnverified(committing, 11, facts);
    expect(unverified.state).toMatchObject({ kind: 'settled', outcome: 'committed-unverified', committedText: '' });
    expect(abortCommit(aborted.state, 11, facts).ok).toBe(false);
  });
});

describe('imeMachine —— 未提交的结束、discard、卡死出口', () => {
  it('回滚 / 取消 / 孤立 end / discarded 的 end 都进入 settled 且不可被当作提交', () => {
    expect(endWithoutCommit(start(), 'rolled-back', 1, facts)).toMatchObject({ kind: 'settled', outcome: 'rolled-back', id: 7 });
    expect(endWithoutCommit(start(), 'canceled', 1, facts)).toMatchObject({ kind: 'settled', outcome: 'canceled' });
    expect(endWithoutCommit(IDLE, 'rolled-back', 1, facts)).toMatchObject({ kind: 'settled', outcome: 'rolled-back', id: -1 });
    expect(endWithoutCommit({ kind: 'discarded', id: 7 }, 'rolled-back', 1, facts)).toMatchObject({ kind: 'settled', outcome: 'discarded' });
  });

  it('committing 不能被「未提交结束」覆盖（只能经授权消费 / 中止 / 授权外变化结束）', () => {
    const committing = beginCommit(start(), auth());
    expect(endWithoutCommit(committing, 'canceled', 1, facts)).toBe(committing);
  });

  it('discard：只有 composing → discarded；其它状态不变', () => {
    expect(discardComposition(start())).toEqual({ kind: 'discarded', id: 7 });
    expect(discardComposition(IDLE)).toBe(IDLE);
    const state = settled();
    expect(discardComposition(state)).toBe(state);
    const committing = beginCommit(start(), auth());
    expect(discardComposition(committing)).toBe(committing);
  });

  it('卡死出口：composing / discarded → idle；其它不变', () => {
    expect(stuckExit(start())).toBe(IDLE);
    expect(stuckExit({ kind: 'discarded', id: 3 })).toBe(IDLE);
    const state = settled();
    expect(stuckExit(state)).toBe(state);
  });
});

describe('imeMachine —— 诊断窗口退出', () => {
  it('事件退出；带会话号的迟到回调只在匹配时退出', () => {
    const state = settled();
    expect(exitSettled(state)).toBe(IDLE);
    expect(exitSettled(state, 7)).toBe(IDLE);
    expect(exitSettled(state, 6)).toBe(state);
    expect(exitSettled(IDLE, 7)).toBe(IDLE);
  });

  it('store 版本或文档变化 → 退出；仍是提交后的值 → 保持', () => {
    const state = settled();
    expect(noteStoreChange(state, 1, 4)).toBe(state);
    expect(noteStoreChange(state, 1, 5)).toBe(IDLE);
    expect(noteStoreChange(state, 2, 4)).toBe(IDLE);
  });
});

describe('imeMachine —— 诊断谓词 D1–D3（Q8-B′，勘误 E-3）', () => {
  const event = (overrides: Partial<Parameters<typeof diagnose>[1]> = {}): Parameters<typeof diagnose>[1] => ({
    inputType: 'insertText',
    cancelable: true,
    data: '好',
    caretAtCommitEnd: true,
    version: 4,
    eventSeq: 23,
    ...overrides,
  });

  it('Q-1′：同文本、光标在提交末尾、版本未变 → 记录全部可观测字段；事件序号差代替任何时间量', () => {
    const { state, record } = diagnose(settled(), event());
    expect(record).toEqual({
      imeSessionId: 7,
      outcome: 'committed',
      inputType: 'insertText',
      dataLength: 1,
      dataMatchesCommit: true,
      caretAtCommitEnd: true,
      versionUnchanged: true,
      eventsSinceEnd: 3,
    });
    expect(state).toMatchObject({ kind: 'settled', diagnostics: 1 });
  });

  it('Q-4′ / Q-9′：不同文本与删除类同样记录，dataMatchesCommit 如实为 false', () => {
    expect(diagnose(settled(), event({ data: '你' })).record?.dataMatchesCommit).toBe(false);
    expect(diagnose(settled(), event({ inputType: 'deleteContentBackward', data: null })).record).toMatchObject({ dataLength: 0, dataMatchesCommit: false });
  });

  it('D2：不可取消或非尾随提交型类型不记录', () => {
    expect(diagnose(settled(), event({ cancelable: false })).record).toBeNull();
    expect(diagnose(settled(), event({ inputType: 'insertFromPaste' })).record).toBeNull();
    expect(diagnose(settled(), event({ inputType: 'insertCompositionText' })).record).toBeNull();
  });

  it('D1：不在诊断窗口（idle / composing）不记录', () => {
    expect(diagnose(IDLE, event()).record).toBeNull();
    expect(diagnose(start(), event()).record).toBeNull();
  });

  it('Q-D3（纯状态机，版本保持不变）：连续 5 个满足 D2 的事件恰好记录 3 条', () => {
    let state = settled();
    let records = 0;
    for (let i = 0; i < 5; i += 1) {
      const step = diagnose(state, event({ eventSeq: 21 + i }));
      state = step.state;
      if (step.record !== null) records += 1;
    }
    expect(records).toBe(MAX_DIAGNOSTICS);
    expect(MAX_DIAGNOSTICS).toBe(3);
  });

  it('无变化提交的窗口：committedText 存在，但 outcome 为 unchanged（诊断如实记录）', () => {
    expect(diagnose(settled('unchanged'), event()).record?.outcome).toBe('unchanged');
  });

  it('Q-shape：settled 状态与诊断记录都没有吸收 / 时间字段', () => {
    const state = settled();
    expect(Object.keys(state).sort()).toEqual(['caretView', 'committedText', 'diagnostics', 'documentId', 'endSeq', 'id', 'kind', 'outcome', 'versionAfter']);
    const record = diagnose(state, event()).record;
    expect(Object.keys(record ?? {}).some((key) => /absorb|time|ms|task|distance/i.test(key))).toBe(false);
  });
});
