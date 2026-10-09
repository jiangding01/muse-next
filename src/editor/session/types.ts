/**
 * DocumentSession 的 T0 纯状态合同（`docs/M3_EDITOR_CORE_PLAN.md` §7.1）。
 *
 * - 只存事实，不存可推导的布尔值：`sourceDirty` / `parseStale` / `saveInFlight` 由 `derive.ts` 派生。
 * - `documentId` 由调用方注入（adapter / main / store 负责分配），Editor Core 不持有全局计数器；
 *   `documentId + sourceVersion` 共同构成语义快照的身份。
 * - History（T2）、Selection 运行时状态（T6）、解析调度（T3）不在 T0 会话合同内。
 */

import type { ByteBom, EncodingRoundTrip, FileReference } from '../../shared/documentContracts';
import type { JcxEncoding, LoadResult } from '../../formats/jcxParse';
import type { SourceProjection } from '../projection/types';

/** 某个 (documentId, sourceVersion) 的只读语义快照（§5.1、§7.1）。 */
export interface ParsedSnapshot {
  readonly documentId: number;
  readonly sourceVersion: number;
  readonly load: LoadResult;
}

/** 保存检查点：只在自解码校验通过且写盘成功后前移（§12.2，T4 实现）。 */
export interface SavedCheckpoint {
  readonly source: string;
}

export type FileOperationKind = 'open' | 'save' | 'saveAs' | 'export';

/** 进行中的文件操作；同一时刻最多一个（§20，T4 / T5 实现调度）。 */
export interface FileOperation {
  readonly kind: FileOperationKind;
}

export interface DocumentSession {
  readonly documentId: number;
  /** Exact Source：编辑与持久化的唯一权威（D1）。 */
  readonly source: string;
  /** 同一 documentId 内单调递增、永不回退；任何 source 变化都 +1（§7.1）。 */
  readonly sourceVersion: number;
  readonly projection: SourceProjection;
  readonly parsed: ParsedSnapshot | null;
  readonly saved: SavedCheckpoint;
  readonly file: FileReference | null;
  readonly writeEncoding: JcxEncoding;
  /** 字节级编码元数据，不参与编辑规则（§6.3）。 */
  readonly byteBom: ByteBom;
  /** 文本事实：Open / New 时由 exact source 计算并冻结，决定受保护前缀（§6.3）。 */
  readonly protectedLeadingFeff: boolean;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly fileOp: FileOperation | null;
}
