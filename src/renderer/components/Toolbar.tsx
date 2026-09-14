import { useMuseAppStore } from '../app/store';

export function Toolbar() {
  const openScore = useMuseAppStore((state) => state.openScore);
  const reparse = useMuseAppStore((state) => state.reparse);
  const filePath = useMuseAppStore((state) => state.filePath);
  const encoding = useMuseAppStore((state) => state.encoding);

  return (
    <header className="toolbar">
      <div className="brand">
        <span className="brand-mark">M</span>
        <div>
          <strong>Muse Next</strong>
          <small>Legacy Muse reimplementation</small>
        </div>
      </div>
      <div className="toolbar-actions">
        <button onClick={() => void openScore()}>Open .jcx</button>
        <button className="secondary" onClick={reparse}>Reparse</button>
      </div>
      <div className="file-status" title={filePath ?? undefined}>
        <span>{filePath ? filePath.split('/').pop() : 'demo.jcx'}</span>
        <small>{encoding ?? '—'}</small>
      </div>
    </header>
  );
}
