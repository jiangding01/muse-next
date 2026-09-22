/**
 * renderer/integrations/vexflow —— `StaffLayout` → 真实五线谱 SVG（M2 T7.4 入口）。
 *
 * **全仓唯一允许 import vexflow 的目录**（守卫见 `tests/unit/notation/architecture.test.ts`
 * 的「全仓 vexflow 守卫」）。入口固定 `vexflow/bravura`：它在模块加载时用 FontFace API
 * 注册内嵌的 Bravura / Academico 字体数据（`Font.load(...)`），**仓库里不放任何字体
 * 文件**。VexFlow 自己**不**等字体就绪，所以调用方必须先 `await document.fonts.ready`
 * ——这一步在 `StaffVoiceView.tsx` 里做，不在本文件。
 *
 * 职责分工（各文件 ≤350 行）：本文件负责 Renderer / Stave 循环 / Voice+Formatter /
 * 异常退化 / dispose；节点 → tickable 在 `vexTickables.ts`；tie / tuplet 在
 * `vexRelations.ts`；`data-*` 回写与热区在 `vexAnchors.ts`；纯映射表在 `vexEncoding.ts`。
 *
 * **横向位置**：每个 `StaffStaveSpec` 建一个 `Stave(x, y, width)`，measure 内的 glyph x
 * 全部交给 `Formatter().joinVoices([voice]).formatToStave([voice], stave)`。**任何
 * pre-layout 的 `slot.x` 都没有参与定位**——`slot` 只是 `notation/**` 打包这一行时用
 * 的列宽需求，不是最终 x（`StaffStaveSpec` 的 JSDoc 写明了这条裁决）。
 *
 * **Voice 不做 tick 校验**：`VoiceMode.SOFT` 下超 tick / 欠 tick 都不抛。拍号只用来构造
 * `Voice`，不参与任何列宽计算（P1-3）。
 *
 * **逐 tickable 绘制而不是 `voice.draw()`**：`Voice.draw()` 实测只是「setStave +
 * setContext + drawWithStyle」的循环，本文件原样复刻这三步，**唯一的差别**是把
 * `TextNote`（占位文本 / 和弦符号）包进一个自建的 `<g>` ——因为 `TextNote.draw()` 不
 * `openGroup`，不包就拿不到可写 `data-anchor-key` 的元素，那两类事件会变成点不到也
 * 高亮不了的死角。这不是「手工包 `Voice.draw()`」（那会让整个声部共用一个 anchor）。
 */

import {
  BarlineType, Formatter, Renderer, RuntimeError, Stave, StaveNote, SVGContext, VexFlow,
  Voice, VoiceMode, type Tickable,
} from 'vexflow/bravura';

import type { EventId } from '../../../domain';
import { STAFF_METRICS } from '../../../notation/layout/metrics';
import type {
  StaffBarlineForm, StaffEventNode, StaffLayout, StaffStaveSpec, StaffTimeSignature,
} from '../../../notation/staff/staffTypes';
import {
  appendHitArea, applyAnchorAttrs, drawAnchoredGroup, drawFallbackMarker, drawHitArea, drawText,
} from './vexAnchors';
import {
  vexBeginBarlineTypeName, vexClefName, vexEndBarlineTypeName, vexKeySpec, vexTimeSpec,
  type VexBeginBarlineTypeName, type VexEndBarlineTypeName,
} from './vexEncoding';
import { drawStaffTies, drawStaffTuplets } from './vexRelations';
import { buildMeasureTickables } from './vexTickables';

/**
 * `vexEncoding.ts` 只给名字（它不 import vexflow），在这里换成真正的枚举值。
 * **两张表按位置分开**：`setBegBarType` 实测只接受 `SINGLE` / `REPEAT_BEGIN` / `NONE`
 * （其余静默忽略），`setEndBarType` 拒绝 `REPEAT_BEGIN`，详见 `vexEncoding.ts`。
 */
const BEGIN_BARLINE_TYPE: Record<VexBeginBarlineTypeName, BarlineType> = {
  SINGLE: BarlineType.SINGLE,
  REPEAT_BEGIN: BarlineType.REPEAT_BEGIN,
  NONE: BarlineType.NONE,
};

const END_BARLINE_TYPE: Record<VexEndBarlineTypeName, BarlineType> = {
  SINGLE: BarlineType.SINGLE,
  DOUBLE: BarlineType.DOUBLE,
  END: BarlineType.END,
  REPEAT_END: BarlineType.REPEAT_END,
  REPEAT_BOTH: BarlineType.REPEAT_BOTH,
  NONE: BarlineType.NONE,
};

/**
 * 缺席的小节线画 `NONE`（**不是** `SINGLE`）：`StaffStaveSpec` 明写「缺席表示作者没写，
 * 不代表普通单线」。VexFlow 的 `Stave` 默认两端都画 `SINGLE`，所以必须显式覆盖。
 */
function beginBarlineTypeOf(form: StaffBarlineForm | undefined): BarlineType {
  return form === undefined ? BarlineType.NONE : BEGIN_BARLINE_TYPE[vexBeginBarlineTypeName(form)];
}

