/**
 * notation/jianpu —— 简谱 layout 的**节点类型**与**基准几何**（M2 方案 v1.1.1 §3.2 / §2.7，
 * T4；自 `layoutJianpu.ts` 拆出；U-Polish Phase A 再拆出字形构造函数到
 * `jianpuGlyphBuilders.ts`）。拆分理由：`layoutJianpu.ts` 管切分 / 换行 / 关系 / 歌词 /
 * 诊断，必超 350 行上限；`jianpuGlyphBuilders.ts` 管「给定基准点画出具体字形」，本文件只留
 * 节点类型定义 + 少数**跨构造函数共享**的基准几何（`digitTop` / `digitBottom` /
 * `digitMidline` / `barlineTop` / `barlineBottom`）——它们是多个构造函数（附点、延音线、
 * 小节线、未知占位框、降级角标）共同的纵向参照系，留在类型文件里避免被拆散成不同文件里
 * 各算各的坐标。歌词行与头部标签另见 `jianpuSections.ts`。这些类型是**简谱自己的**
 * layout model，不继承任何万能基类，也不与 `ChordLayout` / `TabLayout` / `StaffLayout`
 * 互相转换（§2.7）。依赖方向单向 `layoutJianpu.ts → jianpuGlyphBuilders.ts →
 * jianpuGlyphs.ts`，无环；尺寸一律取自 `metrics.ts` 的 `JIANPU_METRICS`（唯一来源），
 * 单位是 abstract unit（D6，不是像素）。
 */

import type { SourceRef } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { Point } from '../layout/primitives';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { Anchor, RenderDiagnosticCode } from '../model/types';
import type { JianpuPitch } from './pitchToNumber';

export interface JianpuSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** `fontSize` 同时供 `TextMeasurer` 与渲染使用。 */
export interface JianpuTextGlyph {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
}

/**
 * 时值装饰。`unrepresentable` 为真时三者**全为空**——方案 §3.2「分解失败」行明写
 * 「不画任何时值装饰」，而不是退到某个近似写法（那是在编造作者没写的时值）。
 */
export interface JianpuDurationGlyphs {
  readonly beams: readonly JianpuSegment[];
  readonly dashes: readonly JianpuSegment[];
  readonly augmentationDots: readonly Point[];
  readonly unrepresentable: boolean;
}

/** 八度点 + 临时记号（临时记号原样渲染，不因调号增删，前提 P3）。 */
export interface JianpuPitchGlyphs {
  readonly octaveDots: readonly Point[];
  readonly accidental?: JianpuTextGlyph;
}

/**
 * 小节线形态（spec §18 最长匹配）。**只有四种形态是 `CONFIRMED` 的**：`|`（单线）、
 * `|]`（细+粗终止线）、`:|` / `|:`（反复点）。`||`、`::`、`[|`、`[:]`、`[|]` 等在
 * spec §18 里是 `DOC-ONLY` 且语料 0，与任意表外组合同等对待 → `unrecognized`：画一根
 * 普通竖线 + 一条诊断。给 `DOC-ONLY` 的写法配专属字形＝把没有证据的记法画成既成事实。
 */
export type BarlineForm = 'single' | 'final' | 'repeat-start' | 'repeat-end' | 'unrecognized';

/** 小节线构件。反复语义**只画形状，不做任何展开/跳转**（§3.2）。 */
export interface JianpuBarlineGlyphs {
  readonly lines: readonly JianpuSegment[];
  readonly repeatDots: readonly Point[];
  /** 粗线在 `lines` 中的下标；终止线用它区分细/粗。 */
  readonly thickLineIndices: readonly number[];
}

// ---------------------------------------------------------------------------
// 节点类型
// ---------------------------------------------------------------------------

