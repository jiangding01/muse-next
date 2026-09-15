/** 左侧文档面板：M1.6 T10b 起读正式 Domain 的 `Score.voices`，不再读 scaffold 的 `tracks`。 */

import { useMuseAppStore } from '../app/store';

const DASH = '—';

export function DocumentSidebar() {
  const score = useMuseAppStore((state) => state.score);

  return (
    <aside className="document-sidebar panel">
      <div className="panel-heading">
        <span>Document</span>
        <span className="pill">{score.voices.length} voices</span>
      </div>

      <section>
        <h3>Score</h3>
        <dl className="properties">
          <dt>Title</dt><dd>{score.titles[0] ?? 'Untitled'}</dd>
          <dt>Meter</dt><dd>{score.meter?.raw ?? DASH}</dd>
          <dt>Key</dt><dd>{score.key?.raw ?? DASH}</dd>
          <dt>Tempo</dt><dd>{score.tempo?.raw ?? DASH}</dd>
        </dl>
      </section>

      <section>
        <h3>Voices</h3>
        <div className="track-list">
          {score.voices.map((voice) => (
            <div className="track-card" key={voice.id}>
              {/* style 是原值保留、且可缺省（spec §12.6），缺省时不带 track-<style> 配色。 */}
              <span className={`track-type${voice.style === undefined ? '' : ` track-${voice.style}`}`}>
                {voice.style ?? DASH}
              </span>
              <div>
                <strong>{voice.name ?? `Voice ${voice.id}`}</strong>
                <small>
                  {voice.id} · MIDI {voice.instrument ?? DASH} · vol {voice.volume ?? DASH}
                </small>
              </div>
            </div>
          ))}
        </div>
      </section>
    </aside>
  );
}
