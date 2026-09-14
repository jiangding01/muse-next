import { useMuseAppStore } from '../app/store';

export function SourceInspector() {
  const source = useMuseAppStore((state) => state.source);
  const setSource = useMuseAppStore((state) => state.setSource);
  const document = useMuseAppStore((state) => state.document);

  return (
    <aside className="source-inspector panel">
      <div className="panel-heading">
        <span>JCX Source</span>
        <span className="pill">%MUSE2</span>
      </div>
      <textarea
        className="source-editor"
        spellCheck={false}
        value={source}
        onChange={(event) => setSource(event.target.value)}
      />
      <div className="parse-summary">
        <span>Headers</span><strong>{document ? document.metadata.titles.length + document.metadata.credits.length : 0}</strong>
        <span>Chords</span><strong>{document?.chords.length ?? 0}</strong>
        <span>Tracks</span><strong>{document?.tracks.length ?? 0}</strong>
      </div>
    </aside>
  );
}
