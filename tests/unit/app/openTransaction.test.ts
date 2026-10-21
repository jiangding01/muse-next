/**
 * M3 T1c-2：Open 状态机（`src/renderer/app/editor/openTransaction.ts`）的完整转换表（T1c Preflight r2 §3.2 / §9.1；保守 R1）。
 *
 * 重点：只有当前事务收到明确的激活成功才产生一次 `commit`；吊销信号（superseded、open 抛错、首次 invalid、document-mismatch、
 * 预算耗尽）产生 `downgrade-trust`，canceled / failed / busy 不产生；同票重试；迟到事件被忽略；重入不产生副作用。
 * M3 T3a（r3a 复核 H-1）：`controller-failed` / `commit-failed` 按事务阶段 fail closed，已终结的事务不受影响。
 */

import { describe, expect, it } from 'vitest';

import { initialOpenFlow, MAX_ACTIVATION_ATTEMPTS, stepOpenFlow } from '../../../src/renderer/app/editor/openTransaction';
import type { OpenFlowEffect, OpenFlowEvent, OpenFlowState, PrepareCandidate } from '../../../src/renderer/app/editor/openTransaction';
import type { DocumentActivationTicket } from '../../../src/shared/activationContracts';
import type { DecodedDocument } from '../../../src/shared/openContracts';

const DOCUMENT: DecodedDocument = {
  documentId: 3,
  source: 'X:1\nT:t\nK:C\nC|\n',
  writeEncoding: 'utf-8',
  byteBom: 'none',
  encodingRoundTrip: 'exact',
  file: { capability: { id: 'cap-3' }, displayName: 't.jcx', displayPath: '/t.jcx' },
};
const TICKET = { capabilityId: 'cap-3', documentId: 3 };

interface Run {
  readonly state: OpenFlowState;
  readonly effects: OpenFlowEffect[];
}

