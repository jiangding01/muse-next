/**
 * notation/tab —— `-S-`/`-H-`/`-P-` 同弦相邻音关系连线的几何（M2 方案 §3.3，T6.3；
 * spec §26.6，`CONFIRMED`）。
 *
 * **同弦契约**：`TabRelation` 在 Domain 层已经是「同弦」的（`src/formats/jcx/parse/body/
 * pairTabRelations.ts` 的 `resolveSameString`）——两端弦号不同时 parse 层发
 * `jcx.parse.tab-relation.cross-string` 并**不建立关系**，这类输入根本不会进入本文件。
 * 因此本层**不写任何「跨弦画斜线」的特判逻辑**：两端 y 各自独立地由自己的
 * `TabFretGlyph.stringIndex` 求 `stringY`，对于合法输入它们恰好相等；万一调用方喂进一条
 * 违反此不变量的手造关系（不是 JCX 合法产出），这里也只是如实画出各自的 y，不检查、
 * 不纠正、不报告——契约在 Domain 层已经保证，渲染层没有再次判定的依据。
 *
 * 与 `jianpuArcs.ts` 同一套「跨行谱切段」手法（**不 import** 它，§2.7 / 不 import jianpu）：
 * 首末端同行谱画一整段（`whole`）；跨行谱画两段（`start` + `end`），同一 `anchor`，
 * label 只画在 `start` 段——续行段没有对端可供标注，硬画一个字母反而是编造。
 *
 * 端点缺失（悬空 / 越界 / 端点节点类型不支持）时**不画、不重发诊断**：
 * `muse.render.relation.endpoint-missing` 已由 `notation/model/relations.ts` 在
 * `buildRenderScore` 里统一发过（§4.2「同一件事只由一层报告一次」）。
 */

import type { DomainIndex } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import { resolveVoiceRelations } from '../model/relations';
import type { Anchor, RenderVoice } from '../model/types';
import { glyph, stringY } from './tabGlyphs';
import type { DraftSink, TabFretGlyph, TabNode, TabTextGlyph } from './tabGlyphs';

export interface TabRelationLine {
  readonly anchor: Anchor;
  readonly kind: 'slide' | 'hammer' | 'pull';
  readonly systemIndex: number;
  readonly segment: 'whole' | 'start' | 'end';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** 字母 S/H/P，画在线段中点上方；`end` 段没有对端可标注，省略（§26.6 无「续行标签」一说）。 */
  readonly label?: TabTextGlyph;
}

export interface TabRelationsResult {
  readonly lines: readonly TabRelationLine[];
}

const KIND_LABEL: Readonly<Record<TabRelationLine['kind'], string>> = {
  slide: 'S',
  hammer: 'H',
  pull: 'P',
};

/**
 * 端点的品位字形：**直接按 `TabFretGlyph.memberIndex` 查找**，不重放任何排序算法。
 *
 * `NoteRef.memberIndex` 恒按 Domain **原始**成员数组下标解释（`resolveVoiceRelations`
 * 的契约）；`TabFretGlyph.memberIndex` 在节点构造时（`tabEventNodes.ts`）就已经显式
 * 记下了同一个原始下标（`tabNote` 固定为 0）——两者是同一个下标空间，`find` 一步到位，
 * 找不到（下标越界、或节点类型压根不带 `frets`）就丢弃整条关系，不靠 `stringIndex` /
 * `fret` 这类「猜起来像但不保证唯一」的信息去反推。
 */
function fretGlyphFor(node: TabNode, memberIndex: number | undefined): TabFretGlyph | undefined {
  if (memberIndex === undefined) {
    return node.kind === 'tabNote' ? node.fret : undefined;
  }
  if (node.kind !== 'tabGroup' && node.kind !== 'grace') return undefined;
  return node.frets.find((fret) => fret.memberIndex === memberIndex);
}

interface SystemBounds {
  readonly left: number;
  readonly right: number;
}

/** 一行谱 box 本身的左右界（不是内容边界）——线段坐标的**最终**夹取基准。 */
function boxBoundsOf(systems: readonly System[], systemIndex: number): SystemBounds | undefined {
  const system = systems[systemIndex];
  if (system === undefined) return undefined;
  return { left: system.box.origin.x, right: system.box.origin.x + system.box.width };
}

function clampToBounds(value: number, bounds: SystemBounds): number {
  return Math.min(Math.max(value, bounds.left), bounds.right);
}

/** 逐行谱算出「内容边界 + 续行 padding，clamp 回 box」——与 `jianpuArcs.ts` 同一思路，独立实现（不 import jianpu）。 */
function systemBoundsOf(systems: readonly System[], nodes: Iterable<TabNode>): ReadonlyMap<number, SystemBounds> {
  const content = new Map<number, { left: number; right: number }>();
  for (const node of nodes) {
    const right = node.x + node.width;
    const current = content.get(node.systemIndex);
    if (current === undefined) content.set(node.systemIndex, { left: node.x, right });
    else content.set(node.systemIndex, { left: Math.min(current.left, node.x), right: Math.max(current.right, right) });
  }
  const bounds = new Map<number, SystemBounds>();
  for (const system of systems) {
    const boxLeft = system.box.origin.x;
    const boxRight = system.box.origin.x + system.box.width;
    const measured = content.get(system.index);
    const padding = TAB_METRICS.relationContinuationPadding;
    bounds.set(system.index, {
      left: measured === undefined ? boxLeft : Math.max(boxLeft, measured.left - padding),
      right: measured === undefined ? boxRight : Math.min(boxRight, measured.right + padding),
    });
  }
  return bounds;
}

