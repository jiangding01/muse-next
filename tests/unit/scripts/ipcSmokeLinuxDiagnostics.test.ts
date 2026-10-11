/**
 * M3 T1b-2b-1 Linux 诊断专项：`/proc` 解析与 SIGKILL 前置校验的单元测试（假 `ProcReader`，不接触真实进程）。
 */

import { describe, expect, it } from 'vitest';

import {
  unavailableSnapshot,
  ancestorsOf,
  killRefusals,
  parseCmdline,
  parseStat,
  scanCrashHelpers,
  snapshotProcess,
  stateLabel,
} from '../../electron/ipcSmoke/linuxProcessDiagnostics';
import type { KillPreconditions, ProcessSnapshot, ProcReader } from '../../electron/ipcSmoke/linuxProcessDiagnostics';

const MAIN = 1000;
const ZYGOTE = 1100;
const RENDERER = 4169;

function stat(pid: number, comm: string, state: string, ppid: number, startTime: string): string {
  // 字段 3 = state，字段 22 = starttime；中间字段用占位数字填满。
  const middle = Array.from({ length: 17 }, (_, i) => String(i + 10)).join(' ');
  return `${String(pid)} (${comm}) ${state} ${String(ppid)} ${middle} ${startTime} 0 0`;
}

function status(ppid: number, tracer = 0): string {
  return `Name:\telectron\nState:\tS (sleeping)\nPPid:\t${String(ppid)}\nTracerPid:\t${String(tracer)}\n`;
}

/** 一个假的 /proc：主进程 → zygote → renderer，另有一个 crashpad handler。 */
function fakeProc(overrides: Record<string, string | null> = {}): ProcReader {
  const files: Record<string, string | null> = {
    [`/proc/${String(RENDERER)}/status`]: status(ZYGOTE),
    [`/proc/${String(RENDERER)}/stat`]: stat(RENDERER, 'electron (x)', 'S', ZYGOTE, '777'),
    [`/proc/${String(RENDERER)}/wchan`]: 'futex_wait_queue',
    [`/proc/${String(RENDERER)}/cmdline`]: '/home/runner/app/node_modules/electron/dist/electron --type=renderer --crashpad-handler-pid=2000 --secret-flag=/home/runner/x',
    [`/proc/${String(ZYGOTE)}/status`]: status(MAIN),
    [`/proc/${String(MAIN)}/status`]: status(1),
    '/proc/2000/cmdline': '/home/runner/app/node_modules/electron/dist/chrome_crashpad_handler\0--database=/tmp/x\0',
    '/proc/2000/status': status(MAIN),
    '/proc/2000/stat': stat(2000, 'chrome_crashpad', 'S', MAIN, '5'),
    ...overrides,
  };
  return {
    read: (path) => Promise.resolve(files[path] ?? null),
    listPids: () => Promise.resolve([MAIN, ZYGOTE, 2000, RENDERER]),
  };
}

