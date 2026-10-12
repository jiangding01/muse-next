/**
 * Renderer 生产产物检查（M3 T1c-2，T1c Preflight r2 §9.5）。
 *
 * 用法：`npm run check:renderer-bundle`（= `tsx scripts/m3/rendererBundleCheck.ts`）；三平台 CI 都运行。
 *
 * 1. 在独立的系统 Node 子进程中按 `vite.renderer.config.ts` 做真实生产构建（`base: './'`，与 smoke 的生产 renderer 相同；
 *    tsx 的模块钩子会让 vite 内部解析失败，见 `electronIpcSmoke.ts`），用一个只读插件记录 Rollup 产物中每个 chunk 的
 *    `moduleIds`，输出到临时目录。
 * 2. `rendererBundleProblems` 按模块清单与产物文本判定：不含 iconv-lite / safer-buffer、浏览器外置的 Node builtin、格式层总入口、
 *    serializer、codec 入口与 main / preload 代码；格式层只出现 parse façade 及其解析闭包；生产 HTML 带 CSP 且无 unsafe 来源。
 *    同时要求关键模块确实在产物中（防止空构建假通过）。
 * main 侧合法使用的 iconv-lite 不受影响（只检查 renderer 产物）。
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export interface RendererBundleFacts {
  /** 产物 chunk 的模块 id（绝对路径或虚拟 id）。 */
  readonly moduleIds: readonly string[];
  readonly jsAssets: readonly { readonly name: string; readonly text: string }[];
  readonly indexHtml: string;
}

/** 产物中必须出现的模块（证明构建确实包含应用、Open 接线与 parse façade 闭包）。 */
const REQUIRED_MODULES = [
  'src/renderer/main.tsx',
  'src/renderer/app/store.ts',
  'src/renderer/app/editor/openController.ts',
  'src/formats/jcxParse.ts',
  'src/formats/jcx/loadJcx.ts',
];

