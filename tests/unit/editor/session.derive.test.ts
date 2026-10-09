import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcxParse';
import { createDocumentSession } from '../../../src/editor/session/create';
import { isParseStale, isSaveInFlight, isSourceDirty } from '../../../src/editor/session/derive';
import { acceptParsedSnapshot, applySourceTransaction } from '../../../src/editor/session/reducer';
import type { DocumentSession } from '../../../src/editor/session/types';
import type { TextPatch } from '../../../src/editor/text/types';

const T0 = 'X:1\nK:C\nC D E F\n';
const T1 = 'X:1\nK:C\nC G E F\n';

function open(source: string, documentId = 1): DocumentSession {
  return createDocumentSession({
    documentId,
    source,
    writeEncoding: 'utf-8',
    byteBom: 'none',
    encodingRoundTrip: 'exact',
    file: null,
  });
}

function edit(session: DocumentSession, patches: readonly TextPatch[]): { session: DocumentSession; inverse: readonly TextPatch[] } {
  const result = applySourceTransaction(session, { baseVersion: session.sourceVersion, patches });
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return { session: result.session, inverse: result.inverse };
}

function parse(session: DocumentSession): DocumentSession {
  const result = acceptParsedSnapshot(session, {
    documentId: session.documentId,
    sourceVersion: session.sourceVersion,
    load: loadJcx(session.source),
  });
  if (!result.ok) throw new Error(`意外拒绝：${result.reason}`);
  return result.session;
}

const save = (session: DocumentSession): DocumentSession => ({ ...session, saved: { source: session.source } });

describe('M3 T0 —— DocumentSession 派生状态（§7.1、§7.3）', () => {
  it('创建：version 1、saved 即初始 source、clean、尚无快照即过期、无文件操作', () => {
    const session = open(T0);
    expect(session.sourceVersion).toBe(1);
    expect(isSourceDirty(session)).toBe(false);
    expect(isParseStale(session)).toBe(true);
    expect(isSaveInFlight(session)).toBe(false);
    expect(session.protectedLeadingFeff).toBe(false);
  });

  it('§7.3 状态序列逐行复现：版本单调递增，dirty 只由文本比较派生，回到保存点即 clean 而版本不回退', () => {
    const rows: [string, string, number, boolean, boolean][] = [];
    const record = (label: string, s: DocumentSession): void => {
      rows.push([label, s.source, s.sourceVersion, isSourceDirty(s), isParseStale(s)]);
    };
    let s = parse(open(T0));
    record('Open T0', s);
    const typed = edit(s, [{ start: 10, end: 11, text: 'G' }]);
    s = typed.session;
    record('输入 → T1', s);
    s = parse(s);
    record('debounce 解析', s);
    const undo1 = edit(s, typed.inverse);
    s = parse(undo1.session);
    record('Undo → T0', s);
    s = parse(edit(s, undo1.inverse).session);
    record('Redo → T1', s);
    s = save(s);
    record('Save 成功', s);
    const undo2 = edit(s, [{ start: 10, end: 11, text: 'D' }]);
    s = parse(undo2.session);
    record('Undo → T0', s);
    record('Save 失败（saved 不变）', s);
    s = save(s);
    record('Save 成功', s);
    expect(rows).toEqual([
      ['Open T0', T0, 1, false, false],
      ['输入 → T1', T1, 2, true, true],
      ['debounce 解析', T1, 2, true, false],
      ['Undo → T0', T0, 3, false, false],
      ['Redo → T1', T1, 4, true, false],
      ['Save 成功', T1, 4, false, false],
      ['Undo → T0', T0, 5, true, false],
      ['Save 失败（saved 不变）', T0, 5, true, false],
      ['Save 成功', T0, 5, false, false],
    ]);
  });

  it('saveInFlight 只在 save / saveAs 进行中为真；open / export 不算', () => {
    const session = open(T0);
    expect(isSaveInFlight({ ...session, fileOp: { kind: 'save' } })).toBe(true);
    expect(isSaveInFlight({ ...session, fileOp: { kind: 'saveAs' } })).toBe(true);
    expect(isSaveInFlight({ ...session, fileOp: { kind: 'open' } })).toBe(false);
    expect(isSaveInFlight({ ...session, fileOp: { kind: 'export' } })).toBe(false);
  });

  it('会话对象不存储 dirty / stale / inFlight 布尔值', () => {
    const keys = Object.keys(open(T0)).sort();
    expect(keys).toEqual(
      ['byteBom', 'documentId', 'encodingRoundTrip', 'file', 'fileOp', 'parsed', 'projection', 'protectedLeadingFeff', 'saved', 'source', 'sourceVersion', 'writeEncoding'].sort(),
    );
  });

  it('byteBom 是 main 给出的事实，不由文本推断；protectedLeadingFeff 由 exact source 计算', () => {
    const gbWithFeff = createDocumentSession({
      documentId: 7,
      source: '\uFEFFX:1\n',
      writeEncoding: 'gb18030',
      byteBom: 'none',
      encodingRoundTrip: 'exact',
      file: null,
    });
    expect(gbWithFeff.byteBom).toBe('none');
    expect(gbWithFeff.protectedLeadingFeff).toBe(true);
    expect(gbWithFeff.projection.protectedPrefixLength).toBe(1);
    expect(gbWithFeff.writeEncoding).toBe('gb18030');
  });
});
