/**
 * notation/jianpu —— `JianpuLayout` → `SvgNode`（M2 方案 v1.1.1 §2.3 / §3.2 / §4.2 / §6 T5）。
 *
 * 只做无判断的 layout → SvgNode 映射（同源于 `chord/toSvg.ts` 的分工）：几何/文案/
 * 是否降级的决策全部已在 `layoutJianpu.ts` 做完，这里不引入新的分支逻辑——唯一的
 * "判断"是按 `JianpuNode.kind` 选择要画哪些既有字段，不是重新推导它们。
 *
 * **class 名统一 `jianpu-*` 前缀**，具体样式见 `src/renderer/styles/global.css`。
 *
 * **`data-*` 约定**（§4.2，供 M3 与本任务的谱面↔诊断联动使用）：每个可交互节点上
 * 按其 `Anchor` 写 `data-voice-id` / `data-event-id` / `data-relation-id`，并额外统一
 * 携带 `data-anchor-key`（`notation/model/types.ts` 的 `anchorKey()`，与
 * `RenderDiagnostic.anchor` 走同一份确定性字符串派生）——`ScoreView` 靠这一个属性做
 * 「点击 → 比较 `dataset.anchorKey`」，不用把 `EventId`（含 `:`）拼进 CSS 选择器字符串。
 *
 * **降级可见性**：`fallback` 为真的节点额外画一个小三角角标 + `data-fallback="true"`
 * （契约 C2 的可视对应物：这类节点已在 layout 层挂了至少一条诊断）；`unknown` /
 * `outOfScope` 文本占位额外画一个虚线边框（契约 C1：`UnknownEvent` 恰好一个可见节点）。
 * 二者互不依赖——一个节点可以只有边框、只有角标、或两者都有。
 */

import { element, textElement, type SvgAttrs, type SvgNode } from '../svg/node';
import { JIANPU_METRICS } from '../layout/metrics';
import { anchorKey, type Anchor } from '../model/types';
import {
  digitBottom,
  digitTop,
  type JianpuArc,
  type JianpuBarlineNode,
  type JianpuChordNode,
  type JianpuDurationGlyphs,
  type JianpuGraceNode,
  type JianpuLabel,
  type JianpuLyricNode,
  type JianpuNode,
  type JianpuNoteNode,
  type JianpuPitchGlyphs,
  type JianpuRestNode,
  type JianpuSegment,
  type JianpuTextGlyph,
  type JianpuTextNode,
  type JianpuTupletBracket,
  type JianpuUnitLengthMark,
} from './jianpuGlyphs';
import type { JianpuLayout } from './layoutJianpu';

