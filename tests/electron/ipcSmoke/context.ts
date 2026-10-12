/**
 * smoke 用例的公共上下文、结果类型与状态观测（M3 T1b-2b-1）。
 *
 * 状态观测只读生产 handle 的诊断出口（`currentState` / `authorize` / `pendingNativeDialogs` / `orphanedNativeDialogs`），
 * 不改动协调器状态；一致性用生产 `coordinatorInvariantViolations` 判定。
 * M3 T1c-1 增加：生产安全接线的拦截记录（`SecurityLog`），以及生产 renderer 用例的控制台记录与 CSP 消息分类。
 */

import { isDeepStrictEqual } from 'node:util';

import type { BrowserWindow } from 'electron';

import type { PageEntry } from '../../../src/main/ipc/pageIdentity';
import type { OpenIpcHandle } from '../../../src/main/ipc/registerOpenIpc';
import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
import type { OwnerMeta } from '../../../src/main/open/openCoordinator';
import type { WindowSecurityBlock } from '../../../src/main/security/windowSecurity';
import type { GatedFileSystem, ManualScheduler, ScriptedChooser, TestClock, TokenFaults } from './harness';
import type { ActivationFaults } from './ipcFaults';
import type { WindowFactory } from './windows';

/** 用例状态：`observed` 只记录事实、不是通过；`unverified` 只允许用于登记过的环境受限用例。 */
export type CaseStatus = 'passed' | 'failed' | 'observed' | 'unverified' | 'skipped';

export interface CaseResult {
  readonly id: string;
  readonly status: CaseStatus;
  readonly detail?: string;
}

export interface CaseOutcome {
  readonly status: Exclude<CaseStatus, 'skipped'>;
  readonly detail?: string;
}

export interface Fixtures {
  /** UTF-8 乐谱（内容见 `UTF8_SOURCE`）。 */
  readonly utf8: string;
  /** 第二份 UTF-8 乐谱，用于替换 active。 */
  readonly second: string;
  /** UTF-16 LE（带 BOM）：解码失败 `decode-utf16-unsupported`。 */
  readonly utf16: string;
  /** 含五线谱声部的自建乐谱（内容见 `STAFF_SOURCE`），用于生产 CSP 下的 VexFlow 渲染（M3 T1c-2）。 */
  readonly staff: string;
  /** 所有 fixture 所在目录（断言错误信息不泄露路径）。 */
  readonly dir: string;
}

export const UTF8_SOURCE = 'X:1\nT:smoke 中文\nK:C\nCDEF|\n';
export const SECOND_SOURCE = 'X:2\nT:second\nK:G\nGABc|\n';
/** 自建五线谱 fixture：14 个音符（4 + 4 + 三连音 3 + 2 + 1），另有一个简谱声部。 */
export const STAFF_SOURCE = [
  '%MUSE2',
  'X:1',
  'T:Staff smoke',
  'M:4/4',
  'L:1/8',
  'K:G',
  'V:1 name="Staff" style=staff ins=0 vol=64',
  'V:2 name="Jianpu" style=jianpu play=1 instrument=0 volumn=64',
  '[V:1]',
  'G2 A2 B2 d2 | c2 B2 A2 G2 | (3GAB c4 d2- | d8 |]',
  '[V:2]',
  'G2 A2 B2 d2 | c2 B2 A2 G2 | G2 A2 B2 c2 | d8 |]',
  '',
].join('\n');
export const STAFF_NOTE_COUNT = 14;

export interface SmokeContext {
  readonly openIpc: OpenIpcHandle<BrowserWindow>;
  readonly chooser: ScriptedChooser<BrowserWindow>;
  readonly fs: GatedFileSystem;
  readonly clock: TestClock;
  readonly scheduler: ManualScheduler;
  readonly tokenFaults: TokenFaults;
  readonly windows: WindowFactory;
  /** 可信页面（main 配置）的加载地址与身份。 */
  readonly entry: PageEntry;
  /** 不可信页面（同目录的另一个文件）的 file URL。 */
  readonly foreignUrl: string;
  readonly fixtures: Fixtures;
  /** 可信页面路径中实际包含的特殊字符（平台相关：Windows 文件名不能含 `?`）。 */
  readonly pathChars: readonly string[];
  /** 驱动传入的可信页面原始路径（Windows 上盘符为小写，用于盘符规范化用例）。 */
  readonly trustedPagePath: string;
  /** 生产安全接线（`wireWindowSecurity`）的拦截记录（M3 T1c-1）。 */
  readonly security: SecurityLog;
  /** 激活应答扣留（M3 T1c-2，只在 smoke harness）。 */
  readonly faults: ActivationFaults;
}

