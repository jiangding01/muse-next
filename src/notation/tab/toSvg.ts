/**
 * notation/tab —— `TabLayout` → `SvgNode`（M2 方案 §3.3 / §6 T6.4）。
 *
 * 与 `jianpu/toSvg.ts` **照抄结构与约定**（`element()` / `anchorAttrs` / fallback 角标
 * + `data-fallback` / unknown 虚线框 / 类名前缀 / 根 `<svg>` 的 width/height/viewBox /
 * `serializeSvg` 可序列化），但**不 import 它**（§2.7：两种记谱的几何差异是本质性
 * 的，共用实现只会让一处改动悄悄影响另一处）——同一套「判定思想」各写一遍是有意的
 * 重复，jianpu 分支的类似说明见该文件文件头。
 *
 * 只做无判断的 layout → SvgNode 映射：几何/文案/是否降级的决策全部已在
 * `layoutTab.ts`（及其调用的 `tabEventNodes.ts` / `tabDurationGlyphs.ts` /
 * `tabRelations.ts` / `tabStrokes.ts`）做完，这里不引入新的分支逻辑——唯一的
 * 「判断」是按 `TabNode.kind` 选择要画哪些既有字段，不是重新推导它们。
 *
 * **class 名统一 `tab-*` 前缀**，具体样式见 `src/renderer/styles/global.css`。
 *
 * **`data-*` 约定**：与 jianpu 一致，每个可交互节点上按其 `Anchor` 写
 * `data-voice-id` / `data-event-id` / `data-relation-id`，并额外统一携带
 * `data-anchor-key`（`notation/model/types.ts` 的 `anchorKey()`）。
 *
 * **降级可见性**：`fallback` 为真的节点额外画一个小三角角标 + `data-fallback="true"`
 * （契约 C2）；`unknown` / `outOfScope` 文本占位额外画一个虚线边框（契约 C1）。
 *
 * **text-anchor 选择**（与 jianpu 不同的一处产品决定，见各处推导）：
 * - 品位数字（`TabFretGlyph.text`）与其余 `TabTextGlyph`（rest / decoration /
 *   chordSymbol / unknown / outOfScope / grace 的 out-of-scope 占位 / stroke 记号）的
 *   `x` 语义都是**左缘**——`buildFretGlyph` 的白底 `backdrop.origin.x = x - pad`，
 *   `backdrop.width = textWidth + 2×pad`，即文本从 `x` 起向右延展 `textWidth`，白底
 *   左右各扩 `pad`；若 `x` 是文本中心，白底就不会以文本为中心对称。因此这些文本
 *   **不写 `text-anchor`**，取 SVG 默认值 `start`，与 `x` 的左缘语义一致；
 * - 关系连线标签（`TabRelationLine.label`）的 `x` 是 `tabRelations.ts` 的
 *   `labelAt` 显式算出的线段中点（`(x1 + x2) / 2`），语义是**中心**——与
 *   `jianpu/toSvg.ts` 的 `tupletToSvg` 标签同构，显式写 `text-anchor: middle`。
 *
 * **粗线做法**：与 jianpu 的 `barlineNodeChildren` 同构——`TabBarlineNode.lines`
 * 逐条画 `line`，下标落在 `thickLineIndices` 里的额外追加 `tab-barline-thick` 类名
 * （由 CSS 决定粗细，不在这里算像素宽度）。
 */

import { element, textElement, type SvgAttrs, type SvgNode } from '../svg/node';
import { TAB_METRICS } from '../layout/metrics';
import { anchorKey, type Anchor } from '../model/types';
import type {
  TabBarlineNode,
  TabFretGlyph,
  TabGraceNode,
  TabGroupNode,
  TabNoteNode,
  TabNode,
  TabRestNode,
  TabSegment,
  TabStaffLines,
  TabTextGlyph,
  TabTextNode,
} from './tabGlyphs';
import type { TabDurationGlyphs } from './tabDurationGlyphs';
import type { TabRelationLine } from './tabRelations';
import type { TabStrokeMark } from './tabStrokes';
import type { TabLayout } from './layoutTab';

/** `Anchor` → `data-*` 属性表；写法与 `jianpu/toSvg.ts` 的 `anchorAttrs` 完全同构。 */
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

/** 降级角标：复用 `fallbackMarker` 同款小三角，尺寸取自 `TAB_METRICS.augmentationDotRadius`。 */
function fallbackMarker(cornerX: number, cornerY: number): SvgNode {
  const size = TAB_METRICS.augmentationDotRadius * 2;
  const points = `${cornerX},${cornerY} ${cornerX - size},${cornerY} ${cornerX},${cornerY + size}`;
  return element('polygon', { points, class: 'tab-fallback-marker' });
}

