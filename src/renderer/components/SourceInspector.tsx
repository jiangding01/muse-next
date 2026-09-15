/**
 * 右侧源码面板 + 诊断列表（M1.6 T10b）。
 *
 * 诊断列表是最小只读呈现（severity / 行号 / code / message），不做 UI 打磨、
 * 不做跳转与过滤——M2 渲染层落地后再考虑与谱面联动。
 */

import { useMuseAppStore } from '../app/store';

export function SourceInspector() {
  const source = useMuseAppStore((state) => state.source);
  const setSource = useMuseAppStore((state) => state.setSource);
  const score = useMuseAppStore((state) => state.score);
  const diagnostics = useMuseAppStore((state) => state.diagnostics);

  return (
    <aside className="source-inspector panel">
      <div className="panel-heading">
        <span>JCX Source</span>
        <span className="pill">{diagnostics.length} diagnostics</span>
      </div>

      <textarea
        className="source-editor"
        spellCheck={false}
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />

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