/** 一次拦截及其发生时该窗口的页面代次（用于判断 `did-start-navigation` 是否先于拦截发生）。 */
export interface SecurityRecord extends WindowSecurityBlock {
  readonly ownerId: number;
  /** 拦截回调触发时协调器中该 owner 的 generation；未登记的窗口为 null。 */
  readonly generationAtBlock: number | null;
}

export interface SecurityLog {
  record(ownerId: number, block: WindowSecurityBlock): void;
  events(ownerId: number): readonly SecurityRecord[];
}

/** 拦截记录：只读协调器状态取 generation，不改动任何状态。 */
export function createSecurityLog(generationOf: (ownerId: number) => number | null): SecurityLog {
  const records: SecurityRecord[] = [];
  return {
    record: (ownerId, block) => {
      records.push({ ...block, ownerId, generationAtBlock: generationOf(ownerId) });
    },
    events: (ownerId) => records.filter((item) => item.ownerId === ownerId),
  };
}

export interface SmokeCase {
  readonly id: string;
  /** 该用例的总时间预算（毫秒）；未设置时用 `smokeMain.entry.ts` 的默认值。只给需要更长观察窗口的用例（renderer 崩溃）设置。 */
  readonly timeoutMs?: number;
  run(ctx: SmokeContext): Promise<CaseOutcome>;
}

/** 由问题列表与事实得出结论。 */
export function verdict(problems: readonly string[], facts?: Record<string, unknown>): CaseOutcome {
  const factText = facts === undefined ? '' : JSON.stringify(facts);
  if (problems.length > 0) return { status: 'failed', detail: [problems.join('; '), factText].filter((t) => t !== '').join(' | ') };
  return factText === '' ? { status: 'passed' } : { status: 'passed', detail: factText };
}

/** 失败信息中不输出的字段：能力 token、本地路径与内容指纹。 */
const REDACTED_KEYS: ReadonlySet<string> = new Set(['token', 'capabilityId', 'realpath', 'displayPath', 'lastKnownDiskFingerprint']);
const MAX_DESCRIBED_LENGTH = 300;

/**
 * 只用于失败信息的安全格式化：BigInt 写成 `123n`，敏感字段脱敏，超长截断；格式化本身出错时退回到类型描述，
 * 不抛出、不影响断言结论。
 */
export function describeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value, (key, item: unknown) => {
      if (typeof item === 'bigint') return `${item.toString()}n`;
      if (REDACTED_KEYS.has(key)) return '<redacted>';
      return item;
    });
    const described = text === undefined ? String(value) : text;
    return described.length > MAX_DESCRIBED_LENGTH ? `${described.slice(0, MAX_DESCRIBED_LENGTH)}…` : described;
  } catch {
    return `<unprintable ${typeof value}>`;
  }
}

/** 深度严格相等（`util.isDeepStrictEqual`，支持 BigInt）；只在不相等时格式化失败信息。 */
export function expectEqual(problems: string[], label: string, actual: unknown, expected: unknown): void {
  if (isDeepStrictEqual(actual, expected)) return;
  problems.push(`${label}: expected ${describeValue(expected)}, got ${describeValue(actual)}`);
}

export function expectTrue(problems: string[], label: string, condition: boolean): void {
  if (!condition) problems.push(label);
}

export interface CapabilityView {
  readonly token: string;
  readonly state: string;
  readonly documentId: number;
}

/** 某窗口当前的能力记录（token / 状态 / documentId）。 */
export function capabilitiesOf(ctx: SmokeContext, ownerId: number): CapabilityView[] {
  return [...ctx.openIpc.currentState().table.values()]
    .filter((record) => record.ownerId === ownerId)
    .map((record) => ({ token: record.token, state: record.state, documentId: record.documentId }));
}

