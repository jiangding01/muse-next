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
 * **行首预留参与换行判定**：五线谱每行谱都要重画谱号 + 调号 + 拍号（记谱惯例，
 * **产品决定**，不是 JCX 格式事实），因此 packing 的可用宽度先扣掉一整份
 * `lineHeaderReserve`，排完再把内容整体右移这么多——不是先排完再给行首那一小节追加
 * 宽度（那样行首的谱号会把已经排满的一行挤超宽）。**零 VexFlow 编码**：调号只给
 * `{ tonic, alter }` 这种 renderer-neutral 形状，T7.4 才翻译成渲染器的调号名。
 *
 * T7.3 接上 tie / tuplet：拆段与诊断在 `staffRelations.ts`，本文件只负责把
 * 「事件 → 节点」的映射喂给它，并把结果放进 `ties` / `tuplets`。
 *
 * 本步**不做**：beam 分组（已裁决暂缓）、slur（T7.2 已在声部级发过未建模诊断）、
 * `toSvg` 与 renderer 接入（T7.4）。
 */

import type { EventId, KeySignature, Meter, Score, DomainIndex, Voice } from '../../domain';
import { keyHasExtraText } from '../layout/keySpelling';
import { STAFF_METRICS } from '../layout/metrics';
import { spaceItems } from '../layout/spacing';
import type { SpacedSlot } from '../layout/spacing';
import type { System } from '../layout/primitives';
import { layoutSystems, restackSystems, splitMeasures } from '../layout/systems';
import type { TextMeasurer } from '../layout/textMeasurer';
import { collectRenderDiagnostics, RENDER_DIAGNOSTIC_CODES as CODES } from '../model/diagnostics';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { Anchor, RenderItem, RenderVoice } from '../model/types';
import { buildStaffNode, classifyStaffBarline } from './staffEventNodes';
import type { StaffDraftSink } from './staffEventNodes';
import { buildStaffTies, buildStaffTuplets } from './staffRelations';
import { widenForStaffGlyphs } from './staffSlotWidths';
import type {
  StaffBarlineForm,
  StaffClef,
  StaffEventNode,
  StaffKeySignature,
  StaffLayout,
  StaffStaveSpec,
  StaffTimeSignature,
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
  /** 容器可用宽度（abstract unit）：贪心换行的唯一阈值（D7）。 */
  readonly availableWidth: number;
}

/** 缺省谱号：`treble`（**产品决定**——spec 从未规定 `clef` 缺席时的缺省值）。 */
const DEFAULT_CLEF: StaffClef = 'treble';
function isKnownClef(value: string): value is StaffClef {
  return value === 'treble' || value === 'bass' || value === 'alto' || value === 'tenor';
}

function draftOf(code: RenderDiagnosticDraft['code'], level: 'info' | 'warning',
  message: string, anchor: Anchor, sourceRef: RenderDiagnosticDraft['sourceRef'],
): RenderDiagnosticDraft {
  return sourceRef === undefined
    ? { code, level, message, anchor }
    : { code, level, message, anchor, sourceRef };
}

/**
 * 谱号：**只读 `voice.clef`，不解析 `K:` 里的谱号文本**（spec §8.7 明写 `K:` 的 clef
 * 不解析，`KeySignature` 里根本没有 clef 字段）。三态：缺席 → 默认 + info；值落在
 * `{treble, bass, alto, tenor}` → 采用；其它值（含 `standardtab`、`treble+8` 这类
 * `INFERRED` 的扩展写法——**能不能出现在 `.jcx` 里本层没有证据，不得写成「已确认
 * JCX 格式能力」**）→ 默认 + warning 并把原值带进消息，不静默。
 */
function resolveClef(voice: Voice, sink: StaffDraftSink): StaffClef {
  const anchor: Anchor = { kind: 'voice', voiceId: voice.id };
  const ref = voice.origins[0];
  if (voice.clef === undefined) {
    sink(draftOf(CODES.staffClefAbsent, 'info', `声部未声明 clef：按默认谱号 ${DEFAULT_CLEF} 呈现（产品决定，spec 未规定缺省谱号）`, anchor, ref));
    return DEFAULT_CLEF;
  }
  if (isKnownClef(voice.clef)) {
    return voice.clef;
  }
  sink(draftOf(CODES.staffClefUnrecognized, 'warning', `clef=${voice.clef} 不是本层已知的谱号（treble / bass / alto / tenor）：按默认谱号 ${DEFAULT_CLEF} 呈现并显示原值，不猜它的含义`, anchor, ref));
  return DEFAULT_CLEF;
}

/**
 * 调号：只有 `tonic` 存在且 `raw` 里**没有规范拼写以外的文本**时才画（见
 * `layout/keySpelling.ts`）。不画时**不发新诊断**——`keyAbsent` / `keyUnresolved` /
 * `keyModeUnrecognized` 已由 `scoreHeader.ts` 在文档级表达（§4.2）；T7.4 把 staff
 * 并进那边的 consumer 谓词。
 */
function staffKeySignature(key: KeySignature | undefined): StaffKeySignature | undefined {
  if (key === undefined || key.tonic === undefined || keyHasExtraText(key)) return undefined;
  return key.alter === undefined ? { tonic: key.tonic } : { tonic: key.tonic, alter: key.alter };
}

