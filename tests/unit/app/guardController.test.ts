/**
 * M3 T4 B3b：替换守卫控制器（`src/renderer/app/guard/guardController.ts`）——替身 saveWithin。
 *
 * 询问 → 保存（复用 Open 的租约）/ 不保存 / 取消；SaveResult 驱动批准或重新询问；宿主卸载取消询问；视图订阅；intent 不复用。
 */

import { describe, expect, it } from 'vitest';

import { createFileIntentGate } from '../../../src/renderer/app/fileIntentGate';
import type { FileIntentLease } from '../../../src/renderer/app/fileIntentGate';
import { createGuardController } from '../../../src/renderer/app/guard/guardController';
import type { GuardOutcome } from '../../../src/renderer/app/guard/guardController';
import type { SaveResult } from '../../../src/renderer/app/guard/replacementGuard';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

function rig() {
  const gate = createFileIntentGate();
  const lease = gate.tryAcquire('open', 5);
  if (lease === null) throw new Error('acquire failed');
  const saves: { lease: FileIntentLease; resolve: (result: SaveResult) => void }[] = [];
  let version = 10;
  const views: string[] = [];
  const guard = createGuardController({
    saveWithin: (borrowed) =>
      new Promise<SaveResult>((resolve) => {
        saves.push({ lease: borrowed, resolve });
      }),
    sourceVersion: () => version,
    report: () => undefined,
  });
  guard.subscribe(() => views.push(guard.view().phase));
  const outcomes: GuardOutcome[] = [];
  return { gate, lease, guard, saves, views, outcomes, setVersion: (v: number) => (version = v) };
}

describe('guardController', () => {
  it('没有宿主（根已卸载）→ 立即中止（host-gone），不显示询问', async () => {
    const r = rig();
    const asked = r.guard.ask(r.lease);
    expect(await asked.outcome).toEqual({ aborted: 'host-gone' });
    expect(r.guard.view().phase).toBe('idle');
  });

  it('保存分支复用 Open 的租约；ok && clean → 批准 proceed（绑定 intentId 与原文档）', async () => {
    const r = rig();
    r.guard.attachHost();
    const asked = r.guard.ask(r.lease);
    expect(r.guard.view()).toEqual({ phase: 'asking', intentId: asked.intentId });
    r.guard.choose('save');
    expect(r.saves[0]?.lease).toBe(r.lease);
    expect(r.guard.view().phase).toBe('saving');
    r.saves[0]?.resolve({ ok: true, clean: true });
    expect(await asked.outcome).toEqual({ approval: { decision: 'proceed', intentId: asked.intentId, documentId: 5, sourceVersion: null } });
    expect(r.views).toEqual(['asking', 'saving', 'idle']);
  });

  it('保存后仍 dirty → 重新询问；之后不保存 → 批准 discard（版本取选择时的值）', async () => {
    const r = rig();
    r.guard.attachHost();
    const asked = r.guard.ask(r.lease);
    r.guard.choose('save');
    r.saves[0]?.resolve({ ok: true, clean: false });
    await flush();
    expect(r.guard.view().phase).toBe('asking');
    r.setVersion(12);
    r.guard.choose('discard');
    expect(await asked.outcome).toEqual({ approval: { decision: 'discard', intentId: asked.intentId, documentId: 5, sourceVersion: 12 } });
  });

  it('保存失败 → 中止；取消 → 中止；intentId 单调不复用', async () => {
    const r = rig();
    r.guard.attachHost();
    const first = r.guard.ask(r.lease);
    r.guard.choose('save');
    r.saves[0]?.resolve({ ok: false, clean: false });
    expect(await first.outcome).toEqual({ aborted: 'save-failed' });
    const second = r.guard.ask(r.lease);
    expect(second.intentId).toBeGreaterThan(first.intentId);
    r.guard.choose('cancel');
    expect(await second.outcome).toEqual({ aborted: 'canceled' });
  });

  it('宿主卸载：询问中立即取消；保存中等结果到达后中止（不批准）；进行中再询问被拒（busy）', async () => {
    const r = rig();
    const detach = r.guard.attachHost();
    const asked = r.guard.ask(r.lease);
    expect(await r.guard.ask(r.lease).outcome).toEqual({ aborted: 'busy' });
    detach();
    detach();
    expect(await asked.outcome).toEqual({ aborted: 'host-gone' });
    expect(r.guard.hasHost()).toBe(false);

    const s = rig();
    const off = s.guard.attachHost();
    const saving = s.guard.ask(s.lease);
    s.guard.choose('save');
    off();
    s.saves[0]?.resolve({ ok: true, clean: true });
    expect(await saving.outcome).toEqual({ aborted: 'host-gone' });
  });

  it('saveWithin 抛错或拒绝 → 按保存失败中止', async () => {
    const guard = createGuardController({
      saveWithin: () => Promise.reject(new Error('save broke')),
      sourceVersion: () => 1,
      report: () => undefined,
    });
    const gate = createFileIntentGate();
    const lease = gate.tryAcquire('open', 1);
    if (lease === null) throw new Error('acquire failed');
    guard.attachHost();
    const asked = guard.ask(lease);
    guard.choose('save');
    expect(await asked.outcome).toEqual({ aborted: 'save-failed' });
  });
});