/** 格式层中允许出现的模块：parse façade 与 `loadJcx` 的解析闭包（lexer / ast / parse / 解码）。 */
const ALLOWED_FORMATS = [/^src\/formats\/jcxParse\.ts$/, /^src\/formats\/jcx\/loadJcx\.ts$/, /^src\/formats\/jcx\/(lexer|ast|parse)\//, /^src\/formats\/jcx\/encoding\/(decodeJcx|types)\.ts$/];

const FORBIDDEN_MODULES: readonly (readonly [RegExp, string])[] = [
  [/(^|\/)node_modules\/iconv-lite\//, 'iconv-lite'],
  [/(^|\/)node_modules\/safer-buffer\//, 'safer-buffer'],
  [/__vite-browser-external/, 'externalized Node builtin'],
  [/^node:/, 'node: builtin'],
  [/^src\/(main|preload)\//, 'main / preload code'],
];

const FORBIDDEN_TEXT = ['iconv-lite', '__vite-browser-external', 'safer-buffer'];

/**
 * 模块 id → 仓库相对 posix 路径（去掉虚拟前缀与查询串）。Windows 上 vite 的 id 用正斜杠（`C:/…`），`resolve` 得到反斜杠，
 * 因此两边都统一成正斜杠后再比较，盘符大小写不敏感。
 */
export function normalizeModuleId(id: string, repoRoot: string): string {
  const clean = id.replace(/^\0/, '').replace(/\?.*$/, '').split(sep).join('/').replace(/\\/g, '/');
  const root = `${repoRoot.split(sep).join('/').replace(/\\/g, '/').replace(/\/$/, '')}/`;
  return clean.toLowerCase().startsWith(root.toLowerCase()) ? clean.slice(root.length) : clean;
}

export function rendererBundleProblems(facts: RendererBundleFacts, repoRoot: string, builtins: readonly string[] = builtinModules): string[] {
  const problems: string[] = [];
  const ids = facts.moduleIds.map((id) => normalizeModuleId(id, repoRoot));
  const present = new Set(ids);
  for (const required of REQUIRED_MODULES) if (!present.has(required)) problems.push(`required module missing: ${required}`);
  const builtinSet = new Set(builtins);
  for (const id of ids) {
    for (const [pattern, label] of FORBIDDEN_MODULES) if (pattern.test(id)) problems.push(`${label}: ${id}`);
    if (builtinSet.has(id)) problems.push(`Node builtin: ${id}`);
    if (id.startsWith('src/formats/') && !ALLOWED_FORMATS.some((pattern) => pattern.test(id))) problems.push(`formats module outside the parse façade closure: ${id}`);
  }
  if (facts.jsAssets.length === 0) problems.push('no JS assets');
  for (const asset of facts.jsAssets) {
    for (const text of FORBIDDEN_TEXT) if (asset.text.includes(text)) problems.push(`asset ${asset.name} contains "${text}"`);
  }
  if (!facts.indexHtml.includes('http-equiv="Content-Security-Policy"')) problems.push('index.html has no CSP meta');
  if (/unsafe-inline|unsafe-eval|ws:\/\//.test(facts.indexHtml)) problems.push('index.html CSP contains a development relaxation');
  return problems;
}

const REPO_ROOT = resolve(import.meta.dirname, '../..');

/** 子进程构建脚本：只读插件记录 chunk 的 moduleIds，写入 `modules.json`。 */
const BUILD_SCRIPT = [
  "import { build } from 'vite';",
  "import { writeFile } from 'node:fs/promises';",
  'const options = JSON.parse(process.env.MUSE_RENDERER_BUNDLE);',
  'const moduleIds = [];',
  "const collect = { name: 'muse-bundle-modules', generateBundle(_output, bundle) { for (const item of Object.values(bundle)) if (item.type === 'chunk') moduleIds.push(...item.moduleIds); } };",
  "await build({ configFile: options.configFile, root: options.root, base: './', mode: 'production', envDir: false, cacheDir: options.cacheDir, logLevel: 'warn',",
  '  plugins: [collect], build: { outDir: options.outDir, emptyOutDir: true, sourcemap: false } });',
  'await writeFile(options.modulesFile, JSON.stringify(moduleIds));',
].join('\n');

function runBuild(options: Record<string, string>): Promise<void> {
  return new Promise((done, fail) => {
    const env: NodeJS.ProcessEnv = { ...process.env, MUSE_RENDERER_BUNDLE: JSON.stringify(options) };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ['--input-type=module', '-e', BUILD_SCRIPT], { cwd: REPO_ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', fail);
    child.on('exit', (code, signal) => (code === 0 ? done() : fail(new Error(`renderer build failed: code=${String(code)} signal=${String(signal)}`))));
  });
}

async function main(): Promise<number> {
  const workDir = await mkdtemp(join(tmpdir(), 'muse-renderer-bundle-'));
  try {
    const outDir = join(workDir, 'out');
    const modulesFile = join(workDir, 'modules.json');
    await runBuild({ configFile: join(REPO_ROOT, 'vite.renderer.config.ts'), root: join(REPO_ROOT, 'src/renderer'), cacheDir: join(workDir, 'cache'), outDir, modulesFile });
    const parsed: unknown = JSON.parse(await readFile(modulesFile, 'utf8'));
    const moduleIds = Array.isArray(parsed) ? parsed.map((id) => String(id)) : [];
    const assetDir = join(outDir, 'assets');
    const jsAssets = await Promise.all(
      (await readdir(assetDir)).filter((name) => name.endsWith('.js')).map(async (name) => ({ name, text: await readFile(join(assetDir, name), 'utf8') })),
    );
    const indexHtml = await readFile(join(outDir, 'index.html'), 'utf8');
    const problems = rendererBundleProblems({ moduleIds, jsAssets, indexHtml }, REPO_ROOT);
    const formats = moduleIds.map((id) => normalizeModuleId(id, REPO_ROOT)).filter((id) => id.startsWith('src/formats/')).length;
    for (const problem of problems) process.stderr.write(`[renderer-bundle] FAIL: ${problem}\n`);
    console.log(`[renderer-bundle] modules=${String(moduleIds.length)} formats=${String(formats)} assets=${String(jsAssets.length)} problems=${String(problems.length)} verdict=${problems.length === 0 ? 'PASS' : 'FAIL'}`);
    return problems.length === 0 ? 0 : 1;
  } finally {
    await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`[renderer-bundle] ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
