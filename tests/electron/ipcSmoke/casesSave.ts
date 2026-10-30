/**
 * M3 T4 B2：保存的 Electron IPC smoke（matrix）。页面经 `window.museDesktop` 的两个保存方法调用生产 IPC，写入真实文件系统上
 * 本次运行的隔离目录（`fixtures` 目录下的 `save-*`，不触碰任何用户文档）。
 *
 * 这些用例同时是 W-DISK 的用例本体（GATE-PLAN-r1）：已存在目标 rename、`link` 发布与抢先创建、外部修改、悬空符号链接；
 * Windows / Linux 的结果在 B5 三平台 CI 中判定（T4 Seal 的阻塞条件）。
 */

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, readlink, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openActive } from './casesCapability';
import { expectEqual, expectTrue, ownerMeta, SECOND_SOURCE, UTF8_SOURCE, verdict } from './context';
import type { SmokeCase, SmokeContext } from './context';
import { isRecord } from './replies';
import type { Ticket } from './replies';
import type { SmokeWindow } from './windows';

export const SAVED_SOURCE = 'X:3\nT:saved 中文\nK:D\nDEFG|\n';

/** 本用例的隔离目录。 */
export async function saveDir(ctx: SmokeContext): Promise<string> {
  return mkdtemp(join(ctx.fixtures.dir, 'save-'));
}

/** 写入一份 UTF-8 乐谱并返回路径。 */
export async function scoreFile(dir: string, name: string, text = UTF8_SOURCE): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, text, 'utf8');
  return path;
}

export interface DiskFacts {
  readonly sha256: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
}

/** 文件的字节指纹与身份（H-7 用例断言「X 未被改动」）。 */
export async function diskFacts(path: string): Promise<DiskFacts> {
  const facts = await stat(path, { bigint: true });
  return { sha256: createHash('sha256').update(await readFile(path)).digest('hex'), dev: facts.dev, ino: facts.ino, mtimeNs: facts.mtimeNs };
}

/** 调用桥接方法并返回应答对象；页面调用失败即抛出（用例记为失败）。 */
export async function bridge(window: SmokeWindow, method: 'requestSaveTarget' | 'saveDocument', payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await window.call(`window.museDesktop.${method}(${JSON.stringify(payload)})`);
  if (!result.ok) throw new Error(`${method}: ${result.error}`);
  if (!isRecord(result.value)) throw new Error(`${method}: malformed reply`);
  return result.value;
}

/** Save As 阶段 1，预期会弹出对话框（排入一步选择）。 */
export async function requestTarget(ctx: SmokeContext, window: SmokeWindow, path: string | null, source: string | null): Promise<Record<string, unknown>> {
  ctx.saveChooser.enqueue(path === null ? { kind: 'cancel' } : { kind: 'path', path });
  return bridge(window, 'requestSaveTarget', { suggestedName: 'saved.jcx', encoding: 'utf-8', sourceCapabilityId: source });
}

/** Save As 阶段 1，预期在对话框之前被拒绝（不排入选择）。 */
export function requestRefused(window: SmokeWindow, source: string | null): Promise<Record<string, unknown>> {
  return bridge(window, 'requestSaveTarget', { suggestedName: 'saved.jcx', encoding: 'utf-8', sourceCapabilityId: source });
}

export const grantedId = (reply: Record<string, unknown>): string => {
  if (reply.kind !== 'granted' || typeof reply.capabilityId !== 'string') throw new Error(`expected granted, got ${String(reply.kind)}`);
  return reply.capabilityId;
};

export const saveTo = (window: SmokeWindow, ticket: Ticket, source: string): Promise<Record<string, unknown>> =>
  bridge(window, 'saveDocument', { capabilityId: ticket.capabilityId, documentId: ticket.documentId, source, encoding: 'utf-8' });

export const saveAsTo = (window: SmokeWindow, target: string, documentId: number, sourceCapabilityId: string | null, source: string): Promise<Record<string, unknown>> =>
  bridge(window, 'saveDocument', { capabilityId: target, documentId, source, encoding: 'utf-8', sourceCapabilityId });

/** 应答中的错误码（not-committed / refused），没有则为 null。 */
export const codeOf = (reply: Record<string, unknown>): unknown => (isRecord(reply.error) ? reply.error.code : null);

/** 目录中残留的临时文件。 */
export async function temps(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((name) => name.startsWith('.muse-save-'));
}

