/**
 * 单个声部的渲染分派（从 `ScoreView.tsx` 拆出，T6.4：加入 tab 分支后原文件逼近
 * 350 行硬约束，拆出纯函数部分不影响行为；T7.4 把 `pending` 分支换成真正的 `staff`）。
 *
 * `buildVoiceRender` 本身不含 React：只读 `RenderVoice` + 上下文，产出一棵
 * `SvgNode`（jianpu / tab）、一份 `StaffLayout`（staff）或 fallback 的展示数据，
 * JSX 组装仍在 `ScoreView.tsx` / `StaffVoiceView.tsx`。
 *
 * **本文件不 import vexflow**（全仓守卫：唯一允许目录是
 * `src/renderer/integrations/vexflow/**`）：staff 分支到这里为止只产数据。
 *
 * `computeAvailableWidthUnits` 是「容器 CSS 像素宽 → `availableWidth`（abstract
 * unit）」的纯函数，**放在 renderer 侧**（不进 `notation/layout/`）：它的输入/输出
 * 含 CSS 像素语义（`cssPixelsPerUnitAtZoom1` × `zoom`），`notation/**` 内部只谈
 * abstract unit，不该认识“CSS 像素”这个概念（D6）。
 */
import type { DomainIndex, Score } from '../../../domain';
import { isKnownVoiceStyle, type VoiceId } from '../../../domain';
import { jianpuToSvg } from '../../../notation/jianpu/toSvg';
import { layoutJianpu, type JianpuContext } from '../../../notation/jianpu/layoutJianpu';
import { summarizeEvents } from '../../../notation/layout/fallbackSummary';
import { layoutStaff, type StaffContext } from '../../../notation/staff/layoutStaff';
import type { StaffLayout } from '../../../notation/staff/staffTypes';
import { layoutTab, type TabContext } from '../../../notation/tab/layoutTab';
import { tabToSvg } from '../../../notation/tab/toSvg';
import type { RenderDiagnostic, RenderVoice } from '../../../notation/model/types';
import type { SvgNode } from '../../../notation/svg/node';
import type { TextMeasurer } from '../../../notation/layout/textMeasurer';

export type VoiceRender =
  | {
      readonly kind: 'jianpu';
      readonly voiceId: VoiceId;
      readonly node: SvgNode;
      /** 布局宽度（abstract unit），渲染时按 `cssPixelsPerUnitAtZoom1 × zoom` 换算成 CSS 宽度，字号不随容器缩放。 */
      readonly width: number;
      readonly diagnostics: readonly RenderDiagnostic[];
    }
  | {
      readonly kind: 'tab';
      readonly voiceId: VoiceId;
      readonly node: SvgNode;
      /** 语义同 jianpu 分支的 `width`。 */
      readonly width: number;
      readonly diagnostics: readonly RenderDiagnostic[];
    }
  | {
      /**
       * 五线谱（T7.4）：**不产 `SvgNode`**——SVG 由 VexFlow 在
       * `renderer/integrations/vexflow/renderStaff.ts` 里直接画进一个 DOM host，所以这
       * 一支携带的是布局数据本身（`StaffLayout`），由 `StaffVoiceView` 在
       * `useLayoutEffect` 里交给 adapter。
       */
      readonly kind: 'staff';
      readonly voiceId: VoiceId;
      readonly layout: StaffLayout;
      /** 语义同 jianpu / tab 分支的 `width`。 */
      readonly width: number;
      readonly diagnostics: readonly RenderDiagnostic[];
    }
  | { readonly kind: 'fallback'; readonly voiceId: VoiceId; readonly label: string; readonly summary: string };

export interface VoiceRenderContext {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  readonly availableWidth: number;
}

export function buildVoiceRender(voice: RenderVoice, ctx: VoiceRenderContext): VoiceRender {
  const style = voice.voice.style;
  if (isKnownVoiceStyle(style)) {
    if (style === 'jianpu') {
      const jianpuCtx: JianpuContext = {
        score: {
          ...(ctx.score.key === undefined ? {} : { key: ctx.score.key }),
          ...(ctx.score.meter === undefined ? {} : { meter: ctx.score.meter }),
        },
        index: ctx.index,
        measurer: ctx.measurer,
        availableWidth: ctx.availableWidth,
      };
      const layout = layoutJianpu(voice, jianpuCtx);
      return {
        kind: 'jianpu',
        voiceId: voice.voiceId,
        node: jianpuToSvg(layout),
        width: layout.width,
        diagnostics: layout.diagnostics,
      };
    }
    if (style === 'tab') {
      const tabCtx: TabContext = { index: ctx.index, measurer: ctx.measurer, availableWidth: ctx.availableWidth };
      const layout = layoutTab(voice, tabCtx);
      return {
        kind: 'tab',
        voiceId: voice.voiceId,
        node: tabToSvg(layout),
        width: layout.width,
        diagnostics: layout.diagnostics,
      };
    }
    // `availableWidth` 的换算与 jianpu / tab **同构**（D6/D7）：三种记谱共用同一个
    // `computeAvailableWidthUnits` 的结果，五线谱不另起一套像素语义。
    const staffCtx: StaffContext = {
      score: ctx.score,
      index: ctx.index,
      measurer: ctx.measurer,
      availableWidth: ctx.availableWidth,
    };
    const layout = layoutStaff(voice, staffCtx);
    return {
      kind: 'staff',
      voiceId: voice.voiceId,
      layout,
      width: layout.width,
      diagnostics: layout.diagnostics,
    };
  }

  const label = style === undefined ? '风格未声明' : `未知风格 style=${style}`;
  const summary = summarizeEvents(voice.items.map((item) => item.event));
  return { kind: 'fallback', voiceId: voice.voiceId, label, summary };
}

/**
 * 容器 CSS 像素宽 → `availableWidth`（abstract unit）。
 *
 * 公式：`cssWidth / (cssPixelsPerUnitAtZoom1 × zoom)`——zoom 越大，同样的容器像素宽
 * 换算出的可用 abstract unit 越少，system 换行越早发生；zoom 越小则相反，换行越晚。
 * 这正是「zoom 不改 layout 数值、只改可用宽度」的产品决定（D6 + T5 留给 T6 的接线）：
 * layout 层（`layoutJianpu`/`layoutTab`）看到的 `availableWidth` 单位仍是 abstract
 * unit，它不知道外面套了个 zoom，只是这个数字本身随 zoom 变化。
 *
 * 纯函数、不接触 DOM：`ScoreView` 的 `ResizeObserver` 回调负责量出 `cssWidth`，这里
 * 只做换算，方便单测覆盖（`tests/unit/notation/scoreView.voiceRender.test.ts`）。
 */
export function computeAvailableWidthUnits(
  cssWidthPx: number,
  cssPixelsPerUnitAtZoom1: number,
  zoom: number,
): number {
  return cssWidthPx / (cssPixelsPerUnitAtZoom1 * zoom);
}
