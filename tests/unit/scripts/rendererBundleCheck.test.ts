/**
 * M3 T1c-2：renderer 生产产物检查的判定函数（`scripts/m3/rendererBundleCheck.ts`）。
 *
 * 合格产物通过；iconv-lite / safer-buffer、浏览器外置的 Node builtin、格式层总入口 / serializer / codec、main / preload 代码、
 * 产物文本中的残留、缺 CSP 或带开发放宽的 HTML、空构建（缺关键模块）都必须失败。
 */

import { describe, expect, it } from 'vitest';

import { normalizeModuleId, rendererBundleProblems } from '../../../scripts/m3/rendererBundleCheck';
import type { RendererBundleFacts } from '../../../scripts/m3/rendererBundleCheck';

const ROOT = '/repo';
const abs = (path: string): string => `${ROOT}/${path}`;
const GOOD_HTML = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; script-src &#39;self&#39;">';

function facts(patch: Partial<RendererBundleFacts> = {}): RendererBundleFacts {
  return {
    moduleIds: [
      'src/renderer/main.tsx',
      'src/renderer/app/store.ts',
      'src/renderer/app/editor/openController.ts',
      'src/formats/jcxParse.ts',
      'src/formats/jcx/loadJcx.ts',
      'src/formats/jcx/lexer/index.ts',
      'src/formats/jcx/ast/index.ts',
      'src/formats/jcx/parse/header.ts',
      'src/formats/jcx/encoding/decodeJcx.ts',
      'node_modules/react/index.js',
    ].map(abs),
    jsAssets: [{ name: 'index.js', text: 'console.log(1)' }],
    indexHtml: GOOD_HTML,
    ...patch,
  };
}

const withModule = (id: string): RendererBundleFacts => facts({ moduleIds: [...facts().moduleIds, id] });

describe('rendererBundleProblems', () => {
  it('合格产物通过', () => {
    expect(rendererBundleProblems(facts(), ROOT, ['fs', 'stream'])).toEqual([]);
  });

  it.each([
    [abs('node_modules/iconv-lite/lib/index.js'), 'iconv-lite: node_modules/iconv-lite/lib/index.js'],
    [abs('node_modules/safer-buffer/safer.js'), 'safer-buffer: node_modules/safer-buffer/safer.js'],
    ['\0__vite-browser-external:stream', 'externalized Node builtin: __vite-browser-external:stream'],
    ['node:fs', 'node: builtin: node:fs'],
    [abs('src/main/main.ts'), 'main / preload code: src/main/main.ts'],
    [abs('src/preload/preload.ts'), 'main / preload code: src/preload/preload.ts'],
    [abs('src/formats/jcx/index.ts'), 'formats module outside the parse façade closure: src/formats/jcx/index.ts'],
    [abs('src/formats/jcx/serialize/encodeJcx.ts'), 'formats module outside the parse façade closure: src/formats/jcx/serialize/encodeJcx.ts'],
    [abs('src/formats/jcx/codec.ts'), 'formats module outside the parse façade closure: src/formats/jcx/codec.ts'],
  ])('%s 被拒绝', (id, problem) => {
    expect(rendererBundleProblems(withModule(id), ROOT, ['fs', 'stream'])).toContain(problem);
  });

  it('裸 builtin 名字被拒绝', () => {
    expect(rendererBundleProblems(withModule('stream'), ROOT, ['fs', 'stream'])).toContain('Node builtin: stream');
  });

  it('产物文本残留、缺 CSP、开发放宽都被拒绝', () => {
    expect(rendererBundleProblems(facts({ jsAssets: [{ name: 'a.js', text: 'require("iconv-lite")' }] }), ROOT)).toContain('asset a.js contains "iconv-lite"');
    expect(rendererBundleProblems(facts({ indexHtml: '<title>x</title>' }), ROOT)).toContain('index.html has no CSP meta');
    expect(rendererBundleProblems(facts({ indexHtml: `${GOOD_HTML} &#39;unsafe-inline&#39;` }), ROOT)).toContain('index.html CSP contains a development relaxation');
  });

  it('空构建或缺关键模块不能通过', () => {
    const empty = rendererBundleProblems(facts({ moduleIds: [], jsAssets: [] }), ROOT);
    expect(empty).toContain('required module missing: src/renderer/main.tsx');
    expect(empty).toContain('required module missing: src/formats/jcxParse.ts');
    expect(empty).toContain('no JS assets');
  });

  it('模块 id 规范化：去虚拟前缀与查询串，仓库内路径转为相对 posix 路径', () => {
    expect(normalizeModuleId('\0/repo/src/a.ts?worker', ROOT)).toBe('src/a.ts');
    expect(normalizeModuleId('virtual:thing', ROOT)).toBe('virtual:thing');
    expect(normalizeModuleId('C:/Work/Repo/src/renderer/main.tsx', 'C:\\Work\\Repo')).toBe('src/renderer/main.tsx');
    expect(normalizeModuleId('c:/work/repo/src/a.ts', 'C:\\Work\\Repo')).toBe('src/a.ts');
  });
});