/** 依次执行事件，累计全部副作用。 */
function run(events: readonly OpenFlowEvent[], start: OpenFlowState = initialOpenFlow(), prepare?: PrepareCandidate): Run {
  let state = start;
  const effects: OpenFlowEffect[] = [];
  for (const event of events) {
    const step = prepare === undefined ? stepOpenFlow(state, event) : stepOpenFlow(state, event, prepare);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const OPEN: OpenFlowEvent = { type: 'open-requested' };
const opened = (txn = 1, dirty = false): OpenFlowEvent => ({ type: 'open-replied', txn, reply: { kind: 'opened', document: DOCUMENT }, dirty });
const ok = (attempt: number, txn = 1, dirty = false): OpenFlowEvent => ({ type: 'activate-replied', txn, attempt, reply: { ok: true }, dirty });
const invalid = (attempt: number, txn = 1): OpenFlowEvent => ({ type: 'activate-replied', txn, attempt, reply: { ok: false, code: 'capability-invalid' }, dirty: false });
const failed = (attempt: number, txn = 1): OpenFlowEvent => ({ type: 'activate-failed', txn, attempt });

const types = (effects: readonly OpenFlowEffect[]): string[] => effects.map((effect) => effect.type);
const commits = (effects: readonly OpenFlowEffect[]): number => effects.filter((effect) => effect.type === 'commit').length;

describe('openTransaction —— 正常路径', () => {
  it('Open → opened → 激活 1 → ok：只提交一次，候选会话即准备好的会话', () => {
    const { state, effects } = run([OPEN, opened(), ok(1)]);
    expect(types(effects)).toEqual(['invoke-open', 'invoke-activate', 'commit']);
    expect(effects[1]).toEqual({ type: 'invoke-activate', txn: 1, attempt: 1, ticket: TICKET });
    const commit = effects[2];
    expect(commit?.type === 'commit' ? commit.session.documentId : null).toBe(3);
    expect(state).toEqual({ txn: 1, phase: 'idle', attempt: 0, candidate: null, notice: null });
  });

  it('opened 之后、激活应答之前：phase 为 activating，候选存在但没有提交', () => {
    const { state, effects } = run([OPEN, opened()]);
    expect(state.phase).toBe('activating');
    expect(state.candidate?.ticket).toEqual(TICKET);
    expect(commits(effects)).toBe(0);
  });
});

describe('openTransaction —— open 阶段的结果', () => {
  it.each([
    ['canceled', { kind: 'canceled' } as const, null, []],
    ['failed（DecodeFailure）', { kind: 'failed', error: { code: 'decode-invalid-utf8', message: 'm' } } as const, { kind: 'open-failed', code: 'decode-invalid-utf8' }, []],
    ['failed（读取失败）', { kind: 'failed', error: { code: 'permission-denied', message: 'm' } } as const, { kind: 'open-failed', code: 'permission-denied' }, []],
    ['busy', { kind: 'rejected', reason: 'busy' } as const, { kind: 'busy' }, []],
    ['superseded', { kind: 'rejected', reason: 'superseded' } as const, { kind: 'superseded' }, ['downgrade-trust']],
  ])('%s：回到 idle，不提交；只有 superseded 是吊销信号', (_label, reply, notice, extraEffects) => {
    const { state, effects } = run([OPEN, { type: 'open-replied', txn: 1, reply, dirty: false }]);
    expect(state.phase).toBe('idle');
    expect(state.notice).toEqual(notice);
    expect(types(effects)).toEqual(['invoke-open', ...extraEffects]);
  });

  it('open 抛错：回到 idle、提示 request-rejected、降级', () => {
    const { state, effects } = run([OPEN, { type: 'open-threw', txn: 1 }]);
    expect(state.notice).toEqual({ kind: 'request-rejected' });
    expect(types(effects)).toEqual(['invoke-open', 'downgrade-trust']);
  });

  it('准备失败：发 reject（票据来自回复），不提交，不降级', () => {
    const prepare: PrepareCandidate = () => ({ ok: false, reason: 'session-failed', ticket: TICKET });
    const { state, effects } = run([OPEN, opened()], initialOpenFlow(), prepare);
    expect(state.notice).toEqual({ kind: 'prepare-failed' });
    expect(effects.slice(1)).toEqual([{ type: 'send-reject', ticket: TICKET }]);
  });

  it('准备失败且没有合法票据：不发 reject', () => {
    const prepare: PrepareCandidate = () => ({ ok: false, reason: 'invalid-document', ticket: null });
    expect(types(run([OPEN, opened()], initialOpenFlow(), prepare).effects)).toEqual(['invoke-open']);
  });
});

describe('openTransaction —— 激活结果（保守 R1）', () => {
  it('首次 capability-invalid：不提交、降级、不发 reject', () => {
    const { state, effects } = run([OPEN, opened(), invalid(1)]);
    expect(state.notice).toEqual({ kind: 'activation-invalid' });
    expect(types(effects)).toEqual(['invoke-open', 'invoke-activate', 'downgrade-trust']);
  });

  it('document-mismatch：不提交、降级、提示内部错误', () => {
    const { state, effects } = run([OPEN, opened(), { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: false, code: 'document-mismatch' }, dirty: false }]);
    expect(state.notice).toEqual({ kind: 'activation-mismatch' });
    expect(types(effects).slice(2)).toEqual(['downgrade-trust']);
  });

  it('超时后同票重试，重试成功：进入 uncertain、只提交一次', () => {
    const mid = run([OPEN, opened(), failed(1)]);
    expect(mid.state.phase).toBe('uncertain');
    expect(mid.effects[2]).toEqual({ type: 'invoke-activate', txn: 1, attempt: 2, ticket: TICKET });
    const { effects } = run([OPEN, opened(), failed(1), ok(2)]);
    expect(commits(effects)).toBe(1);
  });

  it(`预算耗尽（${String(MAX_ACTIVATION_ATTEMPTS)} 次都不确定）：不提交、发 reject、降级`, () => {
    const events = [OPEN, opened(), ...Array.from({ length: MAX_ACTIVATION_ATTEMPTS }, (_, i) => failed(i + 1))];
    const { state, effects } = run(events);
    expect(types(effects).filter((type) => type === 'invoke-activate')).toHaveLength(MAX_ACTIVATION_ATTEMPTS);
    expect(effects.filter((e) => e.type === 'invoke-activate').map((e) => (e.type === 'invoke-activate' ? e.ticket : null))).toEqual(
      Array.from({ length: MAX_ACTIVATION_ATTEMPTS }, () => TICKET),
    );
    expect(effects.slice(-2)).toEqual([{ type: 'send-reject', ticket: TICKET }, { type: 'downgrade-trust' }]);
    expect(state.notice).toEqual({ kind: 'activation-unresolved' });
    expect(commits(effects)).toBe(0);
  });

  it('重试后得到 capability-invalid：降级，不发 reject', () => {
    const { effects } = run([OPEN, opened(), failed(1), invalid(2)]);
    expect(types(effects).slice(-1)).toEqual(['downgrade-trust']);
    expect(types(effects)).not.toContain('send-reject');
  });

  it('已超时尝试的迟到 ok（重试进行中）：明确结果有效，只提交一次；之后的 ok 被忽略', () => {
    const { effects } = run([OPEN, opened(), failed(1), ok(1), ok(2)]);
    expect(commits(effects)).toBe(1);
  });

  it('非当前尝试的失败被忽略（重叠的未 settle 尝试不推进预算）', () => {
    const { state } = run([OPEN, opened(), failed(1), failed(1), failed(1)]);
    expect([state.phase, state.attempt]).toEqual(['uncertain', 2]);
  });
});

describe('openTransaction —— 迟到事件与重入', () => {
  it('事务终结后的迟到 ok：不提交（预算耗尽且已发 reject 之后）', () => {
    const exhausted = [OPEN, opened(), failed(1), failed(2), failed(3)];
    const { effects } = run([...exhausted, ok(1), ok(3)]);
    expect(commits(effects)).toBe(0);
  });

  it('旧事务的应答不影响新事务：txn 1 的 ok 在 txn 2 进行中到达被忽略', () => {
    const first = run([OPEN, { type: 'open-replied', txn: 1, reply: { kind: 'canceled' }, dirty: false }, OPEN, opened(2)]);
    const late = run([ok(1, 1)], first.state);
    expect(commits(late.effects)).toBe(0);
    expect(late.state).toBe(first.state);
    expect(commits(run([ok(1, 2)], first.state).effects)).toBe(1);
  });

  it('旧事务的 open 回复不影响新事务', () => {
    const first = run([OPEN, { type: 'open-threw', txn: 1 }, OPEN]);
    const late = run([opened(1)], first.state);
    expect(late.state).toBe(first.state);
    expect(late.effects).toEqual([]);
  });

  it('重入：进行中的事务再次 Open 不产生任何副作用', () => {
    for (const events of [[OPEN], [OPEN, opened()], [OPEN, opened(), failed(1)]]) {
      const before = run(events);
      const after = stepOpenFlow(before.state, OPEN);
      expect(after.effects).toEqual([]);
      expect(after.state).toBe(before.state);
    }
  });

  it('关闭提示只清除提示，不影响事务', () => {
    const { state } = run([OPEN, { type: 'open-replied', txn: 1, reply: { kind: 'rejected', reason: 'busy' }, dirty: false }, { type: 'notice-dismissed' }]);
    expect(state).toEqual({ txn: 1, phase: 'idle', attempt: 0, candidate: null, notice: null });
  });
});

describe('openTransaction —— 阶段性数据安全（M3 T3a，S5）', () => {
  it('opened 时文档已 dirty：只丢弃 pending 候选，不进入激活、不提交、不降级', () => {
    const { state, effects } = run([OPEN, opened(1, true)]);
    expect(types(effects)).toEqual(['invoke-open', 'send-reject', 'replacement-refused']);
    expect(effects[1]).toEqual({ type: 'send-reject', ticket: TICKET });
    expect(effects[2]).toEqual({ type: 'replacement-refused', stage: 'before-activation' });
    expect(state.phase).toBe('idle');
    expect(state.candidate).toBeNull();
    expect(state.notice).toBeNull();
  });

  it('激活成功时文档已 dirty（最后防线）：不提交，reject 已激活候选，降级授权并沿用 activation-invalid 提示', () => {
    const { state, effects } = run([OPEN, opened(), ok(1, 1, true)]);
    expect(types(effects)).toEqual(['invoke-open', 'invoke-activate', 'send-reject', 'downgrade-trust', 'replacement-refused']);
    expect(commits(effects)).toBe(0);
    expect(effects[4]).toEqual({ type: 'replacement-refused', stage: 'at-commit' });
    expect(state).toEqual({ txn: 1, phase: 'idle', attempt: 0, candidate: null, notice: { kind: 'activation-invalid' } });
  });

  it('激活失败的应答不看 dirty：capability-invalid 照旧只降级', () => {
    const dirtyInvalid: OpenFlowEvent = { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: false, code: 'capability-invalid' }, dirty: true };
    const { effects } = run([OPEN, opened(), dirtyInvalid]);
    expect(types(effects)).toEqual(['invoke-open', 'invoke-activate', 'downgrade-trust']);
  });

  it('反例：dirty 为 false 时提交照常（新字段不改变既有路径）', () => {
    expect(commits(run([OPEN, opened(1, false), ok(1, 1, false)]).effects)).toBe(1);
  });

  it('迟到的 dirty 应答被忽略：事务已终结后不产生任何效果', () => {
    const done = run([OPEN, opened(), ok(1)]);
    expect(run([ok(1, 1, true)], done.state).effects).toEqual([]);
  });
});

