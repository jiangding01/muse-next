/**
 * Renderer 页面的 Content-Security-Policy（M3 T1c-1，T1c Preflight r2 §5.3 / §18；用户裁决 Q4）。
 *
 * 纯函数：`vite.renderer.config.ts` 用它注入 `<meta http-equiv="Content-Security-Policy">`（head 最前面），单测、架构守卫与
 * 真实窗口 smoke 用同一份字符串比对。
 * - `production`：`vite build`（含 Forge package / make 与 smoke 的生产 renderer 构建）。只允许同源脚本与样式（字体另允许 VexFlow
 *   内嵌的 data: 字体）；禁止内联脚本、eval、插件对象、`<base>`、表单提交；`frame-src` / `child-src` 为 `'none'`，不加载任何
 *   子 frame 或 worker。
 * - `development`：`vite serve`（`npm start`）。只在 production 之上放宽开发服务器需要的三处：React 刷新运行时的内联脚本、
 *   开发期注入的 `<style>`、HMR 的本机 WebSocket。按 vite 的 command 区分，不按 mode。
 * frame / opener / 导航 / webview 的拦截在 main（`src/main/security/windowSecurity.ts`），CSP 只是页面侧的一层。
 */

export type RendererCspMode = 'production' | 'development';

type Directives = readonly (readonly [name: string, sources: readonly string[]])[];

const PRODUCTION: Directives = [
  ['default-src', ["'self'"]],
  ['script-src', ["'self'"]],
  ['style-src', ["'self'"]],
  ['img-src', ["'self'", 'data:']],
  // VexFlow 的 `vexflow/bravura` 入口用 FontFace 加载内嵌的 data: 字体（M3 T1c-1 生产 renderer 实测，T1c Preflight r2 §5.3 预留）。
  ['font-src', ["'self'", 'data:']],
  ['connect-src', ["'self'"]],
  ['object-src', ["'none'"]],
  ['base-uri', ["'none'"]],
  ['form-action', ["'none'"]],
  ['frame-src', ["'none'"]],
  ['child-src', ["'none'"]],
];

/** development 在 production 之上追加的来源（只追加，不删除任何限制）。 */
const DEVELOPMENT_ADDITIONS: Readonly<Record<string, readonly string[]>> = {
  'script-src': ["'unsafe-inline'"],
  'style-src': ["'unsafe-inline'"],
  'connect-src': ['ws://localhost:*', 'ws://127.0.0.1:*'],
};

export function rendererCsp(mode: RendererCspMode): string {
  return PRODUCTION.map(([name, sources]) => {
    const extra = mode === 'development' ? (DEVELOPMENT_ADDITIONS[name] ?? []) : [];
    return `${name} ${[...sources, ...extra].join(' ')}`;
  }).join('; ');
}
