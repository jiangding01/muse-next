/**
 * notation/tab —— TAB（吉他六线谱）layout 的**节点类型**与**字形几何**
 * （M2 方案 §3.3，T6.1）。
 *
 * 与 `notation/jianpu/**` **平行且独立**：本文件不 import 任何 jianpu 文件、不继承
 * 它的节点类型、不与之互相转换（§2.7 —— 四种记谱的几何差异是本质性的：简谱认一条
 * 数字基线，TAB 认六条弦线）。`buildBarlineGlyphs` 那套「四种 CONFIRMED 形态 + 其余
 * 一律 unrecognized」的**判定思想**在两边各写一遍，是有意的重复：一处改动不会悄悄
 * 改变另一处的语义。
 *
 * 纵向基准只有一个：**`staffTop` = 第 1 弦线的 y**。任何一根弦的 y 都由
 * `stringY(staffTop, stringIndex)` 推导，弦号越大越靠下（吉他惯例：第 1 弦是最细的
 * 高音弦，画在最上面，spec §26.2 的 a..f → 1..6 正是从上往下）。
 *
 * 尺寸一律取自 `layout/metrics.ts` 的 `TAB_METRICS`（唯一来源），单位是 abstract
 * unit（D6，不是像素）。本步**不做**时值装饰（符干 / 减时线）、`-S-/-H-/-P-` 连线、
 * stroke 方向记号——它们属于 T6.2–T6.4。
 */

import type { SourceRef, TabNote } from '../../domain';
import type { Rational } from '../../domain';
import { TAB_METRICS } from '../layout/metrics';
import type { Box, Point, System } from '../layout/primitives';
import type { TextMeasurer } from '../layout/textMeasurer';
import type { RenderDiagnosticDraft } from '../model/diagnostics';
import type { Anchor, RenderDiagnosticCode } from '../model/types';

/** 弦号：直接取 Domain 的字面量联合，不在渲染层重写一遍 `1 | 2 | ... | 6`。 */
export type TabStringIndex = TabNote['stringIndex'];

export interface TabSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** `fontSize` 同时供 `TextMeasurer` 与渲染使用。 */
export interface TabTextGlyph {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly fontSize: number;
}

/**
 * 一个品位数字（或 `x`）画在某根弦线上。
 *
 * - `text` 是**整体一个**文本：`12` 是「第 12 品」这一个数，不是 `1` 和 `2` 两个字形；
 * - `fret` 为 `'x'` 时显示 `x`（spec §26.3：由和弦图决定品位的右手拨弦，`CONFIRMED`）；
 * - `backdrop` 是遮住弦线的白底矩形——品位数字正画在线上，不挖底就会被线穿过。
 */
export interface TabFretGlyph {
  readonly stringIndex: TabStringIndex;
  readonly text: TabTextGlyph;
  readonly backdrop: Box;
}

/**
 * 小节线形态（spec §18 最长匹配）。**只有四种形态是 `CONFIRMED` 的**：`|`、`|]`、
 * `|:`、`:|`；`||` / `::` / `[|` 等在 spec §18 里是 `DOC-ONLY` 且语料 0，与任意表外
 * 组合同等对待 → `unrecognized`：画一根普通竖线 + 一条诊断。给没有证据的写法配专属
 * 字形，等于把它画成既成事实。
 */
export type TabBarlineForm = 'single' | 'final' | 'repeat-start' | 'repeat-end' | 'unrecognized';

// ---------------------------------------------------------------------------
// 节点类型
// ---------------------------------------------------------------------------

export interface TabNodeBase {
  readonly anchor: Anchor;
  readonly sourceRef: SourceRef;
  readonly slotIndex: number;
  readonly measureIndex: number;
  readonly systemIndex: number;
  /** 列左边界（绝对坐标）。 */
  readonly x: number;
  /** 该节点所属 system 的**第 1 弦线** y（staff 顶线）；各弦的 y 由 `stringY` 推导。 */
  readonly y: number;
  /** 槽位宽。 */
  readonly width: number;
  /** 主字形视觉 bbox 跨度，**不是**槽位宽；零成员组 / 单线小节线为 0。 */
  readonly glyphWidth: number;
  /** 是否走了降级路径（契约 C2：这类节点至少关联一条 `RenderDiagnostic`）。 */
  readonly fallback: boolean;
}

