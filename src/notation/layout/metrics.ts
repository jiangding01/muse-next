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

/** 尺寸常量的唯一汇总入口；调用方按需解构，不直接在别处写字面数字。 */
export const NOTATION_METRICS = {
  text: TEXT_METRICS,
  line: LINE_METRICS,
  chord: CHORD_METRICS,
} as const;
