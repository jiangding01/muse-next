/**
 * 模块级同步 beforeunload 阻止（M3 T3a；`docs/M3_EDITOR_CORE_PLAN.md` §15.3 的 renderer 半边提前到 T3，用户裁决 Q3 / S4；
 * T3 Preflight r3 §8，外部审查 H3-2，偏差 D-8）。
 *
 * - 在 React 之外、`createRoot` 之前注册；同步读取 store：文档 dirty，或输入法正在组字（可见但未提交的文本）时
 *   `preventDefault()` 并设置 `returnValue`；不等待任何 Promise、不弹 DOM 对话框。
 * - 已实测（macOS 开发环境，scratchpad `sp-hmr-p-evidence.md` / `sp-hmr-i-evidence.md`）：阻止**开发期整页刷新**；且
 *   Chromium 要求页面曾获得用户激活，阻止才会生效（dirty 必然来自用户输入，通常已满足）。关窗 / 退出 / DevTools 刷新的
 *   阻止尚**待 SP-UNLOAD 实测**（T3c、G4-macOS 前）。
 * - main 不处理 `will-prevent-unload`（T5 才做询问），因此阻止会一直保持，直到用户撤销到未修改状态或结束组字。
 * - 阶段性防线，不是完整的数据安全保证：进程崩溃、强制结束、开发期 main 进程被替换都会绕过它（§15.5）。
 * - 安装幂等：同一目标只注册一次。
 * - M3 T4 B3a-2（§15.3、Gate B3a-1 追加硬门 4）：保存进行中也阻止。判据读取**完整的保存租约**——准入租约是 save / saveAs
 *   （含入口获取租约之后、捕获快照建立 `fileOp` 之前的 IME 等待、送达门、对话框阶段），或会话上有保存中的 `fileOp`；
 *   不只检查 store 的 `fileOp`。
 */

import { isSaveInFlight, isSourceDirty } from '../../../editor/session/derive';
import { museFileIntentGate } from '../fileIntentGate';
import type { FileIntentLease } from '../fileIntentGate';
import { publishEditorView, useMuseAppStore } from '../store';
import { museEditorController } from './editorController';
import type { ImeView } from './editorController';

export type UnloadBlockReason = 'dirty' | 'composing' | 'saving';

export interface BeforeUnloadEventLike {
  preventDefault(): void;
  returnValue: unknown;
}

export interface UnloadTargetLike {
  addEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
  removeEventListener(type: 'beforeunload', listener: (event: BeforeUnloadEventLike) => void): void;
}

export interface UnloadBlockerDeps {
  /** 同步读取当前是否需要阻止；null 表示放行。 */
  readonly reason: () => UnloadBlockReason | null;
  readonly notify: (reason: UnloadBlockReason) => void;
}

/** 生成 beforeunload 处理器（纯同步）。 */
export function createUnloadHandler(deps: UnloadBlockerDeps): (event: BeforeUnloadEventLike) => void {
  return (event) => {
    const reason = deps.reason();
    if (reason === null) return;
    event.preventDefault();
    event.returnValue = '';
    deps.notify(reason);
  };
}

const installed = new WeakSet<UnloadTargetLike>();

/** 在目标上注册处理器；已注册过则不重复注册。返回是否本次新注册。 */
export function installUnloadBlocker(target: UnloadTargetLike, handler: (event: BeforeUnloadEventLike) => void): boolean {
  if (installed.has(target)) return false;
  installed.add(target);
  target.addEventListener('beforeunload', handler);
  return true;
}

/** 判据（纯函数）：保存进行中优先（M3 T4 B3a-2），其次 dirty，再次输入法正在组字；discarded / settled 不阻止（r3 复查 H-1）。 */
export function unloadReasonFor(dirty: boolean, ime: ImeView, saving = false): UnloadBlockReason | null {
  if (saving) return 'saving';
  if (dirty) return 'dirty';
  if (ime === 'composing') return 'composing';
  return null;
}

/** 保存租约：准入租约是 save / saveAs（含尚未建立 fileOp 的准入期）。 */
export const isSaveLease = (lease: FileIntentLease | null): boolean => lease !== null && (lease.kind === 'save' || lease.kind === 'saveAs');

/** 产品判据：以当前准入租约、store 与编辑控制器的组字视图同步求值。 */
export function museUnloadReason(): UnloadBlockReason | null {
  const { session } = useMuseAppStore.getState();
  return unloadReasonFor(isSourceDirty(session), museEditorController.imeView(), isSaveLease(museFileIntentGate.current()) || isSaveInFlight(session));
}

const UNLOAD_NOTICE = { dirty: 'unload-blocked-dirty', composing: 'unload-blocked-composing', saving: 'unload-blocked-saving' } as const;

const museUnloadHandler = createUnloadHandler({
  reason: museUnloadReason,
  notify: (reason) => publishEditorView({ notice: { kind: UNLOAD_NOTICE[reason] } }),
});

/** 入口模块在 `createRoot` 之前调用一次。 */
export function installMuseUnloadBlocker(target: UnloadTargetLike = window): boolean {
  return installUnloadBlocker(target, museUnloadHandler);
}