describe('linuxProcessDiagnostics —— 解析', () => {
  it('stat：comm 含空格与括号时仍取对 state 与 starttime', () => {
    expect(parseStat(stat(1, 'a) (b', 'D', 0, '12345'))).toEqual({ state: 'D', startTime: '12345' });
    expect(parseStat('garbage')).toBeNull();
  });

  it('状态分类：运行 / 睡眠 / 不可中断 / 僵尸 / 停止 / 不可读', () => {
    expect(['R', 'S', 'D', 'Z', 'T', 'W', null].map(stateLabel)).toEqual(['running', 'sleeping', 'uninterruptible', 'zombie', 'stopped', 'other', 'unavailable']);
  });

  it('cmdline：Chromium 改写进程标题后的空格拼接格式同样只取 argv0 basename 与 --type', () => {
    const joined = '/home/runner/app/node_modules/electron/dist/electron --type=renderer --app-path=/home/runner/app/smoke --enable-crash-reporter=abc,linux --lang=en-US';
    const parsed = parseCmdline(joined);
    expect(parsed).toEqual({ argv0Name: 'electron', processType: 'renderer' });
    expect(parsed.argv0Name).not.toContain(' ');
    expect(JSON.stringify(parsed)).not.toMatch(/home|crash-reporter|lang/);
  });

  it('cmdline 只取 argv0 basename 与 --type（不输出路径与其它参数）', () => {
    const parsed = parseCmdline('/home/runner/app/electron\0--type=renderer\0--secret=/home/x\0');
    expect(parsed).toEqual({ argv0Name: 'electron', processType: 'renderer' });
    expect(JSON.stringify(parsed)).not.toContain('/home');
  });

  it('快照：可读时给出状态、PPid、TracerPid、wchan、启动时刻；不可读时为 unavailable 而不是通过', async () => {
    const ok = await snapshotProcess(fakeProc(), RENDERER);
    expect(ok).toMatchObject({ available: true, state: 'S', stateLabel: 'sleeping', ppid: ZYGOTE, tracerPid: 0, wchan: 'futex_wait_queue', startTime: '777', argv0Name: 'electron', processType: 'renderer' });
    expect(JSON.stringify(ok)).not.toContain('/home');
    const gone = await snapshotProcess(fakeProc({ [`/proc/${String(RENDERER)}/status`]: null, [`/proc/${String(RENDERER)}/stat`]: null }), RENDERER);
    expect(gone).toMatchObject({ available: false, stateLabel: 'unavailable', startTime: null });
  });

  it('祖先链：renderer → zygote → 主进程；任一层不可读即 null', async () => {
    expect(await ancestorsOf(fakeProc(), RENDERER)).toEqual([ZYGOTE, MAIN]);
    expect(await ancestorsOf(fakeProc({ [`/proc/${String(ZYGOTE)}/status`]: null }), RENDERER)).toBeNull();
  });

  it('崩溃辅助进程：只按可执行文件名 / --type 识别（带 --crashpad-handler-pid 的 renderer 不算），标出是否在 smoke 主进程之下；/proc 不可列举时为 null', async () => {
    const helpers = await scanCrashHelpers(fakeProc(), MAIN);
    expect(helpers).toEqual([{ pid: 2000, argv0Name: 'chrome_crashpad_handler', processType: null, stateLabel: 'sleeping', ppid: MAIN, underSmokeMain: true }]);
    const unlisted: ProcReader = { read: () => Promise.resolve(null), listPids: () => Promise.resolve(null) };
    expect(await scanCrashHelpers(unlisted, MAIN)).toBeNull();
  });
});

