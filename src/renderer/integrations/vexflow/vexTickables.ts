/**
 * renderer/integrations/vexflow —— `StaffEventNode[]` →**参与 Formatter 的 tickable**
 * （M2 T7.4）。
 *
 * **横向位置的真源是 Formatter，不是 `slot.x`**（`StaffStaveSpec` 的 JSDoc 已经把这条
 * 裁决写死）：`notation/staff/**` 只承诺「这一列有多宽、次序是什么」，stave 内每个
 * glyph 画在哪一个 x 由 VexFlow 的 `Formatter` 排。因此本文件的职责只有一个——把一个
 * measure 里的**每一个**节点都变成一个 tickable 交给 `Voice`，**一个都不能漏**：漏掉
 * 的那个就只能靠 pre-layout 的 `slot.x` 手动定位，而那正是被禁止的做法。
 *
 * 四种节点各自的 tickable（`barline` 不在其中，它由 `Stave` 的 begin/end bar type 画，
 * 见 `renderStaff.ts`）：
 * - `note` → `StaveNote`（keys 带升降后缀 + 可见升降号 `Accidental` 修饰 + `Dot`）；
 * - `rest` → `StaveNote`，时值码加 `r` 后缀，定位 key 按谱号取（`vexEncoding.ts`）；
 * - `placeholder` → `TextNote`（**可参与排版的文本 tickable**）：画在谱表下方，时值取
 *   四分——`StaffPlaceholderNode` 本身不带 `duration`（它正是「时值画不出来」的产物），
 *   所以没有「节点可表示时值」可取，统一用 `'q'` 占一个四分的排版位置；
 * - `chordSymbol` → **同 measure 内下一个音符/休止的 `Annotation`**；只有它已经是段末、
 *   后面再没有音符/休止时，才退化成一个**零 tick** 的 `TextNote`。
 *
 * 和弦符号是 **overlay**（T6.5 冻结的语义：零宽、不占时间轴，
 * `SLOT_SPACING_METRICS.overlaySlotWidth === 0` 是同一条产品决定）。实测
 * `Formatter.createContexts()`（`formatter.js`）在给每个 tickable 分配 `TickContext`
 * 之后，**无条件**执行 `ticksUsed.add(tickable.getTicks())` —— `ignoreTicks` 只影响
 * `Voice` 自己的计数，**推进时间轴的是 `getTicks()`**。所以「`TextNote` +
 * `setIgnoreTicks(true)`」根本保不住 overlay：实测 `getTicks().value()` 仍是 4096，
 * 和弦符号会把它后面的每一个音符往右顶一个四分音符。两条正确做法：
 * - 挂成 `Annotation`：修饰不是 tickable，一个 tick 都不占，而且实测
 *   `Annotation.draw()` **会** `openGroup('annotation', id)`，所以拿得到可写
 *   `data-anchor-key` 的 `<g>`（早先「Annotation 拿不到元素」的判断是错的）；
 * - 段末退化的 `TextNote` 加 `durationOverride: new Fraction(0, 1)`：`Note` 的构造函数
 *   实测在 `durationOverride` 存在时走 `setDuration(fraction)` 而不是
 *   `setIntrinsicTicks(parsed.ticks)`，node 下实测 `getTicks().value() === 0`。
 */

import {
  Accidental, Annotation, AnnotationVerticalJustify, Dot, Fraction, StaveNote, TextNote,
  type Tickable,
} from 'vexflow/bravura';

import type { EventId } from '../../../domain';
import type {
  StaffClef,
  StaffChordSymbolNode,
  StaffEventNode,
  StaffNoteNode,
  StaffPlaceholderNode,
  StaffRestNode,
} from '../../../notation/staff/staffTypes';
import { vexDurationCode, vexKey, vexRestDurationCode, vexRestKey, vexAccidentalCode } from './vexEncoding';

/**
 * 文本 tickable 的谱线位置（**产品决定**）。`TextNote.draw()` 实测按
 * `stave.getYForLine(line - 3)` 取基线，`getYForLine(0)` 是第一线（最上），`4` 是第五
 * 线，所以：`1` → 第一线上方两格（段末的和弦符号），`9` → 第五线下方两格（占位文本）。
 */
const CHORD_SYMBOL_LINE = 1;
const PLACEHOLDER_LINE = 9;

/** 一个节点与它排进 Formatter 的 tickable 的对应关系。 */
export interface StaffTickableEntry {
  readonly node: StaffEventNode;
  readonly tickable: Tickable;
}

/** 挂成修饰的和弦符号：它不是 tickable，但仍要在 draw 之后回写 anchor（见 `renderStaff.ts`）。 */
export interface StaffAnnotationEntry {
  readonly node: StaffChordSymbolNode;
  readonly annotation: Annotation;
}

export interface MeasureTickables {
  /** 按节点次序排列，直接 `voice.addTickables()`。 */
  readonly tickables: readonly Tickable[];
  /** 与 `tickables` 同序，供 draw 后回写 anchor 属性。 */
  readonly entries: readonly StaffTickableEntry[];
  /** 挂到宿主音符上的和弦符号修饰，同样要回写 anchor。 */
  readonly annotations: readonly StaffAnnotationEntry[];
  /**
   * `note` / `rest` 两种节点的 `StaveNote`，按 `EventId` 索引——tie 端点与 tuplet 成员
   * 靠它反查（索引的是**本次布局的产物**，不是 Domain lookup）。
   */
  readonly staveNotes: ReadonlyMap<EventId, StaveNote>;
}

