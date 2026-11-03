/**
 * M3 T4 B3a-2：Save / Save As 纯状态机（`src/renderer/app/save/saveTransaction.ts`；B3 r0 §3.2–§3.6，r0.1 勘误 §1–§3，H-5）。
 *
 * 表驱动：入口顺序（R10 → R5 → R7 / 未命名转 Save As → 送达门 → 预检）、Save As 两阶段与第二道送达门、三态结果、
 * D1–D4（激活成功 / CAS 失败 / 明确失败 / 不确定）、迟到结果、各阶段的 aborted 收束与 `trustAfterSaveAsFailure`。
 */

import { describe, expect, it } from 'vitest';

import { ACTIVATION_TIMEOUT_MS, MAX_ACTIVATION_ATTEMPTS } from '../../../src/renderer/app/editor/openTransaction';
import {
  initialSaveFlow,
  MAX_SAVE_ACTIVATION_ATTEMPTS,
  SAVE_ACTIVATION_TIMEOUT_MS,
  saveReply,
  stepSaveFlow,
  targetReply,
  trustAfterSaveAsFailure,
} from '../../../src/renderer/app/save/saveTransaction';
import type { SaveFlowEffect, SaveFlowEvent, SaveFlowState, SaveKind } from '../../../src/renderer/app/save/saveTransaction';
import type { SaveDocumentReply } from '../../../src/shared/saveContracts';

