/**
 * M1.7 Serializer 类型定义（方案 v1.1 §1）。
 *
 * `serializeJcx` 本体由 T2 实现；本文件只放置签名所需的类型，供 T1
 * `encodeJcx` 与后续任务（preserve/canonical）共用。
 */

import type { JcxDiagnostic } from '../lexer/diagnostics';
import type { JcxEncoding } from '../encoding/types';

export type JcxUnencodableStrategy = 'error' | 'replace';

export interface PreserveOptions {
  readonly mode: 'preserve';
  readonly encoding?: JcxEncoding;
  readonly onUnencodable?: JcxUnencodableStrategy;
}

export interface CanonicalOptions {
  readonly mode: 'canonical';
  readonly magicHeader?: boolean;
}

export interface SerializeResult {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly encoding: JcxEncoding;
  readonly diagnostics: readonly JcxDiagnostic[];
}
