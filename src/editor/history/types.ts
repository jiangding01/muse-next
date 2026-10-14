/**
 * Unified History 的纯数据合同（`docs/M3_EDITOR_CORE_PLAN.md` §9.2、§9.3、§17.3、§17.5；M3 T2 Preflight r3）。
 *
 * - History 与 `DocumentSession` 是并列的纯值，由调用方成对持有；绑定关系靠 `documentId`、`headVersion`、
 *   `headSource` 在每次操作时校验，History 不进入 T0 的会话合同。
 * - 事务只保存补丁、逆补丁与元数据，不保存任何整份 source；`headSource` 只引用会话当前的同一字符串，作一致性依据。
 * - 栈是持久化单链表：压栈、出栈、替换栈顶都是 O(1)，旧状态的节点被新状态共享且从不修改。注意这只是栈操作的成本，
 *   每次 source 变化仍经 T0 reducer（切片 + 投影重建），整体为 O(n)。
 * - 时间戳由调用方注入（毫秒），History 不读时钟。
 */

import type { SourceRange, TextPatch } from '../text/types';
import type { EditorSelection, PersistedSelection, SelectionKind, SemanticFingerprint } from '../selection/types';
import type { TransactionViolation } from '../session/invariants';
import type { DocumentSession } from '../session/types';

/** 事务来源（§9.2 的 origin）。 */
export type HistoryOrigin = 'source-input' | 'visual-command';

/** 可以合并的源码输入类别（§9.3）。换行、粘贴、剪切、替换、IME 不在此列（C1：换行自身是独立事务）。 */
export type CoalesceKind = 'insert' | 'delete-backward' | 'delete-forward';

/** 源码输入的合并提示（只对 source-input 生效）。 */
export interface CoalesceHint {
  readonly kind: CoalesceKind;
  /** 调用方注入的毫秒时间戳；非有限数或负数时按「不合并」处理，输入本身仍然有效。 */
  readonly timestamp: number;
}

/** §17.5 的候选数据形状（补丁后坐标）：不携带快照 id，进入新快照后仍须经 §17.4 校验。 */
export interface SelectionIntent {
  readonly kind: SelectionKind;
  readonly range: SourceRange;
  /** §17.5 必备；`fingerprint.kind` 必须等于 `kind`。 */
  readonly fingerprint: SemanticFingerprint;
}

/** 栈中的一个事务（字段对应 §9.2）。 */
export interface HistoryTransaction {
  /** 首次应用时的 sourceVersion，只作记录：undo / redo 不使用（§9.2）。 */
  readonly baseVersion: number;
  /** 正向顺序补丁：第 i 个补丁的偏移相对于前 i 个补丁应用之后的文本。 */
  readonly patches: readonly TextPatch[];
  /** 逆补丁，已按应用顺序排列：对结果文本直接顺序应用即可还原。 */
  readonly inverse: readonly TextPatch[];
  readonly selectionBefore: PersistedSelection;
  /** §17.1 入口 1 的候选（非权威）；合并时取最后一步的候选。 */
  readonly selectionAfter: PersistedSelection;
  readonly label: string;
  /** 只存储（T2 不据此合并，同 key 合并策略留给 T8 preflight）。 */
  readonly coalesceKey: string | null;
  readonly origin: HistoryOrigin;
}

/** 持久化单链表节点。 */
export interface HistoryStack {
  readonly top: HistoryTransaction;
  readonly rest: HistoryStack | null;
  readonly size: number;
}

/** 正在合并的组：只描述 undo 栈顶事务能否继续吸收下一步源码输入。 */
export interface CoalescingGroup {
  readonly kind: CoalesceKind;
  readonly lastTimestamp: number;
  /** insert：上次插入的末尾；delete-backward / delete-forward：上次删除的起点。 */
  readonly anchor: number;
}

export interface HistoryState {
  readonly documentId: number;
  /** 最近一次经 History 改变 source 后（或创建时）的 sourceVersion。 */
  readonly headVersion: number;
  /** 与 headVersion 对应的 source（与会话共享同一字符串）。 */
  readonly headSource: string;
  readonly undo: HistoryStack | null;
  readonly redo: HistoryStack | null;
  /** 非 null ⇒ 对应 undo 栈顶，且 redo 为 null。 */
  readonly open: CoalescingGroup | null;
}

export interface HistoryOptions {
  /** 合并窗口（D3：约 1 秒），严格小于才合并。 */
  readonly coalesceWindowMs: number;
}

export interface CommitInput {
  /** 必须等于当前 sourceVersion（只有新事务校验 baseVersion，§9.2）。 */
  readonly baseVersion: number;
  readonly patches: readonly TextPatch[];
  /** 当前运行时选中；`basisVersion` 必须等于当前 sourceVersion。 */
  readonly selection: EditorSelection;
  /** 可视化命令给出的候选；缺省时按 §17.2 与 Q7 规则由 selection 变换得到。 */
  readonly selectionIntent?: SelectionIntent;
  readonly label: string;
  readonly origin: HistoryOrigin;
  readonly coalesceKey?: string | null;
  /** source-input 的合并提示；null ⇒ 独立事务并结束当前合并组。visual-command 忽略此字段。 */
  readonly coalesce: CoalesceHint | null;
}

export type HistoryFailureReason =
  | 'document-mismatch'
  | 'history-out-of-sync'
  | 'stale-selection'
  | 'selection-out-of-range'
  | 'invalid-selection-intent'
  | 'nothing-to-undo'
  | 'nothing-to-redo'
  | 'history-corrupt';

export type CommitResult =
  | {
      readonly ok: true;
      readonly changed: true;
      readonly session: DocumentSession;
      readonly history: HistoryState;
      readonly selection: EditorSelection;
      readonly merged: boolean;
    }
  /**
   * 全部校验通过但文本不变（Q4 / R3-H2）：session 原样返回，不入栈、不清 redo、版本不变；selection 可按 Q7 更新
   * （basisVersion = 当前版本）。选中变化时 history 只把 `open` 置 null，否则 history 与 selection 都是传入的同一对象。
   */
  | {
      readonly ok: true;
      readonly changed: false;
      readonly session: DocumentSession;
      readonly history: HistoryState;
      readonly selection: EditorSelection;
    }
  | { readonly ok: false; readonly reason: HistoryFailureReason | 'base-version-mismatch' }
  | { readonly ok: false; readonly reason: TransactionViolation; readonly patchIndex: number };

export type HistoryStepResult =
  | { readonly ok: true; readonly session: DocumentSession; readonly history: HistoryState; readonly selection: EditorSelection }
  | { readonly ok: false; readonly reason: HistoryFailureReason };