describe('openTransaction —— 控制器异常的 fail-closed 终结（r3a 复核 H-1）', () => {
  const crashed = (txn = 1, ticket: DocumentActivationTicket | null = null): OpenFlowEvent => ({ type: 'controller-failed', txn, ticket });
  const IDLE_AFTER = { txn: 1, phase: 'idle', attempt: 0, candidate: null } as const;

  it('requesting 阶段、open 应答带票据（候选尚未激活）：只撤回 pending 候选，不降级', () => {
    const { state, effects } = run([OPEN, crashed(1, TICKET)]);
    expect(effects.slice(1)).toEqual([{ type: 'send-reject', ticket: TICKET }]);
    expect(state).toEqual({ ...IDLE_AFTER, notice: { kind: 'prepare-failed' } });
  });

  it('requesting 阶段、open 应答的含义未知：按 open 抛错处理（降级，提示 request-rejected）', () => {
    const { state, effects } = run([OPEN, crashed()]);
    expect(types(effects)).toEqual(['invoke-open', 'downgrade-trust']);
    expect(state).toEqual({ ...IDLE_AFTER, notice: { kind: 'request-rejected' } });
  });

  it.each([
    ['activating', [OPEN, opened()]],
    ['uncertain（重试中）', [OPEN, opened(), failed(1)]],
  ])('%s 阶段（main 可能已激活）：reject 候选并降级，提示 activation-unresolved，不提交', (_label, events) => {
    const { state, effects } = run([...events, crashed()]);
    expect(commits(effects)).toBe(0);
    expect(effects.slice(-2)).toEqual([{ type: 'send-reject', ticket: TICKET }, { type: 'downgrade-trust' }]);
    expect(state).toEqual({ ...IDLE_AFTER, notice: { kind: 'activation-unresolved' } });
  });

  it('已终结（含已提交）、事务号不符或尚无事务：controller-failed 不产生任何效果', () => {
    const done = run([OPEN, opened(), ok(1)]);
    expect(run([crashed(1, TICKET)], done.state)).toEqual({ state: done.state, effects: [] });
    const active = run([OPEN, opened()]);
    expect(run([crashed(2)], active.state)).toEqual({ state: active.state, effects: [] });
    expect(run([crashed(0)])).toEqual({ state: initialOpenFlow(), effects: [] });
  });

  it('commit 效果携带被提交候选的票据（提交失败时据此撤回已激活的候选）', () => {
    expect(run([OPEN, opened(), ok(1)]).effects.find((effect) => effect.type === 'commit')).toMatchObject({ ticket: TICKET });
  });

  it('commit-failed：刚终结的事务提交失败（main 已激活）→ reject 已激活候选并降级，提示 activation-invalid', () => {
    const done = run([OPEN, opened(), ok(1)]);
    const { state, effects } = run([{ type: 'commit-failed', txn: 1, ticket: TICKET }], done.state);
    expect(effects).toEqual([{ type: 'send-reject', ticket: TICKET }, { type: 'downgrade-trust' }]);
    expect(state).toEqual({ ...IDLE_AFTER, notice: { kind: 'activation-invalid' } });
  });

  it('commit-failed 反例：事务号不符或事务仍在进行时不产生效果', () => {
    const done = run([OPEN, opened(), ok(1)]);
    expect(run([{ type: 'commit-failed', txn: 2, ticket: TICKET }], done.state).effects).toEqual([]);
    const active = run([OPEN, opened()]);
    expect(run([{ type: 'commit-failed', txn: 1, ticket: TICKET }], active.state)).toEqual({ state: active.state, effects: [] });
  });
});
