/**
 * notation/system —— M2.5 Score System Layout 的**纯类型契约**（叶子层）。
 *
 * 依据：方案 v1.0 §B.3 + T0 拍板：`MeasureParticipation` 判别联合；单页 `PageLayout`；补齐 `LayoutTarget` /
 * `PackingPolicy` / `PageSpec` / `PageComposedSystemLayout`；`ChordDiagramOverlay.anchor` 收窄为 `EventAnchor`。
 *
 * **叶子层硬规则**（§B.2 / §Q7.4 守卫 1）：只允许 **type-only** import `../../domain`、
 * `../layout/primitives`、`../model/types` 三条精确路径，三个 voice layout 引用本文件不成环。
 * 全部 readonly、零方法、零 class、零运行时值；单位是 abstract unit（D6），**不是像素**。
 */

import type { Rational, VoiceId } from '../../domain';
import type { Box } from '../layout/primitives';
import type { Anchor } from '../model/types';

/** 一次 compose 的版式目标（§Q6.4）：屏幕交互视图 vs 分页打印数据。 */
export type LayoutTarget = 'screen' | 'page';

/** 系统连接符形态（§Q1.4）：本期只产出 `bracket` / `none`，另两值由类型占位。 */
export type SystemConnector = 'bracket' | 'brace' | 'staves' | 'none';

/** 一个 system group：哪些声部在同一个方括号 / 花括号 / 竖线里（§Q1）。 */
export interface SystemGroup {
  /** 文档顺序，0-based。 */
  readonly index: number;
  /** 层顺序 = `Score.voices` 的文档顺序（§Q1.3，不按 notation 重排）。 */
  readonly voiceIds: readonly VoiceId[];
  readonly connector: SystemConnector;
  /** `declared` = 声部上真的写了连接属性；`singleton` = 无分组证据，自成一组。 */
  readonly evidence: 'declared' | 'singleton';
}

/**
 * 某个 voice 在一个对齐后 measure 上的参与情况（§Q2.3 / §Q2.4）。
 *
 * **判别联合，不是「字段可选」**：`present` / `incompatible` 必带该 voice 自己的
 * measure 序号；`absent`（该 voice measure 数不足，前缀对齐后留空保宽）没有序号。
 */
export type MeasureParticipation =
  | {
      readonly voiceId: VoiceId;
      readonly kind: 'present';
      readonly localMeasureIndex: number;
    }
  | {
      readonly voiceId: VoiceId;
      readonly kind: 'incompatible';
      readonly localMeasureIndex: number;
    }
  | {
      readonly voiceId: VoiceId;
      readonly kind: 'absent';
    };

/**
 * 小节内的**共享音乐 onset** 位置（§Q3）。`offsets` 单调递增，非空时首项恒为 ZERO；无 timed 事件时为空（R3）。
 *
 * **只表示音乐时间**：timed event 的 onset（绝对 `Rational` 累计，零归一化），外加
 * `chordSymbol` 这种明确的 zero-time overlay（贴在后续 onset 上，不新增位置）。
 * **不包含** barline / decoration / grace / unknown——它们走 voice-local slot（§Q3.1b）。
 */
export interface MeasureTimeline {
  /** 小节内累计 onset（仅 timed event）。 */
  readonly offsets: readonly Rational[];
  /** 小节内容总时长（= 末 onset + 该事件时值）。 */
  readonly total: Rational;
  /** 与 `offsets` 同序的 measure 内相对 x；`[0] = contentOffsetX + lead`（T4 裁决 D/E，已含行首预留）。 */
  readonly xByOffsetIndex: readonly number[];
  /** 收尾 barline 的相对 x（无收尾 barline 时 = 逻辑内容末端）；`width = endX + tail`（T4 裁决 D/E）。 */
  readonly endX: number;
}

/** 跨声部对齐后的一个 measure 的公共几何（§Q2 / §Q4）。 */
export interface SystemMeasureGeometry {
  /** group 内的对齐序号（ordinal candidate，**不是** Domain 身份，§Q2.2）。 */
  readonly measureOrdinal: number;
  readonly systemIndex: number;
  /** system box 内的左边界。 */
  readonly x: number;
  /** 公共宽度（justify 后终值，含 `contentOffsetX`）；恒 `≥` 每个 voice 的 demand（§Q4.6）。 */
  readonly width: number;
  /** justify 之前的内容需求宽（量化后的 operational minimum，不含行首预留）。 */
  readonly demandWidth: number;
  /** 内容起点：行首 measure = 该行 `lineStartReserve`，其余 0（T4 裁决 G-b；timeline 已含，T5 不得重复加）。 */
  readonly contentOffsetX: number;
  /** 缺席 = 本 measure 退出 shared intra-measure timing（tier 3，§Q2.4）。 */
  readonly timeline?: MeasureTimeline;
  /** 每个 voice 的参与情况，顺序同 `SystemGroup.voiceIds`。 */
  readonly participation: readonly MeasureParticipation[];
}

/** 声部层的记谱种类；`fallback` = 无法识别 style 时的占位层（T4：demand / 预留恒 0）。 */
export type VoiceLayerNotation = 'jianpu' | 'tab' | 'staff' | 'fallback';

