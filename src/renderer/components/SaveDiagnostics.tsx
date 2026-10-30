/**
 * 保存诊断区（M3 T4 B3a-2；B3 r0 §2.1 a15、§3.8）。
 *
 * 独立于编辑器轻提示（不放进 `.editor-status-notice`）：只读 store 的保存视图，只派发「知道了」（清空保存视图）。
 * 提示种类以产品数据属性呈现（`data-save-message` / `data-save-failure`，失败时另有错误码 `data-save-code`），不含任何派发来源或计数之类的测试钩子；
 * 不注册 effect，不接触 `museDesktop` 与保存控制器。
 */

import { isSaveFailure, saveMessageText } from '../app/save/saveMessages';
import { publishSaveView, useMuseAppStore } from '../app/store';

export function SaveDiagnostics() {
  const message = useMuseAppStore((state) => state.save.message);
  if (message === null) return null;
  return (
    <div
      className="save-diagnostics"
      role="status"
      data-save-message={message.kind}
      data-save-failure={isSaveFailure(message)}
      data-save-code={message.kind === 'failed' ? message.code : undefined}
    >
      <span>{saveMessageText(message)}</span>
      <button type="button" className="secondary" onClick={() => { publishSaveView({ message: null }); }}>
        知道了
      </button>
    </div>
  );
}
