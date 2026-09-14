import { ChordDiagram } from '../../notation/chord/ChordDiagram';
import { useMuseAppStore } from '../app/store';

export function ScoreWorkspace() {
  const document = useMuseAppStore((state) => state.document);
  const error = useMuseAppStore((state) => state.error);

  return (
    <main className="score-workspace">
      <div className="workspace-tabs">
        <button className="active">Score</button>
        <button>Source</button>
        <button>Print Preview</button>
      </div>

      <div className="page-stage">
        <article className="score-page">
          {error ? (
            <div className="error-card">{error}</div>
          ) : (
            <>
              <header className="score-title">
                <h1>{document?.metadata.titles[0] ?? 'Untitled'}</h1>
                {document?.metadata.credits[0] && <p>{document.metadata.credits[0]}</p>}
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
                  <span>{document?.chords.length ?? 0} from %%gchord</span>
                </div>
                <div className="chord-grid">
                  {document?.chords.map((chord) => (
                    <ChordDiagram key={chord.name} chord={chord} />
                  ))}
                </div>
              </section>
            </>
          )}
        </article>
      </div>
    </main>
  );
}