/**
 * 一个 `TabTextGlyph` 的视觉纵向范围（顶/底）：反推自 `buildFretGlyph` 的白底算法
 * （`centerY = y − fontSize×fretBaselineRatio`，`top/bottom = centerY ∓ fontSize/2 ∓
 * fretBackdropPadding`）——复用同一对既有 `TAB_METRICS` 常量，不新增尺寸常量。
 */
function textGlyphTop(glyph: TabTextGlyph): number {
  const centerY = glyph.y - glyph.fontSize * TAB_METRICS.fretBaselineRatio;
  return centerY - glyph.fontSize / 2 - TAB_METRICS.fretBackdropPadding;
}

function textGlyphBottom(glyph: TabTextGlyph): number {
  const centerY = glyph.y - glyph.fontSize * TAB_METRICS.fretBaselineRatio;
  return centerY + glyph.fontSize / 2 + TAB_METRICS.fretBackdropPadding;
}

/** `unknown` / `outOfScope` 占位的虚线边框：横向用 `text.x` 起、`width` 与 `textWidth` 的较大者兜住。 */
function unknownBox(node: TabTextNode): SvgNode {
  const top = textGlyphTop(node.text);
  const bottom = textGlyphBottom(node.text);
  return element('rect', {
    x: node.text.x,
    y: top,
    width: Math.max(node.width, node.textWidth),
    height: bottom - top,
    class: 'tab-unknown-box',
  });
}

function textGlyphToSvg(glyph: TabTextGlyph, className: string): SvgNode {
  return textElement('text', glyph.text, { x: glyph.x, y: glyph.y, 'font-size': glyph.fontSize, class: className });
}

/** 关系标签专用：显式 `text-anchor: middle`（`x` 是线段中点，见文件头说明）。 */
function centeredTextGlyphToSvg(glyph: TabTextGlyph, className: string): SvgNode {
  return textElement('text', glyph.text, {
    x: glyph.x,
    y: glyph.y,
    'font-size': glyph.fontSize,
    'text-anchor': 'middle',
    class: className,
  });
}

function segmentToLine(segment: TabSegment, className: string): SvgNode {
  return element('line', { x1: segment.x1, y1: segment.y1, x2: segment.x2, y2: segment.y2, class: className });
}

/** 一个品位字形：白底 `rect`（遮弦线）+ 文本，`memberIndex` 不参与渲染（只是查找口）。 */
function fretGlyphToSvg(fret: TabFretGlyph): readonly SvgNode[] {
  const backdrop = element('rect', {
    x: fret.backdrop.origin.x,
    y: fret.backdrop.origin.y,
    width: fret.backdrop.width,
    height: fret.backdrop.height,
    class: 'tab-fret-backdrop',
  });
  return [backdrop, textGlyphToSvg(fret.text, 'tab-fret-text')];
}

function durationGlyphsToSvg(glyphs: TabDurationGlyphs): readonly SvgNode[] {
  const stem = glyphs.stem === undefined ? [] : [segmentToLine(glyphs.stem, 'tab-stem')];
  const beams = glyphs.beams.map((segment) => segmentToLine(segment, 'tab-beam'));
  const dashes = glyphs.dashes.map((segment) => segmentToLine(segment, 'tab-dash'));
  const dots = glyphs.augmentationDots.map((dot) =>
    element('circle', { cx: dot.x, cy: dot.y, r: TAB_METRICS.augmentationDotRadius, class: 'tab-augmentation-dot' }),
  );
  return [...stem, ...beams, ...dashes, ...dots];
}

function tabNoteNodeChildren(node: TabNoteNode): readonly SvgNode[] {
  return [...fretGlyphToSvg(node.fret), ...durationGlyphsToSvg(node.duration)];
}

function tabGroupNodeChildren(node: TabGroupNode): readonly SvgNode[] {
  return [...node.frets.flatMap(fretGlyphToSvg), ...durationGlyphsToSvg(node.duration)];
}

function restNodeChildren(node: TabRestNode): readonly SvgNode[] {
  return [textGlyphToSvg(node.text, 'tab-rest'), ...durationGlyphsToSvg(node.duration)];
}

/** 倚音：TAB 成员画品位字形（小字号），pitch 模式成员画范围外文本占位。 */
function graceNodeChildren(node: TabGraceNode): readonly SvgNode[] {
  return [
    ...node.frets.flatMap(fretGlyphToSvg),
    ...node.outOfScopeTexts.map((text) => textGlyphToSvg(text, 'tab-grace-out-of-scope')),
  ];
}

