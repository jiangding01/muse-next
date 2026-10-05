/**
 * notation/staff —— `RenderVoice` → `StaffLayout`（M2 T7.2）。
 *
 * 本文件负责**判定与编排**（谱号 / 调号 / 拍号、measure 切分、换行、节点放置、诊断）；
 * 单个事件画成什么在 `staffEventNodes.ts`，列宽兜底在 `staffSlotWidths.ts`，measure 与
 * system 复用 `layout/spacing.ts` / `layout/systems.ts`。`StaffLayout` 是 Staff **自己
 * 的** layout model，不继承万能基类、不与 `TabLayout` 互转（§2.7）。纯函数、确定性、
 * **零 Domain 修改**：同一 `(voice, ctx)` 必得逐字段相等的输出（`measurer` 亦须纯）。
 *
 * **横向布局的真源**（T7.2 裁决，详见 `StaffStaveSpec` 的 JSDoc）：`spacing` /
 * `layoutSystems` 只决定 measure / system 切分、system 打包、每个 stave 的**目标
 * 宽度**与换行；`slot.x` 是 packing 的输入，**不是**最终音符 x（stave 内音符 x 由
 * 渲染器的 formatter 排，T7.4）。节点只带 `measureIndex`/`systemIndex`/`slotIndex`。
 *
 * **行首预留参与换行判定，但预留空间归行首 stave 自己**：五线谱每行谱都要重画谱号 +
 * 调号 + 拍号（记谱惯例，**产品决定**，不是 JCX 格式事实），因此 packing 的可用宽度
 * 先扣掉一整份 `lineHeaderReserve`——不是先排完再给行首那一小节追加宽度（那样行首的
 * 谱号会把已经排满的一行挤超宽）。
 *
 * 预留出来的那段空间**加在行首 stave 的 `width` 上，而不是把整行内容右移**（T7.4 修正）：
 * 谱号 / 调号 / 拍号是**画在 stave 内部**的（渲染器从 stave 左缘起依次排它们，音符从
 * 三者之后才开始），所以「把所有 stave 右移 reserve」会在每行左侧留下一段谁都不画的
 * 死区，同时行首小节的音符区还被压掉同样宽度。正确的几何是：
 * - 行首 stave：`x = placement.x`（即 system box 的左边），`width = 内容宽 + reserve`；
 * - 非行首 stave：`x = placement.x + reserve`（因为行首 stave 变宽了），`width` 不变。
 *
 * 两条不变式因此成立：同一 system 内相邻 stave 首尾相接
 * （`prev.x + prev.width === next.x`），且最后一个 stave 的右缘
 * `x + width ≤ ctx.availableWidth`（packing 用的是 `availableWidth - reserve`）。
 *
 * **零 VexFlow 编码**：调号只给 `{ tonic, alter }` 这种 renderer-neutral 形状，
 * T7.4 才翻译成渲染器的调号名。
 *
 * T7.3 接上 tie / tuplet：拆段与诊断在 `staffRelations.ts`，本文件只负责把
 * 「事件 → 节点」的映射喂给它，并把结果放进 `ties` / `tuplets`。
 *
 * 本步**不做**：beam 分组（已裁决暂缓）、slur（T7.2 已在声部级发过未建模诊断）、
 * `toSvg` 与 renderer 接入（T7.4）。
 */

