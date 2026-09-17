/**
 * notation/jianpu —— 简谱延音线的槽宽兜底（用户裁决方案，2026-09-17）。
 *
 * 背景：`layout/spacing.ts` 的 `timedSlotWidth` 把槽宽夹在
 * `SLOT_SPACING_METRICS.maxSlotWidth`（96u）以内——这条上界是**跨记谱通用**的产品
 * 决定，不因某一种记谱画得下画不下而改变（`spacing.ts` 不认识任何一种记谱）。但简谱
 * 用延音线表达长时值（`jianpuGlyphs.ts` 的 `buildDurationGlyphs`），条数由
 * `decomposeDuration` 给出；条数一多，延音线的水平延展就会超过 96u 夹逼后的槽宽，
 * 右侧溢出压到下一个槽（典型地是紧随其后的小节线）上。
 *
 * 修复只加宽、不缩窄：`spacing.ts` / `metrics.ts` 的 `maxSlotWidth` 保持不变（它对
 * 其余三种记谱、以及简谱里不含长延音线的槽仍然是对的），本文件在简谱自己的 layout
 * 步骤里，对每个槽单独核实「延音线画不画得下」，画不下就把**这一个槽**（连同同一
 * measure 内所有槽的 x 累计）撑宽到刚好放得下，其余槽原样不动。
 *
 * 依赖方向单向 `layoutJianpu.ts → jianpuSlotWidths.ts → layout/spacing.ts`
 * `→ model/duration.ts`，无环；尺寸一律取自 `metrics.ts` 的 `JIANPU_METRICS`
 * （唯一来源），单位是 abstract unit（D6，不是像素）。
 */

import { JIANPU_METRICS, SLOT_SPACING_METRICS } from '../layout/metrics';
import type { MeasureSpacing, SpacedSlot } from '../layout/spacing';
import type { TimeSlot } from '../layout/primitives';
import { decomposeDuration } from '../model/duration';
import type { RenderItem } from '../model/types';

/**
 * `dashes` 条延音线（`jianpuGlyphs.ts` 的画法：
 * `x + dashFirstOffset + i × (dashLength + dashGap)`，每条长 `dashLength`）从数字
 * 字形左边界向右延展多远。全部从 `JIANPU_METRICS` 推导，不硬编码任何具体数值。
 *
 * `dashes ≤ 0`（没有延音线，含未分解出延音线的常规时值）返回 0——此时这个函数不对
 * 槽宽表达任何意见，调用方仍以原槽宽为准。
 */
export function requiredDashExtent(dashes: number): number {
  if (dashes <= 0) {
    return 0;
  }
  return (
    JIANPU_METRICS.dashFirstOffset +
    (dashes - 1) * (JIANPU_METRICS.dashLength + JIANPU_METRICS.dashGap) +
    JIANPU_METRICS.dashLength
  );
}

/**
 * 一个渲染项在简谱记谱下的延音线条数。判据与 `jianpuEventNodes.ts` 同源同一份
 * 时值取法（note → `event.note.duration`、rest → `event.rest.duration`、chord →
 * `event.duration`）——两处各自按 Domain 定义写一遍是有意的（见 `spacing.ts` 里
 * `timedDurationOf` 的同一段说明）；其余 kind 本就不带时值，不参与本次核实。
 *
 * `duration === undefined`（`L:` 不可知）与 `decomposeDuration` 判定
 * `unrepresentable` 的情形一律返回 0：前者没有时值可分解，后者虽有时值但画不出任何
 * 时值装饰（含延音线），两者都不应把槽撑宽。
 */
function dashesOf(item: RenderItem): number {
  const event = item.event;
  const duration =
    event.kind === 'note' ? event.note.duration
    : event.kind === 'rest' ? event.rest.duration
    : event.kind === 'chord' ? event.duration
    : undefined;
  if (duration === undefined) {
    return 0;
  }
  const decomposition = decomposeDuration(duration);
  return decomposition.kind === 'glyph' ? decomposition.dashes : 0;
}

/**
 * 一个槽实际需要的宽度：延音线 bbox 延展 + 尾部留白。`requiredDashExtent` 只回答
 * 「延音线字形画到哪」——它是 bbox，不含任何呼吸空间，紧贴着放下一个槽（典型地是
 * 小节线）视觉上会贴线。留白量**复用 `JIANPU_METRICS.dashGap`**（相邻两条延音线的
 * 间距）而不是新增一个常量：产品决定是「延音线与下一个槽之间也留一条 dash 间隙那么
 * 宽」，没有另立标准的理由。`dashes ≤ 0`（没有延音线）不加留白——没有延音线就没有
 * 「延音线与下一槽之间」这回事，此时这个函数仍不对槽宽表达任何意见。
 */
function requiredSlotWidth(dashes: number): number {
  if (dashes <= 0) {
    return 0;
  }
  return requiredDashExtent(dashes) + JIANPU_METRICS.dashGap;
}

/**
 * 按每个槽实际要画的延音线延展（含尾部留白），加宽 `spaceItems` 排出的槽宽——只
 * 加宽、不缩窄（`effective = max(slot.width, requiredSlotWidth(dashes))`）。
 *
 * `items` 必须与 `spacing.slots` 同序同长（调用方传入同一个 measure 的
 * `measure.items`）：第 i 个 item 对应第 i 个 slot。任一槽变宽时，重新累计该
 * measure 内所有槽的 `x`（段内相对坐标从 0 起）与总 `width`；`widthKind` /
 * `equidistant` 原样保留——延音线的画法与「这一列的宽度是怎么定的」是两个维度的
 * 事实，加宽不改变后者的解释。`TimeSlot.index` 原样保留。
 *
 * 无变化时返回**同一个对象引用**（`spacing`），方便调用方 / 测试用引用相等判断
 * 「这个 measure 完全没被动过」。
 */
export function widenForJianpuGlyphs(
  spacing: MeasureSpacing,
  items: readonly RenderItem[],
): MeasureSpacing {
  const effectiveWidths = spacing.slots.map((spacedSlot, offset) => {
    // overlay 列恒零宽（`layout/spacing.ts` 的 `SpacedSlot` 语义）：加宽它就等于把
    // 和弦符号重新变回一个占位列，正是 T6.5 要消掉的空档。
    if (spacedSlot.widthKind === 'overlay') return SLOT_SPACING_METRICS.overlaySlotWidth;
    const item = items[offset];
    const extent = item === undefined ? 0 : requiredSlotWidth(dashesOf(item));
    return Math.max(spacedSlot.slot.width, extent);
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
