/**
 * notation/jianpu —— tie / slur 弧线的**几何**（M2 方案 v1.1.1 §3.2 / §22，T5.2-B）。
 *
 * 自 `jianpuSections.ts` 拆出：那边负责「读关系、发诊断」，本文件只回答两个纯几何问题
 * ——**弧要多高**、**一条关系被换行切成几段**。拆开的现实理由是 350 行上限，选这个切口
 * 是因为本文件完全不碰 Domain：入参只有已经算好的布局节点与行谱矩形。
 *
 * 两条产品决定（**不是格式事实**，spec 里没有任何一句话规定弧线长什么样）：
 *
 * 1. **弧高随跨度变化**。原先固定 `arcHeight` 的写法在长跨度上会退化成一条贴着数字行
 *    的水平长线（真实语料里 100 多条弧几乎都是这样），既不像连线也压住了上方内容。
 *    改成 `clamp(arcHeight + span × arcHeightFactor, arcHeightMin, arcHeightMax)`：
 *    相邻两音仍是小弧（与原来几乎等高），长圆滑线弧顶抬起来，并且有上限不会顶穿行距。
 * 2. **跨行谱的关系按行谱切段**。布局里每行谱的 x 都从各自的 box 原点重新起算，所以
 *    「首端在第 3 行、末端在第 4 行」的关系若只画一条 `x1 → x2`，画出来是一条从行末
 *    折返到行首的超长横线（真实语料里 3 条）。切段后每行谱各画一段：首段从首端拉到
 *    **本行谱的续行边界**，中间行整行贯穿，末段从本行谱的续行边界拉到末端。
 *
 * **切段只增加视觉段，不增加 relation identity**：每段携带**同一个** `Anchor`
 * （因而 SVG 里 `data-anchor-key` 相同），诊断仍由 `jianpuSections.ts` 每条关系发一次。
 *
 * 续行边界取**该行谱的实际内容边界**（行内节点的最左 / 最右）再外扩
 * `arcContinuationPadding`，并 clamp 回 `system.box`——取整块 box 边缘会把短行（尤其是
 * 末行）的弧拉进右侧一大片空白里。行内一个节点都没有时才退回 box 边缘。
 */

import { JIANPU_METRICS } from '../layout/metrics';
import type { System } from '../layout/primitives';
import type { Anchor } from '../model/types';
import type { JianpuArc, JianpuNode } from './jianpuGlyphs';

/** 一行谱里与弧线有关的三个量：可画区左右界、以及该行谱自己的弧线基准 y。 */
export interface ArcSystemGeometry {
  readonly left: number;
  readonly right: number;
  readonly y: number;
}

/** 弧顶起伏：短弧≈原固定值，长弧抬高并封顶（产品决定，不是格式事实）。 */
export function arcHeightFor(span: number): number {
  const raw = JIANPU_METRICS.arcHeight + Math.abs(span) * JIANPU_METRICS.arcHeightFactor;
  return Math.min(JIANPU_METRICS.arcHeightMax, Math.max(JIANPU_METRICS.arcHeightMin, raw));
}

/**
 * 逐行谱算出弧线几何。`y` 一律从**行谱矩形**推导
 * （`origin.y + baselineOffset + arcOffsetY`），不复用任何一个端点节点的 y——端点在
 * 哪一行是关系的事，行谱基线是行谱的事，混用就会让切出来的段画到别的行上去。
 */
export function arcSystemGeometries(
  systems: readonly System[],
  nodes: Iterable<JianpuNode>,
): ReadonlyMap<number, ArcSystemGeometry> {
  const content = new Map<number, { left: number; right: number }>();
  for (const node of nodes) {
    const current = content.get(node.systemIndex);
    const right = node.x + node.width;
    if (current === undefined) content.set(node.systemIndex, { left: node.x, right });
    else content.set(node.systemIndex, {
      left: Math.min(current.left, node.x),
      right: Math.max(current.right, right),
    });
  }

  const geometries = new Map<number, ArcSystemGeometry>();
  for (const system of systems) {
    const box = system.box;
    const boxLeft = box.origin.x;
    const boxRight = box.origin.x + box.width;
    const bounds = content.get(system.index);
    const padding = JIANPU_METRICS.arcContinuationPadding;
    geometries.set(system.index, {
      left: bounds === undefined ? boxLeft : Math.max(boxLeft, bounds.left - padding),
      right: bounds === undefined ? boxRight : Math.min(boxRight, bounds.right + padding),
      y: box.origin.y + JIANPU_METRICS.baselineOffset + JIANPU_METRICS.arcOffsetY,
    });
  }
  return geometries;
}

