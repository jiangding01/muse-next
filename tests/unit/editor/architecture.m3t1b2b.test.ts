/**
 * M3 T1b-2b-1 架构守卫（新建，不修改 m3t0 / m3t1b / m3t1b2 与任何历史守卫）。
 *
 * - smoke 复用生产实现：窗口登记与生命周期事件只经生产 `wireOpenIpcWindow`；协议只来自生产 `registerOpenIpc`（smoke 不注册任何
 *   IPC handler、不直接调用 handle 的生命周期方法）；页面身份来自生产 `resolvePageEntry`；真实对话框用与产品相同的选择器表达式。
 * - smoke 使用 runner 用 vite 打包的生产 preload 源码（不是 Forge 构建产物）；每个窗口都是 `sandbox: true` / `contextIsolation: true` / `nodeIntegration: false`；
 *   子 frame preload 只在显式的测试参数下打开。驱动不设 RunAsNode、不追加任何 Chromium 开关。
 * - 产品不含测试通道或测试白名单；旧 Open 通道已在 M3 T1c-2 删除（下方用例由「保留」迁移为「禁止复活」）。
 * - CI：独立 step 运行 smoke，Ubuntu 经 `xvfb-run -a`；既有 gate step 保留。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectTsFiles, parseImports, posixPath, REPO_ROOT, resolveSpecifier } from './staticAnalysis';

const SMOKE_DIR = join(REPO_ROOT, 'tests/electron/ipcSmoke');
const RUNNER = join(REPO_ROOT, 'scripts/m3/electronIpcSmoke.ts');
/** 统一换行：Windows 检出为 CRLF（CI run 38136213551），守卫一律按 LF 文本检查；其余字符不变。 */
const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');
const read = (file: string): string => normalizeEol(readFileSync(file, 'utf8'));
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (source: string, pattern: RegExp): number => source.match(pattern)?.length ?? 0;
const smokeFiles = collectTsFiles(SMOKE_DIR);
const smokeSource = (name: string): string => stripComments(read(join(SMOKE_DIR, name)));
const allSmoke = (): string => smokeFiles.map((file) => stripComments(read(file))).join('\n');

/** `casesIsolated.ts` 中每个独立用例的 `id=realDialog` 声明（输入可以是 LF 或 CRLF 原文）。 */
function realDialogDeclarations(raw: string): string[] {
  return [...normalizeEol(raw).matchAll(/id: '([\w.-]+)',\n\s+realDialog: (true|false),/g)].map((m) => `${m[1] ?? ''}=${m[2] ?? ''}`).sort();
}

const REAL_DIALOG_DECLARATIONS = [
  'identity.win-unc=false',
  'real.close-settles=true',
  'real.crash-keeps-dialog=true',
  'real.destroy-isolated=true',
  'real.reload-keeps-dialog=true',
  'risk.linux-force-crash-stall=false',
];

/** smoke 中唯一允许出现的 Open 生命周期事件名：崩溃诊断的只读监听（注册与移除各一处）。 */
const CRASH_DIAGNOSTIC_LISTENERS = [
  "contents.on('render-process-gone', onContentsGone)",
  "app.on('render-process-gone', onAppGone)",
  "contents.off('render-process-gone', onContentsGone)",
  "app.off('render-process-gone', onAppGone)",
];

const SELF_CHECK_PREFIX = 'SELF_CHECK="$(ELECTRON_RUN_AS_NODE=1 "${ELECTRON}" -e \'';

