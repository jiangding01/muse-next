import type { Plugin } from 'vite';

/**
 * 开发期整页刷新（M3 T3a；T3 Preflight r3 §7.4，外部审查 Vite 8 修订，SP-HMR-P 实测）。
 *
 * T3–T5 期间 renderer 的任何模块变更都改为整页刷新，不做局部热替换：store、解析调度、编辑控制器等模块级单例不会在
 * 页面内被重新执行而重建（实测：不加本插件时修改 `store.ts` 会热替换 5 个组件模块）。整页刷新在文档 dirty 或输入法
 * 组字中由同步 `beforeunload` 阻止，clean 时正常刷新。
 *
 * 使用 Vite 8 的 environment-aware `hotUpdate`：只处理 `client` 环境，逐个使模块失效、发送 `full-reload` 并返回 `[]`；
 * `apply: 'serve'` 保证生产构建不启用。`hot.decline()` 是空操作，不使用。
 */

export const RENDERER_FULL_RELOAD_PLUGIN = 'muse-renderer-full-reload';

/** `hotUpdate` 中用到的 environment 部分（结构类型，便于单测）。 */
export interface ReloadEnvironmentLike<M> {
  readonly name: string;
  readonly moduleGraph: { invalidateModule(mod: M, seen: Set<M>, timestamp: number, isHmr: boolean): void };
  readonly hot: { send(payload: { type: 'full-reload' }): void };
}

/**
 * client 环境：失效全部受影响模块并整页刷新，返回 `[]`（不做局部更新）；其它环境不处理。
 * 没有受影响模块（例如模块图之外的被监听文件）时也整页刷新——有意为之：宁可多刷新一次（dirty 时被 beforeunload 拦下），
 * 也不让任何变更绕过整页刷新。
 */
export function fullReloadOnHotUpdate<M>(environment: ReloadEnvironmentLike<M>, modules: readonly M[], timestamp: number): M[] | undefined {
  if (environment.name !== 'client') return undefined;
  const invalidated = new Set<M>();
  for (const mod of modules) environment.moduleGraph.invalidateModule(mod, invalidated, timestamp, true);
  environment.hot.send({ type: 'full-reload' });
  return [];
}

export function rendererFullReload(): Plugin {
  return {
    name: RENDERER_FULL_RELOAD_PLUGIN,
    apply: 'serve',
    hotUpdate({ modules, timestamp }) {
      return fullReloadOnHotUpdate(this.environment, modules, timestamp);
    },
  };
}
