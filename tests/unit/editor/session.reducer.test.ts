import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import { createDocumentSession } from '../../../src/editor/session/create';
import { acceptParsedSnapshot, applySourceTransaction } from '../../../src/editor/session/reducer';
import type { DocumentSession } from '../../../src/editor/session/types';

function open(source: string, documentId = 1): DocumentSession {
  return createDocumentSession({ documentId, source, writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
}

describe('M3 T0 —— session reducer（§6.7、§7、§8.2、§9.2）', () => {
  it('baseVersion 与当前版本不符的事务被拒绝，会话不变', () => {
    const session = open('abc');
    expect(applySourceTransaction(session, { baseVersion: 2, patches: [{ start: 0, end: 1, text: 'x' }] })).toEqual({
      ok: false,
      reason: 'base-version-mismatch',
    });
    expect(applySourceTransaction(session, { baseVersion: 0, patches: [{ start: 0, end: 1, text: 'x' }] })).toMatchObject({
      ok: false,
      reason: 'base-version-mismatch',
    });
  });

  it('不含补丁的空事务被拒绝（只含无操作补丁的事务是否过滤由 T2 决定，T0 不处理）', () => {
    expect(applySourceTransaction(open('abc'), { baseVersion: 1, patches: [] })).toEqual({
      ok: false,
      reason: 'empty-transaction',
      patchIndex: 0,
    });
  });

  it('应用成功：版本 +1、投影按冻结 frame 重建、旧快照保留但已过期、saved 不变', () => {
    const opened = open('a\r\nb\r\n');
    const parsed = acceptParsedSnapshot(opened, { documentId: 1, sourceVersion: 1, load: loadJcx(opened.source) });
    if (!parsed.ok) throw new Error(parsed.reason);
    const result = applySourceTransaction(parsed.session, { baseVersion: 1, patches: [{ start: 0, end: 0, text: 'x\n' }] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.sourceVersion).toBe(2);
    expect(result.session.source).toBe('x\na\r\nb\r\n');
    expect(result.session.projection.frame).toEqual(opened.projection.frame);
    expect(result.session.projection.view).toBe('x\na\nb\n');
    expect(result.session.parsed?.sourceVersion).toBe(1);
    expect(result.session.saved).toEqual({ source: 'a\r\nb\r\n' });
    expect(result.inverse).toEqual([{ start: 0, end: 2, text: '' }]);
  });

  it('直接 source 补丁（可视化命令）同样经过源码不变量；任一补丁违规整组拒绝并报告下标', () => {
    const feff = open('\uFEFFab');
    expect(applySourceTransaction(feff, { baseVersion: 1, patches: [{ start: 0, end: 1, text: '' }] })).toEqual({
      ok: false,
      reason: 'touches-protected-prefix',
      patchIndex: 0,
    });
    expect(applySourceTransaction(open('a\uFEFFb'), { baseVersion: 1, patches: [{ start: 0, end: 1, text: '' }] })).toMatchObject({
      reason: 'creates-leading-feff',
    });
    expect(applySourceTransaction(open('a\r\nb'), { baseVersion: 1, patches: [{ start: 2, end: 2, text: 'x' }] })).toMatchObject({
      reason: 'splits-crlf',
    });
    expect(applySourceTransaction(open('a\r\nb'), { baseVersion: 1, patches: [{ start: 1, end: 2, text: '' }] })).toMatchObject({
      reason: 'splits-crlf',
    });
    expect(applySourceTransaction(open('a\rXb\nc'), { baseVersion: 1, patches: [{ start: 2, end: 4, text: '' }] })).toMatchObject({
      reason: 'merges-cr-lf',
    });
    expect(applySourceTransaction(open('ab\nc'), { baseVersion: 1, patches: [{ start: 2, end: 2, text: 'x\r' }] })).toMatchObject({
      reason: 'merges-cr-lf',
    });
    expect(
      applySourceTransaction(open('abc'), {
        baseVersion: 1,
        patches: [
          { start: 0, end: 1, text: 'X' },
          { start: 5, end: 6, text: '' },
        ],
      }),
    ).toEqual({ ok: false, reason: 'patch-out-of-range', patchIndex: 1 });
  });

  it('多补丁事务逐个按应用后的中间文本校验不变量', () => {
    // 第一个补丁在末尾追加孤立 CR，第二个补丁在其后插入 LF：第二步会合并成 CRLF，必须被拒。
    expect(
      applySourceTransaction(open('ab'), {
        baseVersion: 1,
        patches: [
          { start: 2, end: 2, text: '\r' },
          { start: 3, end: 3, text: '\n' },
        ],
      }),
    ).toEqual({ ok: false, reason: 'merges-cr-lf', patchIndex: 1 });
  });

  it('多补丁事务：后续补丁删除首部使 U+FEFF 前移同样被拒（按中间文本校验）', () => {
    expect(
      applySourceTransaction(open('a\uFEFFb'), {
        baseVersion: 1,
        patches: [
          { start: 2, end: 2, text: 'y' },
          { start: 0, end: 1, text: '' },
        ],
      }),
    ).toEqual({ ok: false, reason: 'creates-leading-feff', patchIndex: 1 });
  });

  it('多补丁事务的逆补丁按逆序排列：经 reducer 应用后精确还原（undo 往返）', () => {
    const opened = open('ab\r\ncd');
    const forward = applySourceTransaction(opened, {
      baseVersion: 1,
      patches: [
        { start: 0, end: 1, text: 'XYZ' },
        { start: 6, end: 8, text: '' },
      ],
    });
    expect(forward).toMatchObject({ ok: true, session: { source: 'XYZb\r\n', sourceVersion: 2 } });
    if (!forward.ok) return;
    const back = applySourceTransaction(forward.session, { baseVersion: 2, patches: forward.inverse });
    expect(back).toMatchObject({ ok: true, session: { source: 'ab\r\ncd', sourceVersion: 3 } });
  });

  it('解析结果只在 (documentId, sourceVersion) 都一致时被接受', () => {
    const session = open('X:1\n', 3);
    const load = loadJcx(session.source);
    expect(acceptParsedSnapshot(session, { documentId: 4, sourceVersion: 1, load })).toEqual({ ok: false, reason: 'document-mismatch' });
    expect(acceptParsedSnapshot(session, { documentId: 3, sourceVersion: 2, load })).toEqual({ ok: false, reason: 'version-mismatch' });
    const edited = applySourceTransaction(session, { baseVersion: 1, patches: [{ start: 0, end: 0, text: '%' }] });
    if (!edited.ok) throw new Error(edited.reason);
    expect(acceptParsedSnapshot(edited.session, { documentId: 3, sourceVersion: 1, load })).toEqual({
      ok: false,
      reason: 'version-mismatch',
    });
    expect(acceptParsedSnapshot(session, { documentId: 3, sourceVersion: 1, load })).toMatchObject({ ok: true });
  });
});