export interface TabNoteNode extends TabNodeBase {
  readonly kind: 'tabNote';
  readonly fret: TabFretGlyph;
  /** 本步只透传，**不画**任何时值装饰（符干 / 减时线属于 T6.2）。 */
  readonly duration: Rational | undefined;
}

export interface TabGroupNode extends TabNodeBase {
  readonly kind: 'tabGroup';
  /** 同一列纵向排开，按 `stringIndex` 升序（第 1 弦在最上）。 */
  readonly frets: readonly TabFretGlyph[];
  /** 组时值取**末音**（spec §26.8，`CONFIRMED`），Domain 已放在 `TabGroupEvent.duration`。 */
  readonly duration: Rational | undefined;
}

export interface TabRestNode extends TabNodeBase {
  readonly kind: 'rest';
  /** 三态原样保留；`Z` / `@` 都按普通休止画并照常占位，差别只在诊断。 */
  readonly variant: 'z' | 'Z' | '@';
  readonly text: TabTextGlyph;
}

export interface TabGraceNode extends TabNodeBase {
  /** `after` 决定画在主音左还是右；**不占时值**（spec §21）。 */
  readonly kind: 'grace';
  readonly after: boolean;
  readonly frets: readonly TabFretGlyph[];
  /** 成员是 pitch 模式的 `Note` 时的文本占位（`GraceEvent.members` 是 `Note | TabNote`）。 */
  readonly outOfScopeTexts: readonly TabTextGlyph[];
}

export interface TabBarlineNode extends TabNodeBase {
  readonly kind: 'barline';
  readonly raw: string;
  readonly form: TabBarlineForm;
  /** 每根线从第 1 弦贯穿到第 6 弦（上下各外扩 `barlineOverhang`）。 */
  readonly lines: readonly TabSegment[];
  /** 反复点；`single` / `final` / `unrecognized` 为空。**只画形状，不做展开/跳转**。 */
  readonly repeatDots: readonly Point[];
  /** 粗线在 `lines` 中的下标；终止线用它区分细 / 粗。 */
  readonly thickLineIndices: readonly number[];
}

/** 装饰 / 和弦符号 / 未知事件 / 范围外事件共用的纯文本占位节点。 */
export interface TabTextNode extends TabNodeBase {
  readonly kind: 'decoration' | 'chordSymbol' | 'unknown' | 'outOfScope';
  readonly text: TabTextGlyph;
  /** 经注入的 `TextMeasurer` 量出的宽度（参与视觉判断，**不改变列宽**）。 */
  readonly textWidth: number;
}

export type TabNode =
  | TabNoteNode
  | TabGroupNode
  | TabRestNode
  | TabGraceNode
  | TabBarlineNode
  | TabTextNode;

/**
 * 一行谱的六条弦线。
 *
 * 线长取 **system box 宽**：`layout/systems.ts` 的 `layoutSystems` 把 box 宽直接设成
 * 该行实际累计的 measure 宽度（`systemWidth = cursorX`），因此「内容宽」与「box 宽」
 * 在本仓库里是同一个数，不存在「拉满容器还是只到内容末端」的选择分歧——弦线恰好
 * 止于该行最后一个槽的右边界。
 */
export interface TabStaffLines {
  readonly systemIndex: number;
  readonly lines: readonly TabSegment[];
}

// ---------------------------------------------------------------------------
// 六线几何
// ---------------------------------------------------------------------------

/**
 * 第 `stringIndex` 根弦的 y。第 1 弦最上、弦号递增向下（吉他惯例，方案 §3.3；
 * spec §26.2 的 a..f → 1..6 就是从上往下数）。
 */
export function stringY(staffTop: number, stringIndex: TabStringIndex): number {
  return staffTop + (stringIndex - 1) * TAB_METRICS.lineGap;
}

/** 六线的纵向中心：休止符、未知占位等「不属于某一根弦」的字形画在这里。 */
export function staffCenterY(staffTop: number): number {
  return staffTop + ((TAB_METRICS.stringCount - 1) * TAB_METRICS.lineGap) / 2;
}

