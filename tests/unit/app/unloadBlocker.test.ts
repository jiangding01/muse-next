/**
 * M3 T3a：模块级同步 beforeunload（`src/renderer/app/editor/unloadBlocker.ts`；方案 §15.3，T3 Preflight r3 §8，外部审查 H3-2）。
 *
 * 重点：判据同步求值；dirty 或组字中时 preventDefault 并设置 returnValue、给出提示；clean 时放行；安装幂等；
 * 产品判据中 dirty 优先、只有 composing 计入组字（discarded / settled 不阻止，r3 复查 H-1）。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';
import { createUnloadHandler, installUnloadBlocker, museUnloadReason, unloadReasonFor } from '../../../src/renderer/app/editor/unloadBlocker';
import type { BeforeUnloadEventLike, UnloadBlockReason, UnloadTargetLike } from '../../../src/renderer/app/editor/unloadBlocker';
import { applySourceInput, sourceSelectionFromView } from '../../../src/renderer/app/editor/editorTransitions';
import { applyEditorStep, commitSession, useMuseAppStore } from '../../../src/renderer/app/store';

function event(): BeforeUnloadEventLike & { prevented: boolean } {
  const e: BeforeUnloadEventLike & { prevented: boolean } = {
    prevented: false,
    returnValue: undefined,
    preventDefault() {
      e.prevented = true;
    },
  };
  return e;
}

afterEach(() => {
  commitSession(createDemoSession(), 'none');
});

describe('unloadBlocker —— 处理器', () => {
  it.each(['dirty', 'composing'] as const)('%s：阻止并设置 returnValue，通知原因', (reason) => {
    const notified: UnloadBlockReason[] = [];
    const handler = createUnloadHandler({ reason: () => reason, notify: (r) => notified.push(r) });
    const e = event();
    handler(e);
    expect(e.prevented).toBe(true);
    expect(e.returnValue).toBe('');
    expect(notified).toEqual([reason]);
  });

  it('clean 且未组字：放行，不通知', () => {
    const notified: UnloadBlockReason[] = [];
    const handler = createUnloadHandler({ reason: () => null, notify: (r) => notified.push(r) });
    const e = event();
    handler(e);
    expect(e.prevented).toBe(false);
    expect(e.returnValue).toBeUndefined();
    expect(notified).toEqual([]);
  });

  it('判据在事件发生时同步读取（不缓存）', () => {
    let dirty = false;
    const handler = createUnloadHandler({ reason: () => (dirty ? 'dirty' : null), notify: () => undefined });
    const first = event();
    handler(first);
    dirty = true;
    const second = event();
    handler(second);
    expect([first.prevented, second.prevented]).toEqual([false, true]);
  });

  it('安装幂等：同一目标只注册一次', () => {
    const added: string[] = [];
    const target: UnloadTargetLike = {
      addEventListener: (type) => added.push(type),
      removeEventListener: () => undefined,
    };
    const handler = createUnloadHandler({ reason: () => null, notify: () => undefined });
    expect(installUnloadBlocker(target, handler)).toBe(true);
    expect(installUnloadBlocker(target, handler)).toBe(false);
    expect(added).toEqual(['beforeunload']);
  });
});

describe('unloadBlocker —— 产品判据', () => {
  it('demo clean：放行；编辑后 dirty：阻止（原因 dirty）', () => {
    expect(museUnloadReason()).toBeNull();
    const { session, history, selection: current } = useMuseAppStore.getState();
    const core = { session, history, selection: current };
    const end = session.projection.view.length;
    const selection = sourceSelectionFromView(session, { start: end, end });
    if (selection === null) throw new Error('selection');
    const step = applySourceInput(core, { viewPatch: { start: end, end, text: 'z' }, selection, coalesce: null, label: 'type' });
    if (!step.ok) throw new Error(step.reason);
    expect(applyEditorStep(step.core, core)).toEqual({ ok: true });
    expect(museUnloadReason()).toBe('dirty');
  });
});

describe('unloadBlocker —— 判据纯函数（r3a 审查 L-3，变异 M35 补测）', () => {
  it.each([
    [false, 'idle', null],
    [false, 'composing', 'composing'],
    [false, 'discarded', null],
    [false, 'settled', null],
    [true, 'idle', 'dirty'],
    [true, 'composing', 'dirty'],
  ] as const)('dirty=%s、组字视图 %s → %s', (dirty, ime, expected) => {
    expect(unloadReasonFor(dirty, ime)).toBe(expected);
  });
});
