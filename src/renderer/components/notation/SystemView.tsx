/**
 * 一个成品谱 system 的 DOM（M2.5 T9b）：`section.score-system[data-system-index]` 里按 T8 的层几何绝对定位各声部层，
 * 和弦 overlay 叠在最上面。**只做逐字段映射**——几何全部来自 `systemRender.ts` 的 `SystemRender`：
 *
 * - system：宽 / 高 = `box.width / box.height`，左偏移 = `leftOffset`（裁决 J4，≥ 0）；system 之间的 `systemGap` 由
 *   `ScoreView` 的容器 row-gap 恰好放一次，这里**不读** `box.origin.y`；
 * - 层：`top` / `height` = `VoiceLayerLayout`，宽 100%；带 voice 级 `data-voice-id` / `data-anchor-key`（点层内空白命中
 *   声部）；简谱 / TAB 是已切好的 SVG，Staff 是 VexFlow host，fallback 只保留高 0 的身份；
 * - overlay：system box 坐标系的 SVG，绝对铺满 system，DOM 叠放次序在各层之上；纵向次序（F-11：和弦名 / 图 →
 *   扫弦箭头 → 第 1 弦）由 T8 的和弦带几何保证（块底对齐带底、第一层从带底开始），不靠叠放次序；
 *   只有和弦组本身可点击（命中其 event anchor），空白处点击穿透到下面的层。
 *
 * 所有像素换算走 `cssPx`（`cssPixelsPerUnitAtZoom1 × zoom`），三种记谱与 overlay 同一语义。
 */

import { anchorKey } from '../../../notation/model/types';
import { StaffSystemView } from './StaffSystemView';
import { SvgTree } from './SvgTree';
import { cssPx, type LayerRender, type SystemRender } from './systemRender';

function LayerView({ layer, zoom, onRendered }: {
  readonly layer: LayerRender;
  readonly zoom: number;
  readonly onRendered: () => void;
}) {
  const style = { top: cssPx(layer.top, zoom), height: cssPx(layer.height, zoom) };
  return (
    <div
      className={`system-layer system-layer-${layer.notation}`}
      style={style}
      data-voice-id={layer.voiceId}
      data-anchor-key={anchorKey({ kind: 'voice', voiceId: layer.voiceId })}
    >
      {layer.kind === 'svg' ? <SvgTree node={layer.node} /> : null}
      {layer.kind === 'staff' ? <StaffSystemView slice={layer.slice} onRendered={onRendered} /> : null}
    </div>
  );
}

export function SystemView({ system, zoom, onRendered }: {
  readonly system: SystemRender;
  readonly zoom: number;
  readonly onRendered: () => void;
}) {
  const style = {
    width: cssPx(system.box.width, zoom),
    height: cssPx(system.box.height, zoom),
    marginLeft: cssPx(system.leftOffset, zoom),
  };
  return (
    <section className="score-system" data-system-index={system.index} style={style}>
      {system.layers.map((layer) => (
        <LayerView key={layer.voiceId} layer={layer} zoom={zoom} onRendered={onRendered} />
      ))}
      {system.overlay === undefined ? null : <SvgTree node={system.overlay} />}
    </section>
  );
}
