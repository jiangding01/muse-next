/**
 * main 保存管线（`docs/M3_EDITOR_CORE_PLAN.md` §11.4–§11.6、§12、§13.2、§14；DECISIONS-r1 Q8、r1 ERRATA §4–§6、
 * r1.1 §2，M3 T4 B1）。
 *
 * 顺序（已批准）：代次复核 → 编码 + 自解码校验（纯计算）→ 实时解析写入对象与同一文件判定 → 语义拒绝（unsafe、
 * 同文件改编码、unsafe 文档另存非 UTF-8）→ 分管线复核（已存在目标：类型 / 可写 / 提前指纹；不存在目标：不读取）
 * → 临时文件（每个 await 后复核代次）→ 同步临界区提交（C2）→ 提交后：清理、目录 fsync（尽力）、三态结果。
 *
 * - 输入是**已授权的事实**：授权（能力表、save-target、锚点、源文件身份核对）由 B2 的 IPC 层完成，本模块不读写能力表。
 * - `stillCurrent()` 由调用方提供（B2：窗口仍登记且 generation 未变）；提交前失效 → 未提交，提交后失效 →
 *   `committed-unconfirmed`（如实报告已写入，r1 ERRATA §5）。
 * - 「无法确认」一律拒绝：当前文件或目标 unknown → `identity-unknown`；存回已不存在的原路径 → `not-found`（R4）。
 */

import { dirname } from 'node:path';

import type { ByteBom, EncodingRoundTrip } from '../../shared/documentContracts';
import type { SaveCommitOutcome, SaveError, SaveErrorCode } from '../../shared/saveContracts';
import type { JcxEncoding } from '../../formats/jcx/codec';
import { commitAbsentSync, commitExistingSync, hasWriteBit, removeTemp, writeTempFile } from './atomicWrite';
import type { CommitResult, FileStamp, TempFile } from './atomicWrite';
import { sha256Hex } from './fingerprint';
import type { FileIdentity } from './fileIdentity';
import type { ReadOnlyFileSystem } from './fileSystemPort';
import { MAX_DOCUMENT_BYTES, readDocumentBytes } from './readDocumentBytes';
import { encodeForSave } from './saveEncoding';
import type { EncodedForSave } from './saveEncoding';
import { mapVerifyError, saveError } from './saveErrors';
import { compareWithAnchor, resolveCurrentFile, resolveTarget, sameAsRecordedAnchor, sameIdentity } from './saveTargetResolve';
import type { AnchorFileFacts, TargetState } from './saveTargetResolve';
import type { WriteFileSystem } from './writeFileSystemPort';

/** 能力记录（active 或墓碑）上的原文件事实。 */
export interface SaveFileFacts extends AnchorFileFacts {
  readonly writeEncoding: JcxEncoding;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly lastKnownDiskFingerprint: string;
}

/**
 * Save As 阶段 1 授予时记录的目标状态（r1 ERRATA §2.2）。已存在目标记录授予时的身份：POSIX 用 meaningful
 * dev / ino；Windows 没有可信 inode（`identity: null`），以 size + mtimeNs + realpath 作限制性旁证。
 */
export type SaveTargetGrant =
  | { readonly kind: 'existing'; readonly realpath: string; readonly identity: FileIdentity | null; readonly size: bigint; readonly mtimeNs: bigint }
  | { readonly kind: 'absent'; readonly parentRealpath: string; readonly basename: string };

export type SaveRequest =
  | { readonly kind: 'save'; readonly current: SaveFileFacts; readonly source: string; readonly encoding: JcxEncoding }
  | {
      readonly kind: 'saveAs';
      /** 用户在 main 对话框中选择的绝对路径。 */
      readonly requestedPath: string;
      readonly granted: SaveTargetGrant;
      /** 当前会话的原文件事实；未命名文档为 null。 */
      readonly anchor: SaveFileFacts | null;
      readonly source: string;
      readonly encoding: JcxEncoding;
    };

export type SavePipelineEvent = 'temp-cleanup-failed' | 'directory-sync-failed';

export interface SavePipelineDeps {
  readonly readFs: ReadOnlyFileSystem;
  readonly writeFs: WriteFileSystem;
  readonly platform: string;
  readonly limit?: number;
  tempName(): string;
  stillCurrent(): boolean;
  /** 诊断事件（不含路径）。 */
  log(event: SavePipelineEvent): void;
}

