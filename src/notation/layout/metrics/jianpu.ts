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
  /**
   * 一行谱（system）的整体高度（U-Polish Phase A 收紧：72 → 64，item 9 密度收紧的一部分）。
   * 数字行本身只需要 `baselineOffset`（32）+ 下方装饰的最深处，64 仍有余量；歌词占用的
   * 额外高度由 `restackSystems` 按 `lyricBandHeight` 另行叠加，不占用这个基准值。
   */
  systemHeight: 64,
  /** 行与行之间的垂直间隙（U-Polish Phase A：16 → 12，随 `systemHeight` 等比收紧）。 */
  systemGap: 12,
  /** 数字基线相对 system box 顶边的偏移。 */
  baselineOffset: 32,
  /**
   * 八度点半径（U-Polish Phase A：1.5 → 1.4，随整体密度收紧的小幅收窄，视觉上仍清晰可辨）。
   */
  octaveDotRadius: 1.4,
  /** 相邻两个八度点的间距（U-Polish Phase A：4 → 3.5，随密度收紧）。 */
  octaveDotGap: 3.5,
  /**
   * 低方向八度点、减时线均不存在时的默认起点偏移（`digitBottom`，也是未知占位框/`L:`
   * 标记共用的「数字视觉框底边」——Phase A 未改动这个历史耦合，见 `jianpuGlyphs.ts` 的
   * `digitBottom` 注释）。
   */
  octaveDotFirstOffset: 9,
  /**
   * 低方向八度点相对「最深一条减时线」的额外余量（U-Polish Phase A 新增，item 3：固定层序
   * 「数字 → 减时线 → 低八度点」，减时线条数越多，低八度点整体越往下让，而不是画到线上
   * 或翻转层序——见 `jianpuGlyphBuilders.ts` 的 `lowOctaveDotBaseY`）。取 2：约等于减时线
   * 本身线宽（CSS `stroke-width: 1.4`）的量级，肉眼可辨一条空白缝隙但不至于把八度点推得
   * 过远。
   */
  octaveDotBeamClearance: 2,
  /** 第一条减时线相对基线的垂直偏移（向下）。Phase B 才调整减时线粗细/间距，本次不动。 */
  beamFirstOffset: 5,
  /** 相邻两条减时线的间距。Phase B 才调整，本次不动。 */
  beamGap: 3,
  /** 单条减时线的水平长度。Phase B 才调整，本次不动。 */
  beamLength: 12,
  /**
   * 第一条延音线相对数字左边界（`digitGlyphWidthRatio` 折算的数字半宽 + 小间隙）的水平
   * 偏移（U-Polish Phase A：14 → 6，item 2「与数字等距」：取与 `dashGap` 相同的值，让
   * 「数字→第一条延音线」与「延音线→延音线」两段间距视觉上一致）。数字以
   * `text-anchor: middle` 居中于 `x`（见 `toSvg.ts` 的 `textGlyphToSvg`），半宽 ≈
   * `digitFontSize × digitGlyphWidthRatio ÷ 2` = 16 × 0.6 ÷ 2 = 4.8，加小间隙 1.2 ≈ 6。
   */
  dashFirstOffset: 6,
  /** 相邻两条延音线的水平间距（U-Polish Phase A：6 → 6 不变数值，但现在与 `dashFirstOffset`
   * 取同一个数，语义从「随意值」变成「与数字等距」的显式约定）。 */
  dashGap: 6,
  /**
   * 单条延音线的水平长度（U-Polish Phase A：10 → 16，item 2「长度≈一个数字槽宽」的近似：
   * 不直接等于 `SLOT_SPACING_METRICS.quarterWidth`（24u，那是跨记谱的列宽产品决定，本次
   * 边界裁决明确不联动横向列宽算法），取一个「比数字宽、接近但不到一个基准列宽」的中间
   * 值，视觉上更像一条延音记号、不再像旧版（10u）那样过短。
   *
   * **`jianpuSlotWidths.ts` 只加宽契约核实**（用户审查发现的一处需要写清楚的地方）：
   * 单条延音线的**总延展**（`requiredDashExtent(1)` = `dashFirstOffset + dashLength`）
   * 从旧版 `14 + 10 = 24u` 变成新版 `6 + 16 = 22u`，字面上「变窄」，读起来像是与
   * 「`jianpuSlotWidths.ts` 只加宽、不缩窄」的契约矛盾——**实际不矛盾**：
   * `widenForJianpuGlyphs` 永远走 `effective = max(该槽原本的排布宽度, 本文件核实出的
   * 需求宽度)`（见该文件），改变的只是 `max()` 里的**一个候选值**，不是最终槽宽本身。
   * 单条延音线只出现在半音符（`duration = 1/2`）——`spacing.ts` 的 `timedSlotWidth`
   * 按时值加权，半音符本就排得比四分音符宽（`quarterWidth × 2` 量级，远大于 22u/24u
   * 这两个候选值），所以这条延音线从旧版到新版**从来不是 `max()` 里的胜出项**（不是
   * binding constraint）——回归测试 `jianpu.slotWidth.test.ts` 的
   * 「`L:1/4` 下 `C2|`：不含附点/换算不触发，槽宽与修复前一致」已经钉住半音符槽宽
   * 前后完全不变，就是这条结论的证据。只加宽契约仍然成立：本文件唯一会**推动**最终槽宽
   * 变化的路径是「新的候选值比原排布宽度更大」，22u 这个更小的候选值从未走到过这一步。
   */
  dashLength: 16,
  /**
   * 附点半径（U-Polish Phase A：1.5 → 2.4，item 1「宽约半个数字」：数字视觉宽度 ≈
   * `digitFontSize × digitGlyphWidthRatio` = 16 × 0.6 = 9.6，半个数字宽即附点直径的目标
   * ≈ 4.8，半径 = 2.4）。
   */
  augmentationDotRadius: 2.4,
  /**
   * 第一个附点相对数字左边界的水平偏移（U-Polish Phase A：13 → 8.2，item 1「紧贴数字右
   * 侧」：数字半宽 4.8（见 `dashFirstOffset` 注释同一推导）+ 附点半径 2.4 + 小间隙 1 ≈ 8.2，
   * 使附点边缘几乎贴住数字右边缘）。
   */
  augmentationDotFirstOffset: 8.2,
  /**
   * 相邻两个附点的水平间距（U-Polish Phase A：5 → 5.8，item 1：约等于附点直径 4.8 + 小
   * 间隙 1，双附点时两点不重叠且视觉紧凑）。
   */
  augmentationDotGap: 5.8,
  /**
   * 数字视觉宽度相对 `digitFontSize` 的折算比例（U-Polish Phase A 新增）：附点/延音线要
   * 「紧贴数字」，但本层从不读取真实字体量出的宽度（`notation/**` 零 DOM，`TextMeasurer`
   * 也只用于 `textNode`/歌词/标签这类实际调用 `measure()` 的文本，数字本身走固定
   * `digitFontSize` 走 SVG `text-anchor: middle` 居中绘制，不经过 measurer）——0.6 是常见
   * 无衬线数字字形宽高比的粗略估计（产品决定，不是量出来的字体度量）。
   */
  digitGlyphWidthRatio: 0.6,
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
   * 下方装饰的间距）。U-Polish Phase A 重新推导（item 9）：`lowOctaveDotBaseY`
   * （`jianpuGlyphBuilders.ts`）现在会按「减时线条数」动态下压低八度点起点，下限因此要
   * 覆盖「有减时线 + 多个低八度点」这一更深的组合，不能再只按 `octaveDotFirstOffset`
   * 估算。取真实语料常见的上限场景（≤4 条减时线、2 个低八度点）核算：
   * `beamFirstOffset + 3 × beamGap + octaveDotBeamClearance` = 5 + 9 + 2 = 16u（减时线
   * 让出的低点起点）；`+ octaveDotGap + octaveDotRadius` = 16 + 3.5 + 1.4 = 20.9u（两个
   * 低八度点的最深底边）；字形顶部保守按 `lyricFontSize`（12u）估算，下限 =
   * 20.9 + 12 = 32.9u。这个下限比未收紧前（26.5u）更深——是新的「减时线让位」机制本身
   * 要求的，不是本次密度收紧的反例；`jianpu.clearance.test.ts` 的断言 A 按当前数值
   * 逐 fixture 核实，不是钉死这个具体常量。取 34 留一点余量。
   */
  lyricFirstOffset: 34,
  /**
   * 相邻两段歌词（verse）的行距（U-Polish Phase A：数值不变，语义由「巧合的整数」改为
   * 「item 7『约 1.2 倍字高』的显式取整」：`lyricFontSize × 1.2` = 12 × 1.2 = 14.4，取整数
   * 14 而不是 14.4——`jianpu.lyrics.test.ts` 用 `.toBe` 精确比较相邻两行 y 差，非整数会
   * 在浮点加减后产生舍入误差（`14.400000000000006` ≠ `14.4`），整数没有这个问题）。
   */
  lyricLineGap: 14,
  /** 同一行内相邻两个歌词音节之间的最小间距（无对齐目标的音节顺序排布时用）。 */
  lyricSyllableGap: 4,
  /** 小节线细线与粗线之间的水平间距（`|]` 等复合形态）。 */
  barlineCompositeGap: 3,
  /**
   * 小节线（含反复记号 `‖:`/`:‖`、终止线 `|]`）顶边相对基线的垂直偏移。
   *
   * U-Polish Phase A 首版取 `digitFontSize × 1.2 = 19.2`（12.3/6.9 两段）；Electron
   * 100% 实机截图复核后用户裁决**收到 1.1×**（16.5→17.6，按同一上下比例 16:9 分配）——
   * 「反复线整体高度与数字行接近、仅略高」，1.2× 在真机上仍偏高。上段
   * `17.6 × 16/25 ≈ 11.3`。与 `octaveDotFirstOffset`（数字视觉框下边）等历史参照彻底
   * 独立，见 `jianpuGlyphs.ts` 的 `barlineTop` 注释。
   */
  barlineTopOffset: 11.3,
  /**
   * 小节线底边相对基线的垂直偏移（U-Polish Phase A 二次裁决，推导同 `barlineTopOffset`）：
   * `17.6 × 9/25 ≈ 6.3`，上下两段之和 = 17.6 ≈ `digitFontSize × 1.1`。
   */
  barlineBottomOffset: 6.3,
  /** 反复点半径。 */
  repeatDotRadius: 1.5,
  /** 反复点相对小节线的水平偏移。 */
  repeatDotOffsetX: 4,
  /**
   * 两个反复点相对**数字中线**（`digitMidline`，不是排印基线）的垂直偏移量（一上一下）
   * （U-Polish Phase A 二次裁决：「上下两点围绕数字中线对称」——旧版围绕基线对称，
   * 基线偏向数字视觉框底边，两点因此显得上轻下重）。
   */
  repeatDotOffsetY: 5,
  /** `L:` 变化点细标记的高度。 */
  unitLengthMarkHeight: 10,
  /** 头部标签区（`K:` / 拍号）的高度；system 从它下方开始排布。 */
  headerHeight: 20,
  /** 头部相邻两个标签之间的水平间距。 */
  headerLabelGap: 16,
} as const;
