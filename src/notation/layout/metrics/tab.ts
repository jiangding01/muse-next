/**
 * TAB（吉他六线谱）专属几何（M2 方案 §3.3，T6.1 追加；abstract unit，D6，**不是像素**）。
 *
 * 除 `stringCount` 外，**每一项都是产品决定，不是格式事实**：spec §26 只规定了
 * 「弦号 a..f → 1..6」「品位是数字或 `x`」这类语义，从未规定弦间距、字号、留白等
 * 任何排版数值。`stringCount: 6` 是格式事实（spec §26.2：六线，a..f → 1..6）。
 *
 * 与 `JIANPU_METRICS` **平行且独立**：TAB 不复用简谱的任何几何常量，两种记谱的
 * 纵向基准（数字基线 vs 六条弦线）本质不同，共用常量只会让一处调整误伤另一处。
 */
export const TAB_METRICS = {
  /** 弦数：六线谱固定 6 弦（**格式事实**，spec §26.2：a..f → 1..6）。 */
  stringCount: 6,
  /** 相邻两条弦线的垂直间距（产品决定，不是格式事实）。 */
  lineGap: 8,
  /** 第 1 弦（最上一条）相对 system box 顶边的垂直偏移；其上方留给和弦符号行（产品决定）。 */
  staffTopOffset: 16,
  /** 品位数字的度量字号（产品决定）。 */
  fretFontSize: 10,
  /** 倚音品位的小字号（spec §21：倚音不占时值；字号大小本身是产品决定）。 */
  graceFontSize: 7,
  /**
   * 字形视觉中线到文本基线的比例（产品决定）：品位数字画在弦线**上**，要以线为中心
   * 视觉居中，故基线 = 线 y + fontSize × 本比例。写成比例而不是固定偏移，倚音小字号
   * 才能跟着缩放。
   */
  fretBaselineRatio: 0.35,
  /** 品位数字左右留白：`tabSlotWidths.ts` 的列宽下界用它（产品决定）。 */
  fretPaddingX: 3,
  /** 品位数字白底矩形相对字形 bbox 的四周外扩量——它要遮住穿过数字的弦线（产品决定）。 */
  fretBackdropPadding: 2,
  /** 一行谱（system）的整体高度：谱顶偏移 16 + 五段弦距 40 之外再留一段下方余量（产品决定）。 */
  systemHeight: 72,
  /** 相邻两行谱之间的垂直间隙（产品决定）。 */
  systemGap: 16,
  /** 头部标签区高度；system 从它下方开始排布（产品决定）。 */
  headerHeight: 20,
  /** 和弦符号（`"C"`，spec §25）的度量字号（产品决定）。 */
  chordSymbolFontSize: 10,
  /** 和弦符号基线相对第 1 弦线的垂直偏移（负值 = 画在谱上方那条预留行里，产品决定）。 */
  chordSymbolOffsetY: -6,
  /** 小节线相对第 1 / 第 6 弦的上下超出量；取 0 = 恰好贯穿六线（产品决定）。 */
  barlineOverhang: 0,
  /** 复合小节线（`|]` / `|:` / `:|`）两根竖线之间的水平间距（产品决定）。 */
  barlineCompositeGap: 3,
  /** 反复点半径（产品决定）。 */
  repeatDotRadius: 1.5,
  /** 反复点相对小节线的水平偏移（产品决定）。 */
  repeatDotOffsetX: 4,
  /** 两个反复点相对六线纵向中心的垂直偏移量（一上一下，产品决定）。 */
  repeatDotOffsetY: 8,
  /** 休止符文本的度量字号（spec §26.9：TAB 声部里的 `z` 与 pitch 模式同形）（产品决定）。 */
  restFontSize: 10,
  /** 未知 / 范围外 / 装饰占位文本的度量字号（产品决定）。 */
  unknownFontSize: 10,
  /** 倚音品位相对主音列的水平偏移量（`after` 为真时取正、否则取负）（产品决定）。 */
  graceOffsetX: 9,
} as const;