/** 一个声部层在某个 system 上的归属与纵向位置（不复制几何，§B.3）。 */
export interface VoiceLayerLayout {
  readonly voiceId: VoiceId;
  readonly notation: VoiceLayerNotation;
  /** system 内自上而下的层序。 */
  readonly layerIndex: number;
  /** 该层在 system box 内的纵向偏移。 */
  readonly top: number;
  readonly height: number;
}

/** `Anchor` 的 event 分支：和弦图 overlay 恒挂在它的 `ChordSymbolEvent` 上（§Q5.4）。 */
export type EventAnchor = Extract<Anchor, { readonly kind: 'event' }>;

/** 和弦图 overlay：system 第 0 层，不进任何 voice layout 的 `nodes`（§Q5.3 / §Q7.1）。 */
export interface ChordDiagramOverlay {
  readonly anchor: EventAnchor;
  /** `chordSymbolDisplayText(raw)` 的结果。 */
  readonly displayText: string;
  /** `Score.chordShapes` 的下标；缺席 = 只画名（0 命中 / 同名歧义 / 碰撞降级）。 */
  readonly shapeIndex?: number;
  /** system box 内的绝对 x（对齐到所属 offset）。 */
  readonly x: number;
  /** 块顶 y（system box 内；块底对齐和弦带底，M2.5 T8 裁决 E）。 */
  readonly y: number;
  readonly systemIndex: number;
}

/**
 * 行内两端对齐状态，**以 §Q4.5 water-filling 为准**（§B.3 / §Q7.2「有 measure 触顶」的措辞
 * 与之矛盾，不取）：`full` = 拉满行宽；`partial` = 全部 measure 触顶 `maxJustifyRatio` 后
 * 仍有剩余宽、右侧留白；`none` = 未拉伸（如末行，F-3）。
 */
export type JustifyState = 'full' | 'partial' | 'none';

/**
 * 一个跨声部的成品谱 system：overlay 层 + 有序 voice 层 + measure 公共几何。方案 §B.3 原名
 * `SystemLayout`，因与 `layout/systems.ts` 的 `SystemLayout`（单声部换行结果）同名不同义，
 * 2026-10-04 用户裁决改名为 `ScoreSystemLayout`（后者不动）。
 */
export interface ScoreSystemLayout {
  readonly index: number;
  readonly box: Box;
  readonly groupIndex: number;
  readonly measures: readonly SystemMeasureGeometry[];
  readonly layers: readonly VoiceLayerLayout[];
  readonly chordOverlays: readonly ChordDiagramOverlay[];
  readonly justified: JustifyState;
}

/** packing 输入（§Q6.1，不跨 target 共享）；`barsPerStaff` 是 DOC-ONLY 接口预留，M2.5 恒 `undefined`。 */
export type PackingPolicy =
  | { readonly kind: 'screen'; readonly availableWidth: number }
  | { readonly kind: 'page'; readonly contentWidth: number; readonly barsPerStaff?: number };

/**
 * compose 的产物包装（§Q6.4）。`ScoreSystemLayout` 自身**不带** target——版式目标是这一次
 * compose 的属性，不是每个 system 的属性。
 */
export interface ComposedSystemLayout {
  readonly target: LayoutTarget;
  readonly systems: readonly ScoreSystemLayout[];
}

/** `pageModel()` 唯一接受的入参类型：screen 产物在编译期就传不进去（§Q6.4）。 */
export type PageComposedSystemLayout = ComposedSystemLayout & { readonly target: 'page' };

/** 纸张 / 边距 / 页眉页脚高度（abstract unit）；默认值见 `SYSTEM_METRICS.page`（F-8）。 */
export interface PageSpec {
  readonly width: number;
  readonly height: number;
  readonly marginTop: number;
  readonly marginRight: number;
  readonly marginBottom: number;
  readonly marginLeft: number;
  /** 首页页眉高（标题 / 演唱 / 原调-选调 / 作词-作曲，Brief §2.7.1）。 */
  readonly firstPageHeaderHeight: number;
  /** 续页页眉高。 */
  readonly continuationHeaderHeight: number;
  /** 页脚高（页码带）。 */
  readonly footerHeight: number;
}

/** 一页的分配结果（§Q6.5）。 */
export interface PageLayout {
  /** 0-based 存储，显示时从 1 起。 */
  readonly index: number;
  /** 页面内容框（页边距内、页眉页脚之间）。 */
  readonly contentBox: Box;
  /** 页眉占位（首页 / 续页高度不同）。 */
  readonly headerBox: Box;
  /** 页脚占位（页码）。 */
  readonly footerBox: Box;
  readonly systemIndices: readonly number[];
  /** 该页唯一的 system 仍高于内容框（§Q6.6）；不拆、不缩放。 */
  readonly overflow: boolean;
}

/** system → page 分配的纯数据产物（§Q6.3 / §Q6.5）；本期不接任何打印 UI。 */
export interface PageModel {
  readonly pages: readonly PageLayout[];
  readonly pageSpec: PageSpec;
  /** 接口预留，M2.5 恒 `undefined`（Brief §10.18）。 */
  readonly barsPerStaffHint?: number;
}
