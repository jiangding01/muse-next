/**
 * M3 T3a：解析调度控制器（`src/renderer/app/editor/parseController.ts`；T3 Preflight r3 §6，外部审查 H3-3）。
 *
 * 用假时钟与假 store 驱动：自动调度在当前版本已解析时不调用 `loadJcx`；显式 Reparse 同版本也调用；undo 后立即解析；
 * 结果的 documentId / sourceVersion 与当前不一致时丢弃；`loadJcx` 抛错时原快照保留、之后可再次成功；旧定时器不再触发。
 */

import { describe, expect, it } from 'vitest';

import { applySourceTransaction } from '../../../src/editor/session/reducer';
import type { DocumentSession } from '../../../src/editor/session/types';
import { loadJcx } from '../../../src/formats/jcxParse';
import type { JcxEncoding, LoadResult } from '../../../src/formats/jcxParse';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import type { EditorNotice } from '../../../src/renderer/app/editor/editorTransitions';
import { createParseController } from '../../../src/renderer/app/editor/parseController';
import type { StoreWriteResult } from '../../../src/renderer/app/store';

interface Fixture {
  current: DocumentSession;
  /** 发布行为：默认写入；'reject' 返回被拒；'throw' 抛错。 */
  publishMode: 'write' | 'reject' | 'throw';
  now: number;
  loads: { source: string; encoding: JcxEncoding }[];
  notices: EditorNotice['kind'][];
  errors: unknown[];
  timers: Map<number, { delay: number; due: number; task: () => void }>;
  failNext: boolean;
  /** 解析期间（`load` 之内）把当前会话换掉，模拟「结果迟到」。 */
  swapDuringLoad: DocumentSession | null;
}

function fixture() {
  const f: Fixture = {
    current: createDemoSession(),
    publishMode: 'write',
    now: 0,
    loads: [],
    notices: [],
    errors: [],
    timers: new Map(),
    failNext: false,
    swapDuringLoad: null,
  };
  let nextTimer = 0;
  const controller = createParseController({
    schedule: (delay, task) => {
      nextTimer += 1;
      const id = nextTimer;
      f.timers.set(id, { delay, due: f.now + delay, task });
      return () => f.timers.delete(id);
    },
    read: () => f.current,
    load: (source, encoding): LoadResult => {
      f.loads.push({ source, encoding });
      if (f.failNext) {
        f.failNext = false;
        throw new Error('load exploded');
      }
      if (f.swapDuringLoad !== null) f.current = f.swapDuringLoad;
      return loadJcx(source, { sourceEncoding: encoding });
    },
    publish: (session): StoreWriteResult => {
      if (f.publishMode === 'throw') throw new Error('publish exploded');
      if (f.publishMode === 'reject') return { ok: false, reason: 'session-changed' };
      f.current = session;
      return { ok: true };
    },
    notify: (notice) => f.notices.push(notice.kind),
    report: (error) => f.errors.push(error),
  });
  /** 触发所有仍在的定时器（假时钟推进到期）。 */
  const fireAll = (): void => {
    for (const [id, timer] of [...f.timers]) {
      f.timers.delete(id);
      timer.task();
    }
  };
  /** 假时钟：推进 ms 毫秒，触发到期（相对安排时刻）的定时器。 */
  const advance = (ms: number): void => {
    f.now += ms;
    for (const [id, timer] of [...f.timers]) {
      if (timer.due <= f.now) {
        f.timers.delete(id);
        timer.task();
      }
    }
  };
  return { f, controller, fireAll, advance };
}

/** 在 demo 末尾追加文本，版本 +1（解析快照保持旧版本，即 stale）。 */
function edited(session: DocumentSession, text = 'z'): DocumentSession {
  const applied = applySourceTransaction(session, { baseVersion: session.sourceVersion, patches: [{ start: session.source.length, end: session.source.length, text }] });
  if (!applied.ok) throw new Error(applied.reason);
  return applied.session;
}

