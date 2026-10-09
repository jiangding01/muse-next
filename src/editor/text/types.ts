/**
 * Editor Core 的文本坐标合同（`docs/M3_EDITOR_CORE_PLAN.md` §9.2、§16.1、§17.2）。
 *
 * - 所有偏移都是 **exact source 上的 UTF-16 code unit 偏移**，区间半开 `[start, end)`。
 * - 本层不规定代理对边界：冻结方案没有要求 TextPatch 拒绝落在代理对中间的边界（T3 输入层按证据再定，
 *   T4 保存前自解码校验兜底）。
 */

/** exact source 上的半开区间 `[start, end)`。 */
export interface SourceRange {
  readonly start: number;
  readonly end: number;
}

/**
 * 一次文本替换：把 `[start, end)` 替换为 `text`。
 *
 * 同一事务内的多个补丁**按顺序**应用：每个补丁的偏移相对于**前一个补丁应用之后**的文本（§9.2）。
 */
export interface TextPatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 范围端点遇到恰在边界上的纯插入时是否吸收插入内容（§16.1、§17.2）。 */
export type EdgeBias = 'exclude' | 'absorb';

/** 折叠范围（光标）遇到恰在其位置的纯插入时停在插入内容之前还是之后。 */
export type CaretBias = 'before' | 'after';

export interface RangeBias {
  readonly start: EdgeBias;
  readonly end: EdgeBias;
  readonly caret: CaretBias;
}