export interface JianpuNodeBase {
  readonly anchor: Anchor;
  readonly sourceRef: SourceRef;
  readonly slotIndex: number;
  readonly measureIndex: number;
  readonly systemIndex: number;
  /** `x` 是列左边界、`y` 是数字基线，都是绝对坐标。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** 主字形视觉 bbox 跨度，**不是**槽位宽 `width`；弧线端点用它。零成员 chord/grace 为 0。grace 字形整体相对 `x` 偏移 `±graceOffsetX`，`[x, x+glyphWidth]` 不是它的真实 bbox（grace 不作 tie/slur 端点）。 */
  readonly glyphWidth: number;
  /** 是否走了降级路径（契约 C2：这类节点至少关联一条 `RenderDiagnostic`）。 */
  readonly fallback: boolean;
}

export interface JianpuChordMemberGlyph {
  readonly memberIndex: number;
  readonly text: JianpuTextGlyph;
  readonly pitchGlyphs?: JianpuPitchGlyphs;
}

export interface JianpuNoteNode extends JianpuNodeBase {
  readonly kind: 'note';
  readonly pitch: JianpuPitch;
  readonly text: JianpuTextGlyph;
  readonly pitchGlyphs: JianpuPitchGlyphs;
  readonly duration: JianpuDurationGlyphs;
}

export interface JianpuRestNode extends JianpuNodeBase {
  readonly kind: 'rest';
  /** 三态原样保留；`Z` / `@` 都按普通休止画 `0` 并照常占位，差别只在诊断（§3.2）。 */
  readonly variant: 'z' | 'Z' | '@';
  readonly text: JianpuTextGlyph;
  readonly duration: JianpuDurationGlyphs;
}

export interface JianpuChordNode extends JianpuNodeBase {
  readonly kind: 'chord';
  readonly members: readonly JianpuChordMemberGlyph[];
  readonly duration: JianpuDurationGlyphs;
}

export interface JianpuGraceNode extends JianpuNodeBase {
  /** `after` 决定画在主音左还是右；**不占时值**（spec §21）。 */
  readonly kind: 'grace';
  readonly after: boolean;
  readonly texts: readonly JianpuTextGlyph[];
}

export interface JianpuBarlineNode extends JianpuNodeBase {
  readonly kind: 'barline';
  readonly raw: string;
  readonly form: BarlineForm;
  readonly glyphs: JianpuBarlineGlyphs;
}

/** 装饰 / 和弦符号 / 未知事件 / 范围外事件共用的纯文本占位节点。 */
export interface JianpuTextNode extends JianpuNodeBase {
  readonly kind: 'decoration' | 'chordSymbol' | 'unknown' | 'outOfScope';
  readonly text: JianpuTextGlyph;
  /** 经注入的 `TextMeasurer` 量出的宽度（参与视觉判断，**不改变列宽**）。 */
  readonly textWidth: number;
}

export type JianpuNode =
  | JianpuNoteNode
  | JianpuRestNode
  | JianpuChordNode
  | JianpuGraceNode
  | JianpuBarlineNode
  | JianpuTextNode;

/** tuplet 只额外画方括号 + `p` 数字，**不做任何时值缩放**（P1-C）。 */
export interface JianpuTupletBracket {
  readonly anchor: Anchor;
  readonly label: string;
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  readonly hookHeight: number;
  /** `status === 'complete'` 且 `q` 有值；为假时调用方已发对应诊断。 */
  readonly complete: boolean;
}

/** tie / slur 弧线；`open` = A 类恢复单端弧。跨行谱按行切段（T5.2-B），各段共用同一 `anchor`。 */
export interface JianpuArc {
  readonly anchor: Anchor;
  readonly kind: 'tie' | 'slur';
  readonly systemIndex: number;
  readonly segment: 'whole' | 'start' | 'middle' | 'end';
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
  readonly height: number;
  readonly open: boolean;
}

export interface JianpuLyricNode {
  readonly anchor: Anchor;
  readonly verseIndex: number;
  /** 落在第几行谱（T5.2-A）：歌词基线是**行谱局部**的，跨行谱的歌词跟随音符走。 */
  readonly systemIndex: number;
  /** Domain 给的类别原样保留（§24）；`skip` 已在归属阶段滤掉，**不会出现在这里**。 */
  readonly syllableKind: 'text' | 'skip' | 'merge';
  /** `aligned` 为假表示没有可对齐的 `NoteRef` 目标，调用方已发诊断。 */
  readonly text: JianpuTextGlyph;
  readonly aligned: boolean;
}