/**
 * 拍号：只认 `fraction` 分支。`raw`（`C` / `C|` / 复合拍号）与缺席一律省略字段
 * ——**不换算成 4/4**；`meterRaw` 诊断由 `scoreHeader.ts` 在文档级发一次，本层不重发。
 * 也**不做任何满拍 / tick 校验**（P1-3：`Meter` 不参与任何列宽计算）。
 */
function staffTimeSignature(meter: Meter | undefined): StaffTimeSignature | undefined {
  if (meter === undefined || meter.kind !== 'fraction') return undefined;
  return { numerator: meter.num, denominator: meter.den };
}

/** 行首要留的水平空间：谱号 + 调号（按保守上限估个数）+ 拍号，按实际是否存在累加。 */
function lineHeaderReserveOf(
  key: StaffKeySignature | undefined,
  time: StaffTimeSignature | undefined,
): number {
  const reserve = STAFF_METRICS.headerReserve;
  const keyWidth = key === undefined
    ? 0
    : reserve.keySignatureWidthPerAccidental * reserve.keySignatureAccidentalReserve;
  return reserve.clefWidth + keyWidth + (time === undefined ? 0 : reserve.timeSignatureWidth);
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
  const lineHeaderReserve = lineHeaderReserveOf(keySignature, timeSignature);

  const measures = splitMeasures(voice.items);
  const spacings = measures.map((measure) =>
    widenForStaffGlyphs(
      spaceItems(measure.items, measure.startIndex),
      measure.items,
      ctx.measurer,
    ),
  );

  const geometry = {
    // 行首预留在**打包之前**就从可用宽度里扣掉：排完再补会让行首那一小节把整行挤超宽。
    availableWidth: Math.max(0, ctx.availableWidth - lineHeaderReserve),
    systemHeight: STAFF_METRICS.systemHeight,
    systemGap: STAFF_METRICS.systemGap,
    // 谱面头部走 HTML 路径（`scoreHeader.ts`），不占 Staff 画布纵向空间，故从 0 起排。
    originY: 0,
  };
  const packed = layoutSystems(spacings.map((spacing) => spacing.width), geometry);

  // 两趟布局的结构照 T6 保留：第一趟只定横向归属，第二趟按每行实际需要的额外高度
  // 回填。本步节点都画在 `systemHeight` 之内（加线空间已含在 `staffTopOffset` 与
  // `systemHeight` 的推导里），额外高度恒为 0。
  //
  // **T7.3 判断：tie / tuplet bracket 不补高**。两条理由缺一不可：① 它们在本层
  // **不带任何 y**（见 `StaffTie` / `StaffTupletBracket`），notation 层根本没有可以
  // 折算成「额外高度」的量，硬补就是凭空造几何；② tuplet 括号画在谱表上方，而
  // `staffTopOffset(32)` 已按 3 条上加线 + 呼吸空间预留，tie 的弧落在符头附近同样在
  // `systemHeight(96)` 的包络内——真要超出，那是 adapter（T7.4）拿到实际 y 之后才判
  // 得出来的事，届时由它回填，不由这里猜。
  const extraHeights = packed.systems.map(() => 0);
  const restacked = restackSystems(packed.systems, extraHeights, geometry);
  // `layoutSystems` 只知道内容宽度；行首预留是 Staff 自己的事，在这里补回行宽。
  const systems: readonly System[] = restacked.map((system) => ({
    index: system.index,
    box: { ...system.box, width: system.box.width + lineHeaderReserve },
  }));

  const nodes: StaffEventNode[] = [];
  const slots: SpacedSlot[] = [];
  const staves: StaffStaveSpec[] = [];
  // 索引的是**布局产物**（事件 → 本次布局的节点），不是 Domain lookup（§2.4.1，P2-G）；
  // T7.3 的关系拆段靠它判断端点落在第几行、画不画得出来。
  const nodeByEvent = new Map<EventId, StaffEventNode>();

  for (const [measureIndex, measure] of measures.entries()) {
    const spacing = spacings[measureIndex];
    const placement = packed.placements[measureIndex];
    if (spacing === undefined || placement === undefined) continue;
    const system = systems[placement.systemIndex];
    if (system === undefined) continue;

    // 行首 stave（`placement.x === 0`）才带谱号/调号/拍号：每行重画是记谱惯例。
    const lineStart = placement.x === 0;
    const beginBarline = measure.items.length > 1 ? barlineFormAt(measure.items, 0) : undefined;
    const endBarline = barlineFormAt(measure.items, measure.items.length - 1);
    staves.push({
      systemIndex: placement.systemIndex,
      measureIndex,
      x: lineHeaderReserve + placement.x,
      y: system.box.origin.y,
      width: spacing.width,
      ...(lineStart ? { clef } : {}),
      ...(lineStart && keySignature !== undefined ? { keySignature } : {}),
      ...(lineStart && timeSignature !== undefined ? { timeSignature } : {}),
      ...(beginBarline === undefined ? {} : { beginBarline }),
      ...(endBarline === undefined ? {} : { endBarline }),
    });

    for (const [offset, item] of measure.items.entries()) {
      const slot = spacing.slots[offset];
      if (slot === undefined) continue;
      slots.push(slot);
      const node = buildStaffNode(
        { item, slot, measureIndex, systemIndex: placement.systemIndex },
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
    width: systems.reduce((max, system) => Math.max(max, system.box.width), 0),
    height: lastSystem === undefined ? 0 : lastSystem.box.origin.y + lastSystem.box.height,
    diagnostics: collectRenderDiagnostics(drafts),
  };
}
