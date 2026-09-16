/**
 * notation/layout —— 尺寸常量的**唯一来源**（M2 方案 v1.1.1 §2.2 / §2.8 / D6 / §7-19）。
 *
 * 硬约束：
 * - 单位是无量纲的 abstract unit，**不是像素**。不得把「1u ≈ 1px」写成契约——那是
 *   renderer 层 `zoom` / `viewBox` 的事（D6）。
 * - 本文件**只放常量，不放算法**：排布/换行算法住在 `spacing.ts` / `systems.ts`（T4）。
 * - `src/notation/**` 下除本文件外，任何文件都不得再声明「顶层裸数字尺寸常量」——
 *   守卫规则见 `tests/unit/notation/svg.test.ts`（P2-2：扫描范围是整个
 *   `src/notation/**`，排除本文件与 `model/**`——model 层是渲染中立模型，不含尺寸；
 *   另有一条已封存的迁移期例外 `chord/ChordDiagram.tsx`，见该测试文件说明）。
 *   新增尺寸常量一律加到本文件，不要在别处就地写一个数字。
 */

/**
 * 文本度量表：`textMeasurer.ts` 的确定性默认实现按字符类别（ASCII / CJK / 其它）
 * 查这张表得到单字符宽度，不访问 DOM / canvas（§2.8）。
 */
export const TEXT_METRICS = {
  /** 度量表所对应的基准字号（abstract unit）；实际字号通过与此的比例缩放宽度。 */
  fontSize: 12,
  /** 单行文本的行高（abstract unit），与 `fontSize` 同一基准。 */
  lineHeight: 14,
  /** ASCII / 拉丁字符的默认宽度（abstract unit）：等宽近似估算，非真实字体量出。 */
  asciiCharWidth: 7,
  /** CJK（全角：中日韩表意文字、假名、谚文、全角标点）字符的默认宽度（abstract unit）。 */
  cjkCharWidth: 14,
  /** 无法归入以上两类的字符（如零宽符号、控制符）的兜底宽度（abstract unit）。 */
  fallbackCharWidth: 7,
} as const;

/** 线宽（abstract unit）：弦线/品线/小节线等结构性线条的粗细分档，供后续记谱类型复用。 */
export const LINE_METRICS = {
  /** 细线：辅助线、栅格线。 */
  thin: 1,
  /** 常规线：弦线、品线、五线谱谱线。 */
  regular: 1.5,
  /** 粗线：小节线、连音线/延音线的加粗变体。 */
  thick: 2.5,
} as const;

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

/**
 * 列宽（time-slot）排布的间距常量（M2 方案 v1.1.1 §2.6，T4 追加）。
 *
 * 跨记谱通用：`spacing.ts` 的时值加权、固定宽 fallback、等距降级都只从这里取数。
 * 单位仍是 abstract unit（D6），**不是像素**。
 *
 * 取值是**产品决定，不是格式事实**：spec 没有规定任何排布比例。规则只有一条——
 * 以四分音符为基准列宽，按字面 `duration` 线性加权并夹在上下界之间，保证确定性。
 */
export const SLOT_SPACING_METRICS = {
  /** `duration === 1/4`（四分音符）时的列宽基准。 */
  quarterWidth: 24,
  /** 时值加权后的下界：再窄就画不下减时线。 */
  minSlotWidth: 12,
  /** 时值加权后的上界：全音符之后不再无限变宽。 */
  maxSlotWidth: 96,
  /** `duration` 缺失（`L:` 不可知）时的固定占位宽（§2.6.1 R4）。 */
  fallbackSlotWidth: 24,
  /** 不带时值的事件（小节线 / 装饰 / 和弦符号 / 倚音 / 未知占位）的列宽。 */
  untimedSlotWidth: 12,
  /** 某 measure 内出现不可解事件后，该 measure 整体退等距时的统一列宽。 */
  equidistantSlotWidth: 24,
} as const;

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
  /** 连音线 / 圆滑线弧顶相对端点的垂直起伏。 */
  arcHeight: 8,
  /** 弧线相对基线的垂直偏移（负值 = 上方）。 */
  arcOffsetY: -14,
  /** 单端（unresolved / unclosed）弧线的悬空段长度。 */
  arcOpenLength: 12,
  /** 第一行歌词基线相对数字基线的垂直偏移。 */
  lyricFirstOffset: 18,
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

/** 尺寸常量的唯一汇总入口；调用方按需解构，不直接在别处写字面数字。 */
export const NOTATION_METRICS = {
  text: TEXT_METRICS,
  line: LINE_METRICS,
  chord: CHORD_METRICS,
  slot: SLOT_SPACING_METRICS,
  jianpu: JIANPU_METRICS,
} as const;
