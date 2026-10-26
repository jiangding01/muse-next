/**
 * M3 T3b：状态栏的纯派生与文案（`src/renderer/app/editor/editorStatus.ts`；方案 §7.1 / §8.2 F3，用户裁决 Q-B2 / R1）。
 *
 * 三态互不合并：dirty 来自 source ≠ saved，stale 来自快照版本 ≠ 当前版本；clean 但 stale（undo 回到保存点、尚未解析）
 * 仍显示待解析。文案穷举全部编辑器提示种类，且 T3 不出现「先保存」。
 */

import { describe, expect, it } from 'vitest';

import { createDocumentSession } from '../../../src/editor/session/create';
import { editorNoticeText, editorStatusLabels, editorStatusView } from '../../../src/renderer/app/editor/editorStatus';
import { applySourceInput, initialEditorCore, sourceSelectionFromView, undoStep } from '../../../src/renderer/app/editor/editorTransitions';
import type { EditorCore, EditorNoticeKind } from '../../../src/renderer/app/editor/editorTransitions';
import { createDemoSession } from '../../../src/renderer/app/editor/sessionFactory';

function typed(core: EditorCore, text: string): EditorCore {
  const end = core.session.projection.view.length;
  const selection = sourceSelectionFromView(core.session, { start: end, end });
  if (selection === null) throw new Error('selection');
  const step = applySourceInput(core, { viewPatch: { start: end, end, text }, selection, coalesce: null, label: 'type' });
  if (!step.ok) throw new Error(step.reason);
  return step.core;
}

describe('editorStatusView —— F3 三态', () => {
  it('clean 且已解析：无状态标签，版本一致', () => {
    const session = createDemoSession();
    const view = editorStatusView(session);
    expect(view).toEqual({ sourceVersion: session.sourceVersion, parsedVersion: session.sourceVersion, sourceDirty: false, parseStale: false, saveInFlight: false });
    expect(editorStatusLabels(view)).toEqual([]);
  });

  it('编辑之后：dirty 且 stale（编辑不换快照）', () => {
    const base = initialEditorCore(createDemoSession());
    const edited = typed(base, 'x').session;
    const view = editorStatusView(edited);
    expect(view.sourceDirty).toBe(true);
    expect(view.parseStale).toBe(true);
    expect(view.sourceVersion).toBe(base.session.sourceVersion + 1);
    expect(view.parsedVersion).toBe(base.session.sourceVersion);
    expect(editorStatusLabels(view)).toEqual(['源码已修改', '待解析：谱面与诊断来自旧版本']);
  });

  it('undo 回到保存点但尚未解析：clean 却仍 stale，仍显示待解析（R1）', () => {
    const edited = typed(initialEditorCore(createDemoSession()), 'x');
    const step = undoStep(edited);
    if (!step.ok) throw new Error(step.reason);
    const view = editorStatusView(step.core.session);
    expect(view.sourceDirty).toBe(false);
    expect(view.parseStale).toBe(true);
    expect(editorStatusLabels(view)).toEqual(['待解析：谱面与诊断来自旧版本']);
  });

  it('尚无快照：parsedVersion 为 null，算 stale', () => {
    const session = createDocumentSession({ documentId: 3, source: 'X:1\n', writeEncoding: 'utf-8', byteBom: 'none', encodingRoundTrip: 'exact', file: null });
    const view = editorStatusView(session);
    expect(view.parsedVersion).toBeNull();
    expect(view.parseStale).toBe(true);
    expect(view.sourceDirty).toBe(false);
  });

  it('保存中只在 fileOp 为 save / saveAs 时为真（T3 中不会出现，派生规则仍保留）', () => {
    const session = createDemoSession();
    const saving = { ...session, fileOp: { kind: 'save' } } as unknown as typeof session;
    expect(editorStatusView(saving).saveInFlight).toBe(true);
    expect(editorStatusLabels(editorStatusView(saving))).toEqual(['正在保存…']);
  });
});

describe('editorNoticeText —— 文案', () => {
  const KINDS: readonly EditorNoticeKind[] = [
    'open-refused-dirty',
    'open-refused-composing',
    'open-candidate-dropped-dirty',
    'open-commit-refused-dirty',
    'command-ignored-composing',
    'command-ignored-replacing',
    'nothing-to-undo',
    'nothing-to-redo',
    'reparse-ignored-composing',
    'reparsed',
    'parse-failed',
    'editor-error',
    'unload-blocked-dirty',
    'unload-blocked-composing',
    'input-unsupported',
    'input-rejected',
    'input-reverted',
    'edit-conflict',
    'edit-out-of-sync',
    'ime-not-applied',
    'source-readonly-platform',
  ];

  it('每种提示都有非空且互不相同的文案；T3 文案不写「先保存」', () => {
    const texts = KINDS.map((kind) => editorNoticeText(kind));
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('先保存');
    }
    expect(new Set(texts).size).toBe(KINDS.length);
  });

  it('无可撤销 / 无可重做与重新解析的文案', () => {
    expect(editorNoticeText('nothing-to-undo')).toBe('没有可撤销的操作。');
    expect(editorNoticeText('nothing-to-redo')).toBe('没有可重做的操作。');
    expect(editorNoticeText('reparsed')).toBe('已重新解析。');
  });

  it('M3 T3c：写回暂停的提示如实说明恢复途径，不承诺自动恢复；平台只读提示说明原因', () => {
    const outOfSync = editorNoticeText('edit-out-of-sync');
    expect(outOfSync).toContain('已暂停编辑');
    expect(outOfSync).toContain('撤销 / 重做或重新打开文件');
    expect(outOfSync).not.toContain('自动恢复');
    expect(editorNoticeText('source-readonly-platform')).toContain('尚未通过实机验收');
  });
});
