/**
 * 中间乐谱区（M2 T5 接线：M2 方案 v1.1.1 §6 T5）。
 *
 * 谱面本体交给 `<ScoreView>`（store `{score,index}` → `buildRenderScore` → 按
 * `voice.style` 分派各记谱渲染器 + 头部 + 诊断联动，见该文件）；本组件只保留页面
 * 外壳（标签页）与 `%%gchord` 和弦图区——`ScoreView` 已经渲染谱面头部（标题/
 * credits/notes/meter/key/tempo），旧的静态标题块 + 占位五线装饰随之移除。
 *
 * `showFinger` 在此接线到 `ChordDiagram`：迁移前的组件从未读取过
 * `Score.showFinger`（T3 报告已注明这是 T5 的职责），三态语义见
 * `notation/chord/layoutChord.ts` 文件头。
 */

import { ChordDiagram } from './notation/ChordDiagram';
import { ScoreView } from './notation/ScoreView';
import { useMuseAppStore } from '../app/store';

export function ScoreWorkspace() {
  const score = useMuseAppStore((state) => state.score);

  return (
    <main className="score-workspace">
      <div className="workspace-tabs">
        <button className="active">Score</button>
        <button>Source</button>
        <button>Print Preview</button>
      </div>

      <div className="page-stage">
        <article className="score-page">
          <ScoreView />

          <section className="chord-section">
            <div className="section-title">
              <h2>Parsed guitar chords</h2>
              <span>{score.chordShapes.length} from %%gchord</span>
            </div>
            <div className="chord-grid">
              {score.chordShapes.map((chord) => (
                <ChordDiagram key={chord.origin} chord={chord} showFinger={score.showFinger} />
              ))}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}
