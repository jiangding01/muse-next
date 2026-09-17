/**
 * notation/layout —— time-slot 排布（M2 方案 v1.1.1 §2.6 / §2.6.1，T4）。
 *
 * 职责只有一件：**把一段 `RenderItem` 序列变成一串确定性的列宽**。它不认识任何一种
 * 记谱法，也不画任何东西——`JianpuLayout` / `TabLayout` 各自拿着这串列去摆自己的字形。
 *
 * 四条硬约束：
 *
 * 1. **不涉及「拍」**（P1-3）：`Rational` 是相对全音符的绝对音长，`Meter` **不参与**
 *    本文件的任何计算。列宽只是「以四分音符为基准列宽的线性加权」，不是拍宽。
 * 2. **tuplet 不缩放**（P1-C）：成员按**字面** `duration` 排布，全文件没有任何读
 *    `p` / `q` 的代码——`q === 0` 的语义是 UNVERIFIED（U25），渲染层不去猜。
 * 3. **`duration` 缺失 → 固定宽 + 该 measure 整体退等距**（§2.6.1 / R4）：不反推
 *    音乐时值、不看 `durationRaw`。measure 内一旦出现不可解事件就**整体**退等距，
 *    避免「一半时值加权、一半固定宽」产生的视觉错位。
 * 4. **不可表示的 `duration`**（`1/3` / `5/16`）**不走等距**：方案 §2.6.1 明写它
 *    「宽度按字面 `duration` 排布」——它的时值是已知的，只是画不出时值装饰，
 *    这与「时值根本不可知」是两件事，降级方式也不同。
 *
 * 确定性：同一 `items` 必然得到逐字段相等的输出，不依赖宿主字体、不依赖调用顺序。
 * 单位是 abstract unit（D6），**不是像素**。
 */

import type { MusicEvent, Rational } from '../../domain';
import type { RenderItem } from '../model/types';
import { SLOT_SPACING_METRICS } from './metrics';
import type { TimeSlot } from './primitives';

/**
 * 一列宽度的来源，用于让上层（诊断关联、测试）看清这列是怎么算出来的。
 *
 * - `timed`：按字面 `duration` 加权；
 * - `untimed`：该事件在记谱上本就不带时值（小节线 / 装饰 / 倚音 / 未知），取固定窄列，
 *   **不是降级**，不关联诊断；
 * - `overlay`：该事件是**贴在别的列上的标注**（当前只有和弦符号），零宽、不占节奏
 *   位置，**不是降级**；
 * - `fallback`：`duration` 应有而缺失（`L:` 不可知），取固定占位宽——**降级**；
 * - `equidistant`：所在 measure 因出现 `fallback` 而整体退等距——**降级**。
 */
export type SlotWidthKind = 'timed' | 'untimed' | 'overlay' | 'fallback' | 'equidistant';

/**
 * 一列：几何部分是 `TimeSlot`（primitive），来源部分是本层的解释。
 *
 * **overlay 列的语义**（`widthKind === 'overlay'`）：`slot.width` 恒为 0，`slot.x`
 * 因此与**后续第一个有实际列宽的列**的 `x` 相等（累计 x 不前进）；该列位于段末时
 * `slot.x` 等于整段的宽度，即 measure 末端。它不贡献任何段宽，也**不参与**等距降级
 * （见 `spaceItems`）——退等距是「时值不可知，只好让每列一样宽」，overlay 列压根没有
 * 时值可言，统一改宽只会把空档换个地方长出来。消费方（`jianpuSlotWidths.ts` /
 * `tabSlotWidths.ts` 的重累计、`layoutSystems`）必须保持这两条不变量。
 */
export interface SpacedSlot {
  readonly slot: TimeSlot;
  readonly widthKind: SlotWidthKind;
}

/** 一段（通常是一个 measure）排布完的结果。`x` 是**段内**相对坐标，起点为 0。 */
export interface MeasureSpacing {
  readonly slots: readonly SpacedSlot[];
  /** 段的总宽 = 各列宽之和。 */
  readonly width: number;
  /** 该段是否因 `duration` 缺失而整体退等距（§2.6.1）。 */
  readonly equidistant: boolean;
}

/**
 * 「这个事件在记谱上应当带时值吗」。
 *
 * 判据与 `model/buildRenderScore.ts` 的同名判断**同源于 Domain 的事件定义**
 * （`grace` 不占时值见 spec §21；`barline` / `decoration` / `chordSymbol` / `unknown`
 * 本就没有时值字段），而不是互相推断。两处各自按 Domain 定义写一遍是有意的：
 * 让一处改动不会悄悄改变另一处的语义，`switch` 的穷尽性检查会在 Domain 新增事件类型
 * 时同时点亮两个文件。
 *
 * `chordSymbol` 分支在 `itemSlotWidth` 里已经被 overlay 判定先行截住，走不到这里；
 * 仍然列出来是为了保住 `switch` 的穷尽性检查——删掉它会让「Domain 新增事件类型」
 * 这件事在本文件失去报警。
 */
