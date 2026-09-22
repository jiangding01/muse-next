/**
 * notation/staff —— 符头 / 占位文本的槽宽兜底（M2 T7.2）。
 *
 * 背景与 `tabSlotWidths.ts` 同构（结构照抄，**不 import**）：`layout/spacing.ts` 的
 * 槽宽只按字面 `duration` 加权，它不认识任何一种记谱，因此既不知道五线谱的符头要
 * 多宽，也不知道降级占位要画一段多长的文本。短时值的槽
 * （`SLOT_SPACING_METRICS.minSlotWidth` = 12u）放不下一个符头 + 左右留白，更放不下
 * `C1/16` 这样的占位文本——右侧会压到下一列（典型地是紧随其后的小节线）上。
 *
 * 修复只加宽、不缩窄：共享的 `spacing.ts` / `metrics.ts` 的上下界保持不变（它们对
 * 其余三种记谱仍然是对的），本文件在 Staff 自己的布局步骤里逐槽核实所需宽度，取
 * 两个下界的较大者，画不下就把**这一个槽**（连同同一 measure 内所有槽的 x 累计）
 * 撑宽到刚好放得下，其余槽原样不动。
 *
 * 两个下界互不包含，故不能只核实其中一个：
 * 1. **符头下界** `STAFF_METRICS.minNoteSlotWidth`——任何画正规字形的列（音符 /
 *    休止 / 小节线）都至少要这么宽；
 * 2. **占位文本下界**——占位文本宽 + 左右各一份 `placeholderPaddingX`。
 *    「这个事件会不会被画成占位、文本是什么」只问 `planStaffNode` 一处
 *    （`staffEventNodes.ts`），本文件不重新判一遍事件种类。
 *
 * overlay 列（和弦符号）**恒零宽**：加宽它等于把和弦符号重新变回一个占位列，正是
 * T6.5 在 TAB 上消掉的那种空档。
 *
 * 依赖方向单向 `layoutStaff.ts → staffSlotWidths.ts → staffEventNodes.ts`，无环；
 * 尺寸一律取自 `layout/metrics.ts` 的 `STAFF_METRICS`（唯一来源），单位 abstract unit。
 */

import { SLOT_SPACING_METRICS, STAFF_METRICS } from '../layout/metrics';
import type { MeasureSpacing, SpacedSlot } from '../layout/spacing';
import type { TimeSlot } from '../layout/primitives';
import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderItem } from '../model/types';
import { planStaffNode } from './staffEventNodes';

/** 一个渲染项实际需要的槽宽（overlay 列由调用方先行截住，不进本函数）。 */
function requiredSlotWidth(item: RenderItem, measurer: TextMeasurer): number {
  const plan = planStaffNode(item.event);
  if (plan.kind !== 'placeholder') {
    return STAFF_METRICS.minNoteSlotWidth;
  }
  const width = measurer.measure(plan.text, { fontSize: STAFF_METRICS.placeholderFontSize }).width;
  return Math.max(
    STAFF_METRICS.minNoteSlotWidth,
    width + 2 * STAFF_METRICS.placeholderPaddingX,
  );
}

/**
 * 按每个槽实际要画的内容加宽 `spaceItems` 排出的槽宽——只加宽、不缩窄
 * （`effective = max(slot.width, required)`）。
 *
 * `items` 必须与 `spacing.slots` 同序同长（调用方传入同一个 measure 的
 * `measure.items`）：第 i 个 item 对应第 i 个 slot。任一槽变宽时，重新累计该 measure
 * 内所有槽的 `x`（段内相对坐标从 0 起）与总 `width`；`widthKind` / `equidistant` /
 * `TimeSlot.index` 原样保留——画多宽与「这一列的宽度是怎么定的」是两个维度的事实。
 *
 * 无变化时返回**同一个对象引用**（`spacing`），方便调用方 / 测试用引用相等判断
 * 「这个 measure 完全没被动过」。
 */
export function widenForStaffGlyphs(
  spacing: MeasureSpacing,
  items: readonly RenderItem[],
  measurer: TextMeasurer,
): MeasureSpacing {
  const effectiveWidths = spacing.slots.map((spacedSlot, offset) => {
    if (spacedSlot.widthKind === 'overlay') return SLOT_SPACING_METRICS.overlaySlotWidth;
    const item = items[offset];
    const required = item === undefined ? 0 : requiredSlotWidth(item, measurer);
    return Math.max(spacedSlot.slot.width, required);
  });

  const changed = effectiveWidths.some(
    (width, offset) => width !== spacing.slots[offset]?.slot.width,
  );
  if (!changed) {
    return spacing;
  }

  const slots: SpacedSlot[] = [];
  let x = 0;
  for (const [offset, spacedSlot] of spacing.slots.entries()) {
    const width = effectiveWidths[offset] ?? spacedSlot.slot.width;
    const slot: TimeSlot = { index: spacedSlot.slot.index, x, width };
    slots.push({ slot, widthKind: spacedSlot.widthKind });
    x += width;
  }

  return { slots, width: x, equidistant: spacing.equidistant };
}
