/**
 * 替换守卫的三按钮询问（M3 T4 B3b；B3 r0 §2.3 b3、§4）。
 *
 * 只读守卫控制器的询问视图（`useSyncExternalStore`），只派发选择（保存 / 不保存 / 取消）；不接触会话、store 写入或桥。
 * 挂载时登记为守卫的宿主、卸载时注销：根 React 卸载后宿主计数归零，未完成的询问被取消，之后的 Open 被拒绝。
 * 选择以产品数据属性 `data-guard-choice` 呈现，询问状态以 `data-guard-phase` 呈现。
 *
 * M3 T4 B4 UI 定点修复（B4 方案 r0.2 §2）——非模态确认面板（P0 §10 G6：询问期间允许继续编辑）：出现时把焦点放到安全默认的「取消」；不困住焦点，可回到编辑区继续输入；
 * 询问阶段的 Esc 等同「取消」（saving 阶段与输入法组字中不处理）；以「取消」结束时按 `shouldRestoreFocus` 归还原焦点；
 * 保存后仍未 clean 而重新询问时按 `askFocusAction` 不抢编辑区的焦点。
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { Ref } from 'react';

import { museGuardController } from '../app/guard/guardController';
import { askFocusAction, guardKeyAction, shouldRestoreFocus } from '../app/guard/guardInteraction';
import type { GuardPanelPhase } from '../app/guard/guardInteraction';

type GuardChoice = 'save' | 'discard' | 'cancel';

interface ReplacementGuardPanelProps {
  readonly phase: 'asking' | 'saving';
  readonly onChoose: (choice: GuardChoice) => void;
  readonly panelRef?: Ref<HTMLDivElement>;
  readonly cancelRef?: Ref<HTMLButtonElement>;
}

/** 纯展示：询问面板的结构与语义（非模态 alertdialog，问句经 labelledby / describedby 关联）。 */
export function ReplacementGuardPanel({ phase, onChoose, panelRef, cancelRef }: ReplacementGuardPanelProps) {
  const saving = phase === 'saving';
  return (
    <div
      ref={panelRef}
      className="replacement-guard"
      role="alertdialog"
      aria-labelledby="replacement-guard-title"
      aria-describedby="replacement-guard-message"
      data-guard-phase={phase}
    >
      <p id="replacement-guard-message">
        <strong id="replacement-guard-title">{saving ? '正在保存' : '未保存的修改'}</strong>
        <span>{saving ? '正在保存当前文档…' : '当前文档有未保存的修改。打开其它文件之前，是否先保存？'}</span>
      </p>
      <div className="replacement-guard-actions">
        <button type="button" data-guard-choice="save" disabled={saving} onClick={() => { onChoose('save'); }}>
          保存
        </button>
        <button type="button" className="secondary" data-guard-choice="discard" disabled={saving} onClick={() => { onChoose('discard'); }}>
          不保存
        </button>
        <button ref={cancelRef} type="button" className="secondary" data-guard-choice="cancel" disabled={saving} onClick={() => { onChoose('cancel'); }}>
          取消
        </button>
      </div>
    </div>
  );
}

export function ReplacementGuardDialog() {
  const view = useSyncExternalStore(museGuardController.subscribe, museGuardController.view);
  useEffect(() => museGuardController.attachHost(), []);
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<Element | null>(null);
  const lastFocusRef = useRef<Element | null>(null);
  const previousPhaseRef = useRef<GuardPanelPhase>('idle');
  const phase = view.phase;

  // 最近一次获得焦点的元素：鼠标点击 Open 会先让焦点落到 body，原焦点以它为准。
  useEffect(() => {
    const onFocusIn = (event: FocusEvent): void => {
      if (event.target instanceof Element) lastFocusRef.current = event.target;
    };
    window.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  /**
   * 结束询问（三个按钮与 Esc 的唯一出口）：只在控制器的实时阶段仍为询问时生效；先按 `shouldRestoreFocus` 判定焦点归还
   * （只有「取消」归还，且用户已把焦点移出面板时不覆盖），再派发选择。
   */
  const end = (choice: GuardChoice): void => {
    if (museGuardController.view().phase !== 'asking') return;
    const opener = openerRef.current;
    const active = document.activeElement;
    const restore = shouldRestoreFocus(choice === 'cancel' ? 'cancel' : 'other', {
      openerAvailable: opener instanceof HTMLElement && opener !== document.body && opener.isConnected,
      focusInPanel: active !== null && panelRef.current?.contains(active) === true,
      focusOnBody: active === null || active === document.body,
    });
    museGuardController.choose(choice);
    if (restore && opener instanceof HTMLElement) opener.focus();
  };

  // 进入询问（G-M4）：面板新出现时记下原焦点并聚焦「取消」；保存后仍未 clean 而重新询问时不覆盖原焦点，也不抢编辑区的焦点。
  useEffect(() => {
    const previous = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (phase !== 'asking') return;
    const active = document.activeElement;
    const action = askFocusAction(previous, {
      focusInPanel: active !== null && panelRef.current?.contains(active) === true,
      focusOnBody: active === null || active === document.body,
    });
    if (action === 'initial') openerRef.current = active !== null && active !== document.body ? active : lastFocusRef.current;
    if (action !== 'keep') cancelRef.current?.focus();
  }, [phase]);

  // 询问 / 保存中监听 Esc：是否取消由 guardKeyAction 按阶段与组字状态判定（G-M5）。
  useEffect(() => {
    if (phase === 'idle') return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      const action = guardKeyAction(phase, { key: event.key, isComposing: event.isComposing, keyCode: event.keyCode, defaultPrevented: event.defaultPrevented });
      if (action !== 'cancel') return;
      event.preventDefault();
      end('cancel');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [phase]);

  if (phase === 'idle') return null;
  return (
    <ReplacementGuardPanel
      phase={phase}
      panelRef={panelRef}
      cancelRef={cancelRef}
      onChoose={end}
    />
  );
}
