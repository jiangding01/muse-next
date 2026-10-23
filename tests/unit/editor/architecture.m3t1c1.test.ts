/**
 * M3 T1c-1 架构守卫（新建，不修改任何历史守卫的断言；T1c Preflight r2 §17.2 的六条防掩盖规则）。
 *
 * 1. 生产 `main.ts` 对每个 `BrowserWindow` 都在 `createWindow` 顶层无条件调用 `wireWindowSecurity`，且在加载页面之前；没有开关。
 * 2. smoke 窗口工厂默认调用**同一个**生产 `wireWindowSecurity`（从 `src/main/security/windowSecurity.ts` 导入）；smoke / scripts
 *    中没有它的副本，也不自己注册弹窗处理器或页面导航事件。
 * 3. 关闭安全接线的两个取值只出现在登记的两个测试页用例中（`reject.subframe`、`security.subframe-control`），产品源码不出现。
 * 4. 关闭安全接线的窗口不能加载生产 renderer；生产 renderer 用例恰为 `prod.*`，且与判定清单一致。
 * 5. 判定规则零改动：`electronIpcSmokeSummary.ts` 除 `SMOKE_CASES` 之外的内容哈希固定（与 T1b 基线相比只删除了已不再使用的
 *    `ALL_OBSERVE` 常量，scratchpad 核对）。
 * 6. 不存在 skip 或期望降级：T1b 的每个用例期望不变，唯一的改动是 `risk.subframe-parent-bridge` 由 observe 收紧为 pass。
 * 另：`src/main/security/**` 不 import electron；renderer 的 CSP 只经 vite 插件注入（单测见 `tests/unit/main/rendererCsp.test.ts`）。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isCallExpression, isExpressionStatement, isFunctionDeclaration, isIdentifier } from 'typescript';
import { describe, expect, it } from 'vitest';

import { SMOKE_CASES } from '../../../scripts/m3/electronIpcSmokeSummary';
import type { CaseSpec } from '../../../scripts/m3/electronIpcSmokeSummary';
import { collectTsFiles, parse, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (file: string): string => normalizeEol(readFileSync(file, 'utf8'));
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;

const MAIN = join(REPO_ROOT, 'src/main/main.ts');
const SECURITY = join(REPO_ROOT, 'src/main/security/windowSecurity.ts');
const SMOKE_DIR = join(REPO_ROOT, 'tests/electron/ipcSmoke');
const SUMMARY = join(REPO_ROOT, 'scripts/m3/electronIpcSmokeSummary.ts');
const RUNNER = join(REPO_ROOT, 'scripts/m3/electronIpcSmoke.ts');
const smokeFiles = collectTsFiles(SMOKE_DIR);
const smoke = (name: string): string => stripComments(read(join(SMOKE_DIR, name)));

/** `electronIpcSmokeSummary.ts` 去掉 `SMOKE_CASES` 数组后的内容哈希（LF）。 */
const JUDGE_HASH = 'fc23fc2adab632fa7880ce157c7d773e4381b2068bd5c7b6013c458250d5b8ed';

function judgeHash(raw: string): string {
  const text = normalizeEol(raw);
  const start = text.indexOf('export const SMOKE_CASES');
  const end = text.indexOf('];', start) + 2;
  return createHash('sha256').update(text.slice(0, start) + text.slice(end)).digest('hex');
}

/** `createWindow` 函数体中，顶层表达式语句里调用的函数名（按出现顺序）。 */
function topLevelCalls(source: string): string[] {
  const file = parse(MAIN, source);
  const fn = file.statements.find((statement) => isFunctionDeclaration(statement) && statement.name?.text === 'createWindow');
  if (fn === undefined || !isFunctionDeclaration(fn) || fn.body === undefined) return [];
  return fn.body.statements.flatMap((statement) => {
    if (!isExpressionStatement(statement)) return [];
    const call = isCallExpression(statement.expression) ? statement.expression : null;
    if (call === null) {
      // `void mainWindow.loadURL(...)`
      const text = statement.expression.getText(file);
      return text.startsWith('void mainWindow.loadURL(') ? ['mainWindow.loadURL'] : [];
    }
    return [isIdentifier(call.expression) ? call.expression.text : call.expression.getText(file)];
  });
}

const PASS = { darwin: 'pass', win32: 'pass', linux: 'pass' } as const;
const REAL_DIALOG = { darwin: 'pass', win32: 'observe', linux: 'observe' } as const;

