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
 */

import { isSourceDirty } from '../../../editor/session/derive';
import { publishEditorView, useMuseAppStore } from '../store';
import { museEditorController } from './editorController';
import type { ImeView } from './editorController';

export type UnloadBlockReason = 'dirty' | 'composing';

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

/** 判据（纯函数）：dirty 优先，其次输入法正在组字；discarded / settled 不阻止（r3 复查 H-1）。 */
export function unloadReasonFor(dirty: boolean, ime: ImeView): UnloadBlockReason | null {
  if (dirty) return 'dirty';
  if (ime === 'composing') return 'composing';
  return null;
}

/** 产品判据：以当前 store 与编辑控制器的组字视图同步求值。 */
export function museUnloadReason(): UnloadBlockReason | null {
  return unloadReasonFor(isSourceDirty(useMuseAppStore.getState().session), museEditorController.imeView());
}

const museUnloadHandler = createUnloadHandler({
  reason: museUnloadReason,
  notify: (reason) => publishEditorView({ notice: { kind: reason === 'dirty' ? 'unload-blocked-dirty' : 'unload-blocked-composing' } }),
});

/** 入口模块在 `createRoot` 之前调用一次。 */
export function installMuseUnloadBlocker(target: UnloadTargetLike = window): boolean {
  return installUnloadBlocker(target, museUnloadHandler);
}
