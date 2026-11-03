/**
 * M3 T4 B3a-2（裁决 Q4）：Save As 切换后的同版本静默强制解析（`parseController.refreshSnapshot`）。
 *
 * 当前版本已解析时同样重新解析（强制），并以会话当前的 `writeEncoding` 作为 `sourceEncoding`；发布同版本的新快照，
 * 不发「已重新解析」提示；组字中不解析（`ignored-composing`，留待下一次解析）。显式 Reparse 的提示行为不变。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentSession } from '../../../src/editor/session/types';
import { loadJcx } from '../../../src/formats/jcxParse';
import type { JcxEncoding } from '../../../src/formats/jcxParse';
import { createParseController } from '../../../src/renderer/app/editor/parseController';
import type { EditorNotice } from '../../../src/renderer/app/editor/editorTransitions';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';

function rig(session: DocumentSession) {
  let current = session;
  const loads: JcxEncoding[] = [];
  const notices: EditorNotice['kind'][] = [];
  const controller = createParseController({
    schedule: () => () => undefined,
    read: () => current,
    load: (source, encoding) => {
      loads.push(encoding);
      return loadJcx(source, { sourceEncoding: encoding });
    },
    publish: (next) => {
      current = next;
      return { ok: true };
    },
    notify: (notice) => notices.push(notice.kind),
    report: () => undefined,
  });
  return { controller, loads, notices, current: () => current, setEncoding: (encoding: JcxEncoding) => (current = { ...current, writeEncoding: encoding }) };
}

describe('parseController.refreshSnapshot（Q4）', () => {
  it('当前版本已解析时同样强制解析，按新的 writeEncoding 标注；发布同版本新快照；不发 reparsed 提示', () => {
    const r = rig(createDemoSession());
    const before = r.current().parsed;
    expect(before?.sourceVersion).toBe(r.current().sourceVersion);
    r.setEncoding('gb18030');
    expect(r.controller.refreshSnapshot()).toBe('parsed');
    expect(r.loads).toEqual(['gb18030']);
    expect(r.current().parsed).not.toBe(before);
    expect(r.current().parsed?.sourceVersion).toBe(r.current().sourceVersion);
    expect(r.current().parsed?.load.lex.encoding).toBe('gb18030');
    expect(r.notices).toEqual([]);
    // 显式 Reparse 的提示不变。
    r.controller.flush('reparse');
    expect(r.notices).toEqual(['reparsed']);
  });

  it('组字中不解析（留待下一次解析）', () => {
    const r = rig(createDemoSession());
    r.controller.compositionStart();
    expect(r.controller.refreshSnapshot()).toBe('ignored-composing');
    expect(r.loads).toEqual([]);
    expect(r.notices).toEqual([]);
  });
});
