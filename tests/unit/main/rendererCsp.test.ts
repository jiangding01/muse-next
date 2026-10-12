/**
 * M3 T1c-1：renderer CSP（`vite.renderer.csp.ts`）与注入它的 vite 插件。
 *
 * - production：只允许同源脚本 / 样式，禁止内联脚本、eval、插件对象、`<base>`、表单提交、子 frame 与 worker；
 * - development：只在 production 之上追加 React 刷新运行时与开发样式需要的 `'unsafe-inline'`、HMR 的本机 WebSocket；
 * - 插件按 vite command 选择策略（build → production，serve → development），以 meta 注入到 head 最前面。
 */

import { describe, expect, it } from 'vitest';
import type { HtmlTagDescriptor, Plugin, ResolvedConfig } from 'vite';

import rendererConfig from '../../../vite.renderer.config';
import { rendererCsp } from '../../../vite.renderer.csp';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(';').map((part) => {
      const [name = '', ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

const production = directives(rendererCsp('production'));
const development = directives(rendererCsp('development'));

describe('rendererCsp —— production', () => {
  it('指令与来源完整固定', () => {
    expect(Object.fromEntries(production)).toEqual({
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'font-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'object-src': ["'none'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-src': ["'none'"],
      'child-src': ["'none'"],
    });
  });

  it('不含任何 unsafe 来源、通配或远程来源', () => {
    const policy = rendererCsp('production');
    expect(/unsafe-|\*|https?:|wss?:|blob:/.test(policy)).toBe(false);
  });
});

describe('rendererCsp —— development', () => {
  it('只在 production 之上追加三处开发放宽，不删除任何限制', () => {
    const added: Record<string, string[]> = {};
    for (const [name, sources] of development) {
      const base = production.get(name);
      expect(base).toBeDefined();
      expect(sources.slice(0, base?.length)).toEqual(base);
      const extra = sources.slice(base?.length);
      if (extra.length > 0) added[name] = extra;
    }
    expect([...development.keys()]).toEqual([...production.keys()]);
    expect(added).toEqual({
      'script-src': ["'unsafe-inline'"],
      'style-src': ["'unsafe-inline'"],
      'connect-src': ['ws://localhost:*', 'ws://127.0.0.1:*'],
    });
  });

  it('开发放宽项不会出现在 production 策略中', () => {
    const policy = rendererCsp('production');
    for (const relaxed of ["'unsafe-inline'", 'ws://localhost:*', 'ws://127.0.0.1:*']) expect(policy.includes(relaxed)).toBe(false);
  });
});

function cspPlugin(): Plugin {
  const plugins = (rendererConfig.plugins ?? []).flat();
  const found = plugins.find((plugin): plugin is Plugin => typeof plugin === 'object' && plugin !== null && 'name' in plugin && plugin.name === 'muse-renderer-csp');
  if (found === undefined) throw new Error('muse-renderer-csp plugin missing');
  return found;
}

function injectedTags(command: ResolvedConfig['command']): HtmlTagDescriptor[] {
  const plugin = cspPlugin();
  const resolved = plugin.configResolved;
  const transform = plugin.transformIndexHtml;
  if (typeof resolved !== 'function' || typeof transform !== 'function') throw new Error('unexpected plugin hook shape');
  // 只读 command：插件不使用 ResolvedConfig 的其它字段。
  const config: Pick<ResolvedConfig, 'command'> = { command };
  Reflect.apply(resolved, undefined, [config]);
  const result: unknown = Reflect.apply(transform, undefined, ['<html></html>', {}]);
  if (!Array.isArray(result)) throw new Error('transformIndexHtml did not return tags');
  return result.filter((tag): tag is HtmlTagDescriptor => typeof tag === 'object' && tag !== null && 'tag' in tag);
}

describe('vite.renderer.config —— CSP 注入插件', () => {
  it('插件排在 react 插件之前，root 仍为 src/renderer', () => {
    const names = (rendererConfig.plugins ?? []).flat().map((plugin) => (typeof plugin === 'object' && plugin !== null && 'name' in plugin ? plugin.name : ''));
    expect(names[0]).toBe('muse-renderer-csp');
    expect(rendererConfig.root).toBe('src/renderer');
  });

  it.each([
    ['build', 'production'],
    ['serve', 'development'],
  ] as const)('command=%s 注入 %s 策略的 meta，位置为 head-prepend', (command, mode) => {
    expect(injectedTags(command)).toEqual([
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: rendererCsp(mode) }, injectTo: 'head-prepend' },
    ]);
  });
});
