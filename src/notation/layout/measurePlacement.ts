/**
 * notation/layout —— 把一个声部的 measure 放进**外部给定**的公共 measure 框（M2.5 T5，用户裁决 A–P，2026-10-05）。
 *
 * 三个 voice layout 的 external 路径共用本文件；它不认识任何记谱，也**不 import `system/**`**（守卫 6）：
 * 输入是与 `system/contracts` 的 `SystemMeasureGeometry` / `MeasureTimeline` 同名同义的结构类型，调用方
 * 直接传后者，由编译器检查可赋值性。
 *
 * - **映射**（B / C）：只按 `voiceId + participation.localMeasureIndex` 取本声部的框，绝不按数组下标；
 *   system 按 `System.index` 建 Map，全局 index 原样保留、空 system 保留、按 index 升序返回。
 * - **shared**（D / E-c / J）：timed 项按 `voiceMeasureOnsets` 的 onset 与 `timeline.offsets` 精确匹配，
 *   每个不同 offset 的首个 timed 项是锚点，x 恒为 `xByOffsetIndex[k]`；同 onset 的后续 timed 项从锚点起
 *   保原宽向右排；其余 untimed 项保原宽、整串右贴下一锚点（末段贴 `endX`）；收尾 barline 在 `endX`。
 * - **tier 3**（F-d）：非尾项按本声部比例拉满 `contentOffsetX → width − 尾宽`，收尾 barline 保原宽钉右。
 *
 * 越界判定都与 T4 的需求求和**同序、同源**，因而可以精确比较：shared 段内原宽按项顺序累加，与公共区间宽
 * （tick 网格上的两个 x 之差）比；tier 3 比整小节原宽与内容宽。任何 mapping / system / timeline / 数值
 * 不变量失败一律 `RangeError`（A2），**绝不回退**默认路径或 tier 3。产出的 slot 是新对象（P），
 * `x` 为 measure 内最终相对 x、`width` 为最终分到的列宽，原 spacing 不被修改。
 */

import type { Rational, VoiceId } from '../../domain';
import { cmp, equals } from '../../domain';
import { voiceMeasureOnsets } from './measureOnsets';
import type { System } from './primitives';
import type { MeasureSpacing, SpacedSlot } from './spacing';
import type { MeasureSlice } from './systems';

/** 与 `system/contracts` 的 `MeasureTimeline` 同名同义。 */
export interface ExternalTimeline {
  readonly offsets: readonly Rational[];
  readonly total: Rational;
  readonly xByOffsetIndex: readonly number[];
  readonly endX: number;
}

export type ExternalParticipation =
  | { readonly voiceId: VoiceId; readonly kind: 'present' | 'incompatible'; readonly localMeasureIndex: number }
  | { readonly voiceId: VoiceId; readonly kind: 'absent' };

/** `SystemMeasureGeometry` 的结构子集。 */
export interface ExternalMeasureBox {
  readonly systemIndex: number;
  readonly x: number;
  readonly width: number;
  readonly contentOffsetX: number;
  readonly timeline?: ExternalTimeline;
  readonly participation: readonly ExternalParticipation[];
}

export interface MappedExternalGeometry {
  readonly byLocal: ReadonlyMap<number, ExternalMeasureBox>;
  /** 按 `System.index` 升序；全局 index 原样，本声部没有 measure 的 system 也保留。 */
  readonly systems: readonly System[];
  readonly systemByIndex: ReadonlyMap<number, System>;
}

function fail(message: string): never {
  throw new RangeError(`external geometry: ${message}`);
}