const TICKET = { capabilityId: 'cap-new', documentId: 7 } as const;
const FILE = { capability: { id: 'cap-a' }, displayName: 'a.jcx', displayPath: '/a.jcx' };
const SAVED: SaveDocumentReply = { outcome: 'saved', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', displayName: 'n.jcx', displayPath: '/n.jcx', ticket: null };
const SAVED_AS: SaveDocumentReply = { ...SAVED, ticket: TICKET };
const READY = { hasFile: true, dirty: true };

interface Run {
  state: SaveFlowState;
  effects: SaveFlowEffect[];
}

function drive(events: readonly SaveFlowEvent[], start: SaveFlowState = initialSaveFlow()): Run {
  let state = start;
  const effects: SaveFlowEffect[] = [];
  for (const event of events) {
    const step = stepSaveFlow(state, event);
    state = step.state;
    effects.push(...step.effects);
  }
  return { state, effects };
}

const types = (effects: readonly SaveFlowEffect[]): string[] => effects.map((effect) => (effect.type === 'report' ? `report:${effect.message.kind}` : effect.type));

/** 走到阶段 2 写入之前（Save As，txn 1）。 */
const toWriting = (kind: SaveKind): SaveFlowEvent[] =>
  kind === 'save'
    ? [
        { type: 'save-requested', kind: 'save', saveEnabled: true },
        { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY },
        { type: 'gate-checked', txn: 1, delivered: true, unencodable: null },
      ]
    : [
        { type: 'save-requested', kind: 'saveAs', saveEnabled: true },
        { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY },
        { type: 'gate-checked', txn: 1, delivered: true, unencodable: null },
        { type: 'target-replied', txn: 1, reply: { kind: 'granted', capabilityId: 'G', displayName: 'n.jcx', displayPath: '/n.jcx', sameAsCurrent: false } },
        { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY },
        { type: 'gate-checked', txn: 1, delivered: true, unencodable: null },
      ];

const toActivating: SaveFlowEvent[] = [...toWriting('saveAs'), { type: 'save-replied', txn: 1, reply: SAVED_AS }];

describe('saveTransaction —— 常量与 T1c 同值（Q-B3-6）', () => {
  it('激活每次 5 s、最多 3 次；R5 500 ms', () => {
    expect(SAVE_ACTIVATION_TIMEOUT_MS).toBe(ACTIVATION_TIMEOUT_MS);
    expect(MAX_SAVE_ACTIVATION_ATTEMPTS).toBe(MAX_ACTIVATION_ATTEMPTS);
  });
});

describe('saveTransaction —— 入口顺序（r0 §3.2）', () => {
  it('R10：本平台未开放普通 Save → 无操作（不等待、不提示）；Save As 不受影响', () => {
    const save = drive([{ type: 'save-requested', kind: 'save', saveEnabled: false }]);
    expect(save.state.phase).toBe('idle');
    expect(save.effects).toEqual([]);
    const saveAs = drive([{ type: 'save-requested', kind: 'saveAs', saveEnabled: false }]);
    expect(saveAs.state.phase).toBe('settling-ime');
    expect(types(saveAs.effects)).toEqual(['settle-ime']);
  });

  it('先 R5：ime 超时 → 拒绝（ime-timeout），不过送达门、不发 IPC', () => {
    const run = drive([
      { type: 'save-requested', kind: 'save', saveEnabled: true },
      { type: 'ime-settled', txn: 1, outcome: 'timeout', facts: READY },
    ]);
    expect(run.state.phase).toBe('idle');
    expect(types(run.effects)).toEqual(['settle-ime', 'report:ime-timeout']);
  });

  it('R7：clean 的普通 Save 短路（不过送达门）；未命名文档的 Save 转为 Save As（不论 dirty）', () => {
    const clean = drive([
      { type: 'save-requested', kind: 'save', saveEnabled: true },
      { type: 'ime-settled', txn: 1, outcome: 'ready', facts: { hasFile: true, dirty: false } },
    ]);
    expect(types(clean.effects)).toEqual(['settle-ime', 'report:nothing-to-save']);
    const demo = drive([
      { type: 'save-requested', kind: 'save', saveEnabled: true },
      { type: 'ime-settled', txn: 1, outcome: 'ready', facts: { hasFile: false, dirty: false } },
    ]);
    expect(demo.state).toMatchObject({ kind: 'saveAs', phase: 'gating' });
    expect(demo.effects.at(-1)).toEqual({ type: 'check-gate', txn: 1, beforeWrite: false });
    const saveAsClean = drive([
      { type: 'save-requested', kind: 'saveAs', saveEnabled: true },
      { type: 'ime-settled', txn: 1, outcome: 'ready', facts: { hasFile: true, dirty: false } },
    ]);
    expect(saveAsClean.state.phase).toBe('gating');
  });

  it('送达门：未送达 → reject-pending；普通 Save 的预检发现不可编码字符 → 拒绝（含行列与编码），不写入', () => {
    const base: SaveFlowEvent[] = [
      { type: 'save-requested', kind: 'save', saveEnabled: true },
      { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY },
    ];
    const refused = drive([...base, { type: 'gate-checked', txn: 1, delivered: false, unencodable: null }]);
    expect(types(refused.effects)).toEqual(['settle-ime', 'check-gate', 'report:reject-pending']);
    const bad = drive([...base, { type: 'gate-checked', txn: 1, delivered: true, unencodable: { line: 2, column: 3, encoding: 'gb18030' } }]);
    expect(bad.effects.at(-1)).toEqual({ type: 'report', message: { kind: 'unencodable', line: 2, column: 3, encoding: 'gb18030' } });
    expect(types(bad.effects)).not.toContain('write');
    const ok = drive(toWriting('save'));
    expect(ok.state.phase).toBe('writing');
    expect(ok.effects.at(-1)).toEqual({ type: 'write', txn: 1, kind: 'save', target: null });
  });

  it('进行中再次请求不改变状态（准入由控制器的租约同步拒绝）', () => {
    const run = drive([{ type: 'save-requested', kind: 'save', saveEnabled: true }]);
    const again = stepSaveFlow(run.state, { type: 'save-requested', kind: 'saveAs', saveEnabled: true });
    expect(again.state).toBe(run.state);
    expect(again.effects).toEqual([]);
  });
});

describe('saveTransaction —— Save As 两阶段（Q-B3-4、追加硬门 1）', () => {
  it('送达门 → 阶段 1 → 第二次 R5 → 第二道送达门（预检）→ 写入；阶段 2 之前重新核对', () => {
    const run = drive(toWriting('saveAs'));
    expect(types(run.effects)).toEqual(['settle-ime', 'check-gate', 'request-target', 'settle-ime', 'check-gate', 'write']);
    expect(run.effects[1]).toEqual({ type: 'check-gate', txn: 1, beforeWrite: false });
    expect(run.effects[4]).toEqual({ type: 'check-gate', txn: 1, beforeWrite: true });
    expect(run.effects[5]).toEqual({ type: 'write', txn: 1, kind: 'saveAs', target: { capabilityId: 'G', displayName: 'n.jcx' } });
  });

  it('对话框之后：R5 超时、第二道送达门未送达、预检失败都不写入', () => {
    const upToTarget = toWriting('saveAs').slice(0, 4);
    expect(types(drive([...upToTarget, { type: 'ime-settled', txn: 1, outcome: 'timeout', facts: READY }]).effects).at(-1)).toBe('report:ime-timeout');
    const gate2 = [...upToTarget, { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY } as const];
    expect(types(drive([...gate2, { type: 'gate-checked', txn: 1, delivered: false, unencodable: null }]).effects).at(-1)).toBe('report:reject-pending');
    const bad = drive([...gate2, { type: 'gate-checked', txn: 1, delivered: true, unencodable: { line: 1, column: 0, encoding: 'utf-8' } }]);
    expect(types(bad.effects)).not.toContain('write');
    expect(bad.state.phase).toBe('idle');
  });

  it('阶段 1：取消静默结束；refused 写诊断（source-mismatch 另在后台 flush 账本，Q-B3-2）；抛错 / 畸形 → dialog-failed', () => {
    const upToDialog = toWriting('saveAs').slice(0, 3);
    expect(drive([...upToDialog, { type: 'target-replied', txn: 1, reply: { kind: 'canceled' } }]).effects.slice(3)).toEqual([]);
    const mismatch = drive([...upToDialog, { type: 'target-replied', txn: 1, reply: { kind: 'refused', error: { code: 'source-mismatch', message: 'x' } } }]);
    expect(types(mismatch.effects.slice(3))).toEqual(['report:failed', 'flush-ledger']);
    const busy = drive([...upToDialog, { type: 'target-replied', txn: 1, reply: { kind: 'refused', error: { code: 'busy', message: 'x' } } }]);
    expect(types(busy.effects.slice(3))).toEqual(['report:failed']);
    expect(types(drive([...upToDialog, { type: 'target-replied', txn: 1, reply: null }]).effects.slice(3))).toEqual(['report:dialog-failed']);
  });
});

describe('saveTransaction —— 写入结果三态（r0 §3.4 / §3.5）', () => {
  it('普通 Save：saved → 提示后前移检查点；committed-unconfirmed → 前移并降级；not-committed → 只结束操作；结果未知 → 结束并提示', () => {
    const after = (reply: SaveDocumentReply | null): string[] => types(drive([...toWriting('save'), { type: 'save-replied', txn: 1, reply }]).effects.slice(3));
    expect(after(SAVED)).toEqual(['report:saved', 'settle-save']);
    expect(drive([...toWriting('save'), { type: 'save-replied', txn: 1, reply: SAVED }]).effects.at(-1)).toEqual({ type: 'settle-save', downgrade: false });
    expect(drive([...toWriting('save'), { type: 'save-replied', txn: 1, reply: { ...SAVED, outcome: 'committed-unconfirmed' } }]).effects.at(-1)).toEqual({
      type: 'settle-save',
      downgrade: true,
    });
    expect(after({ outcome: 'not-committed', error: { code: 'write-failed', message: 'x' } })).toEqual(['finish', 'report:failed']);
    expect(after(null)).toEqual(['finish', 'report:result-unknown']);
  });

  it('Save As：saved 带票 → 激活第 1 次；committed-unconfirmed 或无票 → 不切换（save-as-unconfirmed）；not-committed → 结束', () => {
    const run = drive(toActivating);
    expect(run.state).toMatchObject({ phase: 'activating', attempt: 1 });
    expect(run.effects.at(-1)).toEqual({ type: 'activate', txn: 1, attempt: 1, ticket: TICKET });
    // committed-unconfirmed 即使（异常地）带了票据也不得激活切换。
    for (const reply of [{ ...SAVED_AS, outcome: 'committed-unconfirmed' as const, ticket: null }, { ...SAVED_AS, outcome: 'committed-unconfirmed' as const }, SAVED]) {
      const unconfirmed = drive([...toWriting('saveAs'), { type: 'save-replied', txn: 1, reply }]);
      expect(types(unconfirmed.effects.slice(6))).toEqual(['finish', 'report:save-as-unconfirmed']);
      expect(unconfirmed.effects).toContainEqual({ type: 'finish', reason: 'plain' });
    }
  });
});

describe('saveTransaction —— Save As 激活与迁移（D1–D4 / F1–F4）', () => {
  it('D1：ok → 先提示再 settle-save-as（CAS 失败时 settle-failed 的提示取代成功提示）', () => {
    const run = drive([...toActivating, { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: true } }]);
    expect(run.state.phase).toBe('idle');
    expect(types(run.effects.slice(7))).toEqual(['report:saved-as', 'settle-save-as']);
  });

  it('D2：settle-failed → 经账本 reject，不写会话、不降级', () => {
    const run = drive([
      ...toActivating,
      { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: true } },
      { type: 'settle-failed', txn: 1, ticket: TICKET, displayName: 'n.jcx' },
    ]);
    expect(types(run.effects.slice(9))).toEqual(['send-reject', 'report:save-as-not-switched']);
    expect(run.effects).not.toContainEqual({ type: 'finish', reason: 'save-as-activation' });
  });

  it('D3：明确失败 → 结束操作（H-5 授权规则），不 reject', () => {
    const run = drive([...toActivating, { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: false, code: 'capability-invalid' } }]);
    expect(run.effects.slice(7)).toEqual([{ type: 'finish', reason: 'save-as-activation' }, { type: 'report', message: { kind: 'save-as-not-switched', displayName: 'n.jcx' } }]);
  });

  it('D4：三次都无明确应答 → reject + 结束（H-5）；同一张票重试', () => {
    const run = drive([
      ...toActivating,
      { type: 'activate-failed', txn: 1, attempt: 1 },
      { type: 'activate-failed', txn: 1, attempt: 2 },
      { type: 'activate-failed', txn: 1, attempt: 3 },
    ]);
    expect(types(run.effects.slice(6))).toEqual(['activate', 'activate', 'activate', 'send-reject', 'finish', 'report:save-as-not-switched']);
    expect(run.effects.filter((effect) => effect.type === 'activate')).toEqual([1, 2, 3].map((attempt) => ({ type: 'activate', txn: 1, attempt, ticket: TICKET })));
    expect(run.effects).toContainEqual({ type: 'send-reject', ticket: TICKET });
    expect(run.effects).toContainEqual({ type: 'finish', reason: 'save-as-activation' });
  });

  it('迟到：进行中较早尝试的明确结果终结事务；不是当前尝试的 failed 被忽略；终结后的一切迟到事件被忽略', () => {
    const retrying = drive([...toActivating, { type: 'activate-failed', txn: 1, attempt: 1 }]);
    expect(retrying.state.attempt).toBe(2);
    expect(stepSaveFlow(retrying.state, { type: 'activate-failed', txn: 1, attempt: 1 }).effects).toEqual([]);
    const lateOk = stepSaveFlow(retrying.state, { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: true } });
    expect(types(lateOk.effects)).toEqual(['report:saved-as', 'settle-save-as']);
    const ended = drive([{ type: 'activate-failed', txn: 1, attempt: 2 }, { type: 'activate-failed', txn: 1, attempt: 3 }], retrying.state);
    expect(ended.state.phase).toBe('idle');
    for (const late of [
      { type: 'activate-replied', txn: 1, attempt: 1, reply: { ok: true } },
      { type: 'save-replied', txn: 1, reply: SAVED_AS },
      { type: 'target-replied', txn: 1, reply: { kind: 'canceled' } },
      { type: 'gate-checked', txn: 1, delivered: true, unencodable: null },
      { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY },
      { type: 'aborted', txn: 1, committed: true, ticket: TICKET },
    ] as const) {
      const step = stepSaveFlow(ended.state, late);
      expect(step.state, late.type).toBe(ended.state);
      expect(step.effects, late.type).toEqual([]);
    }
  });

  it('旧事务（txn 不同）的事件不影响新事务', () => {
    const first = drive([{ type: 'save-requested', kind: 'save', saveEnabled: true }, { type: 'ime-settled', txn: 1, outcome: 'timeout', facts: READY }]);
    const second = drive([{ type: 'save-requested', kind: 'save', saveEnabled: true }], first.state);
    expect(second.state.txn).toBe(2);
    const stale = stepSaveFlow(second.state, { type: 'ime-settled', txn: 1, outcome: 'ready', facts: READY });
    expect(stale.state).toBe(second.state);
  });
});

