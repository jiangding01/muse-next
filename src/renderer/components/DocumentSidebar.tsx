import { useMuseAppStore } from '../app/store';

export function DocumentSidebar() {
  const document = useMuseAppStore((state) => state.document);

  return (
    <aside className="document-sidebar panel">
      <div className="panel-heading">
        <span>Document</span>
        <span className="pill">{document?.tracks.length ?? 0} tracks</span>
      </div>

      <section>
        <h3>Score</h3>
        <dl className="properties">
          <dt>Title</dt><dd>{document?.metadata.titles[0] ?? 'Untitled'}</dd>
          <dt>Meter</dt><dd>{document?.metadata.meter ?? '—'}</dd>
          <dt>Key</dt><dd>{document?.metadata.key ?? '—'}</dd>
          <dt>Tempo</dt><dd>{document?.metadata.tempo ?? '—'}</dd>
        </dl>
      </section>

      <section>
        <h3>Tracks</h3>
        <div className="track-list">
          {document?.tracks.map((track) => (
            <div className="track-card" key={track.id}>
              <span className={`track-type track-${track.style}`}>{track.style}</span>
              <div>
                <strong>{track.name || `Voice ${track.id}`}</strong>
                <small>V:{track.id} · MIDI {track.instrument ?? '—'}</small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
