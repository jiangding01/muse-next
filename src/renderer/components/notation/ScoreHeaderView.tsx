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

/**
 * 头部「调号 / 拍号」这一格的展示文本（Phase A item 8，边界裁决 1）：`jianpuTonicLabel`
 * 只在「至少一个 jianpu 声部 + `K:` 拼得出干净规范形式」时由 `layoutScoreHeader` 给出，
 * 否则退回原始 `key`（`K: <raw>`）——纯 staff 文档、或 `K:` 含未解析 mode 文本的简谱文档
 * 都会走这条退路，不猜测。 */
function tonicOf(header: ScoreHeaderLayout): ScoreHeaderLayout['key'] {
  return header.jianpuTonicLabel ?? header.key;
}

export function ScoreHeaderView({ header }: { readonly header: ScoreHeaderLayout }) {
  const tonic = tonicOf(header);
  return (
    <header className="score-header" data-anchor-key={DOCUMENT_ANCHOR_KEY}>
      {header.title !== undefined && <h1 className="score-header-title">{header.title.text}</h1>}
      {header.subtitles.map((subtitle, index) => (
        <h2 key={index} className="score-header-subtitle">{subtitle.text}</h2>
      ))}
      {(tonic !== undefined || header.meter !== undefined || header.tempo !== undefined) && (
        <div className="score-header-meta">
          {tonic !== undefined && <span className="score-header-meta-item">{tonic.text}</span>}
          {header.jianpuMeterFraction !== undefined ? (
            <span
              className="score-header-meta-item score-header-meter-fraction"
              aria-label={`${header.jianpuMeterFraction.num}/${header.jianpuMeterFraction.den}`}
            >
              <span className="score-header-meter-num">{header.jianpuMeterFraction.num}</span>
              <span className="score-header-meter-den">{header.jianpuMeterFraction.den}</span>
            </span>
          ) : (
            header.meter !== undefined && <span className="score-header-meta-item">{header.meter.text}</span>
          )}
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
