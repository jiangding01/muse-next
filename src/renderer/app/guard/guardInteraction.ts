/**
 * 替换守卫面板的键盘与焦点规则（M3 T4 B4 UI 定点修复；B4 方案 r0.2 §2 的 G-M5 / G-M8）。
 *
 * 纯函数：不 import、不接触平台全局，由 `ReplacementGuardDialog` 以事件与焦点事实调用。守卫是**非模态**确认面板——不困住
 * 焦点，询问期间允许继续编辑（P0 §10 G6）；并发的 Open / Save / Save As 仍由准入租约拒绝，这里不承担任何文件操作的安全。
 */

export type GuardPanelPhase = 'idle' | 'asking' | 'saving';

/** 判定 Esc 所需的键盘事件事实（取自 `KeyboardEvent`）。 */
export interface GuardKeyFacts {
  readonly key: string;
  /** 输入法组字中的按键（组字期间所有 keydown 都为 true，见 imeMachine）。 */
  readonly isComposing: boolean;
  /** 229 = 输入法处理中的按键（部分平台组字首键 `isComposing` 仍为 false）。 */
  readonly keyCode: number;
  /** 其它处理器已经消费了这个按键。 */
  readonly defaultPrevented: boolean;
}

/**
 * G-M5：只有**询问阶段**、**不在组字中**、**未被其它处理器消费**的 Esc 才等同「取消」。
 * saving 阶段不取消进行中的保存；组字中的 Esc 留给输入法取消组字；其它按键一律不处理。
 */
export function guardKeyAction(phase: GuardPanelPhase, facts: GuardKeyFacts): 'cancel' | null {
  if (phase !== 'asking' || facts.key !== 'Escape') return null;
  if (facts.isComposing || facts.keyCode === 229 || facts.defaultPrevented) return null;
  return 'cancel';
}

/** 进入询问时当前焦点的事实。 */
export interface GuardAskFocusFacts {
  /** 当前焦点在面板内。 */
  readonly focusInPanel: boolean;
  /** 当前没有聚焦元素或焦点落在 body。 */
  readonly focusOnBody: boolean;
}

/**
 * G-M4：进入询问时的焦点动作。
 * - `initial`：面板**新出现**（idle → asking）——记下原焦点，把焦点放到安全默认的「取消」。
 * - `refocus`：保存后仍未 clean，saving → asking 重新询问——不覆盖原焦点；焦点在 body 或面板内时才放回「取消」。
 * - `keep`：重新询问时用户正在面板之外（如编辑区，P0 §10 G6）——不抢焦点。
 */
export function askFocusAction(previous: GuardPanelPhase, facts: GuardAskFocusFacts): 'initial' | 'refocus' | 'keep' {
  if (previous === 'idle') return 'initial';
  return facts.focusInPanel || facts.focusOnBody ? 'refocus' : 'keep';
}

/** 询问结束时的焦点事实。 */
export interface GuardFocusFacts {
  /** 打开面板前聚焦的元素仍在文档中（不是 body）。 */
  readonly openerAvailable: boolean;
  /** 当前焦点在面板内。 */
  readonly focusInPanel: boolean;
  /** 当前没有聚焦元素或焦点落在 body。 */
  readonly focusOnBody: boolean;
}

/**
 * G-M8：只在以「取消」（按钮或 Esc）结束、原焦点仍在、且用户没有主动把焦点移到面板之外时，把焦点还给原焦点。
 * 保存 / 不保存（Open 事务继续，原生对话框接管焦点）与宿主消失（根卸载）都不恢复焦点。
 */
export function shouldRestoreFocus(endedBy: 'cancel' | 'other', facts: GuardFocusFacts): boolean {
  return endedBy === 'cancel' && facts.openerAvailable && (facts.focusInPanel || facts.focusOnBody);
}