/** score 级标签。调号一律 `K: <值>`，**永不生成 `1=<tonic>`**（P1-2）。 */
export interface JianpuLabel {
  readonly anchor: Anchor;
  readonly kind: 'key' | 'meter';
  readonly text: JianpuTextGlyph;
}

export interface JianpuUnitLengthMark {
  readonly anchor: Anchor;
  readonly raw: string;
  readonly segment: JianpuSegment;
}
// ---------------------------------------------------------------------------
// 基准几何：多个构造函数共用的纵向参照系（Phase A 起也含 barline 专属参照）
// ---------------------------------------------------------------------------

/**
 * 数字（1–7 / 休止 `0`）的上下边界：`digitTop` 是「数字视觉框」的顶边（未知占位框、
 * 降级角标、`L:` 变化标记用它），`digitBottom` 是同一个框的底边，也是**低八度点/
 * 减时线均不存在时**低方向装饰的默认起点（`jianpuGlyphBuilders.ts` 的
 * `lowOctaveDotBaseY` 在有减时线时会取比它更深的值，见该文件）。两者不是同一套「数字
 * 实际字形高度」的对称量（数字无下伸部，视觉框顶边比底边离基线更远），这是历史取值，
 * Phase A 未改动，只新增 `digitMidline` / `barlineTop` / `barlineBottom` 两套独立参照。
 */
export function digitTop(y: number): number {
  return y - JIANPU_METRICS.digitFontSize;
}

export function digitBottom(y: number): number {
  return y + JIANPU_METRICS.octaveDotFirstOffset;
}

/**
 * 数字视觉框的纵向中线（`digitTop`/`digitBottom` 的中点）。Phase A 新增：附点「垂直
 * 居中于数字中线」、延音线「在数字中线高度」都以它为基准，而不是像旧版那样直接摞在
 * 数字基线（`baselineY`）上——基线是排印基线，不是数字字形的视觉中心。
 */
export function digitMidline(y: number): number {
  return (digitTop(y) + digitBottom(y)) / 2;
}

/**
 * 小节线**专属**的纵向参照（Phase A 新增，替换旧版直接复用 `digitTop`/`digitBottom`
 * 的写法）：spec 只给了一句转述「小节线略高于数字」，本任务把它落成
 * `JIANPU_METRICS.barlineTopOffset`/`barlineBottomOffset`——两者之和 ≈
 * `digitFontSize × 1.2`（见 `metrics/jianpu.ts` 的推导注释），与 `digitTop`/`digitBottom`
 * 各自独立、互不牵动：后者仍被未知占位框等其它构造函数使用，改小节线高度不该连带改
 * 那些框的尺寸。
 */
export function barlineTop(y: number): number {
  return y - JIANPU_METRICS.barlineTopOffset;
}

export function barlineBottom(y: number): number {
  return y + JIANPU_METRICS.barlineBottomOffset;
}

export function glyph(text: string, x: number, y: number, fontSize: number): JianpuTextGlyph {
  return { text, x, y, fontSize };
}

/** 诊断汇集口：各段落只管 `sink(...)`，id 由 `collectRenderDiagnostics` 统一派生。 */
export type DraftSink = (draft: RenderDiagnosticDraft) => void;
/** `exactOptionalPropertyTypes` 下不能写 `sourceRef: undefined`，故分两支构造。 */
export function draftOf(
  code: RenderDiagnosticCode,
  level: 'info' | 'warning',
  message: string,
  anchor: Anchor,
  sourceRef?: SourceRef,
): RenderDiagnosticDraft {
  return sourceRef === undefined
    ? { code, level, message, anchor }
    : { code, level, message, anchor, sourceRef };
}