function finite(...values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function checkBox(box: ExternalMeasureBox, label: string): void {
  if (!finite(box.x, box.width, box.contentOffsetX) || box.contentOffsetX < 0 || box.width < box.contentOffsetX) {
    fail(`${label} 的 x / width / contentOffsetX 非法`);
  }
  const timeline = box.timeline;
  if (timeline === undefined) return;
  const xs = timeline.xByOffsetIndex;
  if (xs.length !== timeline.offsets.length || !finite(...xs, timeline.endX)) fail(`${label} 的 timeline 形状非法`);
  if (timeline.offsets.some((offset, i) => i > 0 && cmp(offset, timeline.offsets[i - 1] ?? offset) <= 0)) fail(`${label} 的 timeline.offsets 不严格递增`);
  const chain = [box.contentOffsetX, ...xs, timeline.endX, box.width];
  if (chain.some((x, i) => i > 0 && x < (chain[i - 1] ?? x))) fail(`${label} 的 timeline x 不单调或越出 measure`);
}

/** 本声部的 localMeasureIndex → 公共框（键集合必须恰为 0..n−1），以及按 index 查找的 system。 */
export function mapExternalMeasures(
  voiceId: VoiceId,
  slices: readonly MeasureSlice[],
  input: { readonly measures: readonly ExternalMeasureBox[]; readonly systems: readonly System[] },
): MappedExternalGeometry {
  const systemByIndex = new Map<number, System>();
  for (const system of input.systems) {
    if (!Number.isSafeInteger(system.index) || systemByIndex.has(system.index)) fail(`system index ${String(system.index)} 非法或重复`);
    const box = system.box;
    if (!finite(box.origin.x, box.origin.y, box.width, box.height) || box.width < 0 || box.height < 0) fail(`system ${String(system.index)} 的 box 非法`);
    systemByIndex.set(system.index, system);
  }
  const byLocal = new Map<number, ExternalMeasureBox>();
  for (const box of input.measures) {
    const own = box.participation.filter((entry) => entry.voiceId === voiceId);
    if (own.length > 1) fail(`同一 measure 上声部 ${voiceId} 出现 ${String(own.length)} 次`);
    const entry = own[0];
    if (entry === undefined || entry.kind === 'absent') continue;
    const local = entry.localMeasureIndex;
    const label = `声部 ${voiceId} 第 ${String(local)} 个 measure`;
    if (!Number.isSafeInteger(local) || local < 0 || local >= slices.length) fail(`${label} 越界`);
    if (byLocal.has(local)) fail(`${label} 重复映射`);
    if (!systemByIndex.has(box.systemIndex)) fail(`${label} 的 systemIndex ${String(box.systemIndex)} 不在 systems 中`);
    if (box.timeline !== undefined && entry.kind !== 'present') fail(`${label} 是 incompatible 却带 timeline`);
    checkBox(box, label);
    byLocal.set(local, box);
  }
  if (byLocal.size !== slices.length) fail(`声部 ${voiceId} 有 ${String(slices.length)} 个 measure，只映射到 ${String(byLocal.size)} 个`);
  const systems = [...input.systems].sort((a, b) => a.index - b.index);
  return { byLocal, systems, systemByIndex };
}

/** 按项顺序累加原宽（与 T4 `measureDemand` 的段内求和同序，保证可与公共区间精确比较）。 */
function sumOf(widths: readonly number[], from: number, to: number): number {
  let sum = 0;
  for (let j = from; j < to; j += 1) sum += widths[j] ?? 0;
  return sum;
}

/** shared：返回每个非尾项的最终起点（measure 内相对）。 */
function sharedStarts(slice: MeasureSlice, widths: readonly number[], box: ExternalMeasureBox, timeline: ExternalTimeline, bodyEnd: number): number[] {
  const onsets = voiceMeasureOnsets(slice);
  if (!onsets.resolved || !equals(onsets.total, timeline.total)) fail(`第 ${String(slice.index)} 个 measure 的本地时值与 timeline 不一致`);
  const offsetOf = new Map<number, number>();
  for (const timed of onsets.timed) {
    const k = timeline.offsets.findIndex((offset) => equals(offset, timed.onset));
    if (k < 0) fail(`第 ${String(slice.index)} 个 measure 的 onset 不在 timeline.offsets 中`);
    offsetOf.set(timed.itemIndex, k);
  }
  // 区间：lead（无锚点，起点 contentOffsetX）+ 每个不同 offset 的首个 timed 项。
  const bounds: { readonly from: number; readonly x: number; readonly anchored: boolean }[] = [{ from: 0, x: box.contentOffsetX, anchored: false }];
  let previous = -1;
  for (const [item, k] of offsetOf) {
    if (k < previous) fail(`第 ${String(slice.index)} 个 measure 的 onset 顺序与 timeline 不一致`);
    if (k !== previous) bounds.push({ from: item, x: timeline.xByOffsetIndex[k] ?? fail('xByOffsetIndex 缺项'), anchored: true });
    previous = k;
  }
  const starts = new Array<number>(widths.length).fill(0);
  for (const [i, bound] of bounds.entries()) {
    const to = bounds[i + 1]?.from ?? bodyEnd;
    const nextX = bounds[i + 1]?.x ?? timeline.endX;
    if (sumOf(widths, bound.from, to) > nextX - bound.x) fail(`第 ${String(slice.index)} 个 measure 的段内原宽超出公共区间`);
    // 左簇：锚点 + 同 onset 的后续 timed 项（及其间的项），从锚点起保原宽向右排。
    let last = bound.from - 1;
    if (bound.anchored) for (let j = bound.from; j < to; j += 1) if (offsetOf.has(j)) last = j;
    let cursor = bound.x;
    for (let j = bound.from; j <= last; j += 1) {
      starts[j] = cursor;
      cursor += widths[j] ?? 0;
    }
    // 右簇：其余 untimed 项保原宽、整串右贴下一锚点；`max` 只吸收浮点末位噪声，不改变相对顺序。
    let suffix = 0;
    for (let j = to - 1; j > last; j -= 1) {
      suffix += widths[j] ?? 0;
      starts[j] = Math.max(cursor, nextX - suffix);
    }
  }
  return starts;
}

/**
 * tier 3：非尾项按本声部比例拉满 `contentOffsetX → width − 尾宽`；`bodyRaw = 0` 时不除零、全部落在起点。
 * 「scale < 1」按与 T4 同源的量判定：本声部整小节原宽（T4 tier 3 demand 的来源）大于公共内容宽。
 */
function selfStarts(spacing: MeasureSpacing, box: ExternalMeasureBox, bodyRaw: number, bodyEndX: number): number[] {
  if (spacing.width > box.width - box.contentOffsetX) fail('tier 3 本声部原宽大于公共内容宽（scale < 1）');
  const scale = bodyRaw > 0 ? (bodyEndX - box.contentOffsetX) / bodyRaw : 1;
  return spacing.slots.map((own) => Math.min(bodyEndX, box.contentOffsetX + own.slot.x * scale));
}

/** 一个 measure 的最终 slot（新对象）：`x` 为 measure 内相对 x，`width` 为最终列宽。 */
export function placeExternalMeasure(slice: MeasureSlice, spacing: MeasureSpacing, box: ExternalMeasureBox): readonly SpacedSlot[] {
  const count = slice.items.length;
  if (spacing.slots.length !== count) fail(`第 ${String(slice.index)} 个 measure 的 spacing 与切片不等长`);
  const widths = spacing.slots.map((own) => own.slot.width);
  const tail = slice.items[count - 1]?.event.kind === 'barline' ? count - 1 : -1;
  const bodyEnd = tail >= 0 ? tail : count;
  const tailWidth = widths[tail] ?? 0;
  const timeline = box.timeline;
  let starts: number[];
  let bodyEndX: number;
  let tailX: number;
  let tailFinal: number;
  if (timeline === undefined) {
    const bodyRaw = spacing.slots[bodyEnd]?.slot.x ?? spacing.width;
    bodyEndX = bodyRaw > 0 ? box.width - tailWidth : box.contentOffsetX;
    starts = selfStarts(spacing, box, bodyRaw, bodyEndX);
    // F-d：收尾 barline 保留原始列宽、钉在右端。
    tailX = box.width - tailWidth;
    tailFinal = tailWidth;
  } else {
    // 收尾 barline 在 `endX`，占满 `endX → width`（T4 tail'，tick 网格上精确可比）。
    if (tail >= 0 && tailWidth > box.width - timeline.endX) fail(`第 ${String(slice.index)} 个 measure 的收尾 barline 超出 measure`);
    bodyEndX = timeline.endX;
    starts = sharedStarts(slice, widths, box, timeline, bodyEnd);
    tailX = timeline.endX;
    tailFinal = box.width - timeline.endX;
  }
  return spacing.slots.map((own, j) => {
    if (j === tail) return { slot: { index: own.slot.index, x: tailX, width: tailFinal }, widthKind: own.widthKind };
    const x = starts[j] ?? 0;
    const end = j + 1 < bodyEnd ? starts[j + 1] ?? bodyEndX : bodyEndX;
    return { slot: { index: own.slot.index, x, width: end - x }, widthKind: own.widthKind };
  });
}

/** external 模式的宽高：按全部 system 的最大外沿，不依赖数组顺序；没有 system 时为 `undefined`。 */
export function externalExtent(systems: readonly System[]): { readonly width: number; readonly height: number } | undefined {
  if (systems.length === 0) return undefined;
  return {
    width: Math.max(...systems.map((system) => system.box.origin.x + system.box.width)),
    height: Math.max(...systems.map((system) => system.box.origin.y + system.box.height)),
  };
}