describe('saveTransaction —— aborted（await 恢复后租约 / 文档身份不成立，或回调异常；勘误 §1.3）', () => {
  it('尚未写入的各阶段：只结束（changed），不 finish、不 reject', () => {
    const prefixes = toWriting('saveAs');
    for (let n = 1; n <= 5; n += 1) {
      const run = drive([...prefixes.slice(0, n), { type: 'aborted', txn: 1, committed: null, ticket: null }]);
      expect(run.state.phase, String(n)).toBe('idle');
      expect(types(run.effects).at(-1), String(n)).toBe('report:changed');
      expect(types(run.effects), String(n)).not.toContain('finish');
    }
  });

  it('写入中：未提交 → 结束 + changed；已提交 → 结束 + result-not-applied（候选经账本 reject）；未知 → result-unknown', () => {
    const at = (committed: boolean | null, ticket: typeof TICKET | null): string[] =>
      types(drive([...toWriting('saveAs'), { type: 'aborted', txn: 1, committed, ticket }]).effects.slice(6));
    expect(at(false, null)).toEqual(['finish', 'report:changed']);
    expect(at(true, TICKET)).toEqual(['finish', 'send-reject', 'report:result-not-applied']);
    expect(at(null, null)).toEqual(['finish', 'report:result-unknown']);
  });

  it('激活中：按 D4 收束（reject + H-5 + 提示）', () => {
    const run = drive([...toActivating, { type: 'aborted', txn: 1, committed: true, ticket: null }]);
    expect(types(run.effects.slice(7))).toEqual(['send-reject', 'finish', 'report:save-as-not-switched']);
  });
});

