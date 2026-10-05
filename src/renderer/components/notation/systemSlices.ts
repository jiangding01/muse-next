/**
 * renderer/components/notation —— 按 system 切片与和弦 overlay 的**纯映射**（M2.5 T9b，用户裁决 C–I / 2 / 4 / 5 / 6 / 8）。
 *
 * 不含 React / DOM / VexFlow。只消费 T8 已算好的 voice layout 与 `ScoreSystemLayout`：按 `systemIndex` 过滤、换根节点
 * viewBox、组装 overlay；**不重新 layout**，不做 T6 的来源选择 / 查表 / 碰撞 / 时间定位，也不解释 `MusicEvent`。
 *
 * - 坐标（裁决 D）：T8 交给每个声部 layout 的 `systems[i]` 就是该层 box S（origin = system box 左上 + 层 top）。
 *   简谱 / TAB 的元素坐标保持原值，层 SVG 的 viewBox 取 `S.origin.x S.origin.y S.width S.height`，即层内坐标
 *   = 绝对坐标 − S.origin；Staff 的 stave 显式平移（x − S.origin.x、y − S.origin.y）；overlay 已是 system box 内坐标。
 * - chordSymbol（裁决 E）：`isSystemVisibleNode` 是三种记谱唯一的判断——`kind === 'chordSymbol'` 的节点一律不输出，
 *   与是否拥有最终 overlay 无关；只过滤副本，T8 的 layout nodes 不变。
 * - 简谱归属（裁决 2）：nodes / beams / arcs / lyrics 按 `systemIndex`；unitLengthMark 经 `anchor.eventId` 找到节点的
 *   `systemIndex`；tuplet 暂按 `bracket.y` 落在哪个层 box（恰好一个，否则 `RangeError`；跨 system 的 tuplet 不拆，是既有债务）。
 * - overlay（裁决 F / G）：带图 = `layoutChord(chordShapes[shapeIndex])` 的子节点放进 `translate(x − 宽/2, y)` 的组；
 *   只画名 = 以 x 居中、基线 `y + CHORD_METRICS.nameY` 的文本。每块 overlay 只有外层组带 `data-anchor-key`（event）。
 */

import type { Score } from '../../../domain';
import { layoutChord } from '../../../notation/chord/layoutChord';
import { chordToSvg } from '../../../notation/chord/toSvg';
import type { JianpuLayout } from '../../../notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../notation/jianpu/toSvg';
import { CHORD_METRICS, SYSTEM_METRICS } from '../../../notation/layout/metrics';
import type { System } from '../../../notation/layout/primitives';
import type { TextMeasurer } from '../../../notation/layout/textMeasurer';
import { anchorKey } from '../../../notation/model/types';
import type { StaffLayout } from '../../../notation/staff/staffTypes';
import { element, isContainerTag, textElement } from '../../../notation/svg/node';
import type { SvgContainerNode, SvgNode } from '../../../notation/svg/node';
import type { ChordDiagramOverlay, ScoreSystemLayout } from '../../../notation/system/contracts';
import type { TabLayout } from '../../../notation/tab/layoutTab';
import { tabToSvg } from '../../../notation/tab/toSvg';
import type { StaffSystemSlice } from '../../integrations/vexflow/staffSystemSlice';

function fail(message: string): never {
  throw new RangeError(`system render: ${message}`);
}

/** systemized renderer 唯一的 chordSymbol 判断：和弦符号只由 system overlay 呈现，声部内一律不画。 */
export function isSystemVisibleNode(node: { readonly kind: string }): boolean {
  return node.kind !== 'chordSymbol';
}

function isContainer(node: SvgNode): node is SvgContainerNode {
  return isContainerTag(node.tag);
}

/** 声部 layout 在某 system 上的层 box（T8 构造：= system box 左上 + 层 top，宽 = system 宽，高 = 层高）。 */
export function layerFrame(systems: readonly System[], systemIndex: number): System {
  return systems.find((system) => system.index === systemIndex) ?? fail(`声部 layout 缺少 system ${String(systemIndex)} 的层 box`);
}

/** 换掉根 `<svg>` 的尺寸与 viewBox，其余属性（class / voice anchor）与子节点原样保留。 */
function withLayerViewBox(root: SvgNode, frame: System): SvgNode {
  if (!isContainer(root) || root.tag !== 'svg') fail('toSvg 根节点不是 <svg>');
  const { origin, width, height } = frame.box;
  const viewBox = `${String(origin.x)} ${String(origin.y)} ${String(width)} ${String(height)}`;
  return element('svg', { ...root.attrs, width, height, viewBox }, root.children);
}

/** tuplet 没有 systemIndex：按 `bracket.y` 所在的层 box 归属，必须恰好一个。 */
function tupletOwner(y: number, systems: readonly System[]): number {
  const owners = systems.filter((system) => y >= system.box.origin.y && y <= system.box.origin.y + system.box.height);
  const [owner] = owners;
  if (owner === undefined || owners.length > 1) fail(`tuplet 括号（y = ${String(y)}）的 system 归属不唯一：${String(owners.length)} 个`);
  return owner.index;
}

