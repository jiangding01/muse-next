/**
 * M3 T4 B2：三态以提交事实为准（B2 r0.1 勘误 §3；T-CS-5 / 6 / 9 与 B2-M7 / M16 / M17 / M18）。
 *
 * 替换 B1 的 `runSavePipeline`，构造管线结果与「提交原语是否成功返回」不一致的情形——这些情形在正确的 B1 中不会发生，
 * 但 B2 必须保证：已提交的不报未提交，未提交的不报已提交。提交原语经 `trackCommits` 包装，管线替身通过调用
 * `deps.writeFs.renameSync / linkSync` 模拟越过提交点。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SavePipelineDeps, SavePipelineResult, SaveRequest } from '../../../src/main/document/savePipeline';
import type { WriteFileSystem } from '../../../src/main/document/writeFileSystemPort';
import { trackCommits } from '../../../src/main/ipc/saveIpc';
import { IPC } from '../../../src/shared/ipc';
import { ACTIVATE, createHarness, DIALOG, mainFrameEvent, OPEN, rejectingWriteFs } from './openIpcHarness';
import type { Harness } from './openIpcHarness';
import { P, setup } from './saveTestKit';

type Pipeline = (deps: SavePipelineDeps, request: SaveRequest) => Promise<SavePipelineResult>;
const pipeline = vi.hoisted(() => ({ impl: null as Pipeline | null }));

vi.mock('../../../src/main/document/savePipeline', async (original) => {
  const actual = await original<typeof import('../../../src/main/document/savePipeline')>();
  return {
    ...actual,
    runSavePipeline: (deps: SavePipelineDeps, request: SaveRequest) => (pipeline.impl === null ? actual.runSavePipeline(deps, request) : pipeline.impl(deps, request)),
  };
});

const A = P('docs', 'a.jcx');
const WRITTEN = {
  realpath: A,
  identity: { dev: 1n, ino: 9n },
  lastKnownDiskFingerprint: 'e'.repeat(64),
  writeEncoding: 'utf-8',
  byteBom: 'none',
  encodingRoundTrip: 'exact',
} as const;

/** 只允许两个提交原语（空操作）的写 port：其它任何调用都抛错。 */
const commitOnlyWriteFs = (): WriteFileSystem => ({ ...rejectingWriteFs(), renameSync: () => undefined, linkSync: () => undefined });

async function opened(): Promise<{ h: Harness; ticket: { capabilityId: string; documentId: number }; save: () => Promise<unknown> }> {
  const disk = setup('linux');
  disk.writeFile(A, 'X:1\n');
  const h = createHarness({ fs: disk.readFs, writeFs: commitOnlyWriteFs() });
  const ev = mainFrameEvent(h.window(1).sender);
  const pending = h.invoke(OPEN, ev, DIALOG);
  h.resolveDialog(0, A);
  const reply = (await pending) as { document: { documentId: number; file: { capability: { id: string } } } };
  const ticket = { capabilityId: reply.document.file.capability.id, documentId: reply.document.documentId };
  expect(await h.invoke(ACTIVATE, ev, ticket)).toEqual({ ok: true });
  return { h, ticket, save: () => h.invoke(IPC.saveDocument, ev, { ...ticket, source: 'X:2\n', encoding: 'utf-8' }) };
}

beforeEach(() => {
  pipeline.impl = null;
});

describe('trackCommits', () => {
  it('原语成功返回后置位；原语抛出不置位；其余方法原样委托（B2-M16 / M17）', () => {
    const fact = { crossed: false };
    const failing: WriteFileSystem = {
      ...rejectingWriteFs(),
      renameSync: () => {
        throw new Error('EACCES');
      },
    };
    expect(() => trackCommits(failing, fact).renameSync('a', 'b')).toThrow();
    expect(fact.crossed).toBe(false);
    trackCommits(commitOnlyWriteFs(), fact).linkSync('a', 'b');
    expect(fact.crossed).toBe(true);
    const viaRename = { crossed: false };
    trackCommits(commitOnlyWriteFs(), viaRename).renameSync('a', 'b');
    expect(viaRename.crossed).toBe(true);
    expect(() => trackCommits(commitOnlyWriteFs(), { crossed: false }).statSync('x')).toThrow('write fs must not be used');
  });
});

describe('三态以提交事实为准', () => {
  it('T-CS-5：原语已成功、管线却报 not-committed → committed-unconfirmed；不刷新锚点；记日志（B2-M7）', async () => {
    const { h, ticket, save } = await opened();
    pipeline.impl = async (deps) => {
      deps.writeFs.renameSync('/t', A);
      return { outcome: 'not-committed', error: { code: 'write-failed', message: 'x' } };
    };
    const before = h.handle.currentState().table.get(ticket.capabilityId);
    expect(await save()).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
    expect(h.handle.currentState().table.get(ticket.capabilityId)).toBe(before);
    expect(h.saveEvents).toContain('commit-state-mismatch');
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
  });

  it('T-CS-5′：原语已成功、管线随后 reject → committed-unconfirmed（B2-M18）', async () => {
    const { save } = await opened();
    pipeline.impl = async (deps) => {
      deps.writeFs.linkSync('/t', A);
      throw new Error('late failure');
    };
    expect(await save()).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
  });

  it('T-CS-6：原语从未成功、管线却报 saved → not-committed / write-failed；记日志', async () => {
    const { h, save } = await opened();
    pipeline.impl = async () => ({ outcome: 'saved', written: WRITTEN, sameAsAnchor: true });
    expect(await save()).toMatchObject({ outcome: 'not-committed', error: { code: 'write-failed' } });
    expect(h.saveEvents).toContain('commit-state-mismatch');
  });

  it('未越过提交点且管线 reject → not-committed / write-failed', async () => {
    const { save } = await opened();
    pipeline.impl = async () => {
      throw new Error('before commit');
    };
    expect(await save()).toMatchObject({ outcome: 'not-committed', error: { code: 'write-failed' } });
  });

  it('T-CS-9：已越过提交点，回复构造抛出 → 外层兜底仍报 committed-unconfirmed（B2-M18）', async () => {
    const { h, save } = await opened();
    pipeline.impl = async (deps) => {
      deps.writeFs.renameSync('/t', A);
      const written = new Proxy(WRITTEN, {
        get(target, key, receiver) {
          if (key === 'byteBom') throw new Error('reply construction failed');
          return Reflect.get(target, key, receiver) as unknown;
        },
      });
      return { outcome: 'saved', written, sameAsAnchor: true };
    };
    expect(await save()).toMatchObject({ outcome: 'committed-unconfirmed', ticket: null });
    expect(h.saveEvents).toContain('reply-failed');
    expect(h.handle.currentState().owners.get(1)?.saveOperation).toBeNull();
  });

  it('正常：越过提交点且管线报 saved → saved（对照组）', async () => {
    const { save } = await opened();
    pipeline.impl = async (deps) => {
      deps.writeFs.renameSync('/t', A);
      return { outcome: 'saved', written: WRITTEN, sameAsAnchor: true };
    };
    expect(await save()).toMatchObject({ outcome: 'saved', ticket: null });
  });
});
