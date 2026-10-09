/**
 * EditorSelection 的持久合同（`docs/M3_EDITOR_CORE_PLAN.md` §16.1，T0 定义）。
 *
 * 只定义纯数据合同：T2 History 的 `selectionBefore` / `selectionAfter` 直接使用 `PersistedSelection`。
 * 选中投影、EditorLocatorIndex（T6）与语义 reconciliation（T7）不在本文件。
 *
 * 跨版本的选中真相只有：selection kind、exact source ranges、semantic fingerprint、bias。
 * EventId / RelationId / AstPath / render anchor 只在单个语义快照内有效，**不得**进入本合同（F9）。
 */

import type { RangeBias, SourceRange } from '../text/types';

export type { CaretBias, EdgeBias, RangeBias, SourceRange } from '../text/types';

export type SelectionKind = 'none' | 'source' | 'voice' | 'event' | 'note' | 'relation' | 'document';

/** 语义指纹字段值：只允许 JSON 原子值。 */
export type FingerprintValue = string | number | boolean | null;

/**
 * 语义指纹：kind 相关的语义字段（具体字段由 T6 locator 决定；哪些字段参与比较、哪些可被命令声明为预期变化，
 * 由 T6 / T7 决定）。T0 只保证它是纯数据、可 JSON 往返、不含快照 id。
 */
export interface SemanticFingerprint {
  readonly kind: SelectionKind;
  readonly fields: Readonly<Record<string, FingerprintValue>>;
}

/** 历史事务中存储的唯一选中形态（§9.2）。 */
export interface PersistedSelection {
  readonly kind: SelectionKind;
  readonly ranges: readonly SourceRange[];
  readonly fingerprint?: SemanticFingerprint;
  readonly bias: RangeBias;
}

/** 运行时选中：持久合同 + ranges 所属的 sourceVersion。 */
export interface EditorSelection extends PersistedSelection {
  readonly basisVersion: number;
}

/**
 * 各 kind 的默认 bias（§16.1）：语义目标与 source 非折叠选区的端点都不吸收边界插入；
 * source 折叠光标遇到插入时移到插入内容之后（与键入一致）。所有 kind 取值相同。
 */
export const DEFAULT_RANGE_BIAS: RangeBias = Object.freeze({ start: 'exclude', end: 'exclude', caret: 'after' });
