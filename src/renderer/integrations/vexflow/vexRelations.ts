/**
 * renderer/integrations/vexflow —— tie 与 tuplet 括号的绘制（M2 T7.4）。
 *
 * **tie 用 VexFlow 的 `StaveTie`，tuplet 括号自己画**，两条相反的决定各有理由：
 *
 * - `StaveTie` 实测支持**单端**（`TieNotes` 的 `firstNote` / `lastNote` 都是可选，
 *   `isPartial()` 就是为此而生）：只给 `firstNote` 时 `getLastX()` 退到
 *   `firstNote.checkStave().getTieEndX()`，即**画到本行谱末**；只给 `lastNote` 时
 *   `getFirstX()` 退到 `getTieStartX()`，即**从本行谱首起**。这正好就是 `StaffTie` 的
 *   `start` / `end` 两种续行段语义，不需要我们再造一遍弧线。
 * - VexFlow 的 `Tuplet` **会改 tick**（它的本职是按 `p:q` 缩放时值），而 M2 明确
 *   「不按 `p`/`q` 推算 effective duration」（`StaffTupletBracket` 连时值缩放字段都
 *   没有，`q === 0` 在 spec 里是 UNVERIFIED）。实例化它等于替作者断言一个我们没有证据
 *   的时值事实，所以**只画括号**：format 之后拿成员 `StaveNote.getAbsoluteX()` 算范围，
 *   用 `ctx` 画线与标签，一个 tick 都不动。
 *
 * 端点身份**不重放筛选规则**（`StaffNotePitch` 的 JSDoc 明令）：
 * `pitches.findIndex((entry) => entry.memberIndex === endpoint.memberIndex)`。
 */

import { StaveTie, type SVGContext, type StaveNote } from 'vexflow/bravura';

import type { EventId } from '../../../domain';
import { STAFF_METRICS } from '../../../notation/layout/metrics';
import type { StaffEventNode } from '../../../notation/staff/staffTypes';
import type {
  StaffRelationEndpoint,
  StaffTie,
  StaffTupletBracket,
} from '../../../notation/staff/staffRelationTypes';
import { applyAnchorAttrs, drawAnchoredGroup, drawHitArea, drawText } from './vexAnchors';

/** 关系绘制需要的两张「布局产物」索引（不是 Domain lookup）。 */
export interface StaffRelationIndex {
  readonly staveNotes: ReadonlyMap<EventId, StaveNote>;
  readonly nodes: ReadonlyMap<EventId, StaffEventNode>;
}

/**
 * 端点 → VexFlow `keys` 下标。`memberIndex` 缺席（指整个事件）或节点不是 `note` 时
 * 回落到 `[0]`；`findIndex` 没找到（端点指向一个已被剔除的休止成员）时也回落到 `[0]`
 * 而不是丢掉整条弧——弧的存在是 Domain 事实，落点偏一个成员好过整条消失。
 */
function keyIndexes(index: StaffRelationIndex, endpoint: StaffRelationEndpoint): number[] {
  if (endpoint.memberIndex === undefined) return [0];
  const node = index.nodes.get(endpoint.eventId);
  if (node === undefined || node.kind !== 'note') return [0];
  const found = node.pitches.findIndex((entry) => entry.memberIndex === endpoint.memberIndex);
  return [found < 0 ? 0 : found];
}

/**
 * 画一段 tie。`segment` 决定给 `StaveTie` 喂哪一端：
 * `whole` 两端都给；`start`（含 `status === 'unresolved'`——它本就只有一个 `start` 段）
 * 只给 `firstNote`；`end` 只给 `lastNote`。缺端的那一侧**不补**，交给 VexFlow 的
 * partial 行为画到行末 / 从行首起。
 */
