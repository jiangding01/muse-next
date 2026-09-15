/**
 * M1.7 Serializer 类型定义（方案 v1.1 §1）。
 *
 * 本文件只放置公开签名所需的类型，由 `encodeJcx` / preserve / canonical 共用。
 * `CanonicalOptions.magicHeader` 缺省为 `true`（拍板 A：canonical 默认输出
 * `%MUSE2`）。canonical 内部的 `CanonicalResult` 比 `SerializeResult` 多一个
 * `bodyLines`，那是实现细节，**不进入本文件的公开类型**：公开 `serializeJcx`
 * 的返回类型恒为 `SerializeResult`。
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
