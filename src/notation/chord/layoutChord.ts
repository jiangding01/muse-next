/**
 * notation/chord —— `GuitarChord`（`%%gchord`）→ `ChordLayout` 纯数据布局
 * （M2 方案 v1.1.1 §2.2 目录 / §3.1 Chord / §6 T3）。
 *
 * 范围（§3.1 逐条对照）：和弦名、capo 品位（`>1` 画 `{n}fr`、`=1` 画粗 nut 线）、
 * 禁弹 `X`、空弦圆圈、按弦点、指法数字（`showFinger` 三态，见下）。**不画横按**——
 * `barres` 在 M1.6 恒为空数组（spec §10.1 `UNVERIFIED`），画出来即等于凭空发明记法。
 *
 * 本文件**不消费** `ChordSymbolEvent`：`chordShapes`（本文件的输入）与正文和弦符号
 * 是两种不同的东西，按名关联的证据等级只有 `INFERRED`（I14），D11 已拍板默认关闭
 * （见 `tests/unit/notation/chord.test.ts` 的断言）。
 *
 * 迁移前的 `notation/chord/ChordDiagram.tsx`（React 组件）从未读取过
 * `Score.showFinger`——指法数字只要 `string.finger !== undefined` 就画。这份布局把
 * `showFinger` **新接线**（方案 §3.1 表「新接线」标注）：`true`/`undefined`（缺省）
 * 两态复刻旧行为（有指法就画数字），`false` 时改画纯黑点。**`undefined` 时默认显示
 * 数字是产品决定，不是 spec 保证的默认值**（spec 未记载 `showFinger` 缺省行为）。
 */

import type { Anchor } from '../model/types';
import type { GuitarChord, SourceRef } from '../../domain';
import { CHORD_METRICS } from '../layout/metrics';
import type { TextMeasurer } from '../layout/textMeasurer';

/**
 * `Score.showFinger` 的三态（§3.1 表）：
 * - `true`  → 按弦点内写指法数字；
 * - `false` → 纯黑点，不写数字；
 * - `undefined`（字段缺席）→ **默认显示数字**，产品决定（见文件头）。
 */
export type ShowFinger = boolean | undefined;

/** 单个网格线（弦线或品线）。`nut` 只在 `kind: 'fret'` 且是第 0 条、`capoFret === 1` 时为真。 */
export interface ChordGridLine {
  readonly kind: 'string' | 'fret';
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly nut: boolean;
}

/**
 * 一条弦的可视标记：判别联合而非「字段可选」——`muted`/`open`/`fretted` 三态互斥，
 * 各自需要的坐标字段不同，可选字段形态会让「这个 `cy` 到底是不是有效值」在
 * `muted` 分支上永远模糊。
 */
export type ChordStringMark =
  | { readonly kind: 'muted'; readonly index: number; readonly x: number; readonly y: number; readonly text: string }
  | {
      readonly kind: 'open';
      readonly index: number;
      readonly x: number;
      readonly cy: number;
      readonly r: number;
    }
  | {
      readonly kind: 'fretted';
      readonly index: number;
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly finger?: { readonly x: number; readonly y: number; readonly text: string };
    };

/** 一段测量过宽度的文本（和弦名 / capo 标签）。`width` 由注入的 `TextMeasurer` 得出，供未来避让/居中使用，本任务不据此改变坐标。 */
export interface ChordText {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly width: number;
}

/** `layoutChord` 的产出：纯数据，`toSvg.ts` 只做无判断的 layout → SvgNode 映射。 */
export interface ChordLayout {
  readonly width: number;
  readonly height: number;
  /**
   * `chordShapes` 是文档级对象，不属于任何声部/事件（D11：与 `ChordSymbolEvent`
   * 不关联），因此 anchor 恒为 `{ kind: 'document' }`。
   */
  readonly anchor: Anchor;
  /** 回源锚点，纯透传自 `GuitarChord.origin`。 */
  readonly sourceRef: SourceRef;
  readonly name: ChordText;
  readonly capoLabel?: ChordText;
  readonly gridLines: readonly ChordGridLine[];
  /** 长度恒为 6，顺序与 `chord.strings` 一致（第六弦 → 第一弦）。 */
  readonly strings: readonly ChordStringMark[];
}

