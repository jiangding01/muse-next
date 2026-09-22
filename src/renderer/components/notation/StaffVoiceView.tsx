/**
 * 五线谱声部视图（M2 T7.4）。
 *
 * **两层 DOM，所有权泾渭分明**：
 * - 外层 `section.score-voice.score-voice-staff` 是 **React 拥有**的——voice 级
 *   `data-anchor-key`、CSS 宽度（`layout.width × cssPixelsPerUnitAtZoom1 × zoom`，与
 *   jianpu / tab 完全相同的 zoom 语义）都在这一层；
 * - 内层 `div.staff-canvas` 是 **VexFlow 独占**的 host：`renderStaff` 会往里塞一个
 *   `<svg>`，并且 `Renderer.resize()` 会改这个 host 与 svg 的 inline width/height。
 *   React 永远不往这层塞 children，两边才不会打架。
 *
 * **本文件不 import vexflow**（`components/**` 有专门的守卫用例）：只 import adapter
 * 的入口函数 `renderStaff`。
 *
 * **StrictMode 幂等**：effect 走 `alive` 旗标 + `handle.dispose()` + `replaceChildren()`，
 * render → cleanup → render 的双跑不会留下两个 `<svg>`。VexFlow **不等字体**（`bravura`
 * 入口只是发起 `FontFace` 加载），所以绘制前先 `await document.fonts.ready`——字体没到
 * 就画，SMuFL 字形会按 fallback 字体量宽，符头与谱线对不上。
 */

import { useLayoutEffect, useRef } from 'react';

import { SCORE_VIEW_METRICS } from '../../../notation/layout/metrics';
import { anchorKey } from '../../../notation/model/types';
import { renderStaff, type StaffRenderHandle } from '../../integrations/vexflow/renderStaff';
import type { VoiceRender } from './voiceRender';

export interface StaffVoiceViewProps {
  readonly render: Extract<VoiceRender, { readonly kind: 'staff' }>;
  readonly zoom: number;
  /** 绘制完成回调：`ScoreView` 用它触发高亮重扫（异步插入的节点否则会漏高亮）。 */
  readonly onRendered?: () => void;
}

export function StaffVoiceView({ render, zoom, onRendered }: StaffVoiceViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const layout = render.layout;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    let alive = true;
    let handle: StaffRenderHandle | undefined;

    const ready = typeof document !== 'undefined' && 'fonts' in document
      ? document.fonts.ready
      : Promise.resolve();

    void ready.then(() => {
      if (!alive) return;
      host.replaceChildren();
      handle = renderStaff(host, layout);
      onRendered?.();
    });

    return () => {
      alive = false;
      handle?.dispose();
      host.replaceChildren();
    };
    // `onRendered` 由 `ScoreView` 用 `useCallback` 稳定住；列进依赖是为了诚实，
    // 不是为了触发重绘（它不变，重绘只由 `layout` 驱动）。
  }, [layout, onRendered]);

  const widthPx = `${String(layout.width * SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1 * zoom)}px`;
  return (
    <section
      className="score-voice score-voice-staff"
      data-voice-id={render.voiceId}
      data-anchor-key={anchorKey({ kind: 'voice', voiceId: render.voiceId })}
    >
      <div className="staff-canvas" style={{ width: widthPx }} ref={hostRef} />
    </section>
  );
}
