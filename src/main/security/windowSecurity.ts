/**
 * 窗口安全接线（M3 T1c-1，`docs/M3_EDITOR_CORE_PLAN.md` §15.1；T1c Preflight r2 §17–§18，用户裁决 Q4）。
 *
 * 产品 main（`src/main/main.ts`）与真实窗口 smoke 共用这一份实现。**本模块不 import electron**：webContents 按结构类型传入，
 * Electron 的 `WebContents` 直接满足这些接口。每个窗口注册一次，没有开关：
 * - `setWindowOpenHandler` → 一律 `deny`：不产生任何子窗口，也就不存在能经 `opener.museDesktop` 访问桥的同源窗口；
 * - `will-navigate`（页面发起的主 frame 跨文档导航）→ 目标不属于可信页面身份即 `preventDefault()`；
 * - `will-frame-navigate`（任意 frame）→ 子 frame 的导航一律 `preventDefault()`；主 frame 按与 `will-navigate` 相同的规则再判一次；
 * - `will-attach-webview` → 一律 `preventDefault()`。
 * main 自己发起的 `loadURL` / `reload` 是程序化导航，不经过页面导航事件；即使经过，目标也是可信页面身份，会被放行。
 *
 * 这不是主世界的完整防线：已在页面主世界执行的脚本仍能直接调用 `window.museDesktop`（T1c Preflight r2 §5.3 残余风险）。
 * 内联脚本、eval 与子 frame 加载由 renderer 的 CSP（`vite.renderer.csp.ts`）在页面侧再挡一层。
 *
 * `observer` 只接收「已拦截」通知（日志与验证证据），在拦截完成之后调用；它抛出的异常被吞掉，不影响拦截结果。
 */

import { matchesPageIdentity } from '../open/ipcValidation';
import type { PageIdentity } from '../open/ipcValidation';

export type WindowSecurityEvent = 'window-open' | 'will-navigate' | 'will-frame-navigate' | 'will-attach-webview';

export type WindowSecurityBlockKind = 'popup' | 'navigation' | 'subframe-navigation' | 'webview';

/** 一次拦截：`url` 只用于诊断，不得进入用户可见文案（可能含本地路径）。 */
export interface WindowSecurityBlock {
  readonly kind: WindowSecurityBlockKind;
  readonly event: WindowSecurityEvent;
  readonly url: string;
}

export type WindowSecurityObserver = (block: WindowSecurityBlock) => void;

export interface PreventableLike {
  preventDefault(): void;
}

/** `will-navigate` / `will-frame-navigate` 事件对象中本模块用到的部分。 */
export interface NavigationAttemptLike extends PreventableLike {
  readonly url: string;
  readonly isMainFrame: boolean;
}

export interface WindowOpenDetailsLike {
  readonly url: string;
}

/** `WebContents` 中本模块用到的部分。 */
export interface WindowSecurityContentsLike {
  setWindowOpenHandler(handler: (details: WindowOpenDetailsLike) => { readonly action: 'deny' }): void;
  on(event: 'will-navigate', listener: (details: NavigationAttemptLike) => void): unknown;
  on(event: 'will-frame-navigate', listener: (details: NavigationAttemptLike) => void): unknown;
  on(event: 'will-attach-webview', listener: (event: PreventableLike) => void): unknown;
}

/** 为一个窗口的 webContents 注册全部安全拦截；在 `loadURL` 之前调用。 */
export function wireWindowSecurity(contents: WindowSecurityContentsLike, identity: PageIdentity, observer?: WindowSecurityObserver): void {
  const report = (block: WindowSecurityBlock): void => {
    if (observer === undefined) return;
    try {
      observer(block);
    } catch {
      // 观测失败不影响拦截。
    }
  };
  const blockNavigation = (attempt: NavigationAttemptLike, kind: WindowSecurityBlockKind, event: WindowSecurityEvent): void => {
    attempt.preventDefault();
    report({ kind, event, url: attempt.url });
  };

  contents.setWindowOpenHandler((details) => {
    report({ kind: 'popup', event: 'window-open', url: details.url });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (attempt) => {
    if (!matchesPageIdentity(attempt.url, identity)) blockNavigation(attempt, 'navigation', 'will-navigate');
  });
  contents.on('will-frame-navigate', (attempt) => {
    if (!attempt.isMainFrame) blockNavigation(attempt, 'subframe-navigation', 'will-frame-navigate');
    else if (!matchesPageIdentity(attempt.url, identity)) blockNavigation(attempt, 'navigation', 'will-frame-navigate');
  });
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    report({ kind: 'webview', event: 'will-attach-webview', url: '' });
  });
}
