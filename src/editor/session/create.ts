/**
 * 创建 DocumentSession（`docs/M3_EDITOR_CORE_PLAN.md` §7.2 的 Open / New / 启动）。
 *
 * - sourceVersion 从 1 开始；saved 检查点即初始 source；尚无解析快照；无进行中的文件操作。
 * - `protectedLeadingFeff` 与 dominant EOL 在此由 exact source 计算并冻结进投影 frame。
 * - `byteBom` / `writeEncoding` / `encodingRoundTrip` / `file` 是 main 给出的事实（未命名文档为调用方给定的默认值），
 *   这里原样记录，不由文本推断。
 */

import type { ByteBom, EncodingRoundTrip, FileReference } from '../../shared/documentContracts';
import type { JcxEncoding } from '../../formats/jcxParse';
import { createInitialProjection } from '../projection/build';
import type { DocumentSession } from './types';

export interface DocumentSessionInit {
  readonly documentId: number;
  readonly source: string;
  readonly writeEncoding: JcxEncoding;
  readonly byteBom: ByteBom;
  readonly encodingRoundTrip: EncodingRoundTrip;
  readonly file: FileReference | null;
}

export function createDocumentSession(init: DocumentSessionInit): DocumentSession {
  const projection = createInitialProjection(init.source);
  return {
    documentId: init.documentId,
    source: init.source,
    sourceVersion: 1,
    projection,
    parsed: null,
    saved: { source: init.source },
    file: init.file,
    writeEncoding: init.writeEncoding,
    byteBom: init.byteBom,
    protectedLeadingFeff: projection.frame.protectedLeadingFeff,
    encodingRoundTrip: init.encodingRoundTrip,
    fileOp: null,
  };
}
