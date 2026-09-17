/**
 * notation/tab —— 品位数字 / 时值装饰的槽宽兜底（M2 方案 §3.3，T6.1 品位文本、
 * T6.2 追加时值装饰延展）。
 *
 * 背景与 `jianpu/jianpuSlotWidths.ts` 同构，但**起因不同**：`layout/spacing.ts` 的
 * 槽宽只按字面 `duration` 加权，它不认识任何一种记谱，因此也不知道 TAB 的品位数字
 * 可能是**两位数**（`12`、`24`），也不知道减时线 / 延音短横线会往右延展多远。短
 * 时值的槽（`SLOT_SPACING_METRICS.minSlotWidth` = 12u）既放不下一个两位品位 + 左右
 * 留白，也放不下十六分音符的两条减时线或 breve 的七条延音短横线——右侧都会压到
 * 下一个槽（典型地是紧随其后的小节线）上。
 *
 * 修复只加宽、不缩窄：共享的 `spacing.ts` / `metrics.ts` 的 `maxSlotWidth` /
 * `minSlotWidth` 保持不变（它们对其余三种记谱仍然是对的），本文件在 TAB 自己的
 * layout 步骤里逐槽核实「最宽的那个品位文本 / 时值装饰画不画得下」，取两者所需
 * 宽度的较大者，画不下就把**这一个槽**（连同同一 measure 内所有槽的 x 累计）撑宽
 * 到刚好放得下，其余槽原样不动。
 *
 * 只核实 `tabNote` / `tabGroup` / `rest`：它们是唯一会画品位数字或时值装饰的事件。
 * 倚音（`grace`）不占时值、不画时值装饰，且字形整体做水平偏移画在主音旁边（见
 * `tabEventNodes.ts`），它的宽度不由自己的槽承担；其余 kind 本就不画这两类字形。
 *
 * 依赖方向单向 `layoutTab.ts → tabSlotWidths.ts → { layout/spacing.ts,
 * tabDurationGlyphs.ts }`，无环；尺寸一律取自 `metrics.ts` 的 `TAB_METRICS`
 * （唯一来源），单位是 abstract unit。
 */

import type { Rational } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { MeasureSpacing, SpacedSlot } from '../layout/spacing';
import type { TimeSlot } from '../layout/primitives';
import type { TextMeasurer } from '../layout/textMeasurer';
import { decomposeDuration } from '../model/duration';
import type { RenderItem } from '../model/types';
import { requiredDurationExtent } from './tabDurationGlyphs';

/**
 * 一个渲染项在 TAB 记谱下**最宽**的品位文本宽度；不画品位的事件返回 0——此时本函数
 * 不对槽宽表达任何意见，调用方仍以原槽宽为准。
 *
 * 文本取法与 `tabGlyphs.ts` 的 `buildFretGlyph` 同源（`String(fret)`：多位品位整体
 * 一个文本，`'x'` 显示 `x`）。两处各自写一遍是有意的：一处改动不会悄悄改变另一处。
 */
function widestFretTextWidth(item: RenderItem, measurer: TextMeasurer): number {
  const event = item.event;
  const fontSize = TAB_METRICS.fretFontSize;
  if (event.kind === 'tabNote') {
    return measurer.measure(String(event.note.fret), { fontSize }).width;
  }
  if (event.kind !== 'tabGroup') {
    return 0;
  }
  let widest = 0;
  for (const member of event.members) {
    widest = Math.max(widest, measurer.measure(String(member.fret), { fontSize }).width);
  }
  return widest;
}

/**
 * 一个渲染项的时值——判据与 `tabEventNodes.ts` 同源同一份取法（`tabNote` →
 * `event.note.duration`、`tabGroup` → `event.duration`【末音】、`rest` →
 * `event.rest.duration`）；两处各自按 Domain 定义写一遍是有意的（见
 * `jianpu/jianpuSlotWidths.ts` 的 `dashesOf` 的同一段说明）。其余 kind 不带时值。
 *
 * 导出给 `layoutTab.ts` 复用（按行谱回填高度也要同一份时值取法）——它与本文件同属
 * TAB-only 模块、单向依赖 `layoutTab.ts → tabSlotWidths.ts`，复用不引入新的耦合面。
 */
export function durationOf(item: RenderItem): Rational | undefined {
  const event = item.event;
  if (event.kind === 'tabNote') return event.note.duration;
  if (event.kind === 'tabGroup') return event.duration;
  if (event.kind === 'rest') return event.rest.duration;
  return undefined;
}

/** 一个渲染项的时值装饰所需水平延展；`duration === undefined` 视为 0（无装饰可画）。 */
function requiredDurationSlotWidth(item: RenderItem): number {
  const duration = durationOf(item);
  return duration === undefined ? 0 : requiredDurationExtent(decomposeDuration(duration));
}

/**
 * 一个槽实际需要的宽度：取「最宽品位文本 + 左右各一份 `fretPaddingX`」与「时值
 * 装饰的水平延展」两者的较大值——两个下界来自不同的字形（品位数字 vs 符干/减时线/
 * 延音短横线），互不包含对方，故不能只核实其中一个。
 */
function requiredSlotWidth(item: RenderItem, measurer: TextMeasurer): number {
  const textWidth = widestFretTextWidth(item, measurer);
  const fretRequirement = textWidth === 0 ? 0 : textWidth + 2 * TAB_METRICS.fretPaddingX;
  return Math.max(fretRequirement, requiredDurationSlotWidth(item));
}

/**
 * 按每个槽实际要画的品位文本宽度，加宽 `spaceItems` 排出的槽宽——只加宽、不缩窄
 * （`effective = max(slot.width, required)`）。
 *
 * `items` 必须与 `spacing.slots` 同序同长（调用方传入同一个 measure 的
 * `measure.items`）：第 i 个 item 对应第 i 个 slot。任一槽变宽时，重新累计该 measure
 * 内所有槽的 `x`（段内相对坐标从 0 起）与总 `width`；`widthKind` / `equidistant` /
 * `TimeSlot.index` 原样保留——品位画多宽与「这一列的宽度是怎么定的」是两个维度的
 * 事实，加宽不改变后者的解释。
 *
 * 无变化时返回**同一个对象引用**（`spacing`），方便调用方 / 测试用引用相等判断
 * 「这个 measure 完全没被动过」。
 */
export function widenForTabGlyphs(
  spacing: MeasureSpacing,
  items: readonly RenderItem[],
  measurer: TextMeasurer,
): MeasureSpacing {
  const effectiveWidths = spacing.slots.map((spacedSlot, offset) => {
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
