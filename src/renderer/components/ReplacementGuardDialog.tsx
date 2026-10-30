/**
 * 替换守卫的三按钮询问（M3 T4 B3b；B3 r0 §2.3 b3、§4）。
 *
 * 只读守卫控制器的询问视图（`useSyncExternalStore`），只派发选择（保存 / 不保存 / 取消）；不接触会话、store 写入或桥。
 * 挂载时登记为守卫的宿主、卸载时注销：根 React 卸载后宿主计数归零，未完成的询问被取消，之后的 Open 被拒绝。
 * 选择以产品数据属性 `data-guard-choice` 呈现，询问状态以 `data-guard-phase` 呈现。
 */

import { useEffect, useSyncExternalStore } from 'react';

import { museGuardController } from '../app/guard/guardController';

export function ReplacementGuardDialog() {
  const view = useSyncExternalStore(museGuardController.subscribe, museGuardController.view);
  useEffect(() => museGuardController.attachHost(), []);
  if (view.phase === 'idle') return null;
  const saving = view.phase === 'saving';
  return (
    <div className="replacement-guard" role="alertdialog" aria-modal="true" data-guard-phase={view.phase}>
      <p>{saving ? '正在保存当前文档…' : '当前文档有未保存的修改。打开其它文件之前，是否先保存？'}</p>
      <div className="replacement-guard-actions">
        <button type="button" data-guard-choice="save" disabled={saving} onClick={() => { museGuardController.choose('save'); }}>
          保存
        </button>
        <button type="button" className="secondary" data-guard-choice="discard" disabled={saving} onClick={() => { museGuardController.choose('discard'); }}>
          不保存
        </button>
        <button type="button" className="secondary" data-guard-choice="cancel" disabled={saving} onClick={() => { museGuardController.choose('cancel'); }}>
          取消
        </button>
      </div>
    </div>
  );
}