export interface LayoutChordOptions {
  readonly showFinger: ShowFinger;
  readonly measurer: TextMeasurer;
  /**
   * 迁移前 `ChordDiagram` 的 `width` prop：省略时沿用原默认值 124，几何与迁移前
   * 完全一致；传入自定义值时全部坐标按同一比例关系重新计算（与迁移前行为一致）。
   */
  readonly width?: number;
}

export function layoutChord(chord: GuitarChord, options: LayoutChordOptions): ChordLayout {
  const width = options.width ?? CHORD_METRICS.defaultWidth;
  const height = Math.round(width * CHORD_METRICS.heightRatio);
  const { left, top, stringCount, fretCount } = CHORD_METRICS;
  const gridWidth = width - CHORD_METRICS.widthInset;
  const gridHeight = height - CHORD_METRICS.heightInset;
  const stringGap = gridWidth / (stringCount - 1);
  const fretGap = gridHeight / fretCount;

  const gridLines: ChordGridLine[] = [];
  for (let index = 0; index < stringCount; index += 1) {
    const x = left + index * stringGap;
    gridLines.push({ kind: 'string', x1: x, y1: top, x2: x, y2: top + gridHeight, nut: false });
  }
  for (let index = 0; index <= fretCount; index += 1) {
    const y = top + index * fretGap;
    gridLines.push({
      kind: 'fret',
      x1: left,
      y1: y,
      x2: left + gridWidth,
      y2: y,
      nut: index === 0 && chord.capoFret === 1,
    });
  }

  const strings: ChordStringMark[] = chord.strings.map((stringState, index) => {
    const x = left + index * stringGap;

    if (stringState.state === 'muted') {
      return { kind: 'muted', index, x, y: top - CHORD_METRICS.mutedYOffset, text: '×' } as const;
    }
    if (stringState.state === 'open') {
      return {
        kind: 'open',
        index,
        x,
        cy: top - CHORD_METRICS.openStringYOffset,
        r: CHORD_METRICS.openStringRadius,
      } as const;
    }

    const absoluteFret = stringState.fret ?? chord.capoFret;
    const visibleFret = absoluteFret - chord.capoFret + 1;
    const cy = top + (Math.max(1, visibleFret) - 0.5) * fretGap;
    // showFinger 三态见文件头：undefined/true 复刻迁移前「有指法就画」的行为，false 隐藏。
    const showNumber = stringState.finger !== undefined && options.showFinger !== false;

    return {
      kind: 'fretted',
      index,
      cx: x,
      cy,
      r: CHORD_METRICS.fingerDotRadius,
      ...(showNumber && stringState.finger !== undefined
        ? { finger: { x, y: cy + CHORD_METRICS.fingerNumberYOffset, text: String(stringState.finger) } }
        : {}),
    } as const;
  });

  const nameMeasure = options.measurer.measure(chord.name, { fontSize: CHORD_METRICS.nameFontSize });
  const name: ChordText = { x: width / 2, y: CHORD_METRICS.nameY, text: chord.name, width: nameMeasure.width };

  let capoLabel: ChordText | undefined;
  if (chord.capoFret > 1) {
    const capoText = `${chord.capoFret}fr`;
    const capoMeasure = options.measurer.measure(capoText, { fontSize: CHORD_METRICS.capoFontSize });
    capoLabel = {
      x: CHORD_METRICS.capoLabelX,
      y: top + fretGap * CHORD_METRICS.capoLabelFretRatio,
      text: capoText,
      width: capoMeasure.width,
    };
  }

  return {
    width,
    height,
    anchor: { kind: 'document' },
    sourceRef: chord.origin,
    name,
    ...(capoLabel !== undefined ? { capoLabel } : {}),
    gridLines,
    strings,
  };
}