/** `Anchor` → `data-*` 属性表；`data-anchor-key` 对每个分支都写，其余按 `kind` 追加。 */
function anchorAttrs(anchor: Anchor): SvgAttrs {
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
 * 降级角标：一个指向内侧的小三角，画在给定框的右上角。**复用**既有 `JIANPU_METRICS`
 * 常量推出尺寸，不新增顶层尺寸常量（T5 的 metrics.ts 额外授权只覆盖头部/ScoreView）。
 */
function fallbackMarker(cornerX: number, cornerY: number): SvgNode {
  const size = JIANPU_METRICS.augmentationDotRadius * 2;
  const points = `${cornerX},${cornerY} ${cornerX - size},${cornerY} ${cornerX},${cornerY + size}`;
  return element('polygon', { points, class: 'jianpu-fallback-marker' });
}

/** `unknown` / `outOfScope` 占位的虚线边框：横向用 `text` 与 `width` 中的较大者兜住量出的文本。 */
function unknownBox(node: JianpuTextNode): SvgNode {
  const top = digitTop(node.y);
  const bottom = digitBottom(node.y);
  return element('rect', {
    x: node.x,
    y: top,
    width: Math.max(node.width, node.textWidth),
    height: bottom - top,
    class: 'jianpu-unknown-box',
  });
}

function textGlyphToSvg(glyph: JianpuTextGlyph, className: string): SvgNode {
  return textElement('text', glyph.text, {
    x: glyph.x,
    y: glyph.y,
    'font-size': glyph.fontSize,
    class: className,
  });
}

function segmentToLine(segment: JianpuSegment, className: string): SvgNode {
  return element('line', {
    x1: segment.x1,
    y1: segment.y1,
    x2: segment.x2,
    y2: segment.y2,
    class: className,
  });
}

function pitchGlyphsToSvg(glyphs: JianpuPitchGlyphs): readonly SvgNode[] {
  const dots = glyphs.octaveDots.map((dot) =>
    element('circle', { cx: dot.x, cy: dot.y, r: JIANPU_METRICS.octaveDotRadius, class: 'jianpu-octave-dot' }),
  );
  return glyphs.accidental === undefined
    ? dots
    : [...dots, textGlyphToSvg(glyphs.accidental, 'jianpu-accidental')];
}

function durationGlyphsToSvg(glyphs: JianpuDurationGlyphs): readonly SvgNode[] {
  const beams = glyphs.beams.map((segment) => segmentToLine(segment, 'jianpu-beam'));
  const dashes = glyphs.dashes.map((segment) => segmentToLine(segment, 'jianpu-dash'));
  const dots = glyphs.augmentationDots.map((dot) =>
    element('circle', {
      cx: dot.x, cy: dot.y, r: JIANPU_METRICS.augmentationDotRadius, class: 'jianpu-augmentation-dot',
    }),
  );
  return [...beams, ...dashes, ...dots];
}

function noteNodeChildren(node: JianpuNoteNode): readonly SvgNode[] {
  return [
    textGlyphToSvg(node.text, 'jianpu-digit'),
    ...pitchGlyphsToSvg(node.pitchGlyphs),
    ...durationGlyphsToSvg(node.duration),
  ];
}

function restNodeChildren(node: JianpuRestNode): readonly SvgNode[] {
  return [textGlyphToSvg(node.text, 'jianpu-rest'), ...durationGlyphsToSvg(node.duration)];
}

function chordNodeChildren(node: JianpuChordNode): readonly SvgNode[] {
  const members = node.members.flatMap((member) => [
    textGlyphToSvg(member.text, 'jianpu-chord-member'),
    ...(member.pitchGlyphs === undefined ? [] : pitchGlyphsToSvg(member.pitchGlyphs)),
  ]);
  return [...members, ...durationGlyphsToSvg(node.duration)];
}

function graceNodeChildren(node: JianpuGraceNode): readonly SvgNode[] {
  return node.texts.map((text) => textGlyphToSvg(text, 'jianpu-grace'));
}

function barlineNodeChildren(node: JianpuBarlineNode): readonly SvgNode[] {
  const lines = node.glyphs.lines.map((seg, i) =>
    segmentToLine(
      seg,
      node.glyphs.thickLineIndices.includes(i) ? 'jianpu-barline-line jianpu-barline-thick' : 'jianpu-barline-line',
    ),
  );
  const dots = node.glyphs.repeatDots.map((dot) =>
    element('circle', { cx: dot.x, cy: dot.y, r: JIANPU_METRICS.repeatDotRadius, class: 'jianpu-repeat-dot' }),
  );
  return [...lines, ...dots];
}

/** 装饰 / 和弦符号 / 未知事件 / 范围外事件；后两者额外画虚线边框（契约 C1）。 */
function textNodeChildren(node: JianpuTextNode): readonly SvgNode[] {
  const glyph = textGlyphToSvg(node.text, `jianpu-text jianpu-text-${node.kind}`);
  return node.kind === 'unknown' || node.kind === 'outOfScope' ? [unknownBox(node), glyph] : [glyph];
}

function nodeChildren(node: JianpuNode): readonly SvgNode[] {
  switch (node.kind) {
    case 'note':
      return noteNodeChildren(node);
    case 'rest':
      return restNodeChildren(node);
    case 'chord':
      return chordNodeChildren(node);
    case 'grace':
      return graceNodeChildren(node);
    case 'barline':
      return barlineNodeChildren(node);
    default:
      return textNodeChildren(node);
  }
}

function nodeToSvg(node: JianpuNode): SvgNode {
  const children = [...nodeChildren(node)];
  if (node.fallback) children.push(fallbackMarker(node.x + node.width, digitTop(node.y)));
  const classNames = `jianpu-node jianpu-node-${node.kind}${node.fallback ? ' jianpu-node-fallback' : ''}`;
  return element(
    'g',
    {
      class: classNames,
      ...anchorAttrs(node.anchor),
      ...(node.fallback ? { 'data-fallback': 'true' } : {}),
    },
    children,
  );
}

/** tuplet 只画方括号 + `p` 数字（P1-C）：两端竖钩朝基线方向，标签居中放在括号上方。 */
function tupletToSvg(bracket: JianpuTupletBracket): SvgNode {
  const hookEnd = bracket.y + bracket.hookHeight;
  const bracketPath = element('path', {
    d: `M ${bracket.x1} ${hookEnd} L ${bracket.x1} ${bracket.y} L ${bracket.x2} ${bracket.y} L ${bracket.x2} ${hookEnd}`,
    class: 'jianpu-tuplet-bracket',
  });
  const label = textElement('text', bracket.label, {
    x: (bracket.x1 + bracket.x2) / 2,
    y: bracket.y,
    'text-anchor': 'middle',
    class: 'jianpu-tuplet-label',
  });
  const children: SvgNode[] = [bracketPath, label];
  if (!bracket.complete) children.push(fallbackMarker(bracket.x2, bracket.y));
  return element(
    'g',
    {
      class: `jianpu-tuplet${bracket.complete ? '' : ' jianpu-tuplet-fallback'}`,
      ...anchorAttrs(bracket.anchor),
      ...(bracket.complete ? {} : { 'data-fallback': 'true' }),
    },
    children,
  );
}

/**
 * tie / slur 弧线：二次贝塞尔近似圆弧；`open`（A 类恢复状态）额外虚线 + 降级角标。
 *
 * 跨行谱的关系在布局层已切成多段（`JianpuArc.segment`），这里**逐段**画一个 `g`——
 * 它们的 `data-anchor-key` 相同（同一条 relation），`data-arc-segment` 说明是哪一段。
 */
function arcToSvg(arc: JianpuArc): SvgNode {
  const midX = (arc.x1 + arc.x2) / 2;
  const path = element('path', {
    d: `M ${arc.x1} ${arc.y} Q ${midX} ${arc.y - arc.height} ${arc.x2} ${arc.y}`,
    class: `jianpu-arc jianpu-arc-${arc.kind}${arc.open ? ' jianpu-arc-open' : ''}`,
  });
  const children: SvgNode[] = [path];
  if (arc.open) children.push(fallbackMarker(arc.x2, arc.y - arc.height));
  return element(
    'g',
    {
      class: `jianpu-arc-group${arc.open ? ' jianpu-arc-fallback' : ''}`,
      'data-arc-segment': arc.segment,
      ...anchorAttrs(arc.anchor),
      ...(arc.open ? { 'data-fallback': 'true' } : {}),
    },
    children,
  );
}

/** 歌词音节；`aligned === false` 表示按顺序落在行尾而非对齐到目标列，视为降级。 */
function lyricToSvg(node: JianpuLyricNode): SvgNode {
  const glyph = textGlyphToSvg(node.text, `jianpu-lyric jianpu-lyric-${node.syllableKind}`);
  const children: SvgNode[] = [glyph];
  if (!node.aligned) children.push(fallbackMarker(node.text.x + node.text.fontSize, node.text.y));
  return element(
    'g',
    {
      class: `jianpu-lyric-group${node.aligned ? '' : ' jianpu-lyric-fallback'}`,
      'data-verse-index': node.verseIndex,
      ...anchorAttrs(node.anchor),
      ...(node.aligned ? {} : { 'data-fallback': 'true' }),
    },
    children,
  );
}

function labelToSvg(label: JianpuLabel): SvgNode {
  return element(
    'g',
    { class: `jianpu-label jianpu-label-${label.kind}`, ...anchorAttrs(label.anchor) },
    [textGlyphToSvg(label.text, 'jianpu-label-text')],
  );
}

function unitLengthMarkToSvg(mark: JianpuUnitLengthMark): SvgNode {
  return element(
    'g',
    { class: 'jianpu-unit-length-mark', ...anchorAttrs(mark.anchor) },
    [segmentToLine(mark.segment, 'jianpu-unit-length-line')],
  );
}

/**
 * 简谱布局入口。纯函数：只读 `layout`，构造新的 `SvgNode` 树，不修改输入。
 *
 * 子节点顺序固定（labels → nodes → tuplets → arcs → lyrics → unitLengthMarks），
 * 与 `layoutJianpu.ts` 的字段声明顺序一致——保证 `serializeSvg` 的输出对同一输入
 * 逐字符确定。
 */
export function jianpuToSvg(layout: JianpuLayout): SvgNode {
  const children: SvgNode[] = [
    ...layout.labels.map(labelToSvg),
    ...layout.nodes.map(nodeToSvg),
    ...layout.tuplets.map(tupletToSvg),
    ...layout.arcs.map(arcToSvg),
    ...layout.lyrics.map(lyricToSvg),
    ...layout.unitLengthMarks.map(unitLengthMarkToSvg),
  ];
  return element(
    'svg',
    {
      class: 'jianpu-score',
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'img',
      'aria-label': 'jianpu notation',
      'data-voice-id': layout.voiceId,
      // 根节点携带 voice 级 `data-anchor-key`（P1-3）：点击空白画布区域（不落在任何
      // 事件节点上）仍能命中该声部——它与 `ScoreView` 给 `<section class="score-voice">`
      // 加的是同一个 key（`anchorKey({kind:'voice', voiceId})`），两处各自独立算出，
      // 不互相依赖，值必然一致。
      'data-anchor-key': anchorKey({ kind: 'voice', voiceId: layout.voiceId }),
    },
    children,
  );
}
