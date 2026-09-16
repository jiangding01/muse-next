/**
 * notation/layout —— measure 切分与 system 贪心换行（M2 方案 v1.1.1 §2.6 / D7，T4）。
 *
 * **Domain 是 flat 的**：`Voice.events` 里没有 measure、没有 system、没有 beat。这两个
 * 概念一律在本文件派生，**绝不回头往 `src/domain/**` 里加音乐事实**（§2.6，§7-4）。
 *
 * 切分规则（§2.6 表）：以 `BarlineEvent` 为切点，**切点事件本身不被消费**——它仍然
 * 留在 `items` 里并被渲染成一根小节线。这与 parse 层「marker 被消费成 Relation」是
 * 两回事：那里 marker 消失了，这里小节线还在。归属上小节线**收尾**它所结束的那个
 * measure（`| CDE |` 的第二根线属于 `CDE` 这一小节），于是「measure 的最后一项是不是
 * 小节线」就等价于「这一小节是否有终止线」，不需要额外的旗标。
 *
 * 换行规则（D7）：**system 级贪心填充，不分页**。按容器可用宽度累加 measure 宽度，
 * 装不下就换行；单个 measure 宽于容器时**独占一行不再拆**——拆小节需要的是迭代式
 * 重排（D7 判据：需反复试排的后移），M2 不做。
 *
 * 确定性：同一 `(items, widths, availableWidth)` 必然得到逐字段相等的输出。
 * 单位是 abstract unit（D6），**不是像素**；本文件**不含任何尺寸常量**，
 * 几何参数一律由调用方从 `metrics.ts` 取来显式传入。
 */

import type { RenderItem } from '../model/types';
import type { Box, System } from './primitives';

/** 一个 measure：切分只切位置，不复制也不改写任何事件（`items` 是原数组的切片引用）。 */
export interface MeasureSlice {
  /** 声部内的 measure 序号，0-based，随事件序单调递增。 */
  readonly index: number;
  /** 本段首项在 `voice.items` 中的下标——列序号也从这里连续派生。 */
  readonly startIndex: number;
  /** 本段的事件序列，**含作为切点的 `BarlineEvent` 本身**（不被消费）。 */
  readonly items: readonly RenderItem[];
}

/** 一个 measure 被放到了哪一行的哪个横向位置。 */
export interface MeasurePlacement {
  readonly measureIndex: number;
  readonly systemIndex: number;
  /** 该 measure 左边界在其所在 system box 内的横向偏移。 */
  readonly x: number;
}

export interface SystemLayout {
  readonly systems: readonly System[];
  readonly placements: readonly MeasurePlacement[];
}

/** system 的几何参数，由调用方从 `metrics.ts` 取来传入（不设默认值，§2.8 同理）。 */
export interface SystemGeometry {
  /** 容器可用宽度：贪心换行的唯一阈值。 */
  readonly availableWidth: number;
  /** 一行谱的高度。 */
  readonly systemHeight: number;
  /** 相邻两行之间的垂直间隙。 */
  readonly systemGap: number;
  /** 第一行顶边的纵向起点（头部标签区之下）。 */
  readonly originY: number;
}

/**
 * 以 barline 为切点切分 measure。
 *
 * - 小节线**收尾**它所在的 measure，因此紧随其后的事件开启下一个 measure；
 * - 开头就是小节线（`|: CDE`）时，第一个 measure 只含那根线——这是事实的如实呈现，
 *   不把它并进后面那小节（并进去就等于替作者判断「这根线属于哪一小节」）；
 * - 末尾没有小节线时，剩余事件构成最后一个 measure；没有剩余则不产生空 measure。
 */
export function splitMeasures(items: readonly RenderItem[]): readonly MeasureSlice[] {
  const measures: MeasureSlice[] = [];
  let startIndex = 0;

  for (const [offset, item] of items.entries()) {
    if (item.event.kind !== 'barline') {
      continue;
    }
    measures.push({
      index: measures.length,
      startIndex,
      items: items.slice(startIndex, offset + 1),
    });
    startIndex = offset + 1;
  }

  if (startIndex < items.length) {
    measures.push({ index: measures.length, startIndex, items: items.slice(startIndex) });
  }

  return measures;
}

/**
 * 贪心换行：按 measure 宽度顺序填充，装不下就换行。
 *
 * `measureWidths[i]` 是第 i 个 measure 的总宽（由 `spacing.ts` 算出）。空输入返回
 * 零 system——**不造一个空行**，「没有内容」和「有一行但空着」是两件事。
 */
export function layoutSystems(
  measureWidths: readonly number[],
  geometry: SystemGeometry,
): SystemLayout {
  const systems: System[] = [];
  const placements: MeasurePlacement[] = [];

  let systemIndex = 0;
  let cursorX = 0;
  let systemWidth = 0;

  const closeSystem = (): void => {
    systems.push({ index: systemIndex, box: systemBox(systemIndex, systemWidth, geometry) });
    systemIndex += 1;
    cursorX = 0;
    systemWidth = 0;
  };

  for (const [measureIndex, width] of measureWidths.entries()) {
    // 「至少一个 measure」优先于「不超宽」：宽于容器的单个 measure 独占一行，不拆。
    if (cursorX > 0 && cursorX + width > geometry.availableWidth) {
      closeSystem();
    }
    placements.push({ measureIndex, systemIndex, x: cursorX });
    cursorX += width;
    systemWidth = cursorX;
  }

  if (placements.length > 0) {
    closeSystem();
  }

  return { systems, placements };
}

function systemBox(index: number, width: number, geometry: SystemGeometry): Box {
  return {
    origin: { x: 0, y: geometry.originY + index * (geometry.systemHeight + geometry.systemGap) },
    width,
    height: geometry.systemHeight,
  };
}

/**
 * 纵向重排：把已经**横向排好**的 system 序列按各自的额外高度重新堆叠（T5.2-A）。
 *
 * 为什么要分两步：`layoutSystems` 的横向打包（哪个 measure 落在第几行、行内 x 多少）
 * 只取决于 measure 宽度与容器宽度，**与行高无关**；而一行实际要多高，取决于该行里
 * 出现了几行歌词——那要等横向归属定下来才知道。于是先打包、再回填行高，两步都是纯
 * 函数，合起来仍然确定性。
 *
 * `extraHeights[i]` 是第 i 行在 `geometry.systemHeight` 之外额外需要的高度（负值按 0
 * 处理）。相邻两行的垂直范围因此恒不相交（间隔恰为 `systemGap`）。`box.width` 与
 * `index` 原样保留——本函数只动 y 与 height。
 */
export function restackSystems(
  systems: readonly System[],
  extraHeights: readonly number[],
  geometry: Pick<SystemGeometry, 'systemHeight' | 'systemGap' | 'originY'>,
): readonly System[] {
  const restacked: System[] = [];
  let y = geometry.originY;
  for (const system of systems) {
    const extra = Math.max(0, extraHeights[system.index] ?? 0);
    const height = geometry.systemHeight + extra;
    restacked.push({
      index: system.index,
      box: { origin: { x: system.box.origin.x, y }, width: system.box.width, height },
    });
    y += height + geometry.systemGap;
  }
  return restacked;
}