describe('linuxProcessDiagnostics —— SIGKILL 前置校验', () => {
  const snapshot = (patch: Partial<ProcessSnapshot> = {}): ProcessSnapshot => ({
    pid: RENDERER,
    available: true,
    state: 'S',
    stateLabel: 'sleeping',
    ppid: ZYGOTE,
    tracerPid: 0,
    wchan: 'futex_wait_queue',
    startTime: '777',
    argv0Name: 'electron',
    processType: 'renderer',
    ...patch,
  });
  const base: KillPreconditions = {
    platform: 'linux',
    purpose: { kind: 'post-force-crash-diagnostic', observationEnded: true, forceCrashRecorded: true },
    eventAlreadyArrived: false,
    pid: RENDERER,
    mainPid: MAIN,
    mainExecutableName: 'electron',
    before: snapshot(),
    now: snapshot(),
    ancestors: [ZYGOTE, MAIN],
    windowAlive: true,
    currentWebContentsPid: RENDERER,
    otherWindowPids: [5555],
  };

  it('读取失败时的快照一律 unavailable，会被拒绝', () => {
    expect(killRefusals({ ...base, now: unavailableSnapshot(RENDERER) })).toEqual(
      expect.arrayContaining(['/proc snapshot unavailable', 'process is a zombie or unavailable', 'not a renderer process']),
    );
  });

  const gate: KillPreconditions = { ...base, purpose: { kind: 'direct-exit-gate', forceCrashInvoked: false } };

  it('全部条件满足时允许发送（两种用途）', () => {
    expect(killRefusals(base)).toEqual([]);
    expect(killRefusals(gate)).toEqual([]);
  });

  it.each<[string, Partial<KillPreconditions>, string]>([
    ['硬门目标曾被 forceCrash', { purpose: { kind: 'direct-exit-gate', forceCrashInvoked: true } }, 'forceCrash was invoked on this renderer'],
    ['硬门目标停在 do_exit（半退出）', { now: snapshot({ state: 'I', stateLabel: 'sleeping', wchan: 'do_exit' }) }, 'renderer is not running normally'],
    ['硬门目标不可中断睡眠', { now: snapshot({ state: 'D', stateLabel: 'uninterruptible' }) }, 'renderer is not running normally'],
    ['硬门目标 wchan 读不到（无法确认不在退出路径）', { now: snapshot({ wchan: null }) }, 'renderer is not running normally'],
    ['硬门目标为僵尸', { now: snapshot({ state: 'Z', stateLabel: 'zombie' }) }, 'process is a zombie or unavailable'],
    ['硬门 PID 复用', { now: snapshot({ startTime: '999' }) }, 'start time differs (pid reuse)'],
    ['硬门目标为主进程', { pid: MAIN, currentWebContentsPid: MAIN }, 'pid is the main process'],
    ['硬门目标不是 renderer', { now: snapshot({ processType: 'utility' }) }, 'not a renderer process'],
  ])('direct-exit-gate：%s → 拒绝', (_label, patch, reason) => {
    expect(killRefusals({ ...gate, ...patch })).toContain(reason);
  });

  it('诊断用途不受「正常运行」限制（半退出的 renderer 正是诊断对象），但仍做全部身份校验', () => {
    expect(killRefusals({ ...base, now: snapshot({ state: 'I', wchan: 'do_exit' }) })).toEqual([]);
    expect(killRefusals({ ...base, now: snapshot({ state: 'I', wchan: 'do_exit', startTime: '999' }) })).toContain('start time differs (pid reuse)');
  });

  it.each<[string, Partial<KillPreconditions>, string]>([
    ['非 Linux', { platform: 'darwin' }, 'not linux'],
    ['观察窗口未结束', { purpose: { kind: 'post-force-crash-diagnostic', observationEnded: false, forceCrashRecorded: true } }, 'forceCrash observation not ended'],
    ['原始结果未保存', { purpose: { kind: 'post-force-crash-diagnostic', observationEnded: true, forceCrashRecorded: false } }, 'forceCrash result not recorded'],
    ['事件已迟到', { eventAlreadyArrived: true }, 'render-process-gone already arrived'],
    ['PID 为 0', { pid: 0 }, 'pid is not a positive safe integer'],
    ['PID 为 1（init）', { pid: 1 }, 'pid is not a positive safe integer'],
    ['PID 非整数', { pid: 4169.5 }, 'pid is not a positive safe integer'],
    ['PID 为主进程', { pid: MAIN, currentWebContentsPid: MAIN }, 'pid is the main process'],
    ['/proc 不可读', { now: snapshot({ available: false, stateLabel: 'unavailable', startTime: null }) }, '/proc snapshot unavailable'],
    ['基准身份缺失', { before: null }, 'baseline identity unavailable'],
    ['PID 复用（启动时刻不同）', { now: snapshot({ startTime: '999' }) }, 'start time differs (pid reuse)'],
    ['不是 renderer', { now: snapshot({ processType: 'gpu-process' }) }, 'not a renderer process'],
    ['不是 Electron 可执行文件', { now: snapshot({ argv0Name: 'bash' }) }, 'not the Electron executable'],
    ['祖先链不含 smoke 主进程', { ancestors: [ZYGOTE, 42] }, 'ancestry unavailable or not under the smoke main process'],
    ['祖先链不可读', { ancestors: null }, 'ancestry unavailable or not under the smoke main process'],
    ['窗口已销毁（例如用例超时后已被关闭）', { windowAlive: false }, 'window destroyed'],
    ['webContents 已不再报告该 PID', { currentWebContentsPid: 0 }, 'webContents no longer reports this pid'],
    ['与其它窗口共用 PID', { otherWindowPids: [RENDERER] }, 'pid shared with another window'],
    ['僵尸进程', { now: snapshot({ state: 'Z', stateLabel: 'zombie' }) }, 'process is a zombie or unavailable'],
  ])('%s → 拒绝', (_label, patch, reason) => {
    expect(killRefusals({ ...base, ...patch })).toContain(reason);
  });
});
