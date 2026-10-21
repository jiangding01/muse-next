/**
 * M3 T3a：开发期整页刷新插件（`vite.renderer.reload.ts`；T3 Preflight r3 §7.4，SP-HMR-P）。
 *
 * 重点：client 环境逐个使模块失效（isHmr = true，共用一个 seen 集合）、发送 full-reload、返回空数组（不做局部更新）；
 * 非 client 环境不处理；插件只在 serve 生效；在 renderer 配置中紧随 CSP 插件之后、早于 React 插件。
 */

import { describe, expect, it } from 'vitest';

import rendererConfig from '../../../vite.renderer.config';
import { fullReloadOnHotUpdate, RENDERER_FULL_RELOAD_PLUGIN, rendererFullReload } from '../../../vite.renderer.reload';
import type { ReloadEnvironmentLike } from '../../../vite.renderer.reload';

function environment(name: string) {
  const invalidated: { mod: string; seen: Set<string>; timestamp: number; isHmr: boolean }[] = [];
  const sent: { type: 'full-reload' }[] = [];
  const env: ReloadEnvironmentLike<string> = {
    name,
    moduleGraph: {
      invalidateModule: (mod, seen, timestamp, isHmr) => {
        invalidated.push({ mod, seen, timestamp, isHmr });
      },
    },
    hot: { send: (payload) => sent.push(payload) },
  };
  return { env, invalidated, sent };
}

describe('vite.renderer.reload —— hotUpdate 行为', () => {
  it('client：逐个失效、共用 seen 集合、isHmr 为 true；发送一次 full-reload；返回 []', () => {
    const { env, invalidated, sent } = environment('client');
    expect(fullReloadOnHotUpdate(env, ['/app/store.ts', '/components/Toolbar.tsx'], 123)).toEqual([]);
    expect(invalidated.map((call) => [call.mod, call.timestamp, call.isHmr])).toEqual([
      ['/app/store.ts', 123, true],
      ['/components/Toolbar.tsx', 123, true],
    ]);
    expect(invalidated[0]?.seen).toBe(invalidated[1]?.seen);
    expect(sent).toEqual([{ type: 'full-reload' }]);
  });

  it('client 且没有受影响模块：仍整页刷新', () => {
    const { env, sent } = environment('client');
    expect(fullReloadOnHotUpdate(env, [], 1)).toEqual([]);
    expect(sent).toEqual([{ type: 'full-reload' }]);
  });

  it('非 client 环境：不失效、不发送、返回 undefined（交给默认处理）', () => {
    const { env, invalidated, sent } = environment('ssr');
    expect(fullReloadOnHotUpdate(env, ['/x.ts'], 1)).toBeUndefined();
    expect(invalidated).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe('vite.renderer.reload —— 插件与配置', () => {
  it('插件名称固定，只在 serve 生效，提供 hotUpdate', () => {
    const plugin = rendererFullReload();
    expect(plugin.name).toBe(RENDERER_FULL_RELOAD_PLUGIN);
    expect(plugin.apply).toBe('serve');
    expect(plugin.hotUpdate).toBeTypeOf('function');
  });

  it('renderer 配置：CSP 插件第一、整页刷新插件第二、其后才是 React 插件', () => {
    const names = (rendererConfig.plugins ?? []).flat().map((plugin) => (typeof plugin === 'object' && plugin !== null && 'name' in plugin ? plugin.name : ''));
    expect(names.slice(0, 2)).toEqual(['muse-renderer-csp', RENDERER_FULL_RELOAD_PLUGIN]);
    expect(names.slice(2).some((name) => name.startsWith('vite:react'))).toBe(true);
  });
});