export function glyph(text: string, x: number, y: number, fontSize: number): TabTextGlyph {
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

/** 文本基线相对字形视觉中线的偏移：让字形以给定的 y 为中心视觉居中。 */
function baselineOf(centerY: number, fontSize: number): number {
  return centerY + fontSize * TAB_METRICS.fretBaselineRatio;
}

/** 以 `centerY` 为视觉中心的一个文本字形（休止 / 未知 / 范围外占位共用）。 */
export function centeredGlyph(
  text: string,
  x: number,
  centerY: number,
  fontSize: number,
): TabTextGlyph {
  return glyph(text, x, baselineOf(centerY, fontSize), fontSize);
}

/**
 * 一个品位字形：数字画在弦线上，白底矩形把线遮住。
 *
 * `fret` 原样文本化——多位品位（`12`）是**整体一个** text，不拆成两个字符；`'x'`
 * 显示为 `x`（spec §26.3）。
 */
export function buildFretGlyph(
  stringIndex: TabStringIndex,
  fret: number | 'x',
  x: number,
  staffTop: number,
  fontSize: number,
  measurer: TextMeasurer,
): TabFretGlyph {
  const text = String(fret);
  const lineY = stringY(staffTop, stringIndex);
  const textWidth = measurer.measure(text, { fontSize }).width;
  const pad = TAB_METRICS.fretBackdropPadding;
  return {
    stringIndex,
    text: glyph(text, x, baselineOf(lineY, fontSize), fontSize),
    backdrop: {
      origin: { x: x - pad, y: lineY - fontSize / 2 - pad },
      width: textWidth + 2 * pad,
      height: fontSize + 2 * pad,
    },
  };
}

/**
 * `BarlineEvent.raw` → 形态。表内只有四种 `CONFIRMED` 写法，其余一律 `unrecognized`：
 * 不按前缀 / 后缀去猜「它大概是个反复」——猜错等于把作者没写的反复语义画上谱面。
 */
export function classifyTabBarline(raw: string): TabBarlineForm {
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
      return 'unrecognized';
  }
}

/** 一根贯穿六线的竖线（上下各外扩 `barlineOverhang`）。 */
function barlineSegment(x: number, staffTop: number): TabSegment {
  const overhang = TAB_METRICS.barlineOverhang;
  return {
    x1: x,
    y1: stringY(staffTop, 1) - overhang,
    x2: x,
    y2: stringY(staffTop, TAB_METRICS.stringCount) + overhang,
  };
}

function repeatDots(x: number, staffTop: number): readonly Point[] {
  const center = staffCenterY(staffTop);
  const dy = TAB_METRICS.repeatDotOffsetY;
  return [
    { x, y: center - dy },
    { x, y: center + dy },
  ];
}

/** 形态 → 几何。`unrecognized` 与 `single` 共用同一根普通竖线。 */
export function buildTabBarlineGlyphs(
  form: TabBarlineForm,
  x: number,
  staffTop: number,
): Pick<TabBarlineNode, 'lines' | 'repeatDots' | 'thickLineIndices'> {
  const secondX = x + TAB_METRICS.barlineCompositeGap;
  const pair = [barlineSegment(x, staffTop), barlineSegment(secondX, staffTop)];
  const leftDots = repeatDots(x - TAB_METRICS.repeatDotOffsetX, staffTop);
  const rightDots = repeatDots(secondX + TAB_METRICS.repeatDotOffsetX, staffTop);

  switch (form) {
    case 'final':
      return { lines: pair, repeatDots: [], thickLineIndices: [1] };
    case 'repeat-start':
      return { lines: pair, repeatDots: rightDots, thickLineIndices: [0] };
    case 'repeat-end':
      return { lines: pair, repeatDots: leftDots, thickLineIndices: [1] };
    case 'single':
    case 'unrecognized':
      return { lines: [barlineSegment(x, staffTop)], repeatDots: [], thickLineIndices: [] };
    default: {
      const exhaustive: never = form;
      return exhaustive;
    }
  }
}

/** 一行谱的六条弦线；`lines[i]` 是第 `i + 1` 弦（见 `TabStaffLines` 的线长说明）。 */
export function buildStaffLines(system: System): TabStaffLines {
  const staffTop = system.box.origin.y + TAB_METRICS.staffTopOffset;
  const x1 = system.box.origin.x;
  const x2 = system.box.origin.x + system.box.width;
  const lines: TabSegment[] = [];
  for (let index = 0; index < TAB_METRICS.stringCount; index += 1) {
    const y = staffTop + index * TAB_METRICS.lineGap;
    lines.push({ x1, y1: y, x2, y2: y });
  }
  return { systemIndex: system.index, lines };
}
