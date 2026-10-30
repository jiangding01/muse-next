/**
 * M3 T4 B1：保存前的当前文件 / 目标解析与同一文件判定（`saveTargetResolve.ts`，r1 ERRATA §4.2 判定表）。
 */

import { describe, expect, it } from 'vitest';

import { compareWithAnchor, resolveCurrentFile, resolveTarget } from '../../../src/main/document/saveTargetResolve';
import type { AnchorFileFacts, CurrentFileState, TargetState } from '../../../src/main/document/saveTargetResolve';
import { P, setup } from './saveTestKit';

const ANCHOR: AnchorFileFacts = { realpath: P('docs', 'a.jcx'), identity: { dev: 1n, ino: 7n } };
const present = (realpath: string, ino: bigint | null): CurrentFileState => ({
  kind: 'present',
  resolved: { kind: 'resolved', realpath, identity: ino === null ? null : { dev: 1n, ino } },
});
const existing = (realpath: string, ino: bigint | null): TargetState => ({ kind: 'existing', realpath, identity: ino === null ? null : { dev: 1n, ino }, size: 1n, mtimeNs: 1n });
const absent = (name: string): TargetState => ({ kind: 'absent', parentRealpath: P('docs'), basename: name, path: P('docs', name) });

describe('compareWithAnchor —— 判定表', () => {
  it.each<[string, CurrentFileState, TargetState, string]>([
    ['当前存在 · 目标同路径', present(ANCHOR.realpath, 7n), existing(ANCHOR.realpath, 7n), 'same'],
    ['当前存在 · 目标路径不同但 dev/ino 相同（硬链接）', present(ANCHOR.realpath, 7n), existing(P('docs', 'b.jcx'), 7n), 'same'],
    ['当前存在 · 目标不同', present(ANCHOR.realpath, 7n), existing(P('docs', 'b.jcx'), 8n), 'different'],
    ['当前存在 · 目标不存在', present(ANCHOR.realpath, 7n), absent('new.jcx'), 'different'],
    ['当前存在 · Windows 无身份、路径不同', present(ANCHOR.realpath, null), existing(P('docs', 'b.jcx'), null), 'different'],
    ['当前 absent · 目标为记录路径', { kind: 'absent' }, existing(ANCHOR.realpath, 9n), 'same'],
    ['当前 absent · 目标身份等于记录身份（被移动）', { kind: 'absent' }, existing(P('docs', 'moved.jcx'), 7n), 'same'],
    ['当前 absent · 目标为其它已存在文件', { kind: 'absent' }, existing(P('docs', 'b.jcx'), 8n), 'different'],
    ['当前 absent · 存回已不存在的原路径', { kind: 'absent' }, absent('a.jcx'), 'original-path-missing'],
    ['当前 absent · 其它新路径', { kind: 'absent' }, absent('new.jcx'), 'different'],
    ['当前 unknown', { kind: 'unknown' }, existing(P('docs', 'b.jcx'), 8n), 'unknown'],
    ['目标 unknown', present(ANCHOR.realpath, 7n), { kind: 'unknown' }, 'unknown'],
    ['目标被占用（悬空符号链接）', present(ANCHOR.realpath, 7n), { kind: 'occupied' }, 'unknown'],
    ['目标父目录不存在', present(ANCHOR.realpath, 7n), { kind: 'parent-missing' }, 'unknown'],
  ])('%s → %s', (_name, current, target, expected) => {
    expect(compareWithAnchor(current, ANCHOR, target)).toBe(expected);
  });
});

describe('resolveCurrentFile / resolveTarget', () => {
  it('当前文件：存在 / 不存在 / 无法确认（符号链接环）', async () => {
    const fs = setup();
    fs.writeFile(P('docs', 'a.jcx'), 'x');
    fs.symlink(P('docs', 'loop.jcx'), P('docs', 'loop.jcx'));
    expect((await resolveCurrentFile(fs.readFs, P('docs', 'a.jcx'), 'darwin')).kind).toBe('present');
    expect(await resolveCurrentFile(fs.readFs, P('docs', 'gone.jcx'), 'darwin')).toEqual({ kind: 'absent' });
    expect(await resolveCurrentFile(fs.readFs, P('docs', 'loop.jcx'), 'darwin')).toEqual({ kind: 'unknown' });
  });

  it('目标：已存在（跟随符号链接到 realpath）/ 不存在（父目录 realpath + 文件名）/ 悬空符号链接为占用 / 父目录不存在或是文件为 parent-missing', async () => {
    const fs = setup();
    fs.writeFile(P('docs', 'a.jcx'), 'x');
    fs.symlink(P('docs', 'alias.jcx'), P('docs', 'a.jcx'));
    fs.symlink(P('docs', 'dangling.jcx'), P('docs', 'none.jcx'));
    expect(await resolveTarget(fs.readFs, fs.writeFs, P('docs', 'alias.jcx'), 'darwin')).toEqual({
      kind: 'existing',
      realpath: P('docs', 'a.jcx'),
      identity: { dev: 1n, ino: fs.inodeOf(P('docs', 'a.jcx')) },
      ...fs.statOf(P('docs', 'a.jcx')),
    });
    expect(await resolveTarget(fs.readFs, fs.writeFs, P('docs', 'new.jcx'), 'darwin')).toEqual(absent('new.jcx'));
    expect(await resolveTarget(fs.readFs, fs.writeFs, P('docs', 'dangling.jcx'), 'darwin')).toEqual({ kind: 'occupied' });
    expect(await resolveTarget(fs.readFs, fs.writeFs, P('nowhere', 'x.jcx'), 'darwin')).toEqual({ kind: 'parent-missing' });
    expect(await resolveTarget(fs.readFs, fs.writeFs, P('docs', 'a.jcx', 'child.jcx'), 'darwin')).toEqual({ kind: 'parent-missing' });
  });
});
