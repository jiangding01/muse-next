/**
 * Linux renderer 崩溃诊断：`/proc` 只读快照、崩溃处理辅助进程扫描与 SIGKILL 前置校验（M3 T1b-2b-1 诊断专项）。
 *
 * - 不 import electron；`/proc` 读取经可注入的 `ProcReader`，解析与校验都是纯函数，可在普通 Node 单测。
 * - 只保留诊断需要的字段：可执行文件只记 basename，cmdline 只取 `--type=`；不读 environ，不输出完整 cmdline / 路径。
 * - 读取失败一律记为 unavailable，不当成通过；`killRefusals` 任一条件无法确认都拒绝发送信号。
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename } from 'node:path';

export interface ProcReader {
  /** 读取 `/proc` 下的文本文件；不存在或无权限时为 null。 */
  read(path: string): Promise<string | null>;
  /** `/proc` 下的数字目录（PID）；不可读时为 null。 */
  listPids(): Promise<number[] | null>;
}

export const nodeProcReader: ProcReader = {
  read: async (path) => {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  },
  listPids: async () => {
    try {
      return (await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number);
    } catch {
      return null;
    }
  },
};

export type StateLabel = 'running' | 'sleeping' | 'uninterruptible' | 'zombie' | 'stopped' | 'other' | 'unavailable';

export interface ProcessSnapshot {
  readonly pid: number;
  /** status 与 stat 都能读到。 */
  readonly available: boolean;
  /** stat 第 3 字段（如 `S`、`D`、`Z`）。 */
  readonly state: string | null;
  readonly stateLabel: StateLabel;
  readonly ppid: number | null;
  readonly tracerPid: number | null;
  readonly wchan: string | null;
  /** stat 第 22 字段（进程启动时刻，clock ticks），用于识别 PID 复用。 */
  readonly startTime: string | null;
  readonly argv0Name: string | null;
  /** cmdline 的 `--type=` 值（renderer / zygote / gpu-process / crashpad-handler …）。 */
  readonly processType: string | null;
}

export function stateLabel(state: string | null): StateLabel {
  switch (state) {
    case null:
      return 'unavailable';
    case 'R':
      return 'running';
    case 'S':
    case 'I':
      return 'sleeping';
    case 'D':
      return 'uninterruptible';
    case 'Z':
    case 'X':
      return 'zombie';
    case 'T':
    case 't':
      return 'stopped';
    default:
      return 'other';
  }
}

/** `/proc/<pid>/stat`：comm 可能含空格与括号，从最后一个 `)` 之后切分。 */
export function parseStat(stat: string): { readonly state: string; readonly startTime: string } | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 1).trim().split(/\s+/);
  const state = fields[0];
  const startTime = fields[19];
  if (state === undefined || startTime === undefined || !/^\d+$/.test(startTime)) return null;
  return { state, startTime };
}

export function parseStatusNumber(status: string, field: string): number | null {
  const value = new RegExp(`^${field}:\\s*(\\d+)\\s*$`, 'm').exec(status)?.[1];
  return value === undefined ? null : Number(value);
}

/**
 * cmdline 只取 argv0 的 basename 与 `--type=`。Chromium 在 Linux 上会改写进程标题，zygote 派生的 renderer 的 cmdline
 * 往往是**一整段以空格拼接**的字符串（而不是 NUL 分隔）；只有一段且含空格时按空格切分（与 psutil 的处理一致）。
 * 可执行文件路径本身含空格时切分会失败，结果只会是校验拒绝，不会误判。
 */
export function parseCmdline(cmdline: string): { readonly argv0Name: string | null; readonly processType: string | null } {
  const nulSplit = cmdline.split('\0').filter((arg) => arg !== '');
  const only = nulSplit.length === 1 ? nulSplit[0] : undefined;
  const args = only !== undefined && only.includes(' ') ? only.split(' ').filter((arg) => arg !== '') : nulSplit;
  const argv0 = args[0];
  const type = args.find((arg) => arg.startsWith('--type='));
  return { argv0Name: argv0 === undefined ? null : basename(argv0), processType: type === undefined ? null : type.slice('--type='.length) };
}

export async function snapshotProcess(reader: ProcReader, pid: number): Promise<ProcessSnapshot> {
  const [status, stat, wchan, cmdline] = await Promise.all([
    reader.read(`/proc/${String(pid)}/status`),
    reader.read(`/proc/${String(pid)}/stat`),
    reader.read(`/proc/${String(pid)}/wchan`),
    reader.read(`/proc/${String(pid)}/cmdline`),
  ]);
  const parsedStat = stat === null ? null : parseStat(stat);
  const command = cmdline === null ? { argv0Name: null, processType: null } : parseCmdline(cmdline);
  const state = parsedStat?.state ?? null;
  return {
    pid,
    available: status !== null && parsedStat !== null,
    state,
    stateLabel: stateLabel(state),
    ppid: status === null ? null : parseStatusNumber(status, 'PPid'),
    tracerPid: status === null ? null : parseStatusNumber(status, 'TracerPid'),
    wchan: wchan === null ? null : wchan.trim() === '' ? '0' : wchan.trim(),
    startTime: parsedStat?.startTime ?? null,
    ...command,
  };
}

