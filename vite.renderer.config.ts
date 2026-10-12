import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

import { rendererCsp } from './vite.renderer.csp';
import type { RendererCspMode } from './vite.renderer.csp';

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
  plugins: [rendererCspPlugin(), react()],
  root: 'src/renderer',
  build: {
    sourcemap: true,
  },
});
