/**
 * notation/jianpu —— 简谱 layout 的**节点类型**与**字形几何**
 * （M2 方案 v1.1.1 §3.2 / §2.7，T4；自 `layoutJianpu.ts` 拆出）。
 *
 * 拆分理由很实在：`layoutJianpu.ts` 要同时管 measure 切分、换行、事件节点、关系、歌词、
 * 标签与诊断，一个文件必然超过 350 行的工程上限。切口选在**不依赖事件排布结果**的部分：
 * 本文件的几何只认「一个基准点」，歌词行与头部标签另见 `jianpuSections.ts`。
 *
 * 这些类型是**简谱自己的** layout model，不继承任何万能基类，也不与 `ChordLayout` /
 * `TabLayout` / `StaffLayout` 互相转换（§2.7）。依赖方向单向 `layoutJianpu.ts →
 * jianpuGlyphs.ts`，无环；尺寸一律取自 `metrics.ts` 的 `JIANPU_METRICS`（唯一来源），
 * 单位是 abstract unit（D6，不是像素）。
 */

import type { Accidental, SourceRef } from '../../domain';
import { JIANPU_METRICS } from '../layout/metrics';
import type { Point } from '../layout/primitives';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { DurationDecomposition } from '../model/duration';
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

/** tie / slur 弧线。`open` 为真即 A 类恢复状态（unresolved / unclosed）的单端弧。 */
export interface JianpuArc {
  readonly anchor: Anchor;
  readonly kind: 'tie' | 'slur';
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
// 字形几何
// ---------------------------------------------------------------------------

/** 数字（1–7 / 休止 `0`）的上下边界，供小节线、弧线、括号共用同一套纵向基准。 */
export function digitTop(y: number): number {
  return y - JIANPU_METRICS.digitFontSize;
}

export function digitBottom(y: number): number {
  return y + JIANPU_METRICS.octaveDotFirstOffset;
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

/**
 * 减时线 / 延音线 / 附点：条数直接取 `decomposeDuration` 的 `{ beams, dashes, dots }`，
 * **不重新解释时值**、不涉及「拍」（P1-3）；tuplet 成员同路径、**不缩放**（P1-C）。
 */
export function buildDurationGlyphs(
  decomposition: DurationDecomposition,
  x: number,
  baselineY: number,
): JianpuDurationGlyphs {
  if (decomposition.kind === 'unrepresentable') {
    return { beams: [], dashes: [], augmentationDots: [], unrepresentable: true };
  }

  const beams: JianpuSegment[] = [];
  for (let i = 0; i < decomposition.beams; i += 1) {
    const y = baselineY + JIANPU_METRICS.beamFirstOffset + i * JIANPU_METRICS.beamGap;
    beams.push({ x1: x, y1: y, x2: x + JIANPU_METRICS.beamLength, y2: y });
  }
  const dashes: JianpuSegment[] = [];
  const dashStep = JIANPU_METRICS.dashLength + JIANPU_METRICS.dashGap;
  for (let i = 0; i < decomposition.dashes; i += 1) {
    const sx = x + JIANPU_METRICS.dashFirstOffset + i * dashStep;
    dashes.push({ x1: sx, y1: baselineY, x2: sx + JIANPU_METRICS.dashLength, y2: baselineY });
  }
  const augmentationDots: Point[] = [];
  for (let i = 0; i < decomposition.dots; i += 1) {
    const dx = JIANPU_METRICS.augmentationDotFirstOffset + i * JIANPU_METRICS.augmentationDotGap;
    augmentationDots.push({ x: x + dx, y: baselineY });
  }
  return { beams, dashes, augmentationDots, unrepresentable: false };
}

/** 八度点与临时记号：点数与方向已由 `pitchToNumber` 判定，这里**不再判断**，只摆坐标。 */
export function buildPitchGlyphs(
  pitch: JianpuPitch,
  x: number,
  baselineY: number,
): JianpuPitchGlyphs {
  const above = pitch.octaveDotDirection === 'above';
  const direction = above ? -1 : 1;
  const dotBaseY = above ? digitTop(baselineY) : digitBottom(baselineY);
  const octaveDots: Point[] = [];
  for (let i = 0; i < pitch.octaveDots; i += 1) {
    octaveDots.push({ x, y: dotBaseY + direction * i * JIANPU_METRICS.octaveDotGap });
  }
  const glyphs = { octaveDots };
  return pitch.accidental === undefined
    ? glyphs
    : { ...glyphs, accidental: buildAccidentalGlyph(pitch.accidental, x, baselineY) };
}

/** 临时记号**原样渲染**：不因调号增删，也不做小节内延续推断（前提 P3）。 */
export function buildAccidentalGlyph(
  accidental: Accidental,
  x: number,
  baselineY: number,
): JianpuTextGlyph {
  const { accidentalOffsetX: dx, accidentalOffsetY: dy, annotationFontSize: size } = JIANPU_METRICS;
  return glyph(accidental, x + dx, baselineY + dy, size);
}

/**
 * `BarlineEvent.raw` → 形态。表内只有四种 `CONFIRMED` 写法，其余一律 `unrecognized`：
 * 不按前缀/后缀去猜「它大概是个反复」——猜错等于把作者没写的反复语义画上谱面。
 */
export function classifyBarline(raw: string): BarlineForm {
  switch (raw) {
    case '|':
      return 'single';
    case '|]':
      return 'final';
    case '|:':
      return 'repeat-start';
    case ':|':
      return 'repeat-end';
    default:
      // `||` / `::` / `[|` / `[:]` / `[|]` 以及任何表外组合都走这里（spec §18 DOC-ONLY，语料 0）。
      return 'unrecognized';
  }
}

/** 形态 → 几何。`unrecognized` 与 `single` 共用同一根普通竖线（§3.2）。 */
export function buildBarlineGlyphs(
  form: BarlineForm,
  x: number,
  baselineY: number,
): JianpuBarlineGlyphs {
  const top = digitTop(baselineY);
  const bottom = digitBottom(baselineY);
  const line = (lx: number): JianpuSegment => ({ x1: lx, y1: top, x2: lx, y2: bottom });
  const secondX = x + JIANPU_METRICS.barlineCompositeGap;
  const pair = [line(x), line(secondX)];
  const leftDots = repeatDots(x - JIANPU_METRICS.repeatDotOffsetX, baselineY);
  const rightDots = repeatDots(secondX + JIANPU_METRICS.repeatDotOffsetX, baselineY);

  switch (form) {
    case 'final':
      return { lines: pair, repeatDots: [], thickLineIndices: [1] };
    case 'repeat-start':
      return { lines: pair, repeatDots: rightDots, thickLineIndices: [0] };
    case 'repeat-end':
      return { lines: pair, repeatDots: leftDots, thickLineIndices: [1] };
    case 'single':
    case 'unrecognized':
      return { lines: [line(x)], repeatDots: [], thickLineIndices: [] };
    default: {
      const exhaustive: never = form;
      return exhaustive;
    }
  }
}

function repeatDots(x: number, y: number): readonly Point[] {
  const dy = JIANPU_METRICS.repeatDotOffsetY;
  return [
    { x, y: y - dy },
    { x, y: y + dy },
  ];
}

/** `L:` 变化点的细标记：一段短竖线，画在列的左边界（§3.2）。 */
export function buildUnitLengthMark(x: number, baselineY: number): JianpuSegment {
  const top = digitTop(baselineY);
  return { x1: x, y1: top - JIANPU_METRICS.unitLengthMarkHeight, x2: x, y2: top };
}