export function ownerMeta(ctx: SmokeContext, ownerId: number): OwnerMeta | undefined {
  return ctx.openIpc.currentState().owners.get(ownerId);
}

export function invariantProblems(ctx: SmokeContext): string[] {
  return coordinatorInvariantViolations(ctx.openIpc.currentState()).map((v) => `invariant: ${v}`);
}

/** 用例收尾检查：窗口全部关闭后，状态必须一致、无残留能力 / owner / 原生对话框 / 脚本 / 读取闸门。 */
export function residueProblems(ctx: SmokeContext): string[] {
  const state = ctx.openIpc.currentState();
  const problems = invariantProblems(ctx);
  if (state.table.size !== 0) problems.push(`residue: ${String(state.table.size)} capabilities left`);
  if (state.owners.size !== 0) problems.push(`residue: ${String(state.owners.size)} owners left`);
  if (ctx.openIpc.pendingNativeDialogs() !== 0) problems.push(`residue: ${String(ctx.openIpc.pendingNativeDialogs())} unsettled choosers`);
  if (ctx.chooser.remaining() !== 0) problems.push(`residue: ${String(ctx.chooser.remaining())} unused chooser steps`);
  if (ctx.fs.hasPendingGate()) problems.push('residue: read gate or injected fs fault left');
  if (ctx.tokenFaults.pending() !== 0) problems.push('residue: injected token fault left');
  return problems;
}

/** 文本里是否出现本次运行的任何本地路径片段（错误信息不得泄露路径）。 */
export function leaksPath(ctx: SmokeContext, text: string): boolean {
  return text.includes(ctx.fixtures.dir) || text.includes(ctx.trustedPagePath) || /[\\/](tmp|var|Users|home)[\\/]/i.test(text);
}

export interface ConsoleEntry {
  readonly level: string;
  readonly message: string;
}

/** 在加载页面之前挂上的控制台记录（只读，M3 T1c-1 生产 renderer 用例）。 */
export function consoleRecorder(): { readonly entries: ConsoleEntry[]; readonly attach: (win: BrowserWindow) => void } {
  const entries: ConsoleEntry[] = [];
  return {
    entries,
    attach: (win) => {
      win.webContents.on('console-message', (event) => {
        entries.push({ level: event.level, message: event.message });
      });
    },
  };
}

const CSP_REFUSAL = /Content Security Policy/i;

/** CSP 拒绝消息中被违反的指令（`directive` 之后第一个引号内的指令名；Chromium 用单引号或双引号）。 */
function violatedDirective(message: string): string {
  return /directive:?\s*["']([a-z-]+)/i.exec(message)?.[1] ?? 'unknown';
}

export interface ConsoleClassification {
  readonly expected: readonly string[];
  readonly unexpected: readonly string[];
}

/**
 * 预期的策略拒绝：CSP 拒绝且指令在 `expectedDirectives` 中，或命中 `expectedPatterns`（例如 Chromium 对顶层 data: 导航的拒绝）。
 * 其余 error 级消息、任何其它 CSP 拒绝、资源加载失败与 Electron 安全警告都是非预期。
 */
export function classifyConsole(entries: readonly ConsoleEntry[], expectedDirectives: readonly string[], expectedPatterns: readonly RegExp[] = []): ConsoleClassification {
  const expected: string[] = [];
  const unexpected: string[] = [];
  for (const entry of entries) {
    const text = `${entry.level}: ${entry.message.slice(0, 240)}`;
    if (CSP_REFUSAL.test(entry.message)) {
      const directive = violatedDirective(entry.message);
      if (expectedDirectives.some((name) => directive.startsWith(name))) expected.push(`csp:${directive}`);
      else unexpected.push(text);
    } else if (expectedPatterns.some((pattern) => pattern.test(entry.message))) {
      expected.push(`refusal:${entry.message.slice(0, 80)}`);
    } else if (entry.level === 'error' || /Failed to load resource|Electron Security Warning/i.test(entry.message)) {
      unexpected.push(text);
    }
  }
  return { expected, unexpected };
}