/** 提交后供 B2 刷新能力记录（或登记 Save As 候选）的事实。 */
export interface WrittenFacts {
  readonly realpath: string;
  readonly identity: FileIdentity | null;
  readonly lastKnownDiskFingerprint: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
}

export type SavePipelineResult =
  | { readonly outcome: Extract<SaveCommitOutcome, 'not-committed'>; readonly error: SaveError }
  | {
      readonly outcome: Exclude<SaveCommitOutcome, 'not-committed'>;
      readonly written: WrittenFacts;
      /** 写入对象就是锚点所指的原文件（普通 Save 恒为 true）。 */
      readonly sameAsAnchor: boolean;
    };

type WritePlan =
  | {
      readonly kind: 'existing';
      readonly realpath: string;
      readonly fingerprint: string | null;
      readonly identity: FileIdentity | null;
      readonly stamp: FileStamp | null;
      readonly mode: number;
      readonly sameAsAnchor: boolean;
    }
  | { readonly kind: 'absent'; readonly target: string; readonly directory: string };

type Planned = { readonly ok: true; readonly plan: WritePlan } | { readonly ok: false; readonly code: SaveErrorCode };

const refuse = (code: SaveErrorCode): Planned => ({ ok: false, code });
const notCommitted = (code: SaveErrorCode): SavePipelineResult => ({ outcome: 'not-committed', error: saveError(code) });

/**
 * 回调保护：`stillCurrent()` 抛出（例如窗口已销毁）视为代次已失效；`log()` 抛出被忽略。
 * 这样任何回调异常都不会让已提交的保存变成 rejected promise，也不会越过临时文件清理。
 */
function guarded(deps: SavePipelineDeps): SavePipelineDeps {
  return {
    ...deps,
    stillCurrent: () => {
      try {
        return deps.stillCurrent();
      } catch {
        return false;
      }
    },
    log: (event) => {
      try {
        deps.log(event);
      } catch {
        // 诊断失败不影响保存结论。
      }
    },
  };
}

export async function runSavePipeline(rawDeps: SavePipelineDeps, request: SaveRequest): Promise<SavePipelineResult> {
  const deps = guarded(rawDeps);
  const limit = deps.limit ?? MAX_DOCUMENT_BYTES;
  if (!deps.stillCurrent()) return notCommitted('capability-invalid');
  if (request.kind === 'save' && request.encoding !== request.current.writeEncoding) return notCommitted('encoding-mismatch');

  const encoded = encodeForSave(request.source, request.encoding, limit);
  if (!encoded.ok) return notCommitted(encoded.code);

  let tempPath: string | null = null;
  let plan: WritePlan;
  let temp: TempFile;
  let commit: CommitResult;
  try {
    const planned = request.kind === 'save' ? await planSave(deps, request.current, limit) : await planSaveAs(deps, request, limit);
    if (!planned.ok) return notCommitted(planned.code);
    if (!deps.stillCurrent()) return notCommitted('capability-invalid');
    plan = planned.plan;

    const directory = plan.kind === 'existing' ? dirname(plan.realpath) : plan.directory;
    const tempWrite = await writeTempFile(deps.writeFs, {
      directory,
      bytes: encoded.encoded.bytes,
      copyMode: plan.kind === 'existing' ? plan.mode : null,
      tempName: () => deps.tempName(),
      stillCurrent: () => deps.stillCurrent(),
    });
    tempPath = tempWrite.ok ? tempWrite.temp.path : tempWrite.temp;
    if (!tempWrite.ok) {
      if (tempPath !== null) await cleanup(deps, tempPath);
      return notCommitted(tempWrite.code);
    }
    temp = tempWrite.temp;
    commit = commitPlan(deps, plan, temp, limit);
  } catch {
    // 提交点之前的意外异常：目标未改动；清理临时文件并按写失败报告。
    if (tempPath !== null) await cleanup(deps, tempPath);
    return notCommitted('write-failed');
  }
  if (!commit.committed) {
    await cleanup(deps, temp.path);
    return notCommitted(commit.code);
  }
  return finishCommitted(deps, plan, temp, encoded.encoded, request.encoding, commit);
}

