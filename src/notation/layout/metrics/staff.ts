/**
 * Staff（五线谱）专属几何（M2 T7.1 追加；abstract unit，D6，**不是像素**）。
 *
 * 除 `lineCount` 外，**每一项都是产品决定，不是格式事实**：spec 从未规定线间距、
 * 留白、字号等任何排版数值——五线谱本身也不是 JCX 的格式概念，是渲染器的选择
 * （T7.4 才决定用 VexFlow 画出来）。`lineGap` 取值与 `TAB_METRICS.lineGap` 相同，
 * 只是「两条线足够分辨」这一common-sense 判断的复用，不是两种记谱共享同一常量表——
 * `staff/**` 不 import `tab/**`（见 architecture 守卫），本文件独立声明。
 *
 * 与 `TAB_METRICS` / `JIANPU_METRICS` **平行且独立**：Staff 不复用其他记谱的几何常量。
 */
export const STAFF_METRICS = {
  /**
   * 五线谱线数：固定 5 条（**格式事实**——「五线谱」这个记谱形式本身的定义，
   * 不因作者写的 `.jcx` 而变化，唯一不算产品决定的一项）。
   */
  lineCount: 5,
  /**
   * 相邻两条谱线的垂直间距（产品决定）——**Muse Next 五线谱线距的唯一真源**（M2.5 T9b.S，用户裁决 M1：8 → 10）。
   *
   * 原值 8 与实际谱面不一致：谱线一直按 VexFlow 默认的 10 绘制，只有自绘的 tuplet 括号与占位热区读的是 8。
   * 10 与 Bravura 字形在 VexFlow 默认字号下的设计线距一致；`renderStaff.ts` 把它**显式**传给 VexFlow 的
   * `spacingBetweenLinesPx`，不再依赖 `VexFlow.STAVE_LINE_DISTANCE` 定义任何几何。同步后的预期变化（不是债务）：
   * 自绘 tuplet 括号离第一线 16 → 20、腿长 4 → 5、最小跨度 8 → 10；占位热区改为基础 Staff box，不再按线距推导。
   */
  lineGap: 10,
  /**
   * 第 1 线（最上一条谱线）相对 Staff 层**内容顶**的垂直偏移（产品决定）= 上方基础余量 32。
   * M2.5 systemized 路径下内容顶 = 层顶 + 本行谱的 `topExtra`（`staff/staffVerticalDemand.ts`）。
   */
  staffTopOffset: 32,
  /**
   * 一行谱（system）的**基础**高度（产品决定）：上方余量 `staffTopOffset`(32) + 谱表跨度 `4 × lineGap`(40)
   * + 下方余量 24 = 96。这是基准情形，不是硬上限：M2.5 systemized 路径由 `staffVerticalDemand.ts` 按本行谱
   * 实际纵向墨迹在上 / 下各补 `topExtra` / `bottomExtra`；M2 默认路径仍恒为 96（用户裁决 M4）。
   */
  systemHeight: 96,
  /**
   * 纵向墨迹包络（M2.5 T9b.S，产品决定，按 `lineGap = 10` 下 Bravura / VexFlow 5.0.0 的浏览器实测标定，取值 ≥ 实测）。
   *
   * 只用于 `staff/staffVerticalDemand.ts` 估算一行谱的纵向需求，目标是**包住**音高相关墨迹（containment），
   * 不是复制渲染器的 SVG bbox。全部以「符头中心」为基准，向上 / 向下的距离（abstract unit）。
   */
  verticalInk: {
    /** 符头半高（一个线距的一半）；加线笔画半宽远小于它，加线墨迹由符头包络覆盖。 */
    noteheadHalfHeight: 5,
    /** 符干标准长度（3.5 个线距）。 */
    stemLength: 35,
    /** 未成束短时值的符尾使符干额外延长的量（实测 32 分 4.4、64 分 12.5、128 分 20.7）。 */
    flagStemExtension: { thirtySecond: 5, sixtyFourth: 13, hundredTwentyEighth: 21 },
    /** 升降号字形相对符头中心的上 / 下伸展（实测：降号上 17.6、升号下 13.9、还原上 13.6、重升 5.1）。 */
    accidental: {
      sharp: { above: 14, below: 14 },
      doubleSharp: { above: 6, below: 6 },
      flat: { above: 18, below: 7 },
      doubleFlat: { above: 18, below: 7 },
      natural: { above: 14, below: 14 },
    },
    /**
     * 附点相对符头中心的**上下双向**保守包络：VexFlow 把线上音的附点移到上方或下方的间（和弦里相邻音会迫使附点
     * 下移），位移至多半个线距，加上附点半径；浏览器实测单音与相邻音和弦的附点墨迹最远距符头中心恰为 7。
     */
    dotVerticalPadding: 7,
    /** 笔画与抗锯齿的安全边距：最终上 / 下墨迹各外扩一次。 */
    padding: 1,
  },
  /**
   * tie 端点音的纵向保守包络（M2.5 T9b.S，用户裁决 M2）：端点音符头中心上下各留这么多，覆盖向外弯的弧线
   * （实测弧线外缘距符头中心 13）。不复制渲染器的 tie 曲线算法。
   */
  tieVerticalPadding: 13,
  /** 相邻两行谱之间的垂直间隙（产品决定）；与 `TAB_METRICS.systemGap` 同量级取值。 */
  systemGap: 16,
  /**
   * 行首（谱号 / 调号 / 拍号）在 abstract unit 里的水平预留（产品决定）。
   * `layoutStaff.ts`（T7.2+）用它算出第一个音符列的起始 x，本任务只声明常量。
   */
  headerReserve: {
    /** 谱号符号预留宽度。 */
    clefWidth: 28,
    /** 调号每个升降号符号预留的宽度（乘以下面的 `keySignatureAccidentalReserve`）。 */
    keySignatureWidthPerAccidental: 8,
    /**
     * 画调号时按几个升降号**保守预留**（T7.2 追加，产品决定）。
     *
     * `KeySignature.alter` 是**主音自己的升降记号**（`Eb` → `-1`），**不是**调号里
     * 升降号的个数——由主音推出个数需要一张「调 → 升降号数」的表，而 `K:` 的 mode
     * 在 spec §8.7 是 `DOC-ONLY`（同一个主音在大小调下调号不同），本层没有依据去查
     * 这张表。因此 notation 层**不计算实际个数**（那是 T7.4 的 adapter 交给渲染器
     * 决定的事），只按西方记谱法的上限 7 个升降号预留水平空间：宁可行首多留一点
     * 空白，也不让调号把排好的一行挤超宽。
     */
    keySignatureAccidentalReserve: 7,
    /** 拍号预留宽度（分子/分母两行数字合计）。 */
    timeSignatureWidth: 20,
  },
  /**
   * 单个音符列（time-slot）的最小宽度下界（产品决定）。
   *
   * **T7.4 按渲染器实测重新标定：16 → 40。** 原值只是「比
   * `SLOT_SPACING_METRICS.minSlotWidth`(12) 略宽」的估计，从未对着真实符头量过。接上
   * 渲染器后在浏览器里量到的 Bravura 符头包围盒（含符干、含升降号修饰）是
   * **12–24 CSS px**，而当时一个四分音符列只有 `SLOT_SPACING_METRICS.quarterWidth`
   * = 24u，于是相邻两个符头之间只剩 ≈5u 的空隙——同一小节内的延音线被压成一个看不出
   * 弧形的小点（跨小节的因为多了小节线的空档反而正常），密集处符头几乎相接。
   *
   * 标定方式：最宽的一个符头（带升降号，24）+ 一段「至少看得出是条弧」的跨度
   * （复用本表已有的 `tieContinuationMinSpan` = 16）= **40**。
   *
   * 这是 Staff **自己**的下界，`staffSlotWidths.ts` 只加宽不缩窄，`SLOT_SPACING_METRICS`
   * 的共享上下界一个字没动——简谱 / TAB 的列宽不受影响。副作用是同样一段音乐在五线谱
   * 下比简谱占更多横向空间、换行更早，这是记谱形式本身的事实，不是缺陷。
   */
  minNoteSlotWidth: 40,
  /** 「越界 / 无法建模」占位文本的度量字号（产品决定）。 */
  placeholderFontSize: 10,
  /** 占位文本左右留白（产品决定）。 */
  placeholderPaddingX: 4,
  /** 和弦符号（spec §25）的度量字号（产品决定）；与 `TAB_METRICS.chordSymbolFontSize` 同量级。 */
  chordSymbolFontSize: 10,
  /** 和弦符号基线相对第 1 线的垂直偏移（负值 = 画在谱表上方，产品决定）。 */
  chordSymbolOffsetY: -8,
  /** tuplet 标签（数字 + 括号）的度量字号（产品决定）。 */
  tupletLabelFontSize: 10,
  /**
   * 跨行谱 tie **续行段**的最小可见跨度（产品决定，**格式事实以外的固定值**，方案
   * 明文给出 `16`，与 `JIANPU_METRICS.arcContinuationMinSpan` / `TAB_METRICS.relationContinuationMinSpan`
   * 同一思路：续行段太短会画成一道看不出弧形的短线，保证至少这个跨度，
   * 再夹回本行谱 `system.box`——box 本身更窄时允许退化，但永不反向）。
   */
  tieContinuationMinSpan: 16,
} as const;
