import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { rendererCsp } from './vite.renderer.csp';
import type { RendererCspMode } from './vite.renderer.csp';
import { rendererFullReload } from './vite.renderer.reload';

/** 按 vite command 注入 CSP meta（M3 T1c-1）：`build` 用 production 策略，`serve` 用 development 策略。 */
function rendererCspPlugin(): Plugin {
  let mode: RendererCspMode = 'development';
  return {
    name: 'muse-renderer-csp',
    configResolved(config) {
      mode = config.command === 'build' ? 'production' : 'development';
    },
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: rendererCsp(mode) }, injectTo: 'head-prepend' },
    ],
  };
}

export default defineConfig({
  // CSP 插件必须排在第一位（rendererCsp.test.ts）；开发期整页刷新插件只在 serve 生效（M3 T3a）。
  plugins: [rendererCspPlugin(), rendererFullReload(), react()],
  root: 'src/renderer',
  build: {
    sourcemap: true,
  },
});
