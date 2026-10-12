/**
 * 右侧源码面板 + 诊断列表（M1.6 T10b；M3 T1c-2 起只读，用户裁决 Q2 / D8）。
 *
 * - 显示当前会话的 editor view（`session.projection.view`：受保护的开头 U+FEFF 不显示，CRLF 显示为一个 LF，孤立 CR 显示为
 *   U+240D）。它只是 exact source 的投影：本组件不处理输入、不读取 `textarea.value`，从不回写 source。源码编辑属 T3。
 * - 诊断列表只呈现解析诊断（解码错误在 Open 提示中，属于另一个错误域）。最小只读呈现，不做跳转与过滤。
 */

import { useMuseAppStore } from '../app/store';

export function SourceInspector() {
  const view = useMuseAppStore((state) => state.session.projection.view);
  const score = useMuseAppStore((state) => state.score);
  const diagnostics = useMuseAppStore((state) => state.diagnostics);

  return (
    <aside className="source-inspector panel">
      <div className="panel-heading">
        <span>JCX Source</span>
        <span className="pill">{diagnostics.length} diagnostics</span>
      </div>

      <textarea className="source-editor" aria-label="JCX 源码（只读）" readOnly spellCheck={false} value={view} />

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
