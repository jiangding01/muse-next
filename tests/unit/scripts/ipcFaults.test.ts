/**
 * M3 T1c-2：smoke 激活应答扣留（`tests/electron/ipcSmoke/ipcFaults.ts`）的透明性。
 *
 * - 非 activate / reject 通道原样交给内部 registrar（同一个函数对象）。
 * - activate：未布置扣留时，生产 handler 以相同参数执行、结果原样返回；布置扣留时 handler 照常执行（main 状态真实改变），
 *   应答换成永不 settle 的 Promise；抛错原样传播且不消耗扣留。
 * - 交给生产 `registerOpenIpc`：open / 保存通道未被包装；activate 与 reject 被包装（M3 T4 B3a-1 STOP 裁决方案 A）。
 * - reject：未布置故障时参数、结果对象与异常完全透明；`hold`（执行但扣留应答）与 `swallow`（不执行并吞没）可区分。
 * - 静态：只有 smoke main 经它包装 ipcMain（一次），只有生产 UI 用例（casesUi）布置扣留与 reject 故障；它不 import electron。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createActivationFaults } from '../../electron/ipcSmoke/ipcFaults';
import { registerOpenIpc } from '../../../src/main/ipc/registerOpenIpc';
import type { InvokeEventLike, IpcRegistrarLike, SenderLike } from '../../../src/main/ipc/registerOpenIpc';
import { IPC } from '../../../src/shared/ipc';
import { collectTsFiles, posixPath, REPO_ROOT } from '../editor/staticAnalysis';
import { createFakeFileSystem } from '../main/fakeFileSystem';
import { rejectingWriteFs } from '../main/openIpcHarness';

type Listener = (event: InvokeEventLike<SenderLike>, payload: unknown) => unknown;

function innerRegistrar(): { readonly registrar: IpcRegistrarLike<SenderLike>; readonly handlers: Map<string, Listener> } {
  const handlers = new Map<string, Listener>();
  return { registrar: { handle: (channel, listener) => handlers.set(channel, listener) }, handlers };
}

const EVENT: InvokeEventLike<SenderLike> = { sender: { id: 1, isDestroyed: () => false, mainFrame: { url: 'file:///a' } }, senderFrame: { url: 'file:///a' } };

describe('createActivationFaults', () => {
  it('非 activate 通道原样转交；activate 未布置扣留时完全透明', () => {
    const faults = createActivationFaults();
    const { registrar, handlers } = innerRegistrar();
    const wrapped = faults.registrar(registrar);
    const calls: unknown[][] = [];
    const open: Listener = () => 'open-result';
    wrapped.handle(IPC.openDocument, open);
    // 生产 handler 的结果用一个有辨识度的对象：包装器必须原样返回同一个对象，不能替换成别的结果。
    const result = { ok: false, code: 'document-mismatch' };
    wrapped.handle(IPC.activateDocument, (event, payload) => {
      calls.push([event, payload]);
      return result;
    });
    expect(handlers.get(IPC.openDocument)).toBe(open);
    const payload = { capabilityId: 'c', documentId: 1 };
    expect(handlers.get(IPC.activateDocument)?.(EVENT, payload)).toBe(result);
    expect(calls).toEqual([[EVENT, payload]]);
    expect(faults.records()).toEqual([{ call: 1, held: false, payload, result }]);
  });

  it('布置扣留：handler 照常执行，应答永不 settle；之后恢复透明；抛错原样传播且不消耗扣留', async () => {
    const faults = createActivationFaults();
    const { registrar, handlers } = innerRegistrar();
    let executed = 0;
    let fail = false;
    faults.registrar(registrar).handle(IPC.activateDocument, () => {
      executed += 1;
      if (fail) throw new Error('Request rejected');
      return { ok: true };
    });
    const activate = handlers.get(IPC.activateDocument);
    if (activate === undefined) throw new Error('not registered');
    faults.holdNextActivations(1);
    fail = true;
    expect(() => activate(EVENT, {})).toThrow('Request rejected');
    fail = false;
    const held = activate(EVENT, {});
    expect(executed).toBe(2);
    expect(held).toBeInstanceOf(Promise);
    const settled = await Promise.race([Promise.resolve(held).then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('pending'), 20))]);
    expect(settled).toBe('pending');
    expect(activate(EVENT, {})).toEqual({ ok: true });
    expect(faults.records().map((r) => r.held)).toEqual([false, true, false]);
    faults.holdNextActivations(2);
    faults.reset();
    expect(activate(EVENT, {})).toEqual({ ok: true });
    expect(faults.records()).toHaveLength(1);
  });

  it('包装后交给生产 registerOpenIpc：恰好注册 5 个通道，open / 保存的 listener 与未包装时逐字相同；activate 与 reject 被包装（M3 T4 B3a-1：reject 应答扣留 / 吞没）', () => {
    const register = (wrap: boolean): Map<string, Listener> => {
      const { registrar, handlers } = innerRegistrar();
      registerOpenIpc<SenderLike, null>({
        ipc: wrap ? createActivationFaults().registrar(registrar) : registrar,
        windowForSender: () => null,
        pageIdentity: { kind: 'file', url: 'file:///a' },
        chooseOpenPath: () => Promise.resolve(null),
        fs: createFakeFileSystem({}),
        platform: 'linux',
        now: () => 0,
        issueToken: () => 't',
        schedule: () => undefined,
        chooseSavePath: () => Promise.resolve(null),
        writeFs: rejectingWriteFs(),
        tempName: () => 'tmp',
      });
      return handlers;
    };
    const wrapped = register(true);
    const plain = register(false);
    expect([...wrapped.keys()].sort()).toEqual([IPC.activateDocument, IPC.openDocument, IPC.rejectDocument, IPC.requestSaveTarget, IPC.saveDocument].sort());
    expect([...plain.keys()].sort()).toEqual([...wrapped.keys()].sort());
    // registerOpenIpc 每次注册的 listener 是新闭包，因此比较源码文本：open / 保存原样转交，activate 与 reject 被包装。
    for (const channel of [IPC.openDocument, IPC.requestSaveTarget, IPC.saveDocument]) expect(String(wrapped.get(channel))).toBe(String(plain.get(channel)));
    for (const channel of [IPC.activateDocument, IPC.rejectDocument]) expect(String(wrapped.get(channel))).not.toBe(String(plain.get(channel)));
  });
});

describe('createActivationFaults —— reject 故障（M3 T4 B3a-1）', () => {
  function rejectRig(behave: (event: InvokeEventLike<SenderLike>, payload: unknown) => unknown) {
    const faults = createActivationFaults();
    const { registrar, handlers } = innerRegistrar();
    const calls: unknown[][] = [];
    faults.registrar(registrar).handle(IPC.rejectDocument, (event, payload) => {
      calls.push([event, payload]);
      return behave(event, payload);
    });
    const reject = handlers.get(IPC.rejectDocument);
    if (reject === undefined) throw new Error('not registered');
    return { faults, reject, calls };
  }
  const pending = async (value: unknown): Promise<string> =>
    Promise.race([Promise.resolve(value).then(() => 'settled'), new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 20))]);

  it('未布置故障：生产 handler 以相同参数执行，结果原样返回（同一对象），抛错原样传播', () => {
    const result = { ok: true };
    let fail = false;
    const { faults, reject, calls } = rejectRig(() => {
      if (fail) throw new Error('Request rejected');
      return result;
    });
    const payload = { capabilityId: 'c', documentId: 1 };
    expect(reject(EVENT, payload)).toBe(result);
    // 参数原样转交：同一个 event 与 payload 对象（不克隆、不改写）。
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(EVENT);
    expect(calls[0]?.[1]).toBe(payload);
    fail = true;
    expect(() => reject(EVENT, payload)).toThrow('Request rejected');
    expect(faults.rejectRecords()).toEqual([
      { call: 1, fault: 'none', executed: true, payload, result },
      { call: 2, fault: 'none', executed: true, payload, result: { threw: true } },
    ]);
  });

  it('hold：生产 handler 照常执行（main 已处理），应答永不 settle；swallow：handler 不执行，应答永不 settle；两者可区分', async () => {
    const { faults, reject, calls } = rejectRig(() => ({ ok: true }));
    faults.setRejectFault('hold');
    const held = reject(EVENT, { n: 1 });
    expect(calls).toHaveLength(1);
    expect(await pending(held)).toBe('pending');
    faults.setRejectFault('swallow');
    const swallowed = reject(EVENT, { n: 2 });
    expect(calls).toHaveLength(1);
    expect(await pending(swallowed)).toBe('pending');
    faults.setRejectFault('none');
    expect(reject(EVENT, { n: 3 })).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(faults.rejectRecords().map((r) => [r.fault, r.executed])).toEqual([
      ['hold', true],
      ['swallow', false],
      ['none', true],
    ]);
  });

  it('hold 下 handler 抛错原样传播（无应答可扣留）；reset 恢复透明并清空记录', () => {
    let fail = true;
    const { faults, reject } = rejectRig(() => {
      if (fail) throw new Error('Request rejected');
      return { ok: true };
    });
    faults.setRejectFault('hold');
    expect(() => reject(EVENT, {})).toThrow('Request rejected');
    faults.reset();
    fail = false;
    expect(reject(EVENT, {})).toEqual({ ok: true });
    expect(faults.rejectRecords()).toEqual([{ call: 2, fault: 'none', executed: true, payload: {}, result: { ok: true } }]);
  });
});

describe('ipcFaults —— 使用范围', () => {
  const smokeDir = join(REPO_ROOT, 'tests/electron/ipcSmoke');
  const files = collectTsFiles(smokeDir).map((file) => ({ rel: posixPath(file), source: readFileSync(file, 'utf8') }));

  it('不 import electron；smoke main 恰好一处包装 ipcMain；只有 casesUi 布置扣留', () => {
    const faults = files.find((file) => file.rel.endsWith('ipcFaults.ts'))?.source ?? '';
    expect(/from 'electron'/.test(faults)).toBe(false);
    const wrappers = files.filter((file) => /faults\.registrar\(/.test(file.source)).map((file) => file.rel);
    expect(wrappers).toEqual(['tests/electron/ipcSmoke/smokeMain.entry.ts']);
    const holders = files.filter((file) => /holdNextActivations\(/.test(file.source) && !file.rel.endsWith('ipcFaults.ts')).map((file) => file.rel);
    expect(holders).toEqual(['tests/electron/ipcSmoke/casesUi.ts']);
    expect(collectTsFiles(join(REPO_ROOT, 'src')).filter((file) => /ipcFaults|holdNextActivations/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('M3 T4 B3a-1：reject 故障只由 casesUi 布置；产品代码不出现 reject 故障', () => {
    const arming = files.filter((file) => /setRejectFault\(/.test(file.source) && !file.rel.endsWith('ipcFaults.ts')).map((file) => file.rel);
    expect(arming).toEqual(['tests/electron/ipcSmoke/casesUi.ts']);
    expect(collectTsFiles(join(REPO_ROOT, 'src')).filter((file) => /setRejectFault|rejectRecords/.test(readFileSync(file, 'utf8')))).toEqual([]);
  });
});
