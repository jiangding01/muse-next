import { SCORE_VIEW_METRICS } from '../../notation/layout/metrics';
import { museOpenController } from '../app/editor/openController';
import type { OpenNotice, OpenPhase } from '../app/editor/openTransaction';
import { useMuseAppStore } from '../app/store';
import type { OpenDocumentErrorCode } from '../../shared/openContracts';

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

const OPEN_LABELS: Readonly<Record<OpenPhase, string>> = {
  idle: 'Open .jcx',
  requesting: '选择文件…',
  activating: '正在打开…',
  uncertain: '正在确认…',
};

/** 键穷尽 main 的全部错误码；「1 MiB」与 main 的 `MAX_DOCUMENT_BYTES` 一致（renderer 不得导入 main）。 */
const OPEN_FAILED: Readonly<Record<OpenDocumentErrorCode, string>> = {
  'not-found': '文件不存在或已被移动。',
  'permission-denied': '没有读取该文件的权限。',
  'not-a-regular-file': '所选项目不是普通文件。',
  'file-too-large': '文件超过 1 MiB 的打开上限。',
  'read-failed': '读取文件失败，请重试。',
  'decode-utf16-unsupported': '不支持 UTF-16 编码的文件。',
  'decode-invalid-utf8': '文件不是有效的 UTF-8 文本。',
  'decode-invalid-gb18030': '文件不是有效的 GB18030 文本。',
};

/**
 * Open 提示文案（T1c Preflight r2 §8；用户裁决 Q3）。main 的 `busy` 不归因；文案不含路径。
 * 「原文件授权未确认」只提示风险与重新 Open 的恢复出口（Save / Save As 属 T4）。
 */
function noticeText(notice: OpenNotice): string {
  switch (notice.kind) {
    case 'open-failed':
      return `无法打开：${Object.hasOwn(OPEN_FAILED, notice.code) ? OPEN_FAILED[notice.code] : '读取文件失败，请重试。'}当前文档未改变。`;
    case 'busy':
      return '此窗口上已有一个打开文件的操作尚未结束。请先完成或关闭已出现的文件对话框，然后重试。';
    case 'superseded':
      return '本次打开已被取代，当前文档未改变；原文件授权未确认，重新打开文件即可恢复。';
    case 'request-rejected':
      return '打开请求被拒绝，当前文档未改变；原文件授权未确认，重新打开文件即可恢复。';
    case 'prepare-failed':
      return '文件已读取，但无法建立文档会话；当前文档未改变。';
    case 'activation-invalid':
      return '无法完成打开，当前文档未改变；原文件授权未确认，重新打开文件即可恢复。';
    case 'activation-mismatch':
      return '打开过程中出现内部错误，当前文档未改变；原文件授权未确认，重新打开文件即可恢复。';
    case 'activation-unresolved':
      return '无法确认打开结果，当前文档未改变；原文件授权未确认，重新打开文件即可恢复。';
  }
}

export function Toolbar() {
  const open = useMuseAppStore((state) => state.open);
  const session = useMuseAppStore((state) => state.session);
  const trust = useMuseAppStore((state) => state.capabilityTrust);
  const { file } = session;

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
        <button type="button" data-open-phase={open.phase} disabled={open.phase !== 'idle'} onClick={() => { museOpenController.open(); }}>
          {OPEN_LABELS[open.phase]}
        </button>
        <ZoomControls />
      </div>
      <div className="file-status" title={file?.displayPath} data-document-id={session.documentId} data-capability-trust={trust}>
        <span>{file?.displayName ?? 'demo.jcx'}</span>
        <small>
          {session.writeEncoding}
          {session.byteBom === 'utf8' ? ' · BOM' : ''}
          {session.encodingRoundTrip === 'unsafe' ? ' · 编码往返不安全' : ''}
          {trust === 'unverified' ? ' · 授权未确认' : ''}
        </small>
      </div>
      {open.notice === null ? null : (
        <div className="open-notice" role="status" data-notice={open.notice.kind}>
          <span>{noticeText(open.notice)}</span>
          <button type="button" className="secondary" onClick={() => { museOpenController.dismissNotice(); }}>
            知道了
          </button>
        </div>
      )}
    </header>
  );
}