function drawTie(ctx: SVGContext, tie: StaffTie, index: StaffRelationIndex): void {
  const fromEndpoint = tie.segment === 'end' ? undefined : tie.from;
  const toEndpoint = tie.segment === 'start' ? undefined : tie.to;
  const first = fromEndpoint === undefined ? undefined : index.staveNotes.get(fromEndpoint.eventId);
  const last = toEndpoint === undefined ? undefined : index.staveNotes.get(toEndpoint.eventId);
  if (first === undefined && last === undefined) return;

  const staveTie = new StaveTie({
    ...(first === undefined || fromEndpoint === undefined
      ? {}
      : { firstNote: first, firstIndexes: keyIndexes(index, fromEndpoint) }),
    ...(last === undefined || toEndpoint === undefined
      ? {}
      : { lastNote: last, lastIndexes: keyIndexes(index, toEndpoint) }),
  });
  staveTie.setContext(ctx).draw();
  // `StaveTie.renderTie()` 实测会 `openGroup('stavetie', id)`，所以这里拿得到 `<g>`。
  applyAnchorAttrs(staveTie.getSVGElement(), tie.anchor);
}

export function drawStaffTies(
  ctx: SVGContext,
  ties: readonly StaffTie[],
  index: StaffRelationIndex,
): void {
  for (const tie of ties) {
    try {
      drawTie(ctx, tie, index);
    } catch (error) {
      // 一条弧画不出来不该拖垮整页谱：Domain 里的关系事实没有丢，只是这一段没画出来。
      console.warn('[staff] tie 绘制失败，已跳过该段', tie.relationId, error);
    }
  }
}

/**
 * 画一段 tuplet 括号：谱表上方一条横线 + 两条向下的短腿 + 居中标签（`label` 只在首段
 * 存在，续行段没有对端可标注）。纵向位置由 `STAFF_METRICS.lineGap` 推出（第一线上方
 * 两个线间距），不新增几何常量；字号取 `STAFF_METRICS.tupletLabelFontSize`。
 */
function drawTuplet(ctx: SVGContext, bracket: StaffTupletBracket, index: StaffRelationIndex): void {
  const members = bracket.eventIds
    .map((eventId) => index.staveNotes.get(eventId))
    .filter((note): note is StaveNote => note !== undefined);
  const first = members[0];
  const last = members[members.length - 1];
  if (first === undefined || last === undefined) return;
  const stave = first.getStave();
  if (stave === undefined) return;

  const x1 = first.getAbsoluteX();
  const x2 = Math.max(last.getAbsoluteX(), x1 + STAFF_METRICS.lineGap);
  const y = stave.getYForLine(0) - STAFF_METRICS.lineGap * 2;
  const legHeight = STAFF_METRICS.lineGap / 2;
  const fontSize = STAFF_METRICS.tupletLabelFontSize;

  drawAnchoredGroup(ctx, 'staff-tuplet', bracket.anchor, () => {
    ctx.save();
    ctx.setStrokeStyle('#6b6459');
    ctx.setLineWidth(1.2);
    ctx.beginPath();
    ctx.moveTo(x1, y + legHeight);
    ctx.lineTo(x1, y);
    ctx.lineTo(x2, y);
    ctx.lineTo(x2, y + legHeight);
    ctx.stroke();
    ctx.restore();
    if (bracket.label !== undefined) {
      const labelWidth = bracket.label.length * fontSize * 0.6;
      drawText(ctx, bracket.label, (x1 + x2) / 2 - labelWidth / 2, y - 2, fontSize, '#6b6459');
    }
    // 根 `<svg>` 带 `pointer-events="none"`，自绘元素必须自带热区才点得到。
    drawHitArea(ctx, { x: x1, y: y - fontSize, width: x2 - x1, height: fontSize + legHeight });
  });
}

export function drawStaffTuplets(
  ctx: SVGContext,
  tuplets: readonly StaffTupletBracket[],
  index: StaffRelationIndex,
): void {
  for (const bracket of tuplets) {
    try {
      drawTuplet(ctx, bracket, index);
    } catch (error) {
      console.warn('[staff] tuplet 括号绘制失败，已跳过该段', bracket.relationId, error);
    }
  }
}
