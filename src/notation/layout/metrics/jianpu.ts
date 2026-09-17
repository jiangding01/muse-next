/**
 * 简谱专属几何（M2 方案 v1.1.1 §3.2，T4 追加；abstract unit，D6）。
 *
 * 全部为**产品决定，不是格式事实**：`jp*` 系列精细排版参数在 spec 里全是 `DOC-ONLY`
 * （§8 不做清单），因此这里的每个数值都只是「画得出、画得稳」的一组自洽比例。
 */
export const JIANPU_METRICS = {
  /** 主数字（1–7 / 休止 0）的度量字号。 */
  digitFontSize: 16,
  /** 倚音小字号（§21：不占时值）。 */
  graceFontSize: 10,
  /** 临时记号、装饰占位、和弦符号等次要文本字号。 */
  annotationFontSize: 10,
  /** 调号 / 拍号标签字号。 */
  labelFontSize: 12,
  /** 歌词字号。 */
  lyricFontSize: 12,
  /** 一行谱（system）的整体高度。 */
  systemHeight: 72,
  /** 行与行之间的垂直间隙。 */
  systemGap: 16,
  /** 数字基线相对 system box 顶边的偏移。 */
  baselineOffset: 32,
  /** 八度点半径。 */
  octaveDotRadius: 1.5,
  /** 相邻两个八度点的间距。 */
  octaveDotGap: 4,
  /** 第一个八度点相对基线的垂直偏移（上点取负、下点取正）。 */
  octaveDotFirstOffset: 9,
  /** 第一条减时线相对基线的垂直偏移（向下）。 */
  beamFirstOffset: 5,
  /** 相邻两条减时线的间距。 */
  beamGap: 3,
  /** 单条减时线的水平长度。 */
  beamLength: 12,
  /** 第一条延音线相对数字左边界的水平偏移。 */
  dashFirstOffset: 14,
  /** 相邻两条延音线的水平间距。 */
  dashGap: 6,
  /** 单条延音线的水平长度。 */
  dashLength: 10,
  /** 附点半径。 */
  augmentationDotRadius: 1.5,
  /** 第一个附点相对数字左边界的水平偏移。 */
  augmentationDotFirstOffset: 13,
  /** 相邻两个附点的水平间距。 */
  augmentationDotGap: 5,
  /** 临时记号相对数字左边界的水平偏移（负值 = 画在左上）。 */
  accidentalOffsetX: -5,
  /** 临时记号相对基线的垂直偏移（负值 = 上方）。 */
  accidentalOffsetY: -9,
  /** 和弦块内相邻两个数字的垂直间距（纵向堆叠）。 */
  chordMemberGap: 14,
  /** 倚音相对主音的水平偏移量（`after` 为真时取正、否则取负）。 */
  graceOffsetX: 9,
  /** tuplet 方括号相对基线的垂直偏移（负值 = 上方）。 */
  tupletBracketOffsetY: -22,
  /** tuplet 方括号两端竖钩的高度。 */
  tupletBracketHookHeight: 5,
  /**
   * 连音线 / 圆滑线弧顶相对端点的垂直起伏**基准项**：实际弧高是
   * `clamp(arcHeight + span × arcHeightFactor, arcHeightMin, arcHeightMax)`。
   * 这四个数是**产品决定，不是格式事实**——spec 没有规定弧线的形状。
   */
  arcHeight: 8,
  /** 弧高随跨度增长的斜率（产品决定，不是格式事实）。 */
  arcHeightFactor: 0.06,
  /** 弧高下限：跨度退化到 0 时也还看得出是一条弧（产品决定，不是格式事实）。 */
  arcHeightMin: 6,
  /** 弧高上限：长圆滑线不至于顶穿上方行距（产品决定，不是格式事实）。 */
  arcHeightMax: 24,
  /**
   * 跨行谱弧线的续行端相对该行谱**内容边界**的外扩量（产品决定，不是格式事实）：
   * 续行段拉到内容边界外一点点表示「还没完」，但不拉进行末的整片空白里。
   */
  arcContinuationPadding: 6,
  /**
   * 跨行谱弧线**续行段**的最小可见跨度（产品决定，不是格式事实）。
   *
   * 人工复验发现：末段（`end`）的目标字形若是本行谱的第一个数字，`[内容左界, 字形
   * 中心]` 只剩几个单位，画出来是一个贴着数字的尖角，看不出「这是上一行那条弧的
   * 续行」。首段（`start`）在源字形是行末最后一个数字时对称地退化。于是给续行段一个
   * 最小跨度：`end` 段向右扩到 `x1 + minSpan`、`start` 段向左扩到 `x2 − minSpan`，
   * 再夹回本行谱的 `system.box`。box 本身就比 `minSpan` 还窄时允许退化（宁可短，
   * 不可越界），但永不反向。
   *
   * 取 16 是产品决定：约等于一个数字字形宽（`digitFontSize` 量级）的一倍半，足以让
   * 弧顶（`arcHeightFor` 在此跨度上仍取 `arcHeightMin` 附近）看出弧形。
   */
  arcContinuationMinSpan: 16,
  /** 弧线相对基线的垂直偏移（负值 = 上方）。 */
  arcOffsetY: -14,
  /** 单端（unresolved / unclosed）弧线的悬空段长度。 */
  arcOpenLength: 12,
  /**
   * 第一行歌词基线相对数字基线的垂直偏移（产品决定，不是格式事实：spec 未规定歌词与
   * 下方装饰的间距）。下限由几何推导：必须 ≥ 最深的下方装饰底边 + 歌词字形高度 + 余量——
   * 最深装饰是两个低八度点（`octaveDotFirstOffset + octaveDotGap + octaveDotRadius`
   * = 9 + 4 + 1.5 = 14.5u，比三条减时线的 `beamFirstOffset + 2 × beamGap` = 11u 更深），
   * 字形顶部保守按 `lyricFontSize`（12u）估算，故下限 = 14.5 + 12 = 26.5u；取 30 留出
   * 余量，修复真实语料人工 smoke 发现的「歌词首行与数字下方装饰重叠」（T5.2-C）。
   */
  lyricFirstOffset: 30,
  /** 相邻两段歌词（verse）的行距。 */
  lyricLineGap: 14,
  /** 同一行内相邻两个歌词音节之间的最小间距（无对齐目标的音节顺序排布时用）。 */
  lyricSyllableGap: 4,
  /** 小节线细线与粗线之间的水平间距（`|]` 等复合形态）。 */
  barlineCompositeGap: 3,
  /** 反复点半径。 */
  repeatDotRadius: 1.5,
  /** 反复点相对小节线的水平偏移。 */
  repeatDotOffsetX: 4,
  /** 两个反复点相对基线的垂直偏移量（一上一下）。 */
  repeatDotOffsetY: 5,
  /** `L:` 变化点细标记的高度。 */
  unitLengthMarkHeight: 10,
  /** 头部标签区（`K:` / 拍号）的高度；system 从它下方开始排布。 */
  headerHeight: 20,
  /** 头部相邻两个标签之间的水平间距。 */
  headerLabelGap: 16,
} as const;