/** T1b 封板时（`bb9231d`）每个用例的期望；本阶段只允许 `risk.subframe-parent-bridge` 由 observe 收紧为 pass。 */
const T1B_EXPECTATIONS: Readonly<Record<string, CaseSpec['expect']>> = {
  ...Object.fromEntries(
    [
      'env.runtime', 'env.sandbox', 'bridge.surface', 'bridge.no-auto-activate', 'identity.file-url', 'identity.query', 'identity.hash',
      'open.activate', 'open.wrong-document', 'open.activate-idempotent', 'open.reject', 'open.reject-after-activate', 'open.replace-active',
      'open.cancel-keeps-active', 'open.decode-failure-keeps-active', 'open.relative-path', 'open.chooser-throws', 'open.chooser-rejects',
      'open.fs-error-hidden', 'open.pipeline-throws', 'open.ttl-expiry', 'open.ttl-starts-at-registration', 'nav.reload-clears',
      'nav.same-document', 'nav.foreign-page', 'nav.race-start-commit', 'nav.early-ipc', 'crash.renderer-gone', 'close.disposes-owner',
      'reject.subframe', 'reject.unattached-window', 'reject.bad-payload', 'reject.cross-window-token', 'reject.forged-capability',
      'dialog.logical-busy', 'dialog.same-window-after-reload', 'dialog.cross-window', 'dialog.parent-window', 'dialog.orphaned', 'final.invariants',
    ].map((id) => [id, PASS]),
  ),
  'identity.win-drive': { win32: 'pass' },
  'identity.win-unc': { win32: 'pass-or-unverified' },
  'risk.subframe-parent-bridge': { darwin: 'observe', win32: 'observe', linux: 'observe' },
  'real.close-settles': REAL_DIALOG,
  'real.reload-keeps-dialog': REAL_DIALOG,
  'real.crash-keeps-dialog': REAL_DIALOG,
  'real.destroy-isolated': REAL_DIALOG,
  'risk.linux-force-crash-stall': { linux: 'observe' },
};

