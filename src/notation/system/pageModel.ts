/**
 * notation/system —— `PageComposedSystemLayout` → `PageModel`（M2.5 T9a，方案 §Q6.3–Q6.6 / F-8；用户裁决 A–N，
 * 2026-10-05）。纯数据：只把已组装好的 system 按顺序分配到页，不重新 compose、不拆 / 不缩放 / 不改写任何 system，
 * 不认识 renderer、voice layout 或屏幕侧的宽度 / 缩放概念（§Q6.4）。
 *
 * **调用方前置条件（裁决 J）**：`spec` 的内容宽（`width − marginLeft − marginRight`）必须等于产生 `input` 时
 * page policy 的 `contentWidth`。本函数无从反查（`ComposedSystemLayout` 不保存 policy），也**不**用 `box.width`
 * 校验——box 合法地包含伸出行宽的和弦墨迹（T8 裁决 F）。
 *
 * - 页面 box（T9a-0）：header / content / footer 都在左右边距内、等宽；header 贴上边距，content 紧接 header，footer
 *   紧接 content、其下是下边距。首页与续页唯一差别是 header 高（`firstPageHeaderHeight` / `continuationHeaderHeight`）。
 * - 分页（T9a-1，裁决 E / I / K）：只看输入顺序与 `box.height`（不读 `origin` / `width`）。页首无 gap，同页相邻
 *   system 之间恰好一个 `systemGap`，页尾无 gap，翻页不继承 gap；放得下用 `≤`。零高 system 也是 system，照样占
 *   相邻 gap（与 T8 纵向堆叠一致）。`systemIndices` 取 `ScoreSystemLayout.index`，页序 0-based 连续。
 * - 超高（T9a-2，裁决 F / G / N）：`height > 所在页内容高` 才算 overflow（相等不算）；超高 system 独占所在页并
 *   立即封页，其后的 system 一律开新页；全谱首个 system 对首页超高也留在首页（不造空首页）。每个超高 system 一条
 *   `system.page-overflow`（warning），anchor 取该 system 首层的 voice anchor——只用于定位，不表示该声部是原因。
 * - 输入校验（裁决 D / G）：PageSpec 对所有调用均校验（含空输入）——各项有限且合法、两种页的内容高 > 0；每个 system
 *   `layers` 非空、`box.height` 有限且 ≥ 0；违反一律 `RangeError`，不进入分页循环。空输入 → `pages: []`（裁决 C）。
 *
 * 诊断只含本函数的 page-overflow（裁决 B），不合并 T8 诊断；page 路径的消费方按
 * `scoreLayout.diagnostics → page diagnostics` 汇合。`barsPerStaffHint` 本期不写（裁决 H）。
 */

import type { VoiceId } from '../../domain';
import { SYSTEM_METRICS } from '../layout/metrics';
import type { Box } from '../layout/primitives';
import { RENDER_DIAGNOSTIC_CODES as CODES, collectRenderDiagnostics } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { RenderDiagnostic } from '../model/types';
import type { PageComposedSystemLayout, PageLayout, PageModel, PageSpec, ScoreSystemLayout } from './contracts';

/** `pageModel` 的产物包装（非 contract，裁决 A / B）：分配结果 + 本阶段诊断。 */
export interface PageModelResult {
  readonly model: PageModel;
  /** 只含 `muse.render.system.page-overflow`，按 system 顺序。 */
  readonly diagnostics: readonly RenderDiagnostic[];
}

/** 分页过程中的当前页（局部可变，不外泄）。 */
interface OpenPage {
  readonly capacity: number;
  readonly systemIndices: number[];
  readonly overflow: boolean;
  used: number;
}

const NON_NEGATIVE_FIELDS = [
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'firstPageHeaderHeight',
  'continuationHeaderHeight',
  'footerHeight',
] as const;

function fail(message: string): never {
  throw new RangeError(`page model: ${message}`);
}

function headerHeight(spec: PageSpec, pageIndex: number): number {
  return pageIndex === 0 ? spec.firstPageHeaderHeight : spec.continuationHeaderHeight;
}

function contentWidth(spec: PageSpec): number {
  return spec.width - spec.marginLeft - spec.marginRight;
}

function contentHeight(spec: PageSpec, pageIndex: number): number {
  return spec.height - spec.marginTop - spec.marginBottom - headerHeight(spec, pageIndex) - spec.footerHeight;
}

