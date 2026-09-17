import { SCORE_VIEW_METRICS } from '../../notation/layout/metrics';
import { useMuseAppStore } from '../app/store';

/** 缩放百分比文案：`zoom` 是比例（1 = 100%），只做展示格式化，不参与任何 layout 计算。 */
function zoomLabel(zoom: number): string {
  return `${String(Math.round(zoom * 100))}%`;
}

/** 缩放控件（T6.4）：− / 百分比 / + / 重置，均只调用 `setZoom`——clamp 在 store 里做，本组件不重复判断范围。 */
function ZoomControls() {
  const zoom = useMuseAppStore((state) => state.zoom);
  const setZoom = useMuseAppStore((state) => state.setZoom);

  return (
    <div className="zoom-controls">
      <button
        type="button"
        className="secondary zoom-button"
        aria-label="缩小"
        onClick={() => { setZoom(zoom - SCORE_VIEW_METRICS.zoomStep); }}
      >
        −
      </button>
      <button
        type="button"
        className="secondary zoom-reset"
        aria-label="重置缩放"
        onClick={() => { setZoom(1); }}
      >
        {zoomLabel(zoom)}
      </button>
      <button
        type="button"
        className="secondary zoom-button"
        aria-label="放大"
        onClick={() => { setZoom(zoom + SCORE_VIEW_METRICS.zoomStep); }}
      >
        +
      </button>
    </div>
  );
}

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
        <ZoomControls />
      </div>
      <div className="file-status" title={filePath ?? undefined}>
        <span>{filePath ? filePath.split('/').pop() : 'demo.jcx'}</span>
        <small>{encoding ?? '—'}</small>
      </div>
    </header>
  );
}
