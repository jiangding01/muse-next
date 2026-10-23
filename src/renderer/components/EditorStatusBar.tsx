/**
 * 编辑器状态栏（M3 T3b；方案 §8.2 / §22「状态栏三态」，T3 Preflight r3 §10 T3b）。
 *
 * 最小呈现：F3 的三个派生状态（源码已修改 / 待解析 / 保存中，见 `editorStatus.ts`）、源码与解析版本、编辑器轻提示，
 * 以及「重新解析」按钮（显式 Reparse，派发来源 `status-bar`，用户裁决 Q-B1）。状态以数据属性呈现在根元素上
 * （`data-source-version` / `data-parsed-version` / `data-source-dirty` / `data-parse-stale` / `data-editor-notice`），
 * 都是产品状态本身，没有派发来源或计数之类的测试钩子。组件不注册 effect，不读写会话以外的状态。
 */

import { editorNoticeText, editorStatusLabels, editorStatusView } from '../app/editor/editorStatus';
import { museEditorController } from '../app/editor/editorController';
import { publishEditorView, useMuseAppStore } from '../app/store';

export function EditorStatusBar() {
  const session = useMuseAppStore((state) => state.session);
  const notice = useMuseAppStore((state) => state.editor.notice);
  const view = editorStatusView(session);
  const labels = editorStatusLabels(view);

  return (
    <footer
      className="editor-status"
      data-source-version={view.sourceVersion}
      data-parsed-version={view.parsedVersion ?? ''}
      data-source-dirty={view.sourceDirty}
      data-parse-stale={view.parseStale}
      data-editor-notice={notice?.kind ?? ''}
    >
      <div className="editor-status-states">
        {labels.length === 0 ? (
          <span className="editor-status-state editor-status-clean">已解析</span>
        ) : (
          labels.map((label) => (
            <span key={label} className="editor-status-state editor-status-attention">
              {label}
            </span>
          ))
        )}
        <span className="editor-status-version">
          源码 v{view.sourceVersion} · 解析 v{view.parsedVersion ?? '—'}
        </span>
      </div>
      <div className="editor-status-notice" role="status">
        {notice === null ? null : (
          <>
            <span>{editorNoticeText(notice.kind)}</span>
            <button type="button" className="secondary" onClick={() => { publishEditorView({ notice: null }); }}>
              知道了
            </button>
          </>
        )}
      </div>
      <button type="button" className="secondary editor-status-reparse" onClick={() => { museEditorController.reparse('status-bar'); }}>
        重新解析
      </button>
    </footer>
  );
}
