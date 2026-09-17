/**
 * 和弦图（`%%gchord`）专属几何尺寸表（abstract unit，D6：不是像素）。数值照搬
 * `chord/layoutChord.ts` 迁移前 `ChordDiagram.tsx` 的既有几何，保证坐标等价
 * （T3 报告已用一次性基线对照验证）。
 */
export const CHORD_METRICS = {
  /** 弦数：吉他固定 6 弦。 */
  stringCount: 6,
  /** 品格数：迁移前既有几何，未改动。 */
  fretCount: 5,
  /** 未显式传入 `width` 时的默认整体宽度。 */
  defaultWidth: 124,
  /** 高度 = 宽度 × 该比例。 */
  heightRatio: 1.15,
  /** 网格左边距。 */
  left: 18,
  /** 网格上边距（为和弦名与 capo 标签留出空间）。 */
  top: 34,
  /** 宽度扣减：`width - widthInset` = 网格宽度。 */
  widthInset: 34,
  /** 高度扣减：`height - heightInset` = 网格高度。 */
  heightInset: 54,
  /** 按弦点半径。 */
  fingerDotRadius: 7,
  /** 空弦圆圈半径。 */
  openStringRadius: 4,
  /** 空弦圆圈相对网格顶部的纵向偏移。 */
  openStringYOffset: 11,
  /** 禁弹 `×` 相对网格顶部的纵向偏移。 */
  mutedYOffset: 8,
  /** 指法数字相对按弦点圆心的纵向偏移（视觉居中）。 */
  fingerNumberYOffset: 3.5,
  /** capo 标签在第一品格内的纵向位置比例。 */
  capoLabelFretRatio: 0.72,
  /** capo 标签左边距。 */
  capoLabelX: 2,
  /** 和弦名文本的纵向位置。 */
  nameY: 15,
  /** 和弦名文本的度量字号（`TextMeasurer` 的 abstract unit 字号，非 CSS px）。 */
  nameFontSize: 13,
  /** capo 标签文本的度量字号。 */
  capoFontSize: 9,
} as const;
