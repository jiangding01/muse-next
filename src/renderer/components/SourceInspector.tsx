/**
 * 右侧源码面板 + 诊断列表（M1.6 T10b；M3 T1c-2 起只读；M3 T3c 起在已开放平台可编辑）。
 *
 * - textarea **非受控**：本组件不传 `value`、不订阅 view、不处理任何输入事件，也不读取 `textarea.value`；元素只经适配层的
 *   `bindSourceEditor` ref 回调交出，DOM 内容与选区由适配层按会话 view 写回（方案 §9.1，T3c Preflight r1 §4）。
 * - 平台门控（用户裁决 Q9-A）：`readOnly` 只来自 `sourceEditingEnabled()`；未开放平台显示只读原因。适配层另有拒绝分支（双重门控）。
 * - 诊断列表只呈现解析诊断（解码错误在 Open 提示中，属于另一个错误域）。最小只读呈现，不做跳转与过滤。
 */

import { editorNoticeText } from '../app/editor/editorStatus';
import { bindSourceEditor, sourceEditingEnabled } from '../app/editor/sourceEditorBinding';
import { useMuseAppStore } from '../app/store';

export function SourceInspector() {
  const score = useMuseAppStore((state) => state.score);
  const diagnostics = useMuseAppStore((state) => state.diagnostics);
  const editable = sourceEditingEnabled();

  return (
    <aside className="source-inspector panel">
      <div className="panel-heading">
        <span>JCX Source</span>
        <span className="pill">{diagnostics.length} diagnostics</span>
      </div>

      <textarea
        ref={bindSourceEditor}
        className="source-editor"
        aria-label={editable ? 'JCX 源码' : 'JCX 源码（只读）'}
        readOnly={!editable}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {editable ? null : <p className="source-readonly-note">{editorNoticeText('source-readonly-platform')}</p>}

      <div className="parse-summary">
        <span>Headers</span><strong>{score.titles.length + score.credits.length}</strong>
        <span>Chords</span><strong>{score.chordShapes.length}</strong>
        <span>Voices</span><strong>{score.voices.length}</strong>
      </div>

      <ul className="diagnostic-list">
        {diagnostics.map((diagnostic, index) => (
          <li key={index} className={`diagnostic diagnostic-${diagnostic.severity}`}>
            <code>
              L{diagnostic.span.start.line} {diagnostic.code}
            </code>
            <span>{diagnostic.message}</span>
          </li>
        ))}
      </ul>
    </aside>
  );
}