/** CI 工作流的结构检查；返回违反项（输入可以是 LF 或 CRLF 原文）。 */
function ciProblems(raw: string): string[] {
  const ci = normalizeEol(raw);
  const problems: string[] = [];
  const need = (label: string, ok: boolean): void => {
    if (!ok) problems.push(label);
  };
  for (const step of ['run: npm ci', 'run: npm run typecheck', 'run: npm test', 'run: npm run test:electron-codec', 'run: npm run jcx:fixture-report']) {
    need(`missing gate ${step}`, ci.includes(step));
  }
  need('matrix changed', ci.includes('os: [macos-latest, windows-latest, ubuntu-latest]'));
  need('fail-fast is not false', /strategy:\n(\s+#[^\n]*\n)*\s+fail-fast: false\n\s+matrix:\n/.test(ci));
  need('smoke step count', count(ci, /- name: Electron real-window IPC smoke \(M3 T1b-2b-1\)/g) === 2);
  need('Linux smoke step', /if: runner\.os == 'Linux'\n\s+run: xvfb-run -a npm run test:electron-ipc\n/.test(ci));
  need('non-Linux smoke step', /if: runner\.os != 'Linux'\n\s+run: npm run test:electron-ipc\n/.test(ci));
  need('smoke command count', count(ci, /test:electron-ipc/g) === 2);
  const typecheckAt = ci.indexOf('run: npm run typecheck:electron-ipc');
  const appArmorAt = ci.indexOf('- name: Allow user namespaces for the Electron binary via AppArmor');
  const linuxSmokeAt = ci.indexOf('run: xvfb-run -a npm run test:electron-ipc');
  need('runner typecheck before smoke', typecheckAt > 0 && typecheckAt < ci.indexOf('npm run test:electron-ipc'));
  need('AppArmor step before Linux smoke', appArmorAt > 0 && appArmorAt < linuxSmokeAt);
  need('AppArmor step is Linux-only', /- name: Allow user namespaces for the Electron binary via AppArmor[^\n]*\n\s+if: runner\.os == 'Linux'\n/.test(ci));
  // RunAsNode 只允许作为 AppArmor 进程标签自检这一条命令的前缀（不 export，不进入 smoke）。
  need('RunAsNode only in the self-check command', count(ci, /ELECTRON_RUN_AS_NODE/g) === 1 && count(ci, /SELF_CHECK="\$\(ELECTRON_RUN_AS_NODE=1 "\$\{ELECTRON\}" -e '/g) === 1);
  need('RunAsNode exported', !/export\s+ELECTRON_RUN_AS_NODE|env:\s*\n\s+ELECTRON_RUN_AS_NODE/.test(ci));
  need('self-check label must be the exact profile', ci.includes("LABEL_RE='^muse-next-electron-ci( \\([a-z]+\\))?$'"));
  need('self-check must compare exe', ci.includes('test "${SELF_EXE}" = "${ELECTRON}"'));
  need('self-check must require Electron', ci.includes('test -n "${SELF_VERSION}" ||'));
  need('self-check must apply the label pattern', ci.includes('[[ "${SELF_LABEL}" =~ ${LABEL_RE} ]] ||'));
  // 只读的 `sysctl -n` 允许；任何写入内核参数、改权限、停用 / 卸载 AppArmor 或吞掉失败的写法都报告。
  need(
    'forbidden system change',
    !/\bsysctl\s+(-w|--write|-p|--load|--system)\b|\bsysctl\s+[\w.]+=|\/proc\/sys\/|chmod|chown|aa-teardown|aa-disable|aa-complain|systemctl\s+(stop|disable)\s+apparmor|apparmor_parser\s+-R|continue-on-error/.test(ci),
  );
  return problems;
}

/** 某文件解析后的 `src/**` 导入（相对仓库路径）。 */
function srcImports(file: string): string[] {
  return parseImports(file, read(file)).flatMap((record) => {
    const resolved = resolveSpecifier(file, record.specifier);
    if (resolved === null || resolved === undefined) return [];
    const path = posixPath(resolved);
    return path.startsWith('src/') ? [path] : [];
  });
}

describe('M3 T1b-2b-1 架构守卫 —— smoke 复用生产实现', () => {
  it('扫到 smoke 的全部模块', () => {
    expect(smokeFiles.map(posixPath)).toEqual(
      [
        'casesCapability.ts',
        'casesDialog.ts',
        'casesEnvironment.ts',
        'casesIsolated.ts',
        'casesNavigation.ts',
        'casesSecurity.ts',
        'casesSender.ts',
        'casesUi.ts',
        'context.ts',
        'crashObservation.ts',
        'evidence.ts',
        'harness.ts',
        'ipcFaults.ts',
        'linuxExitExperiments.ts',
        'linuxProcessDiagnostics.ts',
        'replies.ts',
        'smokeMain.entry.ts',
        'windows.ts',
      ].map((name) => `tests/electron/ipcSmoke/${name}`),
    );
  });

  it('smoke 只从生产模块取得协议、接线、页面身份、选择器与只读 fs', () => {
    const imports = new Set(smokeFiles.flatMap(srcImports));
    for (const required of [
      'src/main/ipc/registerOpenIpc.ts',
      'src/main/ipc/wireOpenIpcWindow.ts',
      'src/main/ipc/pageIdentity.ts',
      'src/main/document/fileSystemPort.ts',
      'src/main/open/coordinatorInvariants.ts',
    ]) {
      expect(imports.has(required)).toBe(true);
    }
    // smoke 不得 import 产品 main 入口、preload 源码或 renderer（preload 由 runner 单独打包后经 webPreferences 加载）。
    expect([...imports].filter((path) => /^src\/(main\/main\.ts|preload\/|renderer\/)/.test(path))).toEqual([]);
  });

  it('registerOpenIpc 在 smoke 中恰好调用一次，且 ipc 是真实 ipcMain（仅经激活应答扣留包装）、页面身份来自 resolvePageEntry', () => {
    const entry = smokeSource('smokeMain.entry.ts');
    expect(count(allSmoke(), /registerOpenIpc\(/g)).toBe(1);
    // M3 T1c-2：真实 ipcMain 经 smoke 的激活应答扣留包装后交给生产 registerOpenIpc（包装器的透明性与使用范围由 tests/unit/scripts/ipcFaults.test.ts 钉住）。
    expect(entry).toContain('ipc: faults.registrar(ipcMain),');
    expect(entry).toContain('windowForSender: (sender) => BrowserWindow.fromWebContents(sender),');
    expect(entry).toContain('pageIdentity: entry.identity,');
    expect(entry).toMatch(/const entry = resolvePageEntry\(\{ devServerUrl: undefined, indexFilePath: config\.trustedPagePath/);
    expect(entry).toContain('createNodeReadOnlyFileSystem()');
  });

  it('真实原生对话框使用与产品 main 完全相同的选择器表达式', () => {
    const expression = 'createOpenPathChooser((parent: BrowserWindow, options) => dialog.showOpenDialog(parent, options))';
    expect(stripComments(read(join(REPO_ROOT, 'src/main/main.ts')))).toContain(expression);
    expect(smokeSource('smokeMain.entry.ts')).toContain(expression);
  });

  it('窗口事件只经生产 wireOpenIpcWindow：smoke 不登记 Open 生命周期事件、不直接调用 handle 的生命周期方法、不注册 IPC', () => {
    const source = allSmoke();
    expect(count(source, /wireOpenIpcWindow\(deps\.openIpc, win\)/g)).toBe(1);
    // 唯一例外：crashObservation.ts 的 watchRendererGone 只读监听 render-process-gone（诊断事件时间线，不调用任何 handle 方法）。
    const isolated = smokeSource('crashObservation.ts');
    for (const diagnostic of CRASH_DIAGNOSTIC_LISTENERS) {
      expect(count(source, new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))).toBe(1);
      expect(isolated).toContain(diagnostic);
    }
    const withoutDiagnostics = CRASH_DIAGNOSTIC_LISTENERS.reduce((text, diagnostic) => text.replace(diagnostic, ''), source);
    // 退出观测与 Linux 信号实验（含唯一的 SIGKILL 发送点）的约束见 architecture.m3t1b2b.exit.test.ts。
    expect(/['"`](did-start-navigation|did-navigate|render-process-gone|destroyed)['"`]/.test(withoutDiagnostics)).toBe(false);
    expect(/\.(attachWindow|handleNavigation|handleNavigationCommitted|handleRendererGone|disposeWindow)\s*\(/.test(source)).toBe(false);
    expect(/\[\s*['"`](attachWindow|handleNavigation|handleNavigationCommitted|handleRendererGone|disposeWindow)['"`]\s*\]/.test(source)).toBe(false);
    expect(/ipcMain\s*(\.|\[)|\.ipc\.(handle|on|once|handleOnce)\b|\.emit\(\s*['"`]muse:/.test(source.replace('ipc: faults.registrar(ipcMain),', ''))).toBe(false);
  });

  it('smoke 不自动确认：activate 只由页面经 window.museDesktop.activateDocument 发起', () => {
    const source = allSmoke();
    expect(/activateDocument\(\s*(state|ctx|deps)/.test(source)).toBe(false);
    // 协调器只允许取常量与类型，不允许 import 任何状态迁移函数（activateDocument / completeOpen / …）。
    const coordinatorValues = smokeFiles.flatMap((file) =>
      parseImports(file, read(file))
        .filter((record) => !record.typeOnly && posixPath(resolveSpecifier(file, record.specifier) ?? '') === 'src/main/open/openCoordinator.ts')
        .flatMap((record) => record.names),
    );
    expect(coordinatorValues).toEqual(['PENDING_TTL_MS']);
  });
});

describe('M3 T1b-2b-1 架构守卫 —— 用例构造', () => {
  it('真实原生对话框用例全部声明 realDialog: true（走与产品相同的选择器），其余独立用例不声明', () => {
    expect(realDialogDeclarations(smokeSource('casesIsolated.ts'))).toEqual(REAL_DIALOG_DECLARATIONS);
    expect(smokeSource('smokeMain.entry.ts')).toContain('chooseOpenPath: isolated?.realDialog === true ? realChooser : (parent) => chooser.choose(parent),');
  });

  it('protocol.handle 只用于独立分区 session（不得在默认 session 上拦截 file 伪装可信页面）', () => {
    const source = allSmoke();
    expect(count(source, /protocol\.handle\(/g)).toBe(1);
    expect(source).toContain("ses.protocol.handle('file',");
    expect(source).toContain('const ses = session.fromPartition(partition);');
    expect(/session\.defaultSession|(^|[^.\w])protocol\.(handle|register|intercept)/m.test(source)).toBe(false);
  });

  it('测试页面不自动激活、不发起 reject，只在 #early 时发起 Open', () => {
    const page = read(join(SMOKE_DIR, 'page.html'));
    expect(/activateDocument|rejectDocument|openScore|ipcRenderer|require\(/.test(page)).toBe(false);
    expect(count(page, /museDesktop\.openDocument\(\)/g)).toBe(1);
    expect(page).toContain("if (location.hash === '#early' && window.museDesktop) {");
  });
});

describe('M3 T1b-2b-1 架构守卫 —— 窗口与 sandbox', () => {
  it('smoke 只有一处 new BrowserWindow，使用生产 preload 产物与产品相同的安全偏好', () => {
    const source = allSmoke();
    expect(count(source, /new BrowserWindow\(/g)).toBe(1);
    const windows = smokeSource('windows.ts');
    for (const preference of ['preload: deps.preloadPath,', 'contextIsolation: true,', 'nodeIntegration: false,', 'sandbox: true,']) {
      expect(windows).toContain(preference);
    }
    expect(windows).toContain("...(options.subframePreload === true ? { nodeIntegrationInSubFrames: true } : {}),");
    expect(count(source, /nodeIntegrationInSubFrames:/g)).toBe(1);
    expect(/sandbox:\s*false|contextIsolation:\s*false|nodeIntegration:\s*true|webSecurity|allowRunningInsecureContent/.test(source)).toBe(false);
    // 安全偏好必须是字面量 true / false：任何其它写法（`!true`、变量、展开覆盖）都报告。
    const literal = /const webPreferences = \{([\s\S]*?)\n\s*\};/.exec(windows)?.[1] ?? '';
    expect(literal).toContain('preload: deps.preloadPath,');
    expect([...literal.matchAll(/\b(sandbox|contextIsolation|nodeIntegration):\s*([^,\n}]+)/g)].map((m) => `${m[1] ?? ''}:${(m[2] ?? '').trim()}`).sort()).toEqual([
      'contextIsolation:true',
      'nodeIntegration:false',
      'sandbox:true',
    ]);
  });

  it('不追加 Chromium 开关；关闭沙箱的开关名只出现在 evidence.ts 的只读检测中', () => {
    const source = allSmoke() + stripComments(read(RUNNER));
    expect(/appendSwitch|appendArgument|ELECTRON_DISABLE_SANDBOX|disable-sandbox/.test(source)).toBe(false);
    const offenders = smokeFiles.filter((file) => /no-sandbox/.test(stripComments(read(file)))).map(posixPath);
    expect(offenders).toEqual(['tests/electron/ipcSmoke/evidence.ts']);
    const evidence = smokeSource('evidence.ts');
    expect(count(evidence, /no-sandbox/g)).toBe(2);
    expect(evidence).toContain("app.commandLine.hasSwitch('no-sandbox')");
  });

  it('驱动：打包生产 preload；子进程不设 RunAsNode、只传入口一个参数', () => {
    const runner = stripComments(read(RUNNER));
    expect(runner).toContain("const PRELOAD_ENTRY = join(REPO_ROOT, 'src/preload/preload.ts');");
    expect(runner).toContain("bundle(PRELOAD_ENTRY, workDir, 'preload')");
    expect(runner).toContain('delete env.ELECTRON_RUN_AS_NODE;');
    expect(/ELECTRON_RUN_AS_NODE:\s*'1'/.test(runner)).toBe(false);
    expect(runner).toContain('spawn(binary, [mainBundle], {');
    expect(runner).toContain("rm(workDir, { recursive: true, force: true");
    expect(runner).toContain("mkdtemp(join(tmpdir(), 'muse-ipc-smoke-'))");
  });
});

describe('M3 T1b-2b-1 架构守卫 —— 产品隔离与 CI', () => {
  it('产品源码不含 smoke 通道、配置或测试白名单', () => {
    const offenders = collectTsFiles(join(REPO_ROOT, 'src')).filter((file) => /ipcSmoke|MUSE_IPC_SMOKE|smokeEarly|muse:smoke|test-only/i.test(read(file)));
    expect(offenders.map(posixPath)).toEqual([]);
  });

  it('旧 openScore 已在 M3 T1c-2 删除：IPC 常量恰为三条新通道，preload 与 main 中都没有旧入口', () => {
    const ipc = stripComments(read(join(REPO_ROOT, 'src/shared/ipc.ts')));
    expect(ipc).not.toContain('muse:open-score');
    expect([...ipc.matchAll(/^\s+(\w+): 'muse:[\w-]+',$/gm)].map((m) => m[1]).sort()).toEqual(['activateDocument', 'openDocument', 'rejectDocument']);
    expect(stripComments(read(join(REPO_ROOT, 'src/preload/preload.ts')))).not.toContain('openScore');
    const main = stripComments(read(join(REPO_ROOT, 'src/main/main.ts')));
    expect(main).not.toContain('openScore');
    expect(/ipcMain\.handle\(/.test(main)).toBe(false);
  });

  it('runner 类型检查配置只覆盖两个 runner 文件，且继承根 tsconfig', () => {
    const config: unknown = JSON.parse(read(join(REPO_ROOT, 'tsconfig.electron-ipc.json')));
    expect(config).toEqual({ extends: './tsconfig.json', include: ['scripts/m3/electronIpcSmoke.ts', 'scripts/m3/electronIpcSmokeSummary.ts'] });
  });

  it('package.json 的 smoke 脚本固定', () => {
    const pkg: unknown = JSON.parse(read(join(REPO_ROOT, 'package.json')));
    const scripts = typeof pkg === 'object' && pkg !== null && 'scripts' in pkg ? pkg.scripts : null;
    const script = typeof scripts === 'object' && scripts !== null && 'test:electron-ipc' in scripts ? scripts['test:electron-ipc'] : null;
    expect(script).toBe('tsx scripts/m3/electronIpcSmoke.ts');
    const typecheck = typeof scripts === 'object' && scripts !== null && 'typecheck:electron-ipc' in scripts ? scripts['typecheck:electron-ipc'] : null;
    expect(typecheck).toBe('tsc --noEmit -p tsconfig.electron-ipc.json');
  });

  it('CI：既有 gate 保留、fail-fast: false；runner 类型检查与 Linux AppArmor 自检在 smoke 之前；Ubuntu 经 xvfb-run -a', () => {
    expect(ciProblems(read(join(REPO_ROOT, '.github/workflows/ci.yml')))).toEqual([]);
  });
});

describe('M3 T1b-2b-1 架构守卫 —— LF / CRLF 等价（Windows 检出为 CRLF）', () => {
  const crlf = (text: string): string => text.replace(/\n/g, '\r\n');
  // 基准一律是经 `read` 归一化的 LF 文本（Windows 检出时原文已是 CRLF），再由 `crlf` 构造 CRLF 输入。
  const isolatedRaw = read(join(SMOKE_DIR, 'casesIsolated.ts'));
  const ciRaw = read(join(REPO_ROOT, '.github/workflows/ci.yml'));

  it('realDialog 声明：LF 与 CRLF 识别结果完全一致', () => {
    expect(realDialogDeclarations(crlf(isolatedRaw))).toEqual(REAL_DIALOG_DECLARATIONS);
    expect(realDialogDeclarations(isolatedRaw)).toEqual(REAL_DIALOG_DECLARATIONS);
  });

  it('CI 检查：LF 与 CRLF 结果一致（均无违反项）', () => {
    expect(ciProblems(crlf(ciRaw))).toEqual([]);
    expect(ciProblems(ciRaw)).toEqual([]);
  });

  it('反例（CRLF 下仍能检出）：删除 / 改值 realDialog 声明', () => {
    const removed = crlf(isolatedRaw.replace("  id: 'real.crash-keeps-dialog',\n  realDialog: true,\n", "  id: 'real.crash-keeps-dialog',\n"));
    expect(removed).not.toBe(crlf(isolatedRaw));
    expect(realDialogDeclarations(removed)).not.toEqual(REAL_DIALOG_DECLARATIONS);
    const flipped = crlf(isolatedRaw.replace("  id: 'real.close-settles',\n  realDialog: true,", "  id: 'real.close-settles',\n  realDialog: false,"));
    expect(flipped).not.toBe(crlf(isolatedRaw));
    expect(realDialogDeclarations(flipped)).toContain('real.close-settles=false');
  });

  it('反例（CRLF 下仍能检出）：CI 关键约束被改动', () => {
    const variants: [string, string, string][] = [
      ['run: xvfb-run -a npm run test:electron-ipc', 'run: npm run test:electron-ipc', 'Linux smoke step'],
      ['fail-fast: false', 'fail-fast: true', 'fail-fast is not false'],
      ["if: runner.os != 'Linux'\n        run: npm run test:electron-ipc", "if: runner.os != 'Linux'\n        run: npm run test:electron-ipc --if-present", 'non-Linux smoke step'],
      [SELF_CHECK_PREFIX, 'export ELECTRON_RUN_AS_NODE=1\n          SELF_CHECK="$("${ELECTRON}" -e \'', 'RunAsNode only in the self-check command'],
      ["LABEL_RE='^muse-next-electron-ci( \\([a-z]+\\))?$'", "LABEL_RE='^muse-next-electron-ci'", 'self-check label must be the exact profile'],
      ['test "${SELF_EXE}" = "${ELECTRON}"', 'true', 'self-check must compare exe'],
      ['test -n "${SELF_VERSION}" ||', 'true ||', 'self-check must require Electron'],
      ['[[ "${SELF_LABEL}" =~ ${LABEL_RE} ]] ||', 'true ||', 'self-check must apply the label pattern'],
    ];
    for (const injected of [
      'sudo sysctl -w kernel.x=0',
      'sudo sysctl kernel.apparmor_restrict_unprivileged_userns=0',
      'echo 0 | sudo tee /proc/sys/kernel/apparmor_restrict_unprivileged_userns',
      'sudo systemctl stop apparmor',
      'sudo apparmor_parser -R /etc/apparmor.d/x',
      'sudo chmod 4755 x',
    ]) {
      variants.push(['      - name: Allow user namespaces', `      - name: Injected\n        run: ${injected}\n      - name: Allow user namespaces`, 'forbidden system change']);
    }
    for (const [from, to, problem] of variants) {
      expect(ciRaw.includes(from)).toBe(true);
      expect(ciProblems(crlf(ciRaw.replace(from, to)))).toContain(problem);
    }
  });
});