describe('M3 T1c-1 架构守卫 —— 生产 main 无条件接线', () => {
  const source = stripComments(read(MAIN));

  it('每个 BrowserWindow 都有一次 wireWindowSecurity；参数为窗口的 webContents 与 main 配置的页面身份', () => {
    // 整个 src/main 只有 main.ts 新建窗口（以后新增窗口必须同样接线并更新本守卫）。
    const creators = collectTsFiles(join(REPO_ROOT, 'src/main')).filter((file) => /new BrowserWindow\(/.test(stripComments(read(file))));
    expect(creators.map(posixPath)).toEqual(['src/main/main.ts']);
    expect(count(source, /new BrowserWindow\(/g)).toBe(1);
    expect(count(source, /wireWindowSecurity\(/g)).toBe(count(source, /new BrowserWindow\(/g));
    expect(source).toContain('wireWindowSecurity(mainWindow.webContents, pageEntry.identity, (block) => {');
    expect(source).toContain("import { wireWindowSecurity } from './security/windowSecurity';");
  });

  it('调用位于 createWindow 顶层（不在任何条件分支内），且早于 Open 接线与加载页面', () => {
    const calls = topLevelCalls(source);
    expect(calls).toContain('wireWindowSecurity');
    expect(calls.indexOf('wireWindowSecurity')).toBeLessThan(calls.indexOf('wireOpenIpcWindow'));
    expect(calls.indexOf('wireWindowSecurity')).toBeLessThan(calls.indexOf('mainWindow.loadURL'));
  });

  it('安全接线模块不 import electron，只依赖页面身份判定', () => {
    const imports = parseImports(SECURITY, read(SECURITY));
    expect(imports.map((record) => record.specifier)).toEqual(['../open/ipcValidation', '../open/ipcValidation']);
    expect(/from 'electron'/.test(read(SECURITY))).toBe(false);
  });

  it('产品源码不出现关闭安全接线的取值或开关', () => {
    const offenders = collectTsFiles(join(REPO_ROOT, 'src')).filter((file) => /off-for-(sender-check|control)|WindowSecurityMode|security:\s*'off/.test(read(file)));
    expect(offenders.map(posixPath)).toEqual([]);
  });
});

describe('M3 T1c-1 架构守卫 —— smoke 复用同一份安全接线', () => {
  it('窗口工厂从生产模块导入 wireWindowSecurity，默认 production 时调用它', () => {
    const windows = smoke('windows.ts');
    const imports = parseImports(join(SMOKE_DIR, 'windows.ts'), read(join(SMOKE_DIR, 'windows.ts')));
    const resolved = imports.filter((record) => record.names.includes('wireWindowSecurity')).map((record) => resolveSpecifier(join(SMOKE_DIR, 'windows.ts'), record.specifier));
    expect(resolved.map((path) => (typeof path === 'string' ? posixPath(path) : path))).toEqual(['src/main/security/windowSecurity.ts']);
    expect(windows).toContain("const security = options.security ?? 'production';");
    expect(windows).toContain("if (security === 'production') wireWindowSecurity(contents, deps.identity, (block) => deps.security.record(contents.id, block));");
    expect(count(windows, /wireWindowSecurity\(/g)).toBe(1);
  });

  it('smoke / scripts 中没有安全接线的副本：不定义同名函数、不自己注册弹窗处理器与页面导航拦截事件', () => {
    const files = [...smokeFiles, ...collectTsFiles(join(REPO_ROOT, 'scripts'))];
    for (const file of files) {
      const source = stripComments(read(file));
      expect(/function\s+wireWindowSecurity|wireWindowSecurity\s*=/.test(source), posixPath(file)).toBe(false);
      expect(/setWindowOpenHandler|\.(on|once|addListener|prependListener|prependOnceListener)\(\s*['"`]will-(navigate|frame-navigate|attach-webview)['"`]/.test(source), posixPath(file)).toBe(false);
    }
  });

  it('关闭安全接线的取值只出现在两个登记用例中（各一次），并且只在测试页上使用', () => {
    const all = smokeFiles.map((file) => ({ file: posixPath(file), source: stripComments(read(file)) }));
    const uses = all.flatMap(({ file, source }) => [...source.matchAll(/security: '(off-for-[\w-]+)'/g)].map((m) => `${file}:${m[1] ?? ''}`));
    expect(uses.sort()).toEqual([
      'tests/electron/ipcSmoke/casesSecurity.ts:off-for-control',
      'tests/electron/ipcSmoke/casesSender.ts:off-for-sender-check',
    ]);
    // 不论引号或写法：smoke 中 `off-for-` 字面量只有类型定义的两处与上面两个用例。
    const literals = all.flatMap(({ file, source }) => [...source.matchAll(/off-for-[\w-]+/g)].map((m) => `${file}:${m[0]}`));
    expect(literals.sort()).toEqual([
      'tests/electron/ipcSmoke/casesSecurity.ts:off-for-control',
      'tests/electron/ipcSmoke/casesSender.ts:off-for-sender-check',
      'tests/electron/ipcSmoke/windows.ts:off-for-control',
      'tests/electron/ipcSmoke/windows.ts:off-for-sender-check',
    ]);
    expect(smoke('casesSender.ts')).toContain("const window = await ctx.windows.create({ subframePreload: true, security: 'off-for-sender-check', url: `${ctx.entry.loadUrl}#frame` });");
    expect(smoke('casesSecurity.ts')).toContain("const window = await ctx.windows.create({ security: 'off-for-control', url: `${ctx.entry.loadUrl}#frame` });");
    expect(smoke('windows.ts')).toContain("if (security !== 'production' && deps.productionRenderer) throw new Error(");
  });

  it('关闭安全接线只跳过 wireWindowSecurity：Open 接线与 main 鉴权照常（wireOpenIpcWindow 不受 security 取值影响）', () => {
    const windows = smoke('windows.ts');
    expect(windows).toContain('const ownerId = options.wire === false ? win.webContents.id : wireOpenIpcWindow(deps.openIpc, win);');
    expect(/security[^\n]*wireOpenIpcWindow|wireOpenIpcWindow[^\n]*security/.test(windows)).toBe(false);
  });

  it('生产 renderer 用例恰为 prod.*：runner 按前缀切换可信页面，smoke main 按同一清单判定 productionRenderer', () => {
    const security = smoke('casesSecurity.ts');
    const declared = [...security.matchAll(/id: '(prod\.[\w-]+)'/g)].map((m) => m[1] ?? '');
    const listed = SMOKE_CASES.filter((spec) => spec.id.startsWith('prod.')).map((spec) => spec.id);
    expect(declared.sort()).toEqual([...listed].sort());
    for (const spec of SMOKE_CASES.filter((item) => item.id.startsWith('prod.'))) expect(spec.mode).toBe('isolated');
    expect(SMOKE_CASES.filter((spec) => spec.mode === 'matrix' && spec.id.startsWith('prod.'))).toEqual([]);
    const runner = stripComments(read(RUNNER));
    expect(runner).toContain("const PRODUCTION_MODE_PREFIX = 'prod.';");
    // M3 T1c-2 起 `ui.*`（生产 UI 用例）同样指向生产 renderer；`ui.win-unc` 经 UNC 路径。
    expect(runner).toContain('const production = mode.startsWith(PRODUCTION_MODE_PREFIX) || mode.startsWith(UI_MODE_PREFIX);');
    expect(runner).toContain("mode === 'ui.win-unc' ? uncPath(productionPage) : production ? productionPage : local");
    // M3 T3b（G11）：菜单 / 按键用例同样运行在生产 renderer 上。
    expect(smoke('smokeMain.entry.ts')).toContain('const productionRenderer = [...PRODUCTION_CASES, ...UI_CASES, ...EDITING_CASES].some((item) => item.id === config.mode);');
  });

  it('威胁对照与生产 renderer 用例都真正注册进 smoke（不能只留在清单里）', () => {
    const security = smoke('casesSecurity.ts');
    expect(security).toContain('export const SECURITY_MATRIX_CASES: readonly SmokeCase[] = [securitySubframeControl];');
    expect(security).toContain('[prodRendererLoads, prodPopupDenied, prodSubframeBlocked, prodInlineScriptBlocked, prodNavigationBlocked]');
    const entry = smoke('smokeMain.entry.ts');
    expect(entry).toContain('...SENDER_CASES, ...SECURITY_MATRIX_CASES, ...DIALOG_CASES]');
    expect(entry).toContain('const isolated = [...ISOLATED_CASES, ...PRODUCTION_CASES, ...UI_CASES, ...EDITING_CASES].find((item) => item.id === config.mode);');
  });
});

describe('M3 T1c-1 架构守卫 —— 判定不放宽', () => {
  it('判定规则零改动（除 SMOKE_CASES 之外的内容哈希固定）', () => {
    expect(judgeHash(read(SUMMARY))).toBe(JUDGE_HASH);
  });

  it('T1b 用例全部保留，期望不降级；唯一改动是 risk.subframe-parent-bridge 由 observe 收紧为 pass', () => {
    for (const [id, expectation] of Object.entries(T1B_EXPECTATIONS)) {
      const spec = SMOKE_CASES.find((item) => item.id === id);
      expect(spec, id).toBeDefined();
      if (id === 'risk.subframe-parent-bridge') expect(spec?.expect).toEqual(PASS);
      else expect(spec?.expect, id).toEqual(expectation);
    }
    const added = SMOKE_CASES.map((spec) => spec.id).filter((id) => !(id in T1B_EXPECTATIONS));
    expect(added).toEqual([
      'security.subframe-control',
      'prod.renderer-loads',
      'prod.popup-denied',
      'prod.subframe-blocked',
      'prod.inline-script-blocked',
      'prod.navigation-blocked',
      // M3 T1c-2：生产 UI 的真实 Open（ui.win-unc 与 identity.win-unc 相同，只在 Windows、允许 unverified）。
      'ui.open-commit',
      'ui.cancel-keeps',
      'ui.decode-failure-keeps',
      'ui.reload-isolation',
      'ui.staff-render',
      'ui.activation-held-retry',
      'ui.activation-unresolved',
      'ui.win-unc',
      // M3 T3b：菜单、快捷键与命令桥（全部平台 PASS）。
      'ui.menu-template',
      'ui.menu-click-dispatch',
      'ui.menu-routing',
      'ui.key-intercept',
      'ui.reload-keys-blocked',
    ]);
    for (const id of added) expect(SMOKE_CASES.find((spec) => spec.id === id)?.expect).toEqual(id === 'ui.win-unc' ? { win32: 'pass-or-unverified' } : PASS);
  });

  it('反例：判定器哈希对规则改动敏感', () => {
    const raw = read(SUMMARY);
    expect(judgeHash(raw.replace("if (item.status === 'skipped')", "if (item.status === 'skipped' && false)"))).not.toBe(JUDGE_HASH);
    expect(judgeHash(raw.replace("matrix('env.runtime'),", "matrix('env.runtime'),\n  matrix('env.extra'),"))).toBe(JUDGE_HASH);
  });
});