/** 线段中点上方的标签；`y` 取两端里更靠上（更小）的一个，避免标签落在线段下方。 */
function labelAt(text: string, x1: number, y1: number, x2: number, y2: number): TabTextGlyph {
  return glyph(text, (x1 + x2) / 2, Math.min(y1, y2) + TAB_METRICS.relationLabelOffsetY, TAB_METRICS.relationLabelFontSize);
}

/** TAB 关系连线入口：一个声部的全部 `-S-`/`-H-`/`-P-` → 一批线段。 */
export function buildTabRelations(
  voice: RenderVoice,
  index: DomainIndex,
  nodeByEvent: ReadonlyMap<string, TabNode>,
  systems: readonly System[],
  _sink: DraftSink,
): TabRelationsResult {
  const lines: TabRelationLine[] = [];
  const bounds = systemBoundsOf(systems, nodeByEvent.values());

  for (const resolved of resolveVoiceRelations(voice.voice, index)) {
    const relation = resolved.relation;
    if (relation.kind !== 'slide' && relation.kind !== 'hammer' && relation.kind !== 'pull') continue;

    const fromEndpoint = resolved.resolved.find((endpoint) => endpoint.role === 'from');
    const toEndpoint = resolved.resolved.find((endpoint) => endpoint.role === 'to');
    if (fromEndpoint === undefined || toEndpoint === undefined) continue;

    const fromNode = nodeByEvent.get(fromEndpoint.event.id);
    const toNode = nodeByEvent.get(toEndpoint.event.id);
    if (fromNode === undefined || toNode === undefined) continue;

    const fromFret = fretGlyphFor(fromNode, fromEndpoint.ref.memberIndex);
    const toFret = fretGlyphFor(toNode, toEndpoint.ref.memberIndex);
    if (fromFret === undefined || toFret === undefined) continue;

    const anchor: Anchor = { kind: 'relation', voiceId: voice.voiceId, relationId: resolved.relationId };
    const label = KIND_LABEL[relation.kind];
    const fromX = fromFret.backdrop.origin.x + fromFret.backdrop.width + TAB_METRICS.relationEndGap;
    const fromY = stringY(fromNode.y, fromFret.stringIndex);
    const toX = toFret.backdrop.origin.x - TAB_METRICS.relationEndGap;
    const toY = stringY(toNode.y, toFret.stringIndex);

    const fromBox = boxBoundsOf(systems, fromNode.systemIndex);
    const toBox = boxBoundsOf(systems, toNode.systemIndex);
    if (fromBox === undefined || toBox === undefined) continue; // 不可达：systemIndex 必然来自 systems

    if (fromNode.systemIndex === toNode.systemIndex) {
      // 每段的坐标都显式夹回**所属 system 的 box**（不只是内容边界）——这是最终防线：
      // 无论 `relationEndGap` 还是任何上游计算把端点推到了 box 外，这里都不放行。
      // 两端离得很近时 gap 可能让终点反超起点（尤其相邻列的短跨度关系）：夹到起点，
      // 退化成一条零长线，不产出 `x2 < x1` 的反向线段——不是「再往外挤」，因为再往外
      // 挤会让线头扎进字形 bbox 里，违反 gap 本身的目的。
      const x1 = clampToBounds(fromX, fromBox);
      const x2 = clampToBounds(Math.max(x1, toX), fromBox);
      lines.push({
        anchor,
        kind: relation.kind,
        systemIndex: fromNode.systemIndex,
        segment: 'whole',
        x1,
        y1: fromY,
        x2,
        y2: toY,
        label: labelAt(label, x1, fromY, x2, toY),
      });
      continue;
    }

    const fromContent = bounds.get(fromNode.systemIndex);
    const toContent = bounds.get(toNode.systemIndex);
    if (fromContent === undefined || toContent === undefined) continue; // 不可达：systemIndex 必然来自 systems

    // `start` 段：起点是源字形（+ gap），终点是本行谱内容右界 + 续行 padding，两者都
    // 显式夹回 `fromBox`；`end` 段对称，起点是下一行谱内容左界 − 续行 padding，终点是
    // 目标字形（− gap），都夹回 `toBox`。同一个「宁可零长、不可反向」的决定。
    const startX1 = clampToBounds(fromX, fromBox);
    const startX2 = clampToBounds(Math.max(startX1, fromContent.right), fromBox);
    const endX2 = clampToBounds(toX, toBox);
    const endX1 = clampToBounds(Math.min(toContent.left, endX2), toBox);

    lines.push({
      anchor,
      kind: relation.kind,
      systemIndex: fromNode.systemIndex,
      segment: 'start',
      x1: startX1,
      y1: fromY,
      x2: startX2,
      y2: fromY,
      label: labelAt(label, startX1, fromY, startX2, fromY),
    });
    lines.push({
      anchor,
      kind: relation.kind,
      systemIndex: toNode.systemIndex,
      segment: 'end',
      x1: endX1,
      y1: toY,
      x2: endX2,
      y2: toY,
    });
  }

  return { lines };
}
