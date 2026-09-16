/**
 * notation/chord —— `ChordLayout` → `SvgNode`（M2 方案 v1.1.1 §2.3 / §4.2 / §6 T3）。
 *
 * 只做无判断的 layout → SvgNode 映射：所有几何/文案决策已经在 `layoutChord.ts`
 * 做完，这里不引入任何新的分支逻辑（`capoLabel`/`finger` 是否存在的判断，映射到
 * 「这个节点画不画」本身不是决策，是照抄 layout 已经决定的形状）。
 *
 * class 名沿用迁移前 `ChordDiagram.tsx` 用到的既有 CSS（`src/renderer/styles/global.css`
 * 的 `.chord-diagram` 系列选择器）：`chord-name` / `base-fret-label` / `nut-line` /
 * `string-state` / `open-string` / `finger-dot` / `finger-number`；弦线/品线本身不需要
 * 额外 class（`.chord-diagram line` 是标签选择器，覆盖全部弦线/品线）。
 *
 * `data-chord-name` 携带 `GuitarChord.name` 作为标识（§4.2 的 `data-*` 约定：
 * `chordShapes` 是文档级对象，不落在任何声部/事件下，因此没有 `data-voice-id` /
 * `data-event-id` 可挂——`data-chord-name` 是本文件对该约定的最小延伸）。
 */

import { element, textElement, type SvgAttrs, type SvgNode } from '../svg/node';
import type { ChordLayout } from './layoutChord';

export function chordToSvg(layout: ChordLayout): SvgNode {
  const children: SvgNode[] = [];

  children.push(
    textElement('text', layout.name.text, {
      x: layout.name.x,
      y: layout.name.y,
      'text-anchor': 'middle',
      class: 'chord-name',
    }),
  );

  if (layout.capoLabel !== undefined) {
    children.push(
      textElement('text', layout.capoLabel.text, {
        x: layout.capoLabel.x,
        y: layout.capoLabel.y,
        class: 'base-fret-label',
      }),
    );
  }

  for (const line of layout.gridLines) {
    const attrs: SvgAttrs = { x1: line.x1, y1: line.y1, x2: line.x2, y2: line.y2 };
    children.push(element('line', line.nut ? { ...attrs, class: 'nut-line' } : attrs));
  }

  for (const mark of layout.strings) {
    if (mark.kind === 'muted') {
      children.push(
        textElement('text', mark.text, { x: mark.x, y: mark.y, 'text-anchor': 'middle', class: 'string-state' }),
      );
      continue;
    }
    if (mark.kind === 'open') {
      children.push(element('circle', { cx: mark.x, cy: mark.cy, r: mark.r, class: 'open-string' }));
      continue;
    }

    const dotChildren: SvgNode[] = [
      element('circle', { cx: mark.cx, cy: mark.cy, r: mark.r, class: 'finger-dot' }),
    ];
    if (mark.finger !== undefined) {
      dotChildren.push(
        textElement('text', mark.finger.text, {
          x: mark.finger.x,
          y: mark.finger.y,
          'text-anchor': 'middle',
          class: 'finger-number',
        }),
      );
    }
    children.push(element('g', {}, dotChildren));
  }

  return element(
    'svg',
    {
      class: 'chord-diagram',
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'img',
      'aria-label': `${layout.name.text} guitar chord`,
      'data-chord-name': layout.name.text,
    },
    children,
  );
}
