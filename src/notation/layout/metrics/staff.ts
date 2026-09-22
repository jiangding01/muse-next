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
  /** 相邻两条谱线的垂直间距（产品决定）；与 `TAB_METRICS.lineGap` 同量级取值。 */
  lineGap: 8,
  /**
   * 第 1 线（最上一条谱线）相对 system box 顶边的垂直偏移（产品决定）。
   * 推导：需要给谱表上方的加线留出空间——常规记谱最多按 3 条上加线估算
   * （`3 × lineGap = 24`），再加一点呼吸空间（8），故 `24 + 8 = 32`。
   */
  staffTopOffset: 32,
  /**
   * 一行谱（system）的整体高度（产品决定）。
   * 推导：`staffTopOffset(32)` + 谱表本身跨度 `4 × lineGap(32)`（5 线 4 间）
   * + 下方 3 条加线的空间 `3 × lineGap(24)` + 底部余量（8）= 96。
   * 与 `TAB_METRICS.systemHeight` 的推导方式同构（都是「基准情形，不是硬上限」，
   * 更深的装饰由 `layout/systems.ts` 按行谱实际内容回填）。
   */
  systemHeight: 96,
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
  /** 单个音符列（time-slot）的最小宽度下界；比 `SLOT_SPACING_METRICS.minSlotWidth` 略宽，给符头留出空间（产品决定）。 */
  minNoteSlotWidth: 16,
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