/** 从 pid 沿 PPid 向上最多 `depth` 层的祖先 PID；任一层不可读则为 null（无法确认）。 */
export async function ancestorsOf(reader: ProcReader, pid: number, depth = 5): Promise<number[] | null> {
  const chain: number[] = [];
  let current = pid;
  for (let i = 0; i < depth; i += 1) {
    const status = await reader.read(`/proc/${String(current)}/status`);
    const parent = status === null ? null : parseStatusNumber(status, 'PPid');
    if (parent === null) return null;
    if (parent <= 1) break;
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function isCrashHelper(command: { readonly argv0Name: string | null; readonly processType: string | null }): boolean {
  return command.processType === 'crashpad-handler' || (command.argv0Name !== null && CRASH_HELPER.test(command.argv0Name));
}

export interface CrashHelper {
  readonly pid: number;
  readonly argv0Name: string | null;
  readonly processType: string | null;
  readonly stateLabel: StateLabel;
  readonly ppid: number | null;
  /** 祖先链中含 smoke 主进程。 */
  readonly underSmokeMain: boolean | null;
}

/** 只按可执行文件名或 `--type=crashpad-handler` 识别（每个 Electron 子进程的参数里都可能带 `--crashpad-handler-pid=`）。 */
const CRASH_HELPER = /crashpad|crash_handler|breakpad/i;
const MAX_HELPERS = 10;

/** 只扫描并记录崩溃处理相关进程（不终止任何进程）；`/proc` 不可列举时为 null。 */
export async function scanCrashHelpers(reader: ProcReader, mainPid: number): Promise<CrashHelper[] | null> {
  const pids = await reader.listPids();
  if (pids === null) return null;
  const helpers: CrashHelper[] = [];
  for (const pid of pids) {
    if (helpers.length >= MAX_HELPERS) break;
    const cmdline = await reader.read(`/proc/${String(pid)}/cmdline`);
    if (cmdline === null || !isCrashHelper(parseCmdline(cmdline))) continue;
    const snapshot = await snapshotProcess(reader, pid);
    const ancestors = await ancestorsOf(reader, pid);
    helpers.push({
      pid,
      argv0Name: snapshot.argv0Name,
      processType: snapshot.processType,
      stateLabel: snapshot.stateLabel,
      ppid: snapshot.ppid,
      underSmokeMain: ancestors === null ? null : ancestors.includes(mainPid),
    });
  }
  return helpers;
}

export interface KillPreconditions {
  readonly platform: string;
  /** 原始 forceCrash 观察窗口已结束。 */
  readonly observationEnded: boolean;
  /** 原始 forceCrash 结果已独立保存。 */
  readonly forceCrashRecorded: boolean;
  /** 观察窗口结束后、发送信号前，目标事件是否已经（迟到）到达。 */
  readonly eventAlreadyArrived: boolean;
  readonly pid: number;
  readonly mainPid: number;
  readonly mainExecutableName: string;
  /** 崩溃前采集的快照（经同一窗口的 `getOSProcessId()` 取得的 PID）。 */
  readonly before: ProcessSnapshot | null;
  readonly now: ProcessSnapshot;
  readonly ancestors: readonly number[] | null;
  /** 发送前同步检查：目标窗口仍存活。 */
  readonly windowAlive: boolean;
  /** 当前 `webContents.getOSProcessId()`。 */
  readonly currentWebContentsPid: number;
  /** 其它全部 webContents 的进程 PID。 */
  readonly otherWindowPids: readonly number[];
}

/** 读取失败（超时 / 不可读）时用于校验的快照：一律视为 unavailable。 */
export function unavailableSnapshot(pid: number): ProcessSnapshot {
  return { pid, available: false, state: null, stateLabel: 'unavailable', ppid: null, tracerPid: null, wchan: null, startTime: null, argv0Name: null, processType: null };
}

/** SIGKILL 的全部前置条件；返回拒绝原因，空数组才允许发送。 */
export function killRefusals(p: KillPreconditions): string[] {
  const refusals: string[] = [];
  const refuse = (reason: string, ok: boolean): void => {
    if (!ok) refusals.push(reason);
  };
  refuse('not linux', p.platform === 'linux');
  refuse('forceCrash observation not ended', p.observationEnded);
  refuse('forceCrash result not recorded', p.forceCrashRecorded);
  refuse('render-process-gone already arrived', !p.eventAlreadyArrived);
  refuse('pid is not a positive safe integer', Number.isSafeInteger(p.pid) && p.pid > 1);
  refuse('pid is the main process', p.pid !== p.mainPid);
  refuse('/proc snapshot unavailable', p.now.available);
  refuse('pre-crash identity unavailable', p.before !== null && p.before.startTime !== null);
  refuse('start time differs (pid reuse)', p.before !== null && p.before.startTime !== null && p.before.startTime === p.now.startTime);
  refuse('not a renderer process', p.now.processType === 'renderer');
  refuse('not the Electron executable', p.now.argv0Name === p.mainExecutableName);
  refuse('ancestry unavailable or not under the smoke main process', p.ancestors !== null && p.ancestors.includes(p.mainPid));
  refuse('window destroyed', p.windowAlive);
  refuse('webContents no longer reports this pid', p.currentWebContentsPid === p.pid);
  refuse('pid shared with another window', !p.otherWindowPids.includes(p.pid));
  refuse('process is a zombie or unavailable', p.now.stateLabel !== 'zombie' && p.now.stateLabel !== 'unavailable');
  return refusals;
}
