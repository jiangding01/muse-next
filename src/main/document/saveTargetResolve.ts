/**
 * 保存前对「当前文件」与「写入目标」的实时解析与同一文件判定（`docs/M3_EDITOR_CORE_PLAN.md` §13.2，
 * r1 ERRATA §4.2 / §6，M3 T4 B1；用户裁决 D4、R3、R4）。
 *
 * - 每次保存都实时 realpath / stat，不使用缓存身份；同一文件判定复用 T1a 的 `sameFile()`（路径 OR meaningful dev/ino）。
 * - 「无法确认」（unknown）永远不会被当作「不同」：调用方必须 fail closed（`identity-unknown`）。
 * - 当前文件只在 `ENOENT` / `ENOTDIR` 时记作 absent；absent 时改用能力记录（锚点）上的 realpath / 身份判定。
 *   存回已不存在的原路径单独报告（R4 默认拒绝，R4b 未开启）。
 * - 当前文件 present 时，目标与「实时当前文件」**或**「记录的锚点」任一为 same 即为 same（Gate B1 H-8 裁决 R-H8b）：
 *   原文件路径被换成指向别处的符号链接后，原 inode 的硬链接仍要受同文件保护。记录值只用于**多判出 same**，
 *   不授予任何写盘能力。
 * - 初始不存在的目标：basename 的 `lstat` 必须是 ENOENT（悬空符号链接、目录等任何条目都算占用），父目录取
 *   realpath，合成 `父目录 realpath + basename`（D4：不做大小写折叠）。
 * - 本模块只解析与判定，不读写能力表；锚点事实由调用方（B2）传入。
 */

import { basename, dirname, join } from 'node:path';

import type { FileIdentity, ResolvedFile, SameFileResult } from './fileIdentity';
import { meaningfulIdentity, resolveFile, sameFile } from './fileIdentity';
import type { ReadOnlyFileSystem } from './fileSystemPort';
import { errnoCodeOf } from './fsErrors';
import type { WriteFileSystem } from './writeFileSystemPort';

/** 能力记录（active 或墓碑）上关于原文件的事实。 */
export interface AnchorFileFacts {
  readonly realpath: string;
  readonly identity: FileIdentity | null;
}

export type CurrentFileState =
  | { readonly kind: 'present'; readonly resolved: ResolvedFile & { readonly kind: 'resolved' } }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

export type TargetState =
  | { readonly kind: 'existing'; readonly realpath: string; readonly identity: FileIdentity | null; readonly size: bigint; readonly mtimeNs: bigint }
  | { readonly kind: 'absent'; readonly parentRealpath: string; readonly basename: string; readonly path: string }
  /** 目标名上已有条目但无法解析为文件（悬空符号链接等）。 */
  | { readonly kind: 'occupied' }
  /** 目标不存在，且父目录也不存在或不是目录。 */
  | { readonly kind: 'parent-missing' }
  | { readonly kind: 'unknown' };

export type SameAsAnchor = 'same' | 'different' | 'unknown' | 'original-path-missing';

const isAbsentErrno = (error: unknown): boolean => {
  const errno = errnoCodeOf(error);
  return errno === 'ENOENT' || errno === 'ENOTDIR';
};

export async function resolveCurrentFile(fs: ReadOnlyFileSystem, recordedRealpath: string, platform: string): Promise<CurrentFileState> {
  try {
    const realpath = await fs.realpath(recordedRealpath);
    const stat = await fs.stat(realpath);
    return { kind: 'present', resolved: { kind: 'resolved', realpath, identity: meaningfulIdentity(stat, platform) } };
  } catch (error) {
    return isAbsentErrno(error) ? { kind: 'absent' } : { kind: 'unknown' };
  }
}

export async function resolveTarget(
  readFs: ReadOnlyFileSystem,
  writeFs: WriteFileSystem,
  requestedPath: string,
  platform: string,
): Promise<TargetState> {
  try {
    await writeFs.lstat(requestedPath);
  } catch (error) {
    if (!isAbsentErrno(error)) return { kind: 'unknown' };
    let parentRealpath: string;
    try {
      parentRealpath = await readFs.realpath(dirname(requestedPath));
    } catch (parentError) {
      return isAbsentErrno(parentError) ? { kind: 'parent-missing' } : { kind: 'unknown' };
    }
    try {
      if ((await readFs.stat(parentRealpath)).isFile()) return { kind: 'parent-missing' };
    } catch {
      return { kind: 'unknown' };
    }
    const name = basename(requestedPath);
    return { kind: 'absent', parentRealpath, basename: name, path: join(parentRealpath, name) };
  }
  const resolved = await resolveFile(readFs, requestedPath, platform);
  if (resolved.kind === 'unresolved') return resolved.code === 'not-found' ? { kind: 'occupied' } : { kind: 'unknown' };
  try {
    const stat = await readFs.stat(resolved.realpath);
    return { kind: 'existing', realpath: resolved.realpath, identity: resolved.identity, size: stat.size, mtimeNs: stat.mtimeNs };
  } catch {
    return { kind: 'unknown' };
  }
}

/** 记录的锚点（打开时的 realpath 与身份）是否与给定的实时文件为同一文件（§13.2 OR 规则，R-H8a）。 */
export function sameAsRecordedAnchor(anchor: AnchorFileFacts, live: ResolvedFile): SameFileResult {
  return sameFile({ kind: 'resolved', realpath: anchor.realpath, identity: anchor.identity }, live);
}

export const sameIdentity = (a: FileIdentity | null, b: FileIdentity | null): boolean =>
  a !== null && b !== null && a.dev === b.dev && a.ino === b.ino;

/** 目标是否就是锚点所指的原文件（r1 ERRATA §4.2 判定表）。 */
export function compareWithAnchor(current: CurrentFileState, anchor: AnchorFileFacts, target: TargetState): SameAsAnchor {
  if (target.kind === 'unknown' || target.kind === 'occupied' || target.kind === 'parent-missing' || current.kind === 'unknown') return 'unknown';
  if (current.kind === 'present') {
    const targetResolved: ResolvedFile =
      target.kind === 'existing'
        ? { kind: 'resolved', realpath: target.realpath, identity: target.identity }
        : { kind: 'resolved', realpath: target.path, identity: null };
    // 三方都已解析（无法解析的情形已在函数开头返回 unknown），sameFile 在此只会给出 same / different。
    const live = sameFile(current.resolved, targetResolved);
    const recorded = sameAsRecordedAnchor(anchor, targetResolved);
    return live === 'same' || recorded === 'same' ? 'same' : 'different';
  }
  if (target.kind === 'existing') {
    return target.realpath === anchor.realpath || sameIdentity(target.identity, anchor.identity) ? 'same' : 'different';
  }
  return target.path === anchor.realpath ? 'original-path-missing' : 'different';
}
