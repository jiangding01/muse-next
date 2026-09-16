/**
 * 谱面头部的 HTML 渲染（从 `ScoreView.tsx` 拆出，避免单文件超 350 行）。
 *
 * 只消费 `ScoreHeaderLayout` 的 `.text` 字符串：`width`/`fontSize` 是 abstract unit，
 * 只为 M5 的 `toSvg` 预留，**不得当 CSS px 写进内联样式**（D6）——视觉字号全部由
 * `global.css` 按语义 class（title/subtitle/credit/note/metadata）决定。
 *
 * `data-anchor-key` 用 `document` 分支的 `anchorKey()`：C3「document → 解析到
 * `RenderScore`/`ScoreView` 根（头部区域）」的可视对应物，`key.absent` 之类的
 * document 级诊断点击后高亮的正是本组件的根 `<header>`。
 */

import { anchorKey } from '../../../notation/model/types';
import type { ScoreHeaderLayout } from '../../../notation/layout/scoreHeader';

const DOCUMENT_ANCHOR_KEY = anchorKey({ kind: 'document' });

export function ScoreHeaderView({ header }: { readonly header: ScoreHeaderLayout }) {
  return (
    <header className="score-header" data-anchor-key={DOCUMENT_ANCHOR_KEY}>
      {header.title !== undefined && <h1 className="score-header-title">{header.title.text}</h1>}
      {header.subtitles.map((subtitle, index) => (
        <h2 key={index} className="score-header-subtitle">{subtitle.text}</h2>
      ))}
      {(header.key !== undefined || header.meter !== undefined || header.tempo !== undefined) && (
        <div className="score-header-meta">
          {header.key !== undefined && <span className="score-header-meta-item">{header.key.text}</span>}
          {header.meter !== undefined && <span className="score-header-meta-item">{header.meter.text}</span>}
          {header.tempo !== undefined && <span className="score-header-meta-item">{header.tempo.text}</span>}
        </div>
      )}
      {header.credits.length > 0 && (
        <div className="score-header-credits">
          {header.credits.map((credit, index) => (
            <p key={index} className="score-header-credit">{credit.text}</p>
          ))}
        </div>
      )}
      {header.notes.length > 0 && (
        <div className="score-header-notes">
          {header.notes.map((note, index) => (
            <p key={index} className="score-header-note">{note.text}</p>
          ))}
        </div>
      )}
      {header.textBlocks.map((block, blockIndex) => (
        <div key={blockIndex} className="score-header-text-block">
          {block.lines.map((textLine, lineIndex) => (
            <p key={lineIndex} className="score-header-text-block-line">{textLine.text}</p>
          ))}
        </div>
      ))}
    </header>
  );
}