/** 同步：从最后一次代次复核到提交返回之间没有 await。 */
function commitPlan(deps: SavePipelineDeps, plan: WritePlan, temp: TempFile, limit: number): CommitResult {
  if (plan.kind === 'absent') {
    return commitAbsentSync(deps.writeFs, { temp, target: plan.target, platform: deps.platform, stillCurrent: () => deps.stillCurrent() });
  }
  return commitExistingSync(deps.writeFs, {
    temp,
    realpath: plan.realpath,
    expectedFingerprint: plan.fingerprint,
    expectedIdentity: plan.identity,
    expectedStamp: plan.stamp,
    platform: deps.platform,
    limit,
    stillCurrent: () => deps.stillCurrent(),
  });
}

async function finishCommitted(
  deps: SavePipelineDeps,
  plan: WritePlan,
  temp: TempFile,
  encoded: EncodedForSave,
  encoding: JcxEncoding,
  commit: Extract<CommitResult, { committed: true }>,
): Promise<SavePipelineResult> {
  if (!commit.tempUnlinked) deps.log('temp-cleanup-failed');
  const realpath = plan.kind === 'existing' ? plan.realpath : plan.target;
  // 目录 fsync 尽力而为（D8）；Windows 上目录不能以只读方式打开并 fsync，跳过以免每次保存都产生噪声诊断。
  if (deps.platform !== 'win32') {
    try {
      await deps.writeFs.syncDirectory(dirname(realpath));
    } catch {
      deps.log('directory-sync-failed');
    }
  }
  const identityKnown = deps.platform !== 'win32' && temp.stat.dev !== 0n && temp.stat.ino !== 0n;
  const written: WrittenFacts = {
    realpath,
    identity: identityKnown ? { dev: temp.stat.dev, ino: temp.stat.ino } : null,
    lastKnownDiskFingerprint: sha256Hex(encoded.bytes),
    writeEncoding: encoding,
    byteBom: encoded.byteBom,
    encodingRoundTrip: encoded.encodingRoundTrip,
  };
  const sameAsAnchor = plan.kind === 'existing' && plan.sameAsAnchor;
  return { outcome: deps.stillCurrent() ? 'saved' : 'committed-unconfirmed', written, sameAsAnchor };
}

async function cleanup(deps: SavePipelineDeps, path: string): Promise<void> {
  if (!(await removeTemp(deps.writeFs, path))) deps.log('temp-cleanup-failed');
}

/** 普通 Save：当前文件必须仍存在且可确认；unsafe 由 main 直接拒绝（§11.4）。 */
async function planSave(deps: SavePipelineDeps, current: SaveFileFacts, limit: number): Promise<Planned> {
  const state = await resolveCurrentFile(deps.readFs, current.realpath, deps.platform);
  if (state.kind === 'absent') return refuse('not-found');
  if (state.kind === 'unknown') return refuse('identity-unknown');
  // R-H8a：实时解析出的文件必须与打开时的锚点是同一文件（路径相等 OR meaningful dev / ino 相等）。原路径被换成指向
  // 其它文件的符号链接时，即使内容指纹相同也拒绝；同路径的外部原子保存仍为 same，交给后面的指纹比较。
  // 两侧都已解析（解析失败已在上面报 identity-unknown），所以这里只有 same / different；不是 same 一律拒绝。
  if (sameAsRecordedAnchor(current, state.resolved) !== 'same') return refuse('file-modified-on-disk');
  if (current.encodingRoundTrip === 'unsafe') return refuse('unsafe-overwrite-refused');
  return planExisting(deps, state.resolved.realpath, current.lastKnownDiskFingerprint, null, null, true, limit);
}