const saveBasic: SmokeCase = {
  id: 'save.basic',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'basic 中文.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const first = await saveTo(window, ticket, SAVED_SOURCE);
    expectEqual(problems, 'first save', { outcome: first.outcome, ticket: first.ticket }, { outcome: 'saved', ticket: null });
    expectEqual(problems, 'bytes after first save', await readFile(file, 'utf8'), SAVED_SOURCE);
    // A9 已刷新锚点指纹：紧接着的第二次保存不会误报外部修改。
    const second = await saveTo(window, ticket, SECOND_SOURCE);
    expectEqual(problems, 'second save', second.outcome, 'saved');
    expectEqual(problems, 'bytes after second save', await readFile(file, 'utf8'), SECOND_SOURCE);
    expectEqual(problems, 'temp files', await temps(dir), []);
    return verdict(problems);
  },
};

const saveAsAbsent: SmokeCase = {
  id: 'save-as.absent-link',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'origin.jcx');
    const target = join(dir, 'new 新.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const before = await diskFacts(file);
    const problems: string[] = [];
    const reply = await requestTarget(ctx, window, target, ticket.capabilityId);
    expectEqual(problems, 'granted', { kind: reply.kind, sameAsCurrent: reply.sameAsCurrent }, { kind: 'granted', sameAsCurrent: false });
    const saved = await saveAsTo(window, grantedId(reply), ticket.documentId, ticket.capabilityId, SAVED_SOURCE);
    expectEqual(problems, 'outcome', saved.outcome, 'saved');
    expectEqual(problems, 'new file bytes', await readFile(target, 'utf8'), SAVED_SOURCE);
    expectEqual(problems, 'origin untouched', await diskFacts(file), before);
    const next = saved.ticket;
    if (!isRecord(next) || typeof next.capabilityId !== 'string' || typeof next.documentId !== 'number') return verdict([...problems, 'missing activation ticket']);
    expectEqual(problems, 'activate new', await window.activate({ capabilityId: next.capabilityId, documentId: next.documentId }), { ok: true });
    expectTrue(problems, 'old capability still authorized', ctx.openIpc.authorize(window.ownerId, ticket.capabilityId) === null);
    expectEqual(problems, 'temp files', await temps(dir), []);
    return verdict(problems);
  },
};

const saveAsExisting: SmokeCase = {
  id: 'save-as.existing',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'origin.jcx');
    const other = await scoreFile(dir, 'other.jcx', SECOND_SOURCE);
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const reply = await requestTarget(ctx, window, other, ticket.capabilityId);
    const saved = await saveAsTo(window, grantedId(reply), ticket.documentId, ticket.capabilityId, SAVED_SOURCE);
    expectEqual(problems, 'outcome', saved.outcome, 'saved');
    expectEqual(problems, 'replaced bytes', await readFile(other, 'utf8'), SAVED_SOURCE);
    expectEqual(problems, 'origin bytes', await readFile(file, 'utf8'), UTF8_SOURCE);
    expectEqual(problems, 'temp files', await temps(dir), []);
    return verdict(problems);
  },
};

const saveAsLinkEexist: SmokeCase = {
  id: 'save-as.link-eexist',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const target = join(dir, 'raced.jcx');
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const reply = await requestTarget(ctx, window, target, null);
    // 授予之后、提交之前，另一个进程抢先创建了目标名。
    await writeFile(target, 'theirs', 'utf8');
    const saved = await saveAsTo(window, grantedId(reply), 0, null, SAVED_SOURCE);
    expectEqual(problems, 'refused', { outcome: saved.outcome, code: codeOf(saved) }, { outcome: 'not-committed', code: 'file-modified-on-disk' });
    expectEqual(problems, 'their bytes untouched', await readFile(target, 'utf8'), 'theirs');
    expectEqual(problems, 'temp files', await temps(dir), []);
    return verdict(problems);
  },
};

const saveAsDangling: SmokeCase = {
  id: 'save-as.dangling-symlink',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const link = join(dir, 'dangling.jcx');
    const pointee = join(dir, 'missing.jcx');
    await symlink(pointee, link);
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const reply = await requestTarget(ctx, window, link, null);
    expectEqual(problems, 'refused', { kind: reply.kind, code: codeOf(reply) }, { kind: 'refused', code: 'not-a-regular-file' });
    expectEqual(problems, 'link preserved', await readlink(link), pointee);
    expectEqual(problems, 'pointee not created', (await readdir(dir)).sort(), ['dangling.jcx']);
    return verdict(problems);
  },
};