/** T9a-0：PageSpec 校验（裁决 D），任何非法值都不得进入分页循环。 */
function validateSpec(spec: PageSpec): void {
  for (const field of ['width', 'height'] as const) {
    const value = spec[field];
    if (!Number.isFinite(value) || value <= 0) fail(`PageSpec.${field} 必须是有限正数，实际 ${String(value)}`);
  }
  for (const field of NON_NEGATIVE_FIELDS) {
    const value = spec[field];
    if (!Number.isFinite(value) || value < 0) fail(`PageSpec.${field} 必须是有限非负数，实际 ${String(value)}`);
  }
  if (contentWidth(spec) <= 0) fail('PageSpec 的内容宽必须 > 0');
  if (contentHeight(spec, 0) <= 0) fail('PageSpec 首页内容高必须 > 0');
  if (contentHeight(spec, 1) <= 0) fail('PageSpec 续页内容高必须 > 0');
}

/** 输入 system 的结构不变量（裁决 D / G）：对**全部** system 先验、与 spec 无关；返回 overflow 定位用的首层声部。 */
function validateSystem(system: ScoreSystemLayout): VoiceId {
  const [first] = system.layers;
  if (first === undefined) fail(`system ${String(system.index)} 没有任何层`);
  const { height } = system.box;
  if (!Number.isFinite(height) || height < 0) fail(`system ${String(system.index)} 的高度非法：${String(height)}`);
  return first.voiceId;
}

/** T9a-0：一页的三个 box。 */
function pageBoxes(spec: PageSpec, pageIndex: number): Pick<PageLayout, 'headerBox' | 'contentBox' | 'footerBox'> {
  const x = spec.marginLeft;
  const width = contentWidth(spec);
  const header = headerHeight(spec, pageIndex);
  const box = (y: number, height: number): Box => ({ origin: { x, y }, width, height });
  return {
    headerBox: box(spec.marginTop, header),
    contentBox: box(spec.marginTop + header, contentHeight(spec, pageIndex)),
    footerBox: box(spec.height - spec.marginBottom - spec.footerHeight, spec.footerHeight),
  };
}

function overflowDraft(system: ScoreSystemLayout, anchorVoice: VoiceId, pageIndex: number, capacity: number): RenderDiagnosticDraft {
  const fact = `system ${String(system.index)} 的高度 ${String(system.box.height)} 超过第 ${String(pageIndex + 1)} 页内容框高度`;
  return {
    code: CODES.systemPageOverflow,
    level: 'warning',
    message: `${fact} ${String(capacity)}：独占该页，不拆分、不缩放`,
    anchor: { kind: 'voice', voiceId: anchorVoice },
  };
}

/** 把 page 版式的 system 按顺序分配到页（T9a 产物）。 */
export function pageModel(input: PageComposedSystemLayout, spec: PageSpec = SYSTEM_METRICS.page): PageModelResult {
  validateSpec(spec);
  const checked = input.systems.map((system) => ({ system, anchorVoice: validateSystem(system) }));

  const pages: OpenPage[] = [];
  const drafts: RenderDiagnosticDraft[] = [];
  let current: OpenPage | undefined;
  for (const { system, anchorVoice } of checked) {
    const { height } = system.box;
    // T9a-1：当前页一定已有首个 system（页总是随一个 system 开出），所以这里的 required 恒带一个 gap；
    // 新页的首个 system 不带 gap（used = height）。overflow 页不需要单独判断即已封页：其 used = 该 system
    // 高 > capacity，而 gap ≥ 0、后续 height ≥ 0（已校验），required 必然 > capacity，下一个 system 一定开新页。
    if (current !== undefined) {
      const required = current.used + SYSTEM_METRICS.systemGap + height;
      if (required <= current.capacity) {
        current.systemIndices.push(system.index);
        current.used = required;
        continue;
      }
    }
    const pageIndex = pages.length;
    const capacity = contentHeight(spec, pageIndex);
    const overflow = height > capacity;
    current = { capacity, systemIndices: [system.index], overflow, used: height };
    pages.push(current);
    if (overflow) drafts.push(overflowDraft(system, anchorVoice, pageIndex, capacity));
  }

  const layouts = pages.map((page, index): PageLayout => ({
    index,
    ...pageBoxes(spec, index),
    systemIndices: page.systemIndices,
    overflow: page.overflow,
  }));
  return { model: { pages: layouts, pageSpec: spec }, diagnostics: collectRenderDiagnostics(drafts) };
}
