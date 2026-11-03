/**
 * M3 T4 B3a-1：输入法会话的视图订阅（`imeSession.subscribe`；B3 r0.1 勘误 §3 M-B3-1）。
 *
 * 只在对外视图变化时同步通知；`committing` 仍视为 `composing`（不通知）；订阅者抛错被隔离；退订幂等；
 * 在一次调用内部同步发生的迁移（例如 blur 中同步派发的 compositionend）也会被已订阅者收到；订阅不改变状态、不 discard。
 */

import { describe, expect, it } from 'vitest';

import { createImeSession } from '../../../src/renderer/app/editor/imeSession';
import type { ImeView } from '../../../src/renderer/app/editor/imeMachine';

const startFacts = { documentId: 1, version: 3, view: 'abc', base: { start: 3, end: 3 }, replacing: false };
const facts = { versionAfter: 4, caretView: 4, endSeq: 1 };
const auth = { documentId: 1, authorizedVersion: 4, expectedView: 'abc好', outcome: 'committed' as const, committedText: '好' };

describe('imeSession.subscribe', () => {
  it('视图变化时同步通知；committing 视为 composing，不额外通知', () => {
    const ime = createImeSession();
    const seen: ImeView[] = [];
    ime.subscribe((view) => seen.push(view));
    ime.start(startFacts);
    const token = ime.beginCommit(auth);
    expect(seen).toEqual(['composing']);
    ime.consumeCommit(token ?? -1, facts);
    ime.exitSettled();
    expect(seen).toEqual(['composing', 'settled', 'idle']);
  });

  it('视图不变的迁移不通知（重复 start、无效授权号）', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    const seen: ImeView[] = [];
    ime.subscribe((view) => seen.push(view));
    ime.start(startFacts);
    ime.consumeCommit(999, facts);
    expect(seen).toEqual([]);
  });

  it('退订之后不再通知；退订幂等', () => {
    const ime = createImeSession();
    const seen: ImeView[] = [];
    const unsubscribe = ime.subscribe((view) => seen.push(view));
    unsubscribe();
    unsubscribe();
    ime.start(startFacts);
    expect(seen).toEqual([]);
  });

  it('订阅者抛错被隔离：状态照常迁移，其它订阅者照常收到', () => {
    const ime = createImeSession();
    const seen: ImeView[] = [];
    ime.subscribe(() => {
      throw new Error('listener failed');
    });
    ime.subscribe((view) => seen.push(view));
    expect(() => ime.start(startFacts)).not.toThrow();
    expect(ime.view()).toBe('composing');
    expect(seen).toEqual(['composing']);
  });

  it('先订阅、再执行会同步结束组字的动作（模拟 blur 中同步 compositionend）：通知在动作返回之前到达', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    const order: string[] = [];
    ime.subscribe((view) => order.push(`notify:${view}`));
    const blurThatEndsComposition = (): void => {
      order.push('blur:start');
      ime.endWithoutCommit('canceled', 1, facts);
      order.push('blur:end');
    };
    blurThatEndsComposition();
    expect(order).toEqual(['blur:start', 'notify:settled', 'blur:end']);
    expect(ime.view()).toBe('settled');
  });

  it('订阅本身不改变状态，也不 discard', () => {
    const ime = createImeSession();
    ime.start(startFacts);
    const before = ime.state();
    const unsubscribe = ime.subscribe(() => undefined);
    unsubscribe();
    expect(ime.state()).toBe(before);
  });
});

describe('imeSession.subscribe —— 重入', () => {
  it('订阅者在回调中引发新的迁移：之后的订阅者只收到最新视图，不收到过时的视图', () => {
    const ime = createImeSession();
    const first: ImeView[] = [];
    const second: ImeView[] = [];
    ime.subscribe((view) => {
      first.push(view);
      if (view === 'settled') ime.exitSettled();
    });
    ime.subscribe((view) => second.push(view));
    ime.start(startFacts);
    ime.endWithoutCommit('canceled', 1, facts);
    expect(first).toEqual(['composing', 'settled', 'idle']);
    expect(second).toEqual(['composing', 'idle']);
    expect(ime.view()).toBe('idle');
  });
});
