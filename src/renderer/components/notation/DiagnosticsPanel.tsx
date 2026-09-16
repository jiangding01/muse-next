/**
 * 渲染诊断列表（从 `ScoreView.tsx` 拆出，避免单文件超 350 行）。
 *
 * 纯展示组件：点击一条诊断只是把 `anchorKey(diagnostic.anchor)` 回调给父组件，
 * 高亮判断（谁被选中）与 DOM 联动（谱面节点怎么变亮）都不在这里——组件只做
 * 「诊断列表长什么样」这一件事。
 */

import { anchorKey, type RenderDiagnostic } from '../../../notation/model/types';

interface DiagnosticsPanelProps {
  readonly diagnostics: readonly RenderDiagnostic[];
  readonly selectedAnchorKey: string | undefined;
  readonly onSelect: (key: string) => void;
}

export function DiagnosticsPanel({ diagnostics, selectedAnchorKey, onSelect }: DiagnosticsPanelProps) {
  return (
    <aside className="render-diagnostics panel">
      <div className="panel-heading">
        <span>Render diagnostics</span>
        <span className="pill">{diagnostics.length}</span>
      </div>
      <ul className="render-diagnostic-list">
        {diagnostics.map((diagnostic) => {
          const key = anchorKey(diagnostic.anchor);
          const selected = key === selectedAnchorKey;
          return (
            <li
              key={diagnostic.id}
              className={`render-diagnostic render-diagnostic-${diagnostic.level}${selected ? ' selected' : ''}`}
              onClick={() => { onSelect(key); }}
            >
              <code>{diagnostic.code}</code>
              <span>{diagnostic.message}</span>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