function endBarlineTypeOf(form: StaffBarlineForm | undefined): BarlineType {
  return form === undefined ? BarlineType.NONE : END_BARLINE_TYPE[vexEndBarlineTypeName(form)];
}

export interface StaffRenderHandle {
  /** 幂等：重复调用安全（StrictMode 下 render → cleanup → render 会走到）。 */
  dispose(): void;
}

const NOOP_HANDLE: StaffRenderHandle = { dispose: () => undefined };

/** 谱表在 system box 内的垂直位置：`STAFF_METRICS.staffTopOffset` 换算成 VexFlow 的「线数」。 */
function staveOptions(): { readonly spaceAboveStaffLn: number } {
  return { spaceAboveStaffLn: STAFF_METRICS.staffTopOffset / VexFlow.STAVE_LINE_DISTANCE };
}

/** 整份布局的拍号：取第一条带拍号的行首 stave；没有就按 4/4（只用于构造 `Voice`）。 */
function voiceTimeOf(layout: StaffLayout): { readonly numBeats: number; readonly beatValue: number } {
  const time: StaffTimeSignature | undefined = layout.staves.find(
    (spec) => spec.timeSignature !== undefined,
  )?.timeSignature;
  return time === undefined
    ? { numBeats: 4, beatValue: 4 }
    : { numBeats: time.numerator, beatValue: time.denominator };
}

function buildStave(spec: StaffStaveSpec): Stave {
  const stave = new Stave(spec.x, spec.y, Math.max(spec.width, 1), staveOptions());
  // 行首才有 clef / key / time（每行重画是记谱惯例，`layoutStaff.ts` 已经决定好了）。
  if (spec.clef !== undefined) stave.addClef(vexClefName(spec.clef));
  if (spec.keySignature !== undefined) {
    const keySpec = vexKeySpec(spec.keySignature);
    // 先过 `VexFlow.hasKeySignature`：`Tables` 在 v5 没有导出，合法调号集合只能这样问。
    // 不合法就**不画调号**（而不是猜一个），与 `keySpelling.ts` 的保守裁决同一口径。
    if (keySpec !== undefined && VexFlow.hasKeySignature(keySpec)) stave.addKeySignature(keySpec);
  }
  if (spec.timeSignature !== undefined) stave.addTimeSignature(vexTimeSpec(spec.timeSignature));
  stave.setBegBarType(beginBarlineTypeOf(spec.beginBarline));
  stave.setEndBarType(endBarlineTypeOf(spec.endBarline));
  return stave;
}

/**
 * 小节线事件的点击热区。小节线由 `Stave` 画（它的 `Barline` 修饰不 `openGroup`，拿不到
 * 单独的 `<g>`），所以这里为每个 `barline` 节点另画一块透明热区：位置按它在 measure
 * 里的位置取 stave 左缘或右缘——`layoutStaff.ts` 只会把小节线放在 measure 的首项或末项。
 */
function drawBarlineHitAreas(
  ctx: SVGContext,
  stave: Stave,
  nodes: readonly StaffEventNode[],
): void {
  const top = stave.getYForLine(0);
  const bottom = stave.getYForLine(STAFF_METRICS.lineCount - 1);
  for (const [offset, node] of nodes.entries()) {
    if (node.kind !== 'barline') continue;
    const atStart = offset === 0;
    const x = atStart ? stave.getX() : stave.getX() + stave.getWidth();
    drawAnchoredGroup(ctx, 'staff-barline', node.anchor, () => {
      drawHitArea(ctx, { x: x - 4, y: top, width: 8, height: bottom - top });
    });
  }
}

/** 一个 tickable 画完后的 anchor 回写（含降级角标）。 */
function annotateTickable(
  ctx: SVGContext,
  node: StaffEventNode,
  tickable: Tickable,
  stave: Stave,
): void {
  if (tickable instanceof StaveNote) {
    // `StaveNote.draw()` 自己 `openGroup('stavenote', id)` 并画了 `pointerRect`，
    // 所以既拿得到 `<g>`、又天然可点击。
    applyAnchorAttrs(tickable.getSVGElement(), node.anchor, { fallback: node.fallback });
    return;
  }
  // `TextNote` 的 `<g>` 由调用方（`drawTickables`）用 `drawAnchoredGroup` 建好，这里只补
  // 降级角标与热区（角标画在文本左上角附近，位置用 stave 的行首基线推，不新增常量）。
  if (node.fallback) {
    drawFallbackMarker(ctx, tickable.getAbsoluteX(), stave.getYForLine(STAFF_METRICS.lineCount));
  }
}

