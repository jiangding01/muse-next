/**
 * smoke 用例的公共上下文、结果类型与状态观测（M3 T1b-2b-1）。
 *
 * 状态观测只读生产 handle 的诊断出口（`currentState` / `authorize` / `pendingNativeDialogs` / `orphanedNativeDialogs`），
 * 不改动协调器状态；一致性用生产 `coordinatorInvariantViolations` 判定。
 */

import type { BrowserWindow } from 'electron';

import type { PageEntry } from '../../../src/main/ipc/pageIdentity';
import type { OpenIpcHandle } from '../../../src/main/ipc/registerOpenIpc';
import { coordinatorInvariantViolations } from '../../../src/main/open/coordinatorInvariants';
import type { OwnerMeta } from '../../../src/main/open/openCoordinator';
import type { GatedFileSystem, ManualScheduler, ScriptedChooser, TestClock, TokenFaults } from './harness';
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
  /** 所有 fixture 所在目录（断言错误信息不泄露路径）。 */
  readonly dir: string;
}

export const UTF8_SOURCE = 'X:1\nT:smoke 中文\nK:C\nCDEF|\n';
export const SECOND_SOURCE = 'X:2\nT:second\nK:G\nGABc|\n';

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
}

export interface SmokeCase {
  readonly id: string;
  run(ctx: SmokeContext): Promise<CaseOutcome>;
}

/** 由问题列表与事实得出结论。 */
export function verdict(problems: readonly string[], facts?: Record<string, unknown>): CaseOutcome {
  const factText = facts === undefined ? '' : JSON.stringify(facts);
  if (problems.length > 0) return { status: 'failed', detail: [problems.join('; '), factText].filter((t) => t !== '').join(' | ') };
  return factText === '' ? { status: 'passed' } : { status: 'passed', detail: factText };
}

export function expectEqual(problems: string[], label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) problems.push(`${label}: expected ${e ?? 'undefined'}, got ${a ?? 'undefined'}`);
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
