/**
 * M3 T3c：DOM 选区 → store 选中的同步与收敛（`src/renderer/app/editor/selectionSync.ts`；Preflight r1 §5、r1.1 §2；Q-C1(a)）。
 *
 * 电平触发、三对象 CAS、两次即时尝试 → 一次延迟尝试 → 以 store 为准收束；新请求使旧延迟任务失效；版本 / 文档变化或换代后延迟任务无操作。
 */

import { describe, expect, it } from 'vitest';

import { createHistory } from '../../../src/editor/history/history';
import { createDocumentSession } from '../../../src/editor/session/create';
import type { StoreWriteResult } from '../../../src/renderer/app/store';
import { noSelection } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore } from '../../../src/renderer/app/editor/editorTransitions';
import { createSelectionSync } from '../../../src/renderer/app/editor/selectionSync';

function rig(options: { rejectTimes?: number } = {}) {
  const initial = createDocumentSession({ documentId: 1, source: 'abcdef', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
  let core: EditorCore = { session: initial, history: createHistory(initial), selection: noSelection(1) };
  let rejectTimes = options.rejectTimes ?? 0;
  let generation = 1;
  let canSync = true;
  const dom = { value: 'abcdef', selectionStart: 2, selectionEnd: 4 };
  const posted: (() => void)[] = [];
  const log: string[] = [];
  const sync = createSelectionSync({
    read: () => core,
    write: (next, base): StoreWriteResult => {
      log.push('write');
      if (base !== core && (base.session !== core.session || base.history !== core.history || base.selection !== core.selection)) return { ok: false, reason: 'base-changed' };
      if (rejectTimes > 0) {
        rejectTimes -= 1;
        return { ok: false, reason: 'base-changed' };
      }
      core = next;
      return { ok: true };
    },
    textarea: () => dom,
    canSync: () => canSync,
    generation: () => generation,
    post: (task) => posted.push(task),
    realign: () => log.push('realign'),
    resolveToStore: () => {
      log.push('resolve');
      const range = core.selection.ranges[0];
      dom.selectionStart = range?.start ?? 0;
      dom.selectionEnd = range?.end ?? 0;
    },
    diagnostic: (kind) => log.push(kind),
  });
  return {
    sync,
    dom,
    posted,
    log,
    get core() {
      return core;
    },
    setCore: (next: EditorCore) => {
      core = next;
    },
    setGeneration: (value: number) => {
      generation = value;
    },
    setCanSync: (value: boolean) => {
      canSync = value;
    },
  };
}

describe('selectionSync', () => {
  it('首次即成功：store 选中 = DOM 选区（view → source）', () => {
    const r = rig();
    expect(r.sync.sync()).toBe('written');
    expect(r.core.selection.ranges).toEqual([{ start: 2, end: 4 }]);
    expect(r.sync.sync()).toBe('unchanged');
  });

  it('第一次被拒、即时重算成功', () => {
    const r = rig({ rejectTimes: 1 });
    expect(r.sync.sync()).toBe('written');
    expect(r.log.filter((x) => x === 'write')).toHaveLength(2);
  });

  it('连续三次被拒且之后没有任何事件 → 延迟任务收束为 store 选中，无待办', () => {
    const r = rig({ rejectTimes: 3 });
    expect(r.sync.sync()).toBe('deferred');
    expect(r.sync.hasDeferred()).toBe(true);
    r.posted.shift()?.();
    expect(r.log).toEqual(['write', 'write', 'write', 'resolve', 'selection-sync-resolved-to-store']);
    expect(r.sync.hasDeferred()).toBe(false);
    expect([r.dom.selectionStart, r.dom.selectionEnd]).toEqual([0, 0]);
    expect(r.posted).toHaveLength(0);
  });

  it('两次被拒、延迟任务中第三次成功 → store = DOM，不收束', () => {
    const r = rig({ rejectTimes: 2 });
    r.sync.sync();
    r.posted.shift()?.();
    expect(r.core.selection.ranges).toEqual([{ start: 2, end: 4 }]);
    expect(r.log).not.toContain('resolve');
  });

  it('延迟任务执行前出现新的同步请求 → 旧任务无操作', () => {
    const r = rig({ rejectTimes: 2 });
    r.sync.sync();
    const stale = r.posted.shift();
    r.dom.selectionStart = 1;
    r.dom.selectionEnd = 1;
    expect(r.sync.sync()).toBe('written');
    const writes = r.log.length;
    stale?.();
    expect(r.log).toHaveLength(writes);
    expect(r.core.selection.ranges).toEqual([{ start: 1, end: 1 }]);
  });

  it('延迟任务执行前版本变化（undo 等）或换代 → 无操作', () => {
    const r = rig({ rejectTimes: 2 });
    r.sync.sync();
    r.setCore({ ...r.core, session: { ...r.core.session, sourceVersion: 9 } });
    const writes = r.log.length;
    r.posted.shift()?.();
    expect(r.log).toHaveLength(writes);
    const g = rig({ rejectTimes: 2 });
    g.sync.sync();
    g.setGeneration(2);
    const before = g.log.length;
    g.posted.shift()?.();
    expect(g.log).toHaveLength(before);
  });

  it('不可同步（组字中 / Open 进行中 / broken）时不写；DOM ≠ view 时交给写回层整体对齐', () => {
    const r = rig();
    r.setCanSync(false);
    expect(r.sync.sync()).toBe('skipped');
    expect(r.log).toEqual([]);
    r.setCanSync(true);
    r.dom.value = 'zzz';
    expect(r.sync.sync()).toBe('skipped');
    expect(r.log).toEqual(['realign']);
  });

  it('invalidate 使待办延迟任务失效', () => {
    const r = rig({ rejectTimes: 2 });
    r.sync.sync();
    r.sync.invalidate();
    const before = r.log.length;
    r.posted.shift()?.();
    expect(r.log).toHaveLength(before);
    expect(r.sync.hasDeferred()).toBe(false);
  });
});