async function planSaveAs(deps: SavePipelineDeps, request: Extract<SaveRequest, { kind: 'saveAs' }>, limit: number): Promise<Planned> {
  const target = await resolveTarget(deps.readFs, deps.writeFs, request.requestedPath, deps.platform);
  const drift = grantDrift(request.granted, target);
  if (drift !== null) return refuse(drift);
  if (target.kind !== 'existing' && target.kind !== 'absent') return refuse('identity-unknown');

  const { anchor } = request;
  if (anchor === null) return planDifferent(deps, target, limit);
  const current = await resolveCurrentFile(deps.readFs, anchor.realpath, deps.platform);
  const relation = compareWithAnchor(current, anchor, target);
  if (relation === 'unknown') return refuse('identity-unknown');
  if (relation === 'original-path-missing') return refuse('not-found');
  if (relation === 'different') {
    if (anchor.encodingRoundTrip === 'unsafe' && request.encoding !== 'utf-8') return refuse('encoding-mismatch');
    return planDifferent(deps, target, limit);
  }
  // same：按普通 Save 的规则写回原文件。
  if (anchor.encodingRoundTrip === 'unsafe') return refuse('unsafe-overwrite-refused');
  if (request.encoding !== anchor.writeEncoding) return refuse('same-file-encoding-change-refused');
  if (target.kind !== 'existing') return refuse('identity-unknown');
  // R-H8a 同样适用：被写回的必须是锚点所指的原文件；只与实时当前文件 same（原路径已指向别处）时拒绝。
  if (sameAsRecordedAnchor(anchor, { kind: 'resolved', realpath: target.realpath, identity: target.identity }) !== 'same') {
    return refuse('file-modified-on-disk');
  }
  return planExisting(deps, target.realpath, anchor.lastKnownDiskFingerprint, null, null, true, limit);
}

/** 授予（阶段 1）之后目标状态不得改变：出现 / 消失 / 换了父目录或真实文件，一律视为外部修改。 */
function grantDrift(granted: SaveTargetGrant, target: TargetState): SaveErrorCode | null {
  if (target.kind === 'unknown') return 'identity-unknown';
  // 父目录已不存在（R15：not-found）；目标名上出现了无法解析的条目（悬空符号链接等）属于授予后的变化。
  if (target.kind === 'parent-missing') return granted.kind === 'absent' ? 'not-found' : 'file-modified-on-disk';
  if (target.kind === 'occupied') return 'file-modified-on-disk';
  if (granted.kind === 'existing') {
    if (target.kind !== 'existing' || target.realpath !== granted.realpath) return 'file-modified-on-disk';
    // 授予时的文件必须仍是同一个文件（H-9）：有可信身份时比 dev / ino，否则 size 与 mtimeNs 必须不变。
    if (granted.identity !== null && target.identity !== null) return sameIdentity(granted.identity, target.identity) ? null : 'file-modified-on-disk';
    return target.size === granted.size && target.mtimeNs === granted.mtimeNs ? null : 'file-modified-on-disk';
  }
  if (target.kind !== 'absent' || target.parentRealpath !== granted.parentRealpath || target.basename !== granted.basename) {
    return 'file-modified-on-disk';
  }
  return null;
}

async function planDifferent(deps: SavePipelineDeps, target: Extract<TargetState, { kind: 'existing' | 'absent' }>, limit: number): Promise<Planned> {
  if (target.kind === 'absent') return { ok: true, plan: { kind: 'absent', target: target.path, directory: target.parentRealpath } };
  // §12.3：Save As 到其它已存在文件不比较指纹，提交前只复核它仍是同一个普通可写文件。
  return planExisting(deps, target.realpath, null, target.identity, { size: target.size, mtimeNs: target.mtimeNs }, false, limit);
}

async function planExisting(
  deps: SavePipelineDeps,
  realpath: string,
  fingerprint: string | null,
  identity: FileIdentity | null,
  stamp: FileStamp | null,
  sameAsAnchor: boolean,
  limit: number,
): Promise<Planned> {
  let mode: number;
  try {
    const stat = await deps.writeFs.stat(realpath);
    if (!stat.isFile()) return refuse('not-a-regular-file');
    mode = stat.mode;
    if (!hasWriteBit(stat) || !(await deps.writeFs.isWritable(realpath))) return refuse('permission-denied');
  } catch (error) {
    return refuse(mapVerifyError(error));
  }
  if (fingerprint !== null) {
    // 提前拒绝（避免无谓写临时文件）；权威核验是提交前同步临界区里的最终读盘。
    const read = await readDocumentBytes(deps.readFs, realpath, limit);
    if (!read.ok) return refuse(read.code === 'permission-denied' ? 'permission-denied' : 'file-modified-on-disk');
    if (sha256Hex(read.bytes) !== fingerprint) return refuse('file-modified-on-disk');
  }
  return { ok: true, plan: { kind: 'existing', realpath, fingerprint, identity, stamp, mode, sameAsAnchor } };
}