function barlineNodeChildren(node: TabBarlineNode): readonly SvgNode[] {
  const lines = node.lines.map((seg, i) =>
    segmentToLine(seg, node.thickLineIndices.includes(i) ? 'tab-barline-line tab-barline-thick' : 'tab-barline-line'),
  );
  const dots = node.repeatDots.map((dot) =>
    element('circle', { cx: dot.x, cy: dot.y, r: TAB_METRICS.repeatDotRadius, class: 'tab-repeat-dot' }),
  );
  return [...lines, ...dots];
}

/** 装饰 / 和弦符号 / 未知事件 / 范围外事件；后两者额外画虚线边框（契约 C1）。 */
function textNodeChildren(node: TabTextNode): readonly SvgNode[] {
  const glyph = textGlyphToSvg(node.text, `tab-text tab-text-${node.kind}`);
  return node.kind === 'unknown' || node.kind === 'outOfScope' ? [unknownBox(node), glyph] : [glyph];
}

function nodeChildren(node: TabNode): readonly SvgNode[] {
  switch (node.kind) {
    case 'tabNote':
      return tabNoteNodeChildren(node);
    case 'tabGroup':
      return tabGroupNodeChildren(node);
    case 'rest':
      return restNodeChildren(node);
    case 'grace':
      return graceNodeChildren(node);
    case 'barline':
      return barlineNodeChildren(node);
    default:
      return textNodeChildren(node);
  }
}

function nodeToSvg(node: TabNode): SvgNode {
  const children = [...nodeChildren(node)];
  if (node.fallback) children.push(fallbackMarker(node.x + node.width, node.y));
  const classNames = `tab-node tab-node-${node.kind}${node.fallback ? ' tab-node-fallback' : ''}`;
  return element(
    'g',
    { class: classNames, ...anchorAttrs(node.anchor), ...(node.fallback ? { 'data-fallback': 'true' } : {}) },
    children,
  );
}

function staffLinesToSvg(staffLines: TabStaffLines): SvgNode {
  return element(
    'g',
    { class: 'tab-staff-lines', 'data-system-index': staffLines.systemIndex },
    staffLines.lines.map((line) => segmentToLine(line, 'tab-string-line')),
  );
}

/**
 * 一条 `-S-`/`-H-`/`-P-` 关系连线段：`data-relation-segment` 标注是哪一段
 * （`whole` / `start` / `end`），跨行谱的两段共享同一个 `anchorAttrs`（同一条关系）。
 * `end` 段没有 `label`（见 `tabRelations.ts` 文件头：续行段没有对端可标注）。
 */
function relationLineToSvg(relation: TabRelationLine): SvgNode {
  const line = segmentToLine(
    { x1: relation.x1, y1: relation.y1, x2: relation.x2, y2: relation.y2 },
    `tab-relation-line tab-relation-${relation.kind}`,
  );
  const children: SvgNode[] = [line];
  if (relation.label !== undefined) children.push(centeredTextGlyphToSvg(relation.label, 'tab-relation-label'));
  return element(
    'g',
    {
      class: `tab-relation-group tab-relation-${relation.kind}`,
      'data-relation-segment': relation.segment,
      ...anchorAttrs(relation.anchor),
    },
    children,
  );
}

function strokeMarkToSvg(mark: TabStrokeMark): SvgNode {
  return element(
    'g',
    { class: 'tab-stroke-group', ...anchorAttrs(mark.anchor) },
    [textGlyphToSvg(mark.text, 'tab-stroke-text')],
  );
}

/**
 * TAB 布局入口。纯函数：只读 `layout`，构造新的 `SvgNode` 树，不修改输入。
 *
 * 子节点顺序固定（staffLines → nodes → relations → strokes），与 `TabLayout` 的
 * 字段声明顺序一致——保证 `serializeSvg` 的输出对同一输入逐字符确定。
 */
export function tabToSvg(layout: TabLayout): SvgNode {
  const children: SvgNode[] = [
    ...layout.staffLines.map(staffLinesToSvg),
    ...layout.nodes.map(nodeToSvg),
    ...layout.relations.map(relationLineToSvg),
    ...layout.strokes.map(strokeMarkToSvg),
  ];
  return element(
    'svg',
    {
      class: 'tab-svg',
      width: layout.width,
      height: layout.height,
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      role: 'img',
      'aria-label': 'tab notation',
      'data-voice-id': layout.voiceId,
      // 根节点携带 voice 级 `data-anchor-key`（与 jianpu 同构）：点击空白画布区域
      // （不落在任何事件节点上）仍能命中该声部，与 `ScoreView` 给
      // `<section class="score-voice">` 加的是同一个 key，两处各自独立算出，
      // 值必然一致。
      'data-anchor-key': anchorKey({ kind: 'voice', voiceId: layout.voiceId }),
    },
    children,
  );
}
