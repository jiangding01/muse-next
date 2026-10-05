/**
 * 五线谱的一个 `(system, 声部)` 绘制视图（M2 T7.4 的 `StaffVoiceView` 在 M2.5 T9b 按 system 切分后的继任者）。
 *
 * **两层 DOM，所有权泾渭分明**：外层的层 `<div>`（React 拥有：voice 级 `data-anchor-key`、按 zoom 换算的 top /
 * height，见 `SystemView.tsx`）；内层 `div.staff-canvas` 是 **VexFlow 独占**的 host——`renderStaff` 往里塞
 * `<svg>`，`Renderer.resize()` 会给 host 与 svg 写 inline 尺寸，adapter 画完再清掉（`fitSvgToContainer`），
 * host 只靠 CSS `width:100%`。React 永远不往 host 塞 children，两边才不会打架。
 *
 * **本文件不 import vexflow**（`components/**` 守卫）：只 import adapter 入口 `renderStaff`。
 *
 * **StrictMode 幂等**：effect 走 `alive` 旗标 + `handle.dispose()` + `replaceChildren()`，双跑不会留下两个 `<svg>`。
 * VexFlow **不等字体**，所以绘制前先 `await document.fonts.ready`。每画完一次调用 `onRendered`：`ScoreView`
 * 据此重扫高亮（异步插入的节点否则会漏高亮）；一个文档有多少个 staff 切片就会调用多少次，它只是「DOM 可能变了」的信号。
 */

import { useLayoutEffect, useRef } from 'react';

import { renderStaff, type StaffRenderHandle } from '../../integrations/vexflow/renderStaff';
import type { StaffSystemSlice } from '../../integrations/vexflow/staffSystemSlice';

export interface StaffSystemViewProps {
  readonly slice: StaffSystemSlice;
  /** 绘制完成回调：`ScoreView` 用它触发高亮重扫。 */
  readonly onRendered?: () => void;
}

export function StaffSystemView({ slice, onRendered }: StaffSystemViewProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

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
      handle = renderStaff(host, slice);
      onRendered?.();
    });

    return () => {
      alive = false;
      handle?.dispose();
      host.replaceChildren();
    };
    // `onRendered` 由 `ScoreView` 用 `useCallback` 稳定住；重绘只由 `slice` 驱动。
  }, [slice, onRendered]);

  return <div className="staff-canvas" ref={hostRef} />;
}
