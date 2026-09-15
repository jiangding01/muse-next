/**
 * 中间乐谱区：M1.6 T10b 起读 `Score.titles/credits/chordShapes`。
 *
 * 旧的 `error-card`（解析抛异常）已移除——`loadJcx` 对字符串输入永不抛，
 * 结构问题一律以 diagnostic 呈现，见 `SourceInspector` 的诊断列表。
 */

import { ChordDiagram } from '../../notation/chord/ChordDiagram';
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
          <header className="score-title">
            <h1>{score.titles[0] ?? 'Untitled'}</h1>
            {score.credits[0] !== undefined && <p>{score.credits[0]}</p>}
          </header>

          <section className="notation-placeholder">
            <div className="staff-lines" aria-hidden="true">
              {Array.from({ length: 5 }, (_, index) => <i key={index} />)}
            </div>
            <div className="notation-copy">
              <strong>Notation renderer boundary</strong>
              <span>Staff / Jianpu / TAB renderers will consume the same domain model.</span>
            </div>
          </section>

          <section className="chord-section">
            <div className="section-title">
              <h2>Parsed guitar chords</h2>
              <span>{score.chordShapes.length} from %%gchord</span>
            </div>
            <div className="chord-grid">
              {score.chordShapes.map((chord) => (
                <ChordDiagram key={chord.origin} chord={chord} />
              ))}
            </div>
          </section>
        </article>
      </div>
    </main>
  );
}
