/**
 * 运行环境与 sandbox 的运行时证据（M3 T1b-2b-1）。
 *
 * 创建窗口时传入的 webPreferences 只说明配置（Electron 44 的类型中没有 `getLastWebPreferences`），不足以证明渲染进程
 * 真的在 OS 沙箱里。这里另取平台实际证据：
 * - macOS / Windows：`app.getAppMetrics()` 中该渲染进程（按 `getOSProcessId()` 匹配）的 `sandboxed`；Windows 另记 `integrityLevel`；
 * - Linux：读 `/proc/<pid>/status` 的 `Seccomp`（2 = seccomp-bpf 过滤器，Chromium 渲染进程沙箱启用的标志）与 `NoNewPrivs`。
 * 同时记录命令行上是否存在关闭沙箱的开关，以及页面主世界是否拿得到 Node 的 `require` / `process`。
 */

import { readFile } from 'node:fs/promises';

import { app } from 'electron';
import type { BrowserWindow } from 'electron';

import { isRecord } from './replies';
import type { SmokeWindow } from './windows';

export interface RuntimeEvidence {
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly v8: string;
  readonly icu: string;
  readonly platform: string;
  readonly arch: string;
  /** 由 Electron 主进程（不是 ELECTRON_RUN_AS_NODE 下的 Node 模式）报告。 */
  readonly runAsNode: boolean;
}

export function runtimeEvidence(): RuntimeEvidence {
  return {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node,
    v8: process.versions.v8,
    icu: process.versions.icu ?? '',
    platform: process.platform,
    arch: process.arch,
    runAsNode: process.env.ELECTRON_RUN_AS_NODE !== undefined,
  };
}

export interface SandboxEvidence {
  readonly webPreferences: { readonly sandbox: boolean; readonly contextIsolation: boolean; readonly nodeIntegration: boolean };
  /** 平台实际证据：渲染进程是否在 OS 沙箱中；无法取得时为 null（判定器视为失败）。 */
  readonly rendererSandboxed: boolean | null;
  readonly method: string;
  readonly details: string;
  /** 命令行上是否出现关闭沙箱的开关（必须为 false）。 */
  readonly sandboxDisabledBySwitch: boolean;
  readonly pageHasRequire: boolean;
  readonly pageHasProcess: boolean;
}

async function linuxSeccomp(pid: number): Promise<{ sandboxed: boolean | null; details: string }> {
  try {
    const status = await readFile(`/proc/${String(pid)}/status`, 'utf8');
    const seccomp = /^Seccomp:\s*(\d+)/m.exec(status)?.[1] ?? 'missing';
    const noNewPrivs = /^NoNewPrivs:\s*(\d+)/m.exec(status)?.[1] ?? 'missing';
    return { sandboxed: seccomp === '2', details: `Seccomp=${seccomp} NoNewPrivs=${noNewPrivs}` };
  } catch (error) {
    return { sandboxed: null, details: `cannot read /proc status: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function metricsSandbox(pid: number): { sandboxed: boolean | null; details: string } {
  const metric = app.getAppMetrics().find((entry) => entry.pid === pid);
  if (metric === undefined) return { sandboxed: null, details: `pid ${String(pid)} not in getAppMetrics` };
  const integrity = metric.integrityLevel === undefined ? '' : ` integrityLevel=${metric.integrityLevel}`;
  return { sandboxed: metric.sandboxed ?? null, details: `type=${metric.type} sandboxed=${String(metric.sandboxed)}${integrity}` };
}

async function rendererSandbox(win: BrowserWindow): Promise<{ sandboxed: boolean | null; method: string; details: string }> {
  const pid = win.webContents.getOSProcessId();
  if (process.platform === 'linux') return { ...(await linuxSeccomp(pid)), method: 'linux:/proc/pid/status Seccomp' };
  return { ...metricsSandbox(pid), method: 'app.getAppMetrics().sandboxed' };
}

export async function sandboxEvidence(window: SmokeWindow): Promise<SandboxEvidence> {
  const renderer = await rendererSandbox(window.win);
  const globals = await window.call('({ require: typeof require !== "undefined", process: typeof process !== "undefined" })');
  const value = globals.ok && isRecord(globals.value) ? globals.value : null;
  return {
    webPreferences: { ...window.webPreferences },
    rendererSandboxed: renderer.sandboxed,
    method: renderer.method,
    details: renderer.details,
    sandboxDisabledBySwitch: app.commandLine.hasSwitch('no-sandbox') || process.argv.some((arg) => /^--no-sandbox\b/.test(arg)),
    // 取不到页面结果时按「有」处理（fail closed）。
    pageHasRequire: value === null || value.require !== false,
    pageHasProcess: value === null || value.process !== false,
  };
}

export function sandboxProblems(evidence: SandboxEvidence): string[] {
  const problems: string[] = [];
  if (!evidence.webPreferences.sandbox) problems.push('webPreferences.sandbox is not true');
  if (!evidence.webPreferences.contextIsolation) problems.push('webPreferences.contextIsolation is not true');
  if (evidence.webPreferences.nodeIntegration) problems.push('webPreferences.nodeIntegration is not false');
  if (evidence.rendererSandboxed !== true) problems.push(`renderer not proven sandboxed (${evidence.details})`);
  if (evidence.sandboxDisabledBySwitch) problems.push('sandbox-disabling switch present');
  if (evidence.pageHasRequire) problems.push('page main world has require');
  if (evidence.pageHasProcess) problems.push('page main world has process');
  return problems;
}
