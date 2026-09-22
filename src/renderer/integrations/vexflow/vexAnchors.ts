/**
 * renderer/integrations/vexflow —— **anchor 回写 / 降级角标 / 点击热区**（M2 T7.4）。
 *
 * 简谱与 TAB 走的是 `notation/**` 自产的 `SvgNode` 树，`data-*` 属性在建树时就写好了
 * （见 `notation/tab/toSvg.ts` 的 `anchorAttrs`）。五线谱不一样：SVG 是 VexFlow 画的，
 * 我们只能在 `draw()` **之后**把属性补到它生成的 `<g>` 上。属性表与 tab 那边**逐字
 * 同构**（`data-anchor-key` + 按 `Anchor.kind` 的 `data-voice-id` / `data-event-id` /
 * `data-relation-id`），否则 `ScoreView` 的高亮与点击两条路径会在两种记谱下行为不一致。
 *
 * 实测到的两条 VexFlow 5.0.0 事实（决定了本文件的形状）：
 * 1. `Element.getSVGElement()` 走的是 `document.getElementById(prefix(id))`——只有
 *    **自己 `openGroup(cls, id)` 过**的 Element 才找得到。实测：`StaveNote.draw()` 与
 *    `StaveTie.renderTie()` 都 `openGroup`（所以它们的 `getSVGElement()` 可用），而
 *    `TextNote.draw()` / `Stave` 的小节线修饰**不** `openGroup`——这些只能由我们用
 *    `ctx.openGroup(cls, id)` 亲手包一层再写属性（`openGroup` 只有两个参数）。
 * 2. `SVGContext` 给根 `<svg>` 写了 `pointer-events="none"`。所以任何希望可点击的图形
 *    都必须自带一块 `pointer-events="auto"` 的透明矩形（VexFlow 自己给 StaveNote 画的
 *    `ctx.pointerRect()` 就是这么做的）——我们自绘的元素照抄这条。
 */

import type { SVGContext } from 'vexflow/bravura';

import { STAFF_METRICS } from '../../../notation/layout/metrics';
import { anchorKey, type Anchor } from '../../../notation/model/types';

/** 一块矩形区域（自绘元素的包围盒 / 热区）。 */
export interface VexRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `Anchor` → `data-*` 属性表；与 `notation/tab/toSvg.ts` 的 `anchorAttrs` 逐字同构。 */
export function anchorDataAttrs(anchor: Anchor): Readonly<Record<string, string>> {
  const key = { 'data-anchor-key': anchorKey(anchor) };
  switch (anchor.kind) {
    case 'document':
      return key;
    case 'voice':
      return { ...key, 'data-voice-id': anchor.voiceId };
    case 'event':
      return { ...key, 'data-voice-id': anchor.voiceId, 'data-event-id': anchor.eventId };
    case 'relation':
      return { ...key, 'data-voice-id': anchor.voiceId, 'data-relation-id': anchor.relationId };
    default: {
      const exhaustive: never = anchor;
      return exhaustive;
    }
  }
}

/**
 * 把 anchor 属性（可选地加上 `data-fallback`）写到一个已经存在的元素上。
 * `element` 为 `undefined`（VexFlow 没给这个 Element 建组、或还没 attach 到 document）
 * 时**静默跳过**：少一个可点击的锚点是遗憾，让整棵 React 树炸掉不是。
 */
export function applyAnchorAttrs(
  element: Element | undefined,
  anchor: Anchor,
  options: { readonly fallback?: boolean; readonly className?: string } = {},
): void {
  if (element === undefined) return;
  for (const [name, value] of Object.entries(anchorDataAttrs(anchor))) {
    element.setAttribute(name, value);
  }
  if (options.fallback === true) element.setAttribute('data-fallback', 'true');
  if (options.className !== undefined) {
    const existing = element.getAttribute('class');
    element.setAttribute('class', existing === null ? options.className : `${existing} ${options.className}`);
  }
}

/**
 * 在 `ctx` 上开一个带 anchor 属性的组，运行 `draw`，再关掉，返回该 `<g>`。
 *
 * `openGroup(cls, id)` 的 `cls` 会被 VexFlow 加上 `vf-` 前缀（`util.ts` 的 `prefix`），
 * 所以 CSS 选择器写的是 `.vf-staff-*`——这点在 `global.css` 的注释里也记了一笔。
 */
export function drawAnchoredGroup(
  ctx: SVGContext,
  className: string,
  anchor: Anchor,
  draw: () => void,
  options: { readonly fallback?: boolean } = {},
): SVGGElement {
  const group = ctx.openGroup(className);
  draw();
  ctx.closeGroup();
  applyAnchorAttrs(group, anchor, options);
  return group;
}

/**
 * 透明点击热区：照抄 `SVGContext.pointerRect()` 的做法（`opacity: 0` +
 * `pointer-events: auto`），因为根 `<svg>` 上有 `pointer-events="none"`。
 */
export function drawHitArea(ctx: SVGContext, rect: VexRect): void {
  ctx.rect(rect.x, rect.y, Math.max(rect.width, 1), Math.max(rect.height, 1), {
    opacity: '0',
    'pointer-events': 'auto',
  });
}

/**
 * 降级角标（契约 C2 的「可见」那一半）：画在包围盒右上角的小方块，配 `data-fallback`
 * 一起用。尺寸取 `STAFF_METRICS.placeholderFontSize` 的三分之一——不新增几何常量。
 */
export function drawFallbackMarker(ctx: SVGContext, cornerX: number, cornerY: number): void {
  const size = STAFF_METRICS.placeholderFontSize / 3;
  ctx.rect(cornerX - size, cornerY, size, size, { fill: '#c98a2c', stroke: 'none' });
}

/** 画一段文本（自绘路径专用）：存/取字体状态，避免污染后续 VexFlow 自己的绘制。 */
export function drawText(
  ctx: SVGContext,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  fill: string,
): void {
  ctx.save();
  ctx.setFont('Academico', `${String(fontSize)}px`);
  ctx.setFillStyle(fill);
  ctx.fillText(text, x, y);
  ctx.restore();
}

/**
 * 给一个**已经画好**的 `<g>` 追加透明热区（用它自己的 `getBBox()` 当尺寸）。
 *
 * 用在拿不到「绘制过程」、只拿得到结果元素的场合——典型就是挂成修饰的和弦符号
 * （`Annotation` 画在宿主音符的绘制流程里，我们插不进去，但它自己 `openGroup` 过，
 * 所以事后拿得到 `<g>`）。`getBBox()` 在元素未渲染 / 非 SVG 元素上会抛，整段兜住：
 * 少一块热区是遗憾，抛异常会把整页谱带走。
 */
export function appendHitArea(element: Element | undefined): void {
  if (element === undefined) return;
  if (typeof SVGGraphicsElement === 'undefined' || !(element instanceof SVGGraphicsElement)) return;
  try {
    const box = element.getBBox();
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', String(box.x));
    rect.setAttribute('y', String(box.y));
    rect.setAttribute('width', String(Math.max(box.width, 1)));
    rect.setAttribute('height', String(Math.max(box.height, 1)));
    rect.setAttribute('opacity', '0');
    rect.setAttribute('pointer-events', 'auto');
    element.appendChild(rect);
  } catch {
    // 未渲染的元素量不出包围盒：跳过。
  }
}