function buildNote(node: StaffNoteNode, clef: StaffClef): StaveNote {
  const note = new StaveNote({
    keys: node.pitches.map((entry) => vexKey(entry.pitch)),
    duration: vexDurationCode(node.duration.base),
    clef,
    autoStem: true,
  });
  // keys 里的升降后缀只影响 VexFlow 对**实际音高**的认知；可见的升降号字形必须另外挂
  // 一个 `Accidental` 修饰（见 `vexEncoding.ts` 文件头实测记录）。这里**不做**「本小节
  // 内是否已出现过同名升降号」的省略判断：那是 `notation/**` 的展示决策
  // （`StaffAccidentalDisplay` 预留了这个概念），adapter 不自作主张。
  for (const [index, entry] of node.pitches.entries()) {
    const accidental = entry.pitch.accidental;
    if (accidental !== undefined) {
      note.addModifier(new Accidental(vexAccidentalCode(accidental)), index);
    }
  }
  // 附点不进时值码（`'qd'` 不是合法时值）：逐个 attach，`all` 让和弦块每个符头都带点。
  for (let i = 0; i < node.duration.dots; i += 1) {
    Dot.buildAndAttach([note], { all: true });
  }
  return note;
}

function buildRest(node: StaffRestNode, clef: StaffClef): StaveNote {
  // `variant`（`z` / `Z` / `@`）原样保留在 Domain 里，本层不合并、也不为它换字形：
  // 三者在 M2 都画成同一个休止符，差异不编造。
  const rest = new StaveNote({
    keys: [vexRestKey(clef)],
    duration: vexRestDurationCode(node.duration.base),
    clef,
  });
  for (let i = 0; i < node.duration.dots; i += 1) {
    Dot.buildAndAttach([rest], { all: true });
  }
  return rest;
}

function buildPlaceholder(node: StaffPlaceholderNode): TextNote {
  return new TextNote({ text: node.text, duration: 'q' })
    .setLine(PLACEHOLDER_LINE)
    .setJustification(TextNote.Justification.LEFT);
}

/**
 * 段末和弦符号的退化形态：**零 tick** 的 `TextNote`（`durationOverride` 为 `0/1`）。
 * `duration: 'q'` 只是为了让 `Note.parseNoteStruct` 能解析出一个字形类别，它的 tick
 * 会被 `durationOverride` 覆盖掉——两者不矛盾，见文件头的实测记录。
 */
function buildTrailingChordSymbol(node: StaffChordSymbolNode): TextNote {
  return new TextNote({ text: node.text, duration: 'q', durationOverride: new Fraction(0, 1) })
    .setLine(CHORD_SYMBOL_LINE)
    .setJustification(TextNote.Justification.LEFT);
}

/** 和弦符号挂成修饰：画在谱表上方（`TOP`），零 tick。 */
function buildChordAnnotation(node: StaffChordSymbolNode): Annotation {
  return new Annotation(node.text).setVerticalJustification(AnnotationVerticalJustify.TOP);
}

/** 和弦符号的宿主：同 measure 内**下一个** `note` / `rest` 节点（它们才是 `StaveNote`）。 */
function nextHostNode(
  nodes: readonly StaffEventNode[],
  from: number,
): StaffEventNode | undefined {
  for (let i = from + 1; i < nodes.length; i += 1) {
    const candidate = nodes[i];
    if (candidate === undefined) continue;
    if (candidate.kind === 'note' || candidate.kind === 'rest') return candidate;
  }
  return undefined;
}

/**
 * 一个 measure 的全部节点 → tickables。
 *
 * **`barline` 节点不产生任何 tickable**（既不是 `StaveNote` 也不是 `BarNote`）：小节线
 * 的视觉边界已经由 `StaffStaveSpec.beginBarline` / `endBarline` 交给 `Stave` 画，再塞
 * 一个 `BarNote` 就会在同一个位置画出第二条线。它的可点击性由 `renderStaff.ts` 的
 * `drawBarlineHitAreas` 用一个零内容的 hit-area 组补上（那个组带 `data-anchor-key`），
 * 所以「每个事件都有一个可点的东西」这条仍然成立。
 */
export function buildMeasureTickables(
  nodes: readonly StaffEventNode[],
  clef: StaffClef,
): MeasureTickables {
  const tickables: Tickable[] = [];
  const entries: StaffTickableEntry[] = [];
  const annotations: StaffAnnotationEntry[] = [];
  const staveNotes = new Map<EventId, StaveNote>();

  // 先把所有「本身就是 tickable」的节点建出来，和弦符号第二趟才挂修饰——它需要拿到
  // 宿主音符的**同一个对象**，不能重建一个。
  const built = new Map<StaffEventNode, Tickable>();
  for (const node of nodes) {
    if (node.kind === 'note') built.set(node, buildNote(node, clef));
    else if (node.kind === 'rest') built.set(node, buildRest(node, clef));
    else if (node.kind === 'placeholder') built.set(node, buildPlaceholder(node));
  }

  for (const [offset, node] of nodes.entries()) {
    if (node.kind === 'barline') continue;

    if (node.kind === 'chordSymbol') {
      const host = nextHostNode(nodes, offset);
      const hostTickable = host === undefined ? undefined : built.get(host);
      if (hostTickable instanceof StaveNote) {
        const annotation = buildChordAnnotation(node);
        hostTickable.addModifier(annotation, 0);
        annotations.push({ node, annotation });
        continue;
      }
      const trailing = buildTrailingChordSymbol(node);
      tickables.push(trailing);
      entries.push({ node, tickable: trailing });
      continue;
    }

    const tickable = built.get(node);
    if (tickable === undefined) continue;
    if (tickable instanceof StaveNote && node.anchor.kind === 'event') {
      staveNotes.set(node.anchor.eventId, tickable);
    }
    tickables.push(tickable);
    entries.push({ node, tickable });
  }

  return { tickables, entries, annotations, staveNotes };
}
