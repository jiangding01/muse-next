/**
 * M3 T3c：模块级输入法会话（`src/renderer/app/editor/imeSession.ts`；Preflight r1 §7、r1.1 §1）。
 *
 * 会话号与授权号单调、永不复用；对外视图；三种 discard 理由；迟到的退出回调只在会话号匹配时生效。
 */

import { describe, expect, it } from 'vitest';

import { createImeSession } from '../../../src/renderer/app/editor/imeSession';

const startFacts = { documentId: 1, version: 3, view: 'abc', base: { start: 3, end: 3 }, replacing: false };
const facts = { versionAfter: 4, caretView: 4, endSeq: 1 };
const auth = { documentId: 1, authorizedVersion: 4, expectedView: 'abc好', outcome: 'committed' as const, committedText: '好' };

describe('imeSession', () => {
  it('会话号单调：每次真正开始的组字分配新号，重复 start 不分配', () => {
    const ime = createImeSession();
    const first = ime.start(startFacts);
    expect(first).toMatchObject({ kind: 'composing', id: 1 });
    expect(ime.start(startFacts)).toBe(first);
    ime.endWithoutCommit('canceled', 1, facts);
    ime.exitSettled();
    expect(ime.start(startFacts)).toMatchObject({ id: 2 });
  });

  it('授权号单调且只能消费一次；非 composing 时不发授权', () => {
    const ime = createImeSession();
    expect(ime.beginCommit(auth)).toBeNull();
    ime.start(startFacts);
    const token = ime.beginCommit(auth);
    expect(token).toBe(1);
    expect(ime.view()).toBe('composing');
    expect(ime.authorization()).toMatchObject({ token: 1, outcome: 'committed' });
    expect(ime.consumeCommit(token ?? -1, facts)).toBe(true);
    expect(ime.consumeCommit(token ?? -1, facts)).toBe(false);
    expect(ime.view()).toBe('settled');
    ime.exitSettled();
    ime.start(startFacts);
    expect(ime.beginCommit(auth)).toBe(2);
  });

  it('discard 理由：open-commit / store-changed-while-composing → discarded；detach → idle', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    ime.discard('open-commit');
    expect(ime.view()).toBe('discarded');
    ime.stuckExit();
    ime.start(startFacts);
    ime.discard('store-changed-while-composing');
    expect(ime.view()).toBe('discarded');
    ime.discard('detach');
    expect(ime.view()).toBe('idle');
  });

  it('迟到的退出回调：会话号不匹配时无操作', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    ime.endWithoutCommit('canceled', 1, facts);
    const id = ime.state().kind === 'settled' ? 1 : -1;
    ime.exitSettled(id + 1);
    expect(ime.view()).toBe('settled');
    ime.exitSettled(id);
    expect(ime.view()).toBe('idle');
  });

  it('noteStoreChange 退出诊断窗口；diagnose 透传状态机结果', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    const token = ime.beginCommit(auth);
    ime.consumeCommit(token ?? -1, facts);
    const record = ime.diagnose({ inputType: 'insertText', cancelable: true, data: '好', caretAtCommitEnd: true, version: 4, eventSeq: 3 });
    expect(record).toMatchObject({ dataMatchesCommit: true, eventsSinceEnd: 2 });
    ime.noteStoreChange(1, 5);
    expect(ime.view()).toBe('idle');
  });
});