function drawTickables(
  ctx: SVGContext,
  stave: Stave,
  entries: readonly { readonly node: StaffEventNode; readonly tickable: Tickable }[],
): void {
  for (const { node, tickable } of entries) {
    tickable.setStave(stave);
    tickable.setContext(ctx);
    if (tickable instanceof StaveNote) {
      tickable.drawWithStyle();
      annotateTickable(ctx, node, tickable, stave);
      continue;
    }
    drawAnchoredGroup(
      ctx,
      node.kind === 'chordSymbol' ? 'staff-chord-symbol' : 'staff-placeholder',
      node.anchor,
      () => {
        tickable.drawWithStyle();
        const x = tickable.getAbsoluteX();
        const y = stave.getYForLine(0);
        drawHitArea(ctx, {
          x,
          y: y - STAFF_METRICS.lineGap * 3,
          width: Math.max(tickable.getWidth(), STAFF_METRICS.minNoteSlotWidth),
          height: STAFF_METRICS.systemHeight - STAFF_METRICS.staffTopOffset,
        });
        annotateTickable(ctx, node, tickable, stave);
      },
      { fallback: node.fallback },
    );
  }
}

/** 单个 stave 画失败时的退化：一条可见的占位文本，**不让 React 树崩溃**。 */
function drawStaveFailure(ctx: SVGContext, spec: StaffStaveSpec, error: unknown): void {
  const reason = error instanceof RuntimeError ? `${error.code}: ${error.message}` : String(error);
  console.warn('[staff] 第', spec.measureIndex, '小节的五线谱绘制失败，已退化为占位文本', error);
  drawText(
    ctx,
    `第 ${String(spec.measureIndex + 1)} 小节无法绘制（${reason}）`,
    spec.x,
    spec.y + STAFF_METRICS.staffTopOffset,
    STAFF_METRICS.placeholderFontSize,
    '#a34632',
  );
}

/** 把节点按 measureIndex 分组（一个 measure 对应一个 stave）。 */
function groupNodesByMeasure(
  nodes: readonly StaffEventNode[],
): ReadonlyMap<number, readonly StaffEventNode[]> {
  const grouped = new Map<number, StaffEventNode[]>();
  for (const node of nodes) {
    const bucket = grouped.get(node.measureIndex);
    if (bucket === undefined) grouped.set(node.measureIndex, [node]);
    else bucket.push(node);
  }
  return grouped;
}

/**
 * 把一个 `StaffLayout` 画进 `host`（一个**由 VexFlow 独占**的 div；React 只管它的外层
 * wrapper，见 `StaffVoiceView.tsx`）。返回的 handle 负责把 VexFlow 建的 `<svg>` 摘掉。
 */
export function renderStaff(host: HTMLDivElement, layout: StaffLayout): StaffRenderHandle {
  const width = Math.max(layout.width, 1);
  const height = Math.max(layout.height, 1);
  const renderer = new Renderer(host, Renderer.Backends.SVG);
  // `resize` 实测会 `scale(1,1) → setViewBox(0, 0, w, h)`，所以 CSS 的
  // `width:100%; height:auto` 能让整张谱按容器等比缩放（与简谱/TAB 的 `<svg>` 同语义）。
  renderer.resize(width, height);
  const ctx = renderer.getContext();
  if (!(ctx instanceof SVGContext)) {
    console.warn('[staff] 渲染上下文不是 SVGContext，跳过五线谱绘制');
    return NOOP_HANDLE;
  }

  const grouped = groupNodesByMeasure(layout.nodes);
  const time = voiceTimeOf(layout);
  const staveNotes = new Map<EventId, StaveNote>();
  const nodeByEvent = new Map<EventId, StaffEventNode>();
  for (const node of layout.nodes) {
    if (node.anchor.kind === 'event') nodeByEvent.set(node.anchor.eventId, node);
  }

  for (const spec of layout.staves) {
    try {
      const stave = buildStave(spec);
      stave.setContext(ctx).draw();
      const nodes = grouped.get(spec.measureIndex) ?? [];
      drawBarlineHitAreas(ctx, stave, nodes);

      const measure = buildMeasureTickables(nodes, layout.clef);
      for (const [eventId, note] of measure.staveNotes) staveNotes.set(eventId, note);
      if (measure.tickables.length === 0) continue;

      const voice = new Voice({ numBeats: time.numBeats, beatValue: time.beatValue });
      voice.setMode(VoiceMode.SOFT);
      voice.addTickables([...measure.tickables]);
      voice.setStave(stave);
      new Formatter().joinVoices([voice]).formatToStave([voice], stave);
      drawTickables(ctx, stave, measure.entries);
      // 和弦符号挂成 `Annotation`，随宿主音符一起画完；`Annotation.draw()` 实测
      // `openGroup('annotation', id)`，所以这里拿得到它自己的 `<g>` 来写 anchor。
      // 它不画 `pointerRect`，热区用 `getBBox()` 事后补一块。
      for (const { node, annotation } of measure.annotations) {
        const element = annotation.getSVGElement();
        applyAnchorAttrs(element, node.anchor, { fallback: node.fallback });
        appendHitArea(element);
      }
    } catch (error) {
      drawStaveFailure(ctx, spec, error);
    }
  }

  // 关系画在所有 stave 之后：tie 需要两端音符都已 format（`getYs()` 才有值），
  // tuplet 需要成员的 `getAbsoluteX()`。两者内部各自 try/catch，逐段降级。
  const index = { staveNotes, nodes: nodeByEvent };
  drawStaffTies(ctx, layout.ties, index);
  drawStaffTuplets(ctx, layout.tuplets, index);

  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      ctx.svg.remove();
    },
  };
}