/** 简谱一个 system 的层 SVG。 */
export function jianpuSystemSvg(layout: JianpuLayout, systemIndex: number): SvgNode {
  // 声部头部标签恒为空（Phase A 二次裁决，由文档页眉承担）；它们没有 system 归属，非空时不得静默丢弃。
  if (layout.labels.length > 0) fail(`简谱声部 ${layout.voiceId} 的头部标签非空，system 视图无法归属`);
  const frame = layerFrame(layout.systems, systemIndex);
  const own = (index: number): boolean => index === systemIndex;
  const systemOfEvent = new Map(
    layout.nodes.flatMap((node) => (node.anchor.kind === 'event' ? [[node.anchor.eventId, node.systemIndex] as const] : [])),
  );
  const markOwner = (anchor: JianpuLayout['unitLengthMarks'][number]['anchor']): number => {
    if (anchor.kind !== 'event') fail('L: 标记的 anchor 不是 event');
    return systemOfEvent.get(anchor.eventId) ?? fail(`L: 标记的事件 ${anchor.eventId} 没有对应节点`);
  };
  const slice: JianpuLayout = {
    ...layout,
    nodes: layout.nodes.filter((node) => own(node.systemIndex) && isSystemVisibleNode(node)),
    beams: layout.beams.filter((group) => own(group.systemIndex)),
    tuplets: layout.tuplets.filter((bracket) => own(tupletOwner(bracket.y, layout.systems))),
    arcs: layout.arcs.filter((arc) => own(arc.systemIndex)),
    lyrics: layout.lyrics.filter((lyric) => own(lyric.systemIndex)),
    unitLengthMarks: layout.unitLengthMarks.filter((mark) => own(markOwner(mark.anchor))),
  };
  return withLayerViewBox(jianpuToSvg(slice), frame);
}

/** TAB 一个 system 的层 SVG（全部几何都带 systemIndex，且跨行关系已在 notation 层拆段）。 */
export function tabSystemSvg(layout: TabLayout, systemIndex: number): SvgNode {
  const frame = layerFrame(layout.systems, systemIndex);
  const own = (index: number): boolean => index === systemIndex;
  const slice: TabLayout = {
    ...layout,
    nodes: layout.nodes.filter((node) => own(node.systemIndex) && isSystemVisibleNode(node)),
    staffLines: layout.staffLines.filter((lines) => own(lines.systemIndex)),
    beams: layout.beams.filter((group) => own(group.systemIndex)),
    relations: layout.relations.filter((relation) => own(relation.systemIndex)),
    strokes: layout.strokes.filter((mark) => own(mark.systemIndex)),
  };
  return withLayerViewBox(tabToSvg(slice), frame);
}

/** Staff 一个 system 的绘制输入（裁决 H / I / 6）。 */
export function staffSystemSlice(layout: StaffLayout, systemIndex: number): StaffSystemSlice {
  const frame = layerFrame(layout.systems, systemIndex);
  const own = (index: number): boolean => index === systemIndex;
  const { origin, width, height } = frame.box;
  const timeSignature = layout.staves.find((spec) => spec.timeSignature !== undefined)?.timeSignature;
  return {
    voiceId: layout.voiceId,
    systemIndex,
    clef: layout.clef,
    width,
    height,
    ...(timeSignature === undefined ? {} : { timeSignature }),
    staves: layout.staves.filter((spec) => own(spec.systemIndex)).map((spec) => ({ ...spec, x: spec.x - origin.x, y: spec.y - origin.y })),
    nodes: layout.nodes.filter((node) => own(node.systemIndex) && isSystemVisibleNode(node)),
    ties: layout.ties.filter((tie) => own(tie.systemIndex)),
    tuplets: layout.tuplets.filter((bracket) => own(bracket.systemIndex)),
  };
}

function overlayGroup(overlay: ChordDiagramOverlay, score: Score, measurer: TextMeasurer): SvgNode {
  const { anchor } = overlay;
  const anchorAttrs = { 'data-anchor-key': anchorKey(anchor), 'data-voice-id': anchor.voiceId, 'data-event-id': anchor.eventId };
  if (overlay.shapeIndex === undefined) {
    const name = textElement('text', overlay.displayText, {
      x: overlay.x,
      y: overlay.y + CHORD_METRICS.nameY,
      'text-anchor': 'middle',
      'font-size': CHORD_METRICS.nameFontSize,
      class: 'system-chord-name',
    });
    return element('g', { class: 'system-chord system-chord-text', ...anchorAttrs }, [name]);
  }
  const shape = score.chordShapes[overlay.shapeIndex] ?? fail(`shapeIndex ${String(overlay.shapeIndex)} 越界`);
  const width = SYSTEM_METRICS.chordDiagramWidth;
  const diagram = chordToSvg(layoutChord(shape, { showFinger: score.showFinger, measurer, width }));
  if (!isContainer(diagram)) fail('chordToSvg 根节点不是容器');
  const transform = `translate(${String(overlay.x - width / 2)} ${String(overlay.y)})`;
  return element('g', { class: 'system-chord chord-diagram', transform, ...anchorAttrs }, diagram.children);
}

/** 一个 system 的 overlay SVG（viewBox = system box 内坐标）；没有和弦时为 `undefined`。 */
export function systemOverlaySvg(system: ScoreSystemLayout, score: Score, measurer: TextMeasurer): SvgNode | undefined {
  if (system.chordOverlays.length === 0) return undefined;
  const { width, height } = system.box;
  return element(
    'svg',
    { class: 'system-overlay', width, height, viewBox: `0 0 ${String(width)} ${String(height)}`, 'data-system-index': system.index },
    system.chordOverlays.map((overlay) => overlayGroup(overlay, score, measurer)),
  );
}
