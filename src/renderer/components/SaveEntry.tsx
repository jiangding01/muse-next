/**
 * 独立的保存入口（M3 T4 B3b；B3 r0 §2.3 b4、Q-B3-9）。
 *
 * 不放进 Toolbar（`m3t1c` 钉住 Toolbar 不出现保存字样）：由 App 挂载。只读 store 的派生状态决定可用性，只派发保存控制器的
 * 三个入口（保存、另存为、另存为 UTF-8）；准入、R5、送达门与结果提示都在保存控制器中。不注册 effect，不接触桥。
 */

import { isFileOperationBusy } from '../../editor/session/derive';
import { museSaveController } from '../app/save/saveController';
import { useMuseAppStore } from '../app/store';

export function SaveEntry() {
  const busy = useMuseAppStore((state) => isFileOperationBusy(state.session) || state.open.phase !== 'idle');
  const utf8 = useMuseAppStore((state) => state.session.writeEncoding === 'utf-8');
  return (
    <div className="save-entry" data-save-busy={busy}>
      <button type="button" data-save-entry="save" disabled={busy} onClick={() => { museSaveController.save(); }}>
        保存
      </button>
      <button type="button" className="secondary" data-save-entry="save-as" disabled={busy} onClick={() => { museSaveController.saveAs(); }}>
        另存为…
      </button>
      {utf8 ? null : (
        <button type="button" className="secondary" data-save-entry="save-as-utf8" disabled={busy} onClick={() => { museSaveController.saveAs({ utf8: true }); }}>
          另存为 UTF-8…
        </button>
      )}
    </div>
  );
}