import type { EventId, Score, DomainIndex, Voice } from '../../domain';
import { externalExtent, mapExternalMeasures, placeExternalMeasure } from '../layout/measurePlacement';
import { STAFF_METRICS } from '../layout/metrics';
import type { MeasureSpacing, SpacedSlot } from '../layout/spacing';
import type { System } from '../layout/primitives';
import { layoutSystems, restackSystems, splitMeasures } from '../layout/systems';
import type { MeasureSlice } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { collectRenderDiagnostics, RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { Anchor, RenderItem, RenderVoice } from '../model/types';
import type { SystemMeasureGeometry } from '../system/contracts';
import { resolveStaffClef } from './staffClef';
import { buildStaffNode, classifyStaffBarline } from './staffEventNodes';
import type { StaffDraftSink } from './staffEventNodes';
import { buildStaffTies, buildStaffTuplets } from './staffRelations';
import { staffLineHeaderReserveOf, staffKeySignature, staffTimeSignature } from './staffHeader';
import { staffMeasureSpacing } from './staffSlotWidths';
import type {
  StaffBarlineForm,
  StaffClef,
  StaffEventNode,
  StaffLayout,
  StaffStaveSpec,
} from './staffTypes';

/**
 * 布局输入。`measurer` **显式注入**：无模块级单例、无全局兜底（§2.8）。`score` 与
 * `index` 必须与 `voice` 来自同一次 `loadJcx()`（§2.4.1）：`score` 只被读 `key` /
 * `meter` 两个**文档级**事实（谱号是声部级的，读 `voice.voice.clef`），`index` 供
 * T7.3 的关系反查使用——契约在这一步就位，免得到时再改签名。
 */
export interface StaffContext {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly measurer: TextMeasurer;
  /** 容器可用宽度（abstract unit）：贪心换行的唯一阈值（D7）；`external` 存在时不使用。 */
  readonly availableWidth: number;
  /**
   * M2.5 T5 external 几何（用户裁决 A1，Staff 只承诺 tier 1）：三项（measures / systems / topInsets）一起给出。
   * 缺席 = 走 M2 默认路径（逐字段不变）；存在 = stave 的 x / width 直接取公共 measure（行首 measure 的 `width` 已含 `lineStartReserve`，
   * **不再叠加** `staffLineHeaderReserve`），行首判据为 `contentOffsetX > 0`（K-b），stave 内音符 x 仍由
   * 渲染器 formatter 排（tier 2 归 T5.S）。任何不变量失败抛 `RangeError`，绝不回退。
   */
  readonly external?: {
    readonly measures: readonly SystemMeasureGeometry[];
    readonly systems: readonly System[];
    /**
     * M2.5 T9b.S（用户裁决 M3）：systemIndex → 本行 Staff 内容的上内缩（= vertical prepass 的 `topExtra`，有限且
     * ≥ 0）。**必填**，`systems` 的每一行恰好一个条目（本行没有本声部 measure 时为 0）；层 box 高必须 ≥ 基础
     * `systemHeight` 且 `内缩 + systemHeight ≤ 层高`。缺条目 / 多条目 / 非法值 / 结构不一致一律 `RangeError`，
     * 不 clamp、不回退 0。stave 的 `y` = 层 box 顶 + 内缩；本层只消费，不重算纵向需求。
     */
    readonly topInsets: ReadonlyMap<number, number>;
  };
}

/** 一个 stave 的横向几何与逐项 slot（默认路径 = 本声部 spacing；external = 最终分配）。 */
interface StaveFrame {
  readonly systemIndex: number;
  readonly x: number;
  /** stave 相对层 box 顶的下移量（默认路径恒 0）。 */
  readonly topInset: number;
  readonly width: number;
  readonly lineStart: boolean;
  readonly slots: readonly SpacedSlot[];
}

interface StaffPass {
  readonly frames: readonly (StaveFrame | undefined)[];
  readonly systems: readonly System[];
}

/**
 * T9b.S：`topInsets` 的键集合必须恰为 `systems` 的 index 集合；值有限且 ≥ 0；层高有限且 ≥ 基础 `systemHeight`，
 * 并容得下「内缩 + 基础高」（裁决 L-3：只做一致性校验，不重算需求）。
 */
function checkedTopInsets(external: NonNullable<StaffContext['external']>): ReadonlyMap<number, number> {
  const { systems, topInsets } = external;
  const base = STAFF_METRICS.systemHeight;
  for (const system of systems) {
    const label = `staff external: system ${String(system.index)}`;
    const inset = topInsets.get(system.index);
    const height = system.box.height;
    if (inset === undefined) throw new RangeError(`${label} 缺少 topInset 条目`);
    if (!Number.isFinite(inset) || inset < 0) throw new RangeError(`${label} 的 topInset ${String(inset)} 非法`);
    if (!Number.isFinite(height) || height < base) throw new RangeError(`${label} 的层高 ${String(height)} 小于基础高 ${String(base)}`);
    if (inset + base > height) throw new RangeError(`${label} 的 topInset ${String(inset)} + 基础高超出层高 ${String(height)}`);
  }
  const indices = new Set(systems.map((system) => system.index));
  for (const key of topInsets.keys()) {
    if (!indices.has(key)) throw new RangeError(`staff external: topInset 条目 ${String(key)} 不对应任何 system`);
  }
  return topInsets;
}

/** M2.5 T5 external 路径（tier 1）：measure → 公共框只按 participation 映射；不换行、不 restack。 */
function externalPass(
  voice: RenderVoice, measures: readonly MeasureSlice[], spacings: readonly MeasureSpacing[],
  external: NonNullable<StaffContext['external']>,
): StaffPass {
  const mapped = mapExternalMeasures(voice.voiceId, measures, external);
  const topInsets = checkedTopInsets(external);
  const frames = measures.map((measure, measureIndex): StaveFrame | undefined => {
    const spacing = spacings[measureIndex];
    const box = mapped.byLocal.get(measureIndex);
    if (spacing === undefined || box === undefined) return undefined;
    const topInset = topInsets.get(box.systemIndex);
    // `mapExternalMeasures` 已保证 box 的 systemIndex 在 systems 里，`checkedTopInsets` 已保证每个 system 有条目。
    if (topInset === undefined) throw new RangeError(`staff external: system ${String(box.systemIndex)} 缺少 topInset 条目`);
    return {
      systemIndex: box.systemIndex,
      topInset,
      x: (mapped.systemByIndex.get(box.systemIndex)?.box.origin.x ?? 0) + box.x,
      width: box.width,
      lineStart: box.contentOffsetX > 0,
      slots: placeExternalMeasure(measure, spacing, box),
    };
  });
  return { frames, systems: mapped.systems };
}

function draftOf(code: RenderDiagnosticDraft['code'], level: 'info' | 'warning',
  message: string, anchor: Anchor, sourceRef: RenderDiagnosticDraft['sourceRef'],
): RenderDiagnosticDraft {
  return sourceRef === undefined
    ? { code, level, message, anchor }
    : { code, level, message, anchor, sourceRef };
}

/**
 * 谱号：三态规则的唯一实现在 `staffClef.ts`（纯、不发诊断）；本函数只按 `status` 发原有诊断——缺席 → 默认 + info；
 * 不可识别 → 默认 + warning 并把原值带进消息，不静默。
 */
function resolveClef(voice: Voice, sink: StaffDraftSink): StaffClef {
  const anchor: Anchor = { kind: 'voice', voiceId: voice.id };
  const ref = voice.origins[0];
  const resolved = resolveStaffClef(voice.clef);
  if (resolved.status === 'absent') {
    sink(draftOf(CODES.staffClefAbsent, 'info', `声部未声明 clef：按默认谱号 ${resolved.clef} 呈现（产品决定，spec 未规定缺省谱号）`, anchor, ref));
  }
  if (resolved.status === 'unrecognized') {
    sink(draftOf(CODES.staffClefUnrecognized, 'warning', `clef=${resolved.raw} 不是本层已知的谱号（treble / bass / alto / tenor）：按默认谱号 ${resolved.clef} 呈现并显示原值，不猜它的含义`, anchor, ref));
  }
  return resolved.clef;
}

/** 小节首/末项若是小节线就把形态带上；缺席表示作者没写，**不代表「普通单线」**。 */
function barlineFormAt(items: readonly RenderItem[], offset: number): StaffBarlineForm | undefined {
  const item = items[offset];
  return item !== undefined && item.event.kind === 'barline'
    ? classifyStaffBarline(item.event.raw)
    : undefined;
}

/** 声部级「未建模」诊断：各发一条，不逐成员挂。 */
function sinkVoiceDiagnostics(voice: Voice, sink: StaffDraftSink): void {
  const anchor: Anchor = { kind: 'voice', voiceId: voice.id };
  const ref = voice.origins[0];
  if (voice.slurs.length > 0) {
    sink(draftOf(CODES.staffSlurNotModeled, 'info', `本声部有 ${String(voice.slurs.length)} 条圆滑线（slur）：M2 的五线谱布局不画圆滑线，关系事实如实保留在 Domain 里，不静默丢弃`, anchor, ref));
  }
  if (voice.lyricLines.length > 0) {
    sink(draftOf(CODES.staffLyricsNotModeled, 'info', `本声部有 ${String(voice.lyricLines.length)} 行歌词：M2 的五线谱布局不排歌词（简谱侧才排），歌词事实如实保留在 Domain 里`, anchor, ref));
  }
}

/** Staff 布局入口。 */
export function layoutStaff(voice: RenderVoice, ctx: StaffContext): StaffLayout {
  const drafts: RenderDiagnosticDraft[] = [];
  const sink: StaffDraftSink = (draft) => {
    drafts.push(draft);
  };

  const clef = resolveClef(voice.voice, sink);
  const keySignature = staffKeySignature(ctx.score.key);
  const timeSignature = staffTimeSignature(ctx.score.meter);
  const lineHeaderReserve = staffLineHeaderReserveOf(keySignature, timeSignature);

  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) => staffMeasureSpacing(measure, ctx.measurer));

  const { frames, systems } = ctx.external === undefined
    ? defaultPass(spacings, lineHeaderReserve, ctx.availableWidth)
    : externalPass(voice, measures, spacings, ctx.external);
  // 行谱一律按 `System.index` 查（T5）：external 模式的 index 是全文档全局序号，不是本数组下标。
  const systemByIndex = new Map(systems.map((system) => [system.index, system]));

  const nodes: StaffEventNode[] = [];
  const slots: SpacedSlot[] = [];
  const staves: StaffStaveSpec[] = [];
  // 索引的是**布局产物**（事件 → 本次布局的节点），不是 Domain lookup（§2.4.1，P2-G）；
  // T7.3 的关系拆段靠它判断端点落在第几行、画不画得出来。
  const nodeByEvent = new Map<EventId, StaffEventNode>();

  for (const [measureIndex, measure] of measures.entries()) {
    const frame = frames[measureIndex];
    if (frame === undefined) continue;
    const system = systemByIndex.get(frame.systemIndex);
    if (system === undefined) continue;

    // 行首 stave 才带谱号/调号/拍号：每行重画是记谱惯例。
    const lineStart = frame.lineStart;
    const beginBarline = measure.items.length > 1 ? barlineFormAt(measure.items, 0) : undefined;
    const endBarline = barlineFormAt(measure.items, measure.items.length - 1);
    staves.push({
      systemIndex: frame.systemIndex,
      measureIndex,
      x: frame.x,
      y: system.box.origin.y + frame.topInset,
      width: frame.width,
      ...(lineStart ? { clef } : {}),
      ...(lineStart && keySignature !== undefined ? { keySignature } : {}),
      ...(lineStart && timeSignature !== undefined ? { timeSignature } : {}),
      ...(beginBarline === undefined ? {} : { beginBarline }),
      ...(endBarline === undefined ? {} : { endBarline }),
    });

    for (const [offset, item] of measure.items.entries()) {
      const slot = frame.slots[offset];
      if (slot === undefined) continue;
      slots.push(slot);
      const node = buildStaffNode(
        { item, slot, measureIndex, systemIndex: frame.systemIndex },
        voice.voiceId,
        sink,
      );
      nodes.push(node);
      nodeByEvent.set(item.eventId, node);
    }
  }

  const ties = buildStaffTies(voice, ctx.index, nodeByEvent, sink);
  const tuplets = buildStaffTuplets(voice, ctx.index, nodeByEvent, sink);
  sinkVoiceDiagnostics(voice.voice, sink);

  const lastSystem = systems[systems.length - 1];
  // external 模式（I）：宽高取全部行谱的最大外沿，不依赖数组顺序；没有行谱时取默认路径的空值。
  const extent = ctx.external === undefined ? undefined : externalExtent(systems);
  return {
    voiceId: voice.voiceId,
    clef,
    systems,
    measures,
    slots,
    staves,
    nodes,
    ties,
    tuplets,
    width: ctx.external === undefined
      ? systems.reduce((max, system) => Math.max(max, system.box.width), 0)
      : extent?.width ?? 0,
    height: ctx.external === undefined
      ? lastSystem === undefined ? 0 : lastSystem.box.origin.y + lastSystem.box.height
      : extent?.height ?? 0,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}