const saveAsForgedDocumentId: SmokeCase = {
  id: 'save-as.anchor-forged-document-id',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'origin.jcx');
    const window = await ctx.windows.create();
    const ticket = await openActive(ctx, window, file);
    const problems: string[] = [];
    const target = grantedId(await requestTarget(ctx, window, join(dir, 'new.jcx'), ticket.capabilityId));
    const forged = await saveAsTo(window, target, ticket.documentId + 1, ticket.capabilityId, SAVED_SOURCE);
    expectEqual(problems, 'forged documentId', codeOf(forged), 'document-mismatch');
    // F2：G 已在业务判定之前被消费，带正确 documentId 重试也无效。
    const retry = await saveAsTo(window, target, ticket.documentId, ticket.capabilityId, SAVED_SOURCE);
    expectEqual(problems, 'retry after consumption', codeOf(retry), 'capability-invalid');
    expectEqual(problems, 'nothing written', (await readdir(dir)).sort(), ['origin.jcx']);
    return verdict(problems);
  },
};

const saveAsAnchorChanged: SmokeCase = {
  id: 'save-as.anchor-changed-after-grant',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const x = await scoreFile(dir, 'x.jcx');
    const y = await scoreFile(dir, 'y.jcx', SECOND_SOURCE);
    const window = await ctx.windows.create();
    const tx = await openActive(ctx, window, x);
    const ty = await openActive(ctx, window, y);
    const problems: string[] = [];
    const target = grantedId(await requestTarget(ctx, window, join(dir, 'new.jcx'), ty.capabilityId));
    // reject Y：锚点回退到 X（A2），G.anchor（= Y）不再等于 committed（M47）。
    expectEqual(problems, 'reject Y', await window.reject(ty), { ok: true });
    expectEqual(problems, 'anchor rolled back', ownerMeta(ctx, window.ownerId)?.committed, { kind: 'record', token: tx.capabilityId });
    const saved = await saveAsTo(window, target, ty.documentId, tx.capabilityId, SAVED_SOURCE);
    expectEqual(problems, 'stale grant', codeOf(saved), 'capability-invalid');
    expectEqual(problems, 'nothing written', (await readdir(dir)).sort(), ['x.jcx', 'y.jcx']);
    return verdict(problems);
  },
};

const saveTargetOneShot: SmokeCase = {
  id: 'save-target.one-shot',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const target = join(dir, 'once.jcx');
    const window = await ctx.windows.create();
    const problems: string[] = [];
    const grant = grantedId(await requestTarget(ctx, window, target, null));
    expectEqual(problems, 'first use', (await saveAsTo(window, grant, 0, null, SAVED_SOURCE)).outcome, 'saved');
    expectEqual(problems, 'second use', codeOf(await saveAsTo(window, grant, 0, null, SECOND_SOURCE)), 'capability-invalid');
    expectEqual(problems, 'bytes from first use', await readFile(target, 'utf8'), SAVED_SOURCE);
    return verdict(problems);
  },
};

const saveCrossWindow: SmokeCase = {
  id: 'save.cross-window-token',
  run: async (ctx) => {
    const dir = await saveDir(ctx);
    const file = await scoreFile(dir, 'mine.jcx');
    const owner = await ctx.windows.create();
    const intruder = await ctx.windows.create();
    const ticket = await openActive(ctx, owner, file);
    const problems: string[] = [];
    expectEqual(problems, 'cross-window save', codeOf(await saveTo(intruder, ticket, SAVED_SOURCE)), 'capability-invalid');
    expectEqual(problems, 'bytes untouched', await readFile(file, 'utf8'), UTF8_SOURCE);
    return verdict(problems);
  },
};

export const SAVE_CASES: readonly SmokeCase[] = [
  saveBasic,
  saveAsAbsent,
  saveAsExisting,
  saveAsLinkEexist,
  // Windows 上创建符号链接需要额外权限：该用例只在 POSIX 登记（electronIpcSmokeSummary 中同步只列 darwin / linux）。
  ...(process.platform === 'win32' ? [] : [saveAsDangling]),
  saveAsForgedDocumentId,
  saveAsAnchorChanged,
  saveTargetOneShot,
  saveCrossWindow,
];