function timedDurationOf(
  event: MusicEvent,
): { readonly timed: false } | { readonly timed: true; readonly duration: Rational | undefined } {
  switch (event.kind) {
    case 'note':
      return { timed: true, duration: event.note.duration };
    case 'rest':
      return { timed: true, duration: event.rest.duration };
    case 'tabNote':
      return { timed: true, duration: event.note.duration };
    case 'chord':
    case 'tabGroup':
      return { timed: true, duration: event.duration };
    case 'grace':
    case 'barline':
    case 'decoration':
    case 'chordSymbol':
    case 'unknown':
      return { timed: false };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

/**
 * 时值加权列宽：以四分音符为基准线性加权，再夹在上下界之间。
 *
 * `duration / (1/4)` 就是「几个四分音符」——注意这里的除法**只是数值比例**，
 * 不是「几拍」：它不读 `Meter`，也不假设一拍等于四分音符（P1-3）。
 * 夹逼是**产品决定**：太窄画不下减时线，太宽会让全音符独占一行。
 */
export function timedSlotWidth(duration: Rational): number {
  // 四分音符 = 1/4（绝对音长，不是拍）；`quarters` 是「这个时值相当于几个四分音符」。
  const quarterDuration = 1 / 4;
  const quarters = duration.num / duration.den / quarterDuration;
  const raw = quarters * SLOT_SPACING_METRICS.quarterWidth;
  return Math.min(
    SLOT_SPACING_METRICS.maxSlotWidth,
    Math.max(SLOT_SPACING_METRICS.minSlotWidth, raw),
  );
}

/**
 * 单个事件的列宽与来源（未考虑所在 measure 是否退等距）。
 *
 * **overlay 判定只此一处**（`spaceItems` 只负责按 `kind` 累计，不再重复判事件类型）：
 * 和弦符号（spec §25）标注「此处开始是这个和弦」，不消费节奏时间，因此取零宽 overlay
 * 列贴在后续列上，而不是像装饰 / 小节线那样占一个 `untimedSlotWidth` 的窄列——人工
 * 复验里它在 TAB 六线与节奏带上撕开的空档正来自后者。装饰（`decoration`）**保持
 * `untimed` 不变**：它画的是一个独立占位文本，不是贴在别人身上的标注。
 */
export function itemSlotWidth(item: RenderItem): { readonly width: number; readonly kind: SlotWidthKind } {
  if (item.event.kind === 'chordSymbol') {
    return { width: SLOT_SPACING_METRICS.overlaySlotWidth, kind: 'overlay' };
  }
  const timing = timedDurationOf(item.event);
  if (!timing.timed) {
    return { width: SLOT_SPACING_METRICS.untimedSlotWidth, kind: 'untimed' };
  }
  if (timing.duration === undefined) {
    // `L:` 不可知 → 固定占位宽，**不反推时值、不看 durationRaw**（§2.6.1 R4）。
    return { width: SLOT_SPACING_METRICS.fallbackSlotWidth, kind: 'fallback' };
  }
  // 不可表示的 duration（1/3、5/16）同样走这条：它的时值是已知的，
  // 只是画不出时值装饰——「宽度按字面 duration 排布」（§2.6.1）。
  return { width: timedSlotWidth(timing.duration), kind: 'timed' };
}

/**
 * 给一段 items 排布列宽。
 *
 * @param items 该段的事件序列（通常是一个 measure，**含作为切点的 barline 本身**）。
 * @param firstSlotIndex 该段首列在整个声部内的列序号（`TimeSlot.index` 声部内单调递增）。
 */
export function spaceItems(
  items: readonly RenderItem[],
  firstSlotIndex: number,
): MeasureSpacing {
  const measured = items.map((item) => itemSlotWidth(item));
  const equidistant = measured.some((entry) => entry.kind === 'fallback');

  const slots: SpacedSlot[] = [];
  let x = 0;
  for (const [offset, entry] of measured.entries()) {
    // overlay 列不参与等距降级：它零宽、不占节奏位置，统一改成 `equidistantSlotWidth`
    // 只会把空档换个地方长出来（见 `SpacedSlot` 的 overlay 语义说明）。
    const overlay = entry.kind === 'overlay';
    const width = overlay ? entry.width : equidistant ? SLOT_SPACING_METRICS.equidistantSlotWidth : entry.width;
    slots.push({
      slot: { index: firstSlotIndex + offset, x, width },
      widthKind: overlay ? 'overlay' : equidistant ? 'equidistant' : entry.kind,
    });
    x += width;
  }

  return { slots, width: x, equidistant };
}