/**
 * M2 默认路径（逐字段不变）：packing 前先扣行首预留；预留空间归行首 stave 自己（见文件头）。
 */
function defaultPass(spacings: readonly MeasureSpacing[], lineHeaderReserve: number, availableWidth: number): StaffPass {
  const geometry = {
    // 行首预留在**打包之前**就从可用宽度里扣掉：排完再补会让行首那一小节把整行挤超宽。
    availableWidth: Math.max(0, availableWidth - lineHeaderReserve),
    systemHeight: STAFF_METRICS.systemHeight,
    systemGap: STAFF_METRICS.systemGap,
    // 谱面头部走 HTML 路径（`scoreHeader.ts`），不占 Staff 画布纵向空间，故从 0 起排。
    originY: 0,
  };
  const packed = layoutSystems(spacings.map((spacing) => spacing.width), geometry);

  // 两趟布局的结构照 T6 保留：第一趟只定横向归属，第二趟回填额外高度。**M2 默认路径的额外高度恒为 0**
  // （用户裁决 M4：本路径保持基础 96，不重做动态 restack）——超出谱表上方 32 / 下方 24 的加线、符干、
  // 升降号、附点、tie 墨迹在这条路径上**不被包住**；M2.5 systemized external 路径的纵向需求由
  // `staffVerticalDemand.ts` 在 T8 prepass 中算出（T9b.S），经 `external.topInsets` 与层高传入。
  const extraHeights = packed.systems.map(() => 0);
  const restacked = restackSystems(packed.systems, extraHeights, geometry);
  // `layoutSystems` 只知道内容宽度；行首预留是 Staff 自己的事，在这里补回行宽。
  const systems: readonly System[] = restacked.map((system) => ({
    index: system.index,
    box: { ...system.box, width: system.box.width + lineHeaderReserve },
  }));
  const frames = spacings.map((spacing, measureIndex): StaveFrame | undefined => {
    const placement = packed.placements[measureIndex];
    if (placement === undefined) return undefined;
    // 行首 stave（`placement.x === 0`）；见文件头「行首预留」：reserve 是行首 stave 的一部分，不是整行的左边距。
    const lineStart = placement.x === 0;
    return {
      systemIndex: placement.systemIndex,
      topInset: 0,
      x: lineStart ? placement.x : placement.x + lineHeaderReserve,
      width: lineStart ? spacing.width + lineHeaderReserve : spacing.width,
      lineStart,
      slots: spacing.slots,
    };
  });
  return { frames, systems };
}