describe('parseController —— 自动调度去重与显式 Reparse（H3-3）', () => {
  it('当前版本已解析：自动调度到期与 blur 都不调用 loadJcx', () => {
    const { f, controller, fireAll } = fixture();
    controller.sourceChanged();
    expect([...f.timers.values()].map((timer) => timer.delay)).toEqual([500]);
    fireAll();
    expect(controller.flush('blur')).toBe('skipped');
    expect(f.loads).toEqual([]);
  });

  it('显式 Reparse：同版本也调用 loadJcx（连按两次调用两次），版本与 source 不变、快照换为新对象，并提示已重新解析', () => {
    const { f, controller } = fixture();
    const before = f.current;
    expect(controller.flush('reparse')).toBe('parsed');
    const first = f.current;
    expect(controller.flush('reparse')).toBe('parsed');
    expect(f.loads).toHaveLength(2);
    expect(f.loads[0]).toEqual({ source: before.source, encoding: 'utf-8' });
    expect(f.current.sourceVersion).toBe(before.sourceVersion);
    expect(f.current.source).toBe(before.source);
    expect(f.current.parsed).not.toBe(first.parsed);
    expect(f.current.parsed?.sourceVersion).toBe(before.sourceVersion);
    expect(f.notices).toEqual(['reparsed', 'reparsed']);
  });

  it('stale 版本：debounce 到期后解析一次并发布新版本快照', () => {
    const { f, controller, fireAll } = fixture();
    f.current = edited(f.current);
    controller.sourceChanged();
    fireAll();
    expect(f.loads).toHaveLength(1);
    expect(f.current.parsed?.sourceVersion).toBe(2);
  });

  it('undo / redo 的 flush 立即解析新版本；Reparse 取消旧定时器，旧定时器不再触发', () => {
    const { f, controller, fireAll } = fixture();
    f.current = edited(f.current);
    controller.sourceChanged();
    expect(controller.flush('undo')).toBe('parsed');
    expect(f.timers.size).toBe(0);
    fireAll();
    expect(f.loads).toHaveLength(1);
  });
});

describe('parseController —— 双重校验与异常', () => {
  it('解析期间文档被替换（documentId 不同）：结果丢弃，不发布', () => {
    const { f, controller } = fixture();
    f.current = edited(f.current);
    const other = { ...createDemoSession(), documentId: 42 };
    f.swapDuringLoad = other;
    expect(controller.flush('reparse')).toBe('discarded');
    expect(f.current).toBe(other);
    expect(f.notices).toEqual([]);
  });

  it('解析期间版本前进：旧版本结果丢弃', () => {
    const { f, controller } = fixture();
    const v2 = edited(f.current);
    f.current = v2;
    f.swapDuringLoad = edited(v2, 'y');
    expect(controller.flush('blur')).toBe('discarded');
    expect(f.current.parsed?.sourceVersion).toBe(1);
  });

  it('loadJcx 抛错：报告错误并提示解析失败，原快照保留；之后再次 Reparse 成功', () => {
    const { f, controller } = fixture();
    const before = f.current;
    f.failNext = true;
    expect(controller.flush('reparse')).toBe('failed');
    expect(f.current).toBe(before);
    expect(f.errors).toHaveLength(1);
    expect(f.notices).toEqual(['parse-failed']);
    expect(controller.flush('reparse')).toBe('parsed');
  });
});

describe('parseController —— 组字与文档替换', () => {
  it('组字中 Reparse 被忽略并提示；组字结束后按 debounce 补解析', () => {
    const { f, controller, fireAll } = fixture();
    controller.compositionStart();
    f.current = edited(f.current);
    controller.sourceChanged();
    expect(controller.flush('reparse')).toBe('ignored-composing');
    expect(f.notices).toEqual(['reparse-ignored-composing']);
    expect(f.timers.size).toBe(0);
    controller.compositionEnd();
    fireAll();
    expect(f.loads).toHaveLength(1);
  });

  it('文档替换取消定时器，旧定时器不再触发', () => {
    const { f, controller } = fixture();
    controller.sourceChanged();
    controller.documentReplaced();
    expect(f.timers.size).toBe(0);
    expect(controller.state().armed).toBeNull();
  });
});

describe('parseController —— 499 / 500 边界与非 loadJcx 异常（r3a 审查 L-6 / M-4）', () => {
  it('debounce：推进 499ms 不解析，再推进 1ms 解析', () => {
    const { f, controller, advance } = fixture();
    f.current = edited(f.current);
    controller.sourceChanged();
    advance(499);
    expect(f.loads).toHaveLength(0);
    advance(1);
    expect(f.loads).toHaveLength(1);
  });

  it('发布抛错：控制器不抛出，归入编辑器错误并提示解析失败', () => {
    const { f, controller } = fixture();
    f.publishMode = 'throw';
    expect(controller.flush('reparse')).toBe('failed');
    expect(f.errors).toHaveLength(1);
    expect(f.notices).toEqual(['parse-failed']);
  });

  it('发布被 store 拒绝：丢弃并上报（说明不变量被破坏）', () => {
    const { f, controller } = fixture();
    f.publishMode = 'reject';
    expect(controller.flush('reparse')).toBe('discarded');
    expect(f.errors).toHaveLength(1);
  });

  it('定时器回调中的异常不逃出回调', () => {
    const { f, controller, fireAll } = fixture();
    f.current = edited(f.current);
    f.publishMode = 'throw';
    controller.sourceChanged();
    expect(() => fireAll()).not.toThrow();
    expect(f.errors).toHaveLength(1);
  });
});