/** 端点一律取列中心，保证两端算法一致。 */
function centerOf(node: JianpuNode): number {
  return node.x + node.width / 2;
}

/**
 * 节点的 `systemIndex` 只可能来自 `layoutJianpu.ts` 里已经存在的行谱，所以查不到就是
 * 布局不变量被打破——直接抛错，不拿端点 y 兜底（那会把段画到别的行上却不报错）。
 */
function geometryOf(
  geometries: ReadonlyMap<number, ArcSystemGeometry>,
  systemIndex: number,
): ArcSystemGeometry {
  const geometry = geometries.get(systemIndex);
  if (geometry === undefined) {
    throw new Error(`jianpu arc: no system geometry for systemIndex ${String(systemIndex)}`);
  }
  return geometry;
}

export interface ArcRequest {
  readonly anchor: Anchor;
  readonly kind: 'tie' | 'slur';
  readonly first: JianpuNode;
  readonly last: JianpuNode;
  /** A 类恢复状态（tie unresolved / slur unclosed）：只画首端的一小截悬空弧。 */
  readonly open: boolean;
}

function arcAt(
  request: ArcRequest,
  systemIndex: number,
  x1: number,
  x2: number,
  y: number,
  segment: JianpuArc['segment'],
): JianpuArc {
  return {
    anchor: request.anchor,
    kind: request.kind,
    systemIndex,
    segment,
    x1,
    x2,
    y,
    height: arcHeightFor(x2 - x1),
    open: request.open,
  };
}

/**
 * 一条 tie / slur → 一段或多段弧。
 *
 * - 单端弧（`open`）**只画首端所在行谱的那一小截**，切段逻辑完全不参与：缺失的对端
 *   本来就没有位置，跨不跨行无从谈起，更不能替它造一个末端。
 * - 首末端同行 → 一段 `whole`；跨 N 行 → N 段（`start` + N−2 个 `middle` + `end`），
 *   每段的弧高按**本段自己**的跨度算，不拿整条关系的总跨度去套。
 */
export function buildArcSegments(
  request: ArcRequest,
  geometries: ReadonlyMap<number, ArcSystemGeometry>,
): readonly JianpuArc[] {
  const { first, last, open } = request;
  const startSystem = first.systemIndex;
  const startY = geometryOf(geometries, startSystem).y;

  if (open) {
    const x1 = centerOf(first);
    return [arcAt(request, startSystem, x1, x1 + JIANPU_METRICS.arcOpenLength, startY, 'whole')];
  }

  // parse 层配对保证 from 早于 to（pairTies / pairSlurs），因此这里只会命中 `===`；
  // 写成 `<=` 是让「不可能的反向关系」也落到单段而不是空数组。
  const endSystem = last.systemIndex;
  if (endSystem <= startSystem) {
    return [arcAt(request, startSystem, centerOf(first), centerOf(last), startY, 'whole')];
  }

  const segments: JianpuArc[] = [];
  for (let index = startSystem; index <= endSystem; index += 1) {
    const geometry = geometryOf(geometries, index);
    const isStart = index === startSystem;
    const isEnd = index === endSystem;
    const x1 = isStart ? centerOf(first) : geometry.left;
    const x2 = isEnd ? centerOf(last) : geometry.right;
    // 端点已经在续行边界之外时（列中心落在 padding 外）夹一下，免得画出反向的一段。
    segments.push(arcAt(
      request,
      index,
      Math.min(x1, x2),
      Math.max(x1, x2),
      geometry.y,
      isStart ? 'start' : isEnd ? 'end' : 'middle',
    ));
  }
  return segments;
}
