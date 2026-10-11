/**
 * M3 T1b-2b-1 架构守卫：renderer 退出观测与 Linux 信号实验（自 architecture.m3t1b2b.test.ts 拆出，避免单文件超过 350 行）。
 *
 * - 观测函数（`crashAndObserve`）与 Linux 信号实验（`linuxSigkillExitGate` / `linuxPostKillDiagnosis` / `sendVerifiedSigkill`）只观测：
 *   不 reload / 加载 / 关闭 / 销毁窗口，openIpc 只读 authorize / currentState。
 * - forceCrash 全部 smoke 只在 `crashAndObserve` 中调用一次；Linux 硬门不调用 forceCrash，用途前置条件取真实记录。
 * - SIGKILL 全部 smoke 只此一处：`sendVerifiedSigkill` 中 `killRefusals` 全部通过的分支；不 sudo / killall / pkill / 按名称终止。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { collectTsFiles, REPO_ROOT } from './staticAnalysis';

const SMOKE_DIR = join(REPO_ROOT, 'tests/electron/ipcSmoke');
const normalizeEol = (text: string): string => text.replace(/\r\n/g, '\n');
const stripComments = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const count = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;
const smokeSource = (name: string): string => stripComments(normalizeEol(readFileSync(join(SMOKE_DIR, name), 'utf8')));

describe('M3 T1b-2b-1 架构守卫 —— renderer 退出观测与 Linux 信号实验', () => {
  it('只观测、forceCrash 唯一、SIGKILL 唯一且受前置校验约束', () => {
    const source = collectTsFiles(SMOKE_DIR)
      .map((file) => stripComments(normalizeEol(readFileSync(file, 'utf8'))))
      .join('\n');
    const observation = smokeSource('crashObservation.ts');
    // 只能观测：不得 reload / 加载 / 关闭 / 销毁窗口（会经导航重置掩盖吊销失效），openIpc 只读 authorize / currentState。
    const experiments = smokeSource('linuxExitExperiments.ts');
    const body = (file: string, name: string): string => new RegExp(`(export )?async function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(file)?.[0] ?? '';
    const observer = body(observation, 'crashAndObserve');
    const gate = body(experiments, 'linuxSigkillExitGate');
    const postKill = body(experiments, 'linuxPostKillDiagnosis');
    const sender = body(experiments, 'sendVerifiedSigkill');
    expect(observer).toContain('contents.forcefullyCrashRenderer();');
    for (const fn of [observer, gate, postKill, sender]) {
      expect(fn).not.toBe('');
      expect(/\.(reload|reloadIgnoringCache|loadURL|loadFile|close|destroy)\(|\bwindows\.|navigationHistory/.test(fn)).toBe(false);
    }
    for (const file of [observation, experiments]) {
      expect([...file.matchAll(/openIpc\.(\w+)/g)].map((m) => m[1]).every((name) => name === 'authorize' || name === 'currentState')).toBe(true);
    }
    // forceCrash 全部 smoke 只在 crashAndObserve 中调用一次；Linux 硬门不调用它（目标必须是新鲜、正常运行的 renderer）。
    expect(count(source, /\.forcefullyCrashRenderer\(/g)).toBe(1);
    expect(gate).not.toMatch(/forcefullyCrashRenderer|crashAndObserve/);
    expect(gate).toContain("{ kind: 'direct-exit-gate', forceCrashInvoked: false }");
    expect(postKill).toContain("observationEnded: crash.observationEnded, forceCrashRecorded: crash.forceCrashInvoked");
    // SIGKILL 全部 smoke 只此一处：sendVerifiedSigkill 中、killRefusals 全部通过的分支里；不得 sudo / killall / pkill / 按名称批量终止。
    expect(count(source, /SIGKILL/g)).toBe(1);
    expect(/const refusals = killRefusals\(\{[\s\S]*?if \(refusals\.length === 0\) \{[\s\S]*?process\.kill\(pid, 'SIGKILL'\);/.test(sender)).toBe(true);
    expect(gate).toContain('sendVerifiedSigkill(');
    expect(postKill).toContain('sendVerifiedSigkill(');
    expect(/\bsudo\b|killall|pkill|process\.kill\(\s*-/.test(source)).toBe(false);
    // 完整参数列表：只允许存活探测（信号 0）与唯一的 SIGKILL；数字信号（如 9）同样会被识别。
    expect([...source.matchAll(/process\.kill\(([^)]*)\)/g)].map((m) => (m[1] ?? '').trim()).sort()).toEqual(["pid, 'SIGKILL'", 'pid, 0']);
    // Linux 的 crash.renderer-gone 先走 SIGKILL 硬门并直接返回，不进入 forceCrash 观测。
    const navigation = smokeSource('casesNavigation.ts');
    const gateAt = navigation.indexOf("if (process.platform === 'linux') {\n      const gate = await linuxSigkillExitGate(");
    const gateReturnAt = navigation.indexOf("return verdict(problems, { trigger: 'os-sigkill', gate });");
    const forceCrashAt = navigation.indexOf('const crash = await crashAndObserve(ctx, window, ticket.capabilityId);');
    expect(gateAt).toBeGreaterThan(0);
    expect(gateAt < gateReturnAt && gateReturnAt < forceCrashAt).toBe(true);
  });
});
