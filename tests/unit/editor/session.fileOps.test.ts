/**
 * M3 T4 B1：文件操作与保存检查点纯函数（`src/editor/session/fileOps.ts`，方案 §7.2、§7.3、§12.2、§20）。
 *
 * 覆盖 Gate B1 增补合同 A（C1：对象引用 CAS 的 ABA 反例）与检查点不变量（H2、M1、M18）。
 */

import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import { createDocumentSession } from '../../../src/editor/session/create';
import { isParseStale, isSaveInFlight, isSourceDirty } from '../../../src/editor/session/derive';
import {
  acceptSaveAsSuccess,
  acceptSaveSuccess,
  beginFileOperation,
  finishFileOperation,
} from '../../../src/editor/session/fileOps';
import type { SavedAsFacts } from '../../../src/editor/session/fileOps';
import { acceptParsedSnapshot, applySourceTransaction } from '../../../src/editor/session/reducer';
import type { DocumentSession, FileOperation, FileOperationKind } from '../../../src/editor/session/types';
import { createPrng } from './prng';

const T0 = 'X:1\nK:C\nC D E F\n';
const T1 = 'X:1\nK:C\nC G E F\n';

function open(source: string, documentId = 7): DocumentSession {
  return createDocumentSession({ documentId, source, writeEncoding: 'gb18030', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

function replaceAll(session: DocumentSession, text: string): DocumentSession {
  const result = applySourceTransaction(session, {
    baseVersion: session.sourceVersion,
    patches: [{ start: 0, end: session.source.length, text }],
  });
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return result.session;
}

function parse(session: DocumentSession): DocumentSession {
  const result = acceptParsedSnapshot(session, {
    documentId: session.documentId,
    sourceVersion: session.sourceVersion,
    load: loadJcx(session.source, { sourceEncoding: session.writeEncoding }),
  });
  if (!result.ok) throw new Error('意外拒绝解析快照');
  return result.session;
}

function begin(session: DocumentSession, kind: FileOperationKind): { session: DocumentSession; op: FileOperation } {
  const result = beginFileOperation(session, kind);
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return { session: result.session, op: result.op };
}

function settled(result: ReturnType<typeof acceptSaveSuccess>): DocumentSession {
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return result.session;
}

const SAVE_AS_FACTS: SavedAsFacts = {
  file: { capability: { id: 'cap-new' }, displayName: 'new.jcx', displayPath: '~/new.jcx' },
  writeEncoding: 'utf-8',
  byteBom: 'utf8',
  encodingRoundTrip: 'exact',
};

/** 除 saved / fileOp（及 Save As 的文件四项）之外，会话其余字段必须逐一引用相等。 */
function expectOnlyCheckpointChanged(before: DocumentSession, after: DocumentSession): void {
  expect(after.source).toBe(before.source);
  expect(after.sourceVersion).toBe(before.sourceVersion);
  expect(after.projection).toBe(before.projection);
  expect(after.parsed).toBe(before.parsed);
  expect(after.documentId).toBe(before.documentId);
  expect(after.protectedLeadingFeff).toBe(before.protectedLeadingFeff);
}

describe('beginFileOperation', () => {
  it('空闲时开始：fileOp 是新建对象，saveInFlight 只对 save / saveAs 为真', () => {
    const { session, op } = begin(open(T0), 'save');
    expect(session.fileOp).toBe(op);
    expect(isSaveInFlight(session)).toBe(true);
    expect(isSaveInFlight(begin(open(T0), 'open').session)).toBe(false);
  });

  it('已有进行中的操作 → file-op-busy，会话不变', () => {
    const { session } = begin(open(T0), 'save');
    expect(beginFileOperation(session, 'saveAs')).toEqual({ ok: false, reason: 'file-op-busy' });
  });

  it('ABA-3：两次开始（中间结束）得到的 fileOp 对象互不相同', () => {
    const first = begin(open(T0), 'save');
    const idle = settled(finishFileOperation(first.session, 7, first.op));
    const second = begin(idle, 'save');
    expect(second.op).not.toBe(first.op);
    expect(second.op).toEqual(first.op);
  });
});

describe('acceptSaveSuccess —— 检查点不变量', () => {
  it('检查点前移到捕获值；source / version / parsed / 投影不变；dirty 按文本比较派生', () => {
    const dirty = parse(replaceAll(open(T0), T1));
    const { session, op } = begin(dirty, 'save');
    const after = settled(acceptSaveSuccess(session, 7, op, T1));
    expect(after.saved.source).toBe(T1);
    expect(after.fileOp).toBeNull();
    expect(isSourceDirty(after)).toBe(false);
    expect(after.writeEncoding).toBe('gb18030');
    expect(after.file).toBe(session.file);
    expect(after.byteBom).toBe(session.byteBom);
    expect(after.encodingRoundTrip).toBe(session.encodingRoundTrip);
    expectOnlyCheckpointChanged(session, after);
  });

  it('M18：保存期间继续输入——检查点记录捕获值，完成后仍 dirty', () => {
    const { session, op } = begin(replaceAll(open(T0), T1), 'save');
    const typed = replaceAll(session, `${T1}G\n`);
    const after = settled(acceptSaveSuccess(typed, 7, op, T1));
    expect(after.saved.source).toBe(T1);
    expect(isSourceDirty(after)).toBe(true);
    expect(after.sourceVersion).toBe(typed.sourceVersion);
  });

  it('M1 / M2：失败只清 fileOp，检查点不前移', () => {
    const { session, op } = begin(replaceAll(open(T0), T1), 'save');
    const after = settled(finishFileOperation(session, 7, op));
    expect(after.saved.source).toBe(T0);
    expect(after.fileOp).toBeNull();
    expect(isSourceDirty(after)).toBe(true);
    expectOnlyCheckpointChanged(session, after);
  });
});

describe('ABA 反例（Gate B1 增补合同 A）', () => {
  it('ABA-1：A 结束 → B 开始 → A 的迟到成功结果被拒，检查点不变，fileOp 仍是 B', () => {
    const a = begin(replaceAll(open(T0), T1), 'save');
    const idle = settled(finishFileOperation(a.session, 7, a.op));
    const b = begin(idle, 'save');
    expect(acceptSaveSuccess(b.session, 7, a.op, T1)).toEqual({ ok: false, reason: 'not-current-operation' });
  });

  it('ABA-2：结构相等的新对象冒充当前操作被拒（比较引用而非结构）', () => {
    const { session } = begin(replaceAll(open(T0), T1), 'save');
    expect(acceptSaveSuccess(session, 7, { kind: 'save' }, T1)).toEqual({ ok: false, reason: 'not-current-operation' });
    expect(finishFileOperation(session, 7, { kind: 'save' })).toEqual({ ok: false, reason: 'not-current-operation' });
  });

  it('ABA-4：documentId 不符（会话已替换）先于引用检查被拒', () => {
    const { session, op } = begin(replaceAll(open(T0), T1), 'save');
    const replaced: DocumentSession = { ...session, documentId: 8 };
    expect(acceptSaveSuccess(replaced, 7, op, T1)).toEqual({ ok: false, reason: 'document-mismatch' });
  });

  it('ABA-5：操作种类不符——Save 的结果不能套在 Save As 上，反之亦然', () => {
    const saveAs = begin(replaceAll(open(T0), T1), 'saveAs');
    expect(acceptSaveSuccess(saveAs.session, 7, saveAs.op, T1)).toEqual({ ok: false, reason: 'kind-mismatch' });
    const save = begin(replaceAll(open(T0), T1), 'save');
    expect(acceptSaveAsSuccess(save.session, 7, save.op, T1, SAVE_AS_FACTS)).toEqual({ ok: false, reason: 'kind-mismatch' });
  });

  it('ABA-6：用旧操作 A 结束当前操作 B 不生效', () => {
    const a = begin(open(T0), 'save');
    const idle = settled(finishFileOperation(a.session, 7, a.op));
    const b = begin(idle, 'saveAs');
    expect(finishFileOperation(b.session, 7, a.op)).toEqual({ ok: false, reason: 'not-current-operation' });
  });
});

describe('acceptSaveAsSuccess', () => {
  it('file / writeEncoding / byteBom / encodingRoundTrip 与检查点同时更新；其余不变', () => {
    const unsafe: DocumentSession = { ...replaceAll(open(T0), T1), encodingRoundTrip: 'unsafe' };
    const { session, op } = begin(unsafe, 'saveAs');
    const after = settled(acceptSaveAsSuccess(session, 7, op, T1, SAVE_AS_FACTS));
    expect(after).toMatchObject({ saved: { source: T1 }, ...SAVE_AS_FACTS, fileOp: null });
    expectOnlyCheckpointChanged(session, after);
  });
});

describe('方案 §7.3 状态序列', () => {
  it('Open → 输入 → 解析 → Undo → Redo → Save → Undo → Save 失败 → Save 成功', () => {
    let s = parse(open(T0));
    expect([s.sourceVersion, isSourceDirty(s)]).toEqual([1, false]);
    s = replaceAll(s, T1);
    expect([s.sourceVersion, isSourceDirty(s), isParseStale(s)]).toEqual([2, true, true]);
    s = parse(s);
    s = parse(replaceAll(s, T0)); // undo
    expect([s.sourceVersion, isSourceDirty(s)]).toEqual([3, false]);
    s = parse(replaceAll(s, T1)); // redo
    expect([s.sourceVersion, isSourceDirty(s)]).toEqual([4, true]);
    let op = begin(s, 'save');
    s = settled(acceptSaveSuccess(op.session, 7, op.op, T1));
    expect([s.sourceVersion, isSourceDirty(s), s.saved.source]).toEqual([4, false, T1]);
    s = parse(replaceAll(s, T0)); // undo
    expect([s.sourceVersion, isSourceDirty(s)]).toEqual([5, true]);
    op = begin(s, 'save');
    s = settled(finishFileOperation(op.session, 7, op.op)); // 失败
    expect([s.sourceVersion, isSourceDirty(s), s.saved.source]).toEqual([5, true, T1]);
    op = begin(s, 'save');
    s = settled(acceptSaveSuccess(op.session, 7, op.op, T0));
    expect([s.sourceVersion, isSourceDirty(s), s.saved.source]).toEqual([5, false, T0]);
  });
});

describe('性质测试：任意交错下检查点只取「成功接受的捕获值」', () => {
  it('随机的开始 / 输入 / 成功 / 失败 / 迟到结果序列', () => {
    const texts = [T0, T1, `${T1}A\n`, `${T0}B\n`];
    for (let seed = 1; seed <= 150; seed += 1) {
      const prng = createPrng(seed);
      let s = open(T0);
      let current: { op: FileOperation; captured: string } | null = null;
      const stale: FileOperation[] = [];
      let expectedSaved = T0;
      for (let step = 0; step < 30; step += 1) {
        const message = `seed ${String(seed)}, step ${String(step)}`;
        const action = prng.int(5);
        if (action === 0 && current === null) {
          const started = begin(s, 'save');
          s = started.session;
          current = { op: started.op, captured: s.source };
        } else if (action === 1) {
          const next = prng.pick(texts);
          if (next !== s.source) s = replaceAll(s, next);
        } else if (action === 2 && current !== null) {
          s = settled(acceptSaveSuccess(s, 7, current.op, current.captured));
          expectedSaved = current.captured;
          stale.push(current.op);
          current = null;
        } else if (action === 3 && current !== null) {
          s = settled(finishFileOperation(s, 7, current.op));
          stale.push(current.op);
          current = null;
        } else if (action === 4 && stale.length > 0) {
          const late = prng.pick(stale);
          expect(acceptSaveSuccess(s, 7, late, 'LATE').ok, message).toBe(false);
        }
        expect(s.saved.source, message).toBe(expectedSaved);
        expect(isSourceDirty(s), message).toBe(s.source !== expectedSaved);
        expect(s.fileOp, message).toBe(current?.op ?? null);
      }
    }
  });
});