describe('trustAfterSaveAsFailure（H-5，T-H5-2 / T-H5-5 / T-H5-8）', () => {
  it('demo（无文件）保持原值（none）；已打开文件 trusted → unverified；已降级保持', () => {
    expect(trustAfterSaveAsFailure(null, 'none')).toBe('none');
    expect(trustAfterSaveAsFailure(FILE, 'trusted')).toBe('unverified');
    expect(trustAfterSaveAsFailure(FILE, 'unverified')).toBe('unverified');
    // 规则只看文件：file === null 时绝不产生 unverified（store 一致性 file === null ⇔ none）。
    for (const trust of ['none', 'trusted', 'unverified'] as const) expect(trustAfterSaveAsFailure(null, trust)).toBe(trust);
  });
});

describe('应答结构校验', () => {
  it('畸形应答一律 null；合法应答原样返回', () => {
    expect(targetReply({ kind: 'canceled' })).toEqual({ kind: 'canceled' });
    expect(targetReply({ kind: 'granted', capabilityId: 'G', displayName: 'n' })).not.toBeNull();
    for (const bad of [null, 1, {}, { kind: 'granted' }, { kind: 'refused' }, { kind: 'refused', error: {} }]) expect(targetReply(bad)).toBeNull();
    expect(saveReply(SAVED_AS)).toBe(SAVED_AS);
    expect(saveReply({ outcome: 'not-committed', error: { code: 'busy', message: 'x' } })).not.toBeNull();
    for (const bad of [null, {}, { outcome: 'saved' }, { ...SAVED, ticket: { capabilityId: 1 } }, { outcome: 'not-committed' }, { ...SAVED, outcome: 'done' }]) {
      expect(saveReply(bad)).toBeNull();
    }
  });
});
