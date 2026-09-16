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

/** 尺寸常量的唯一汇总入口；调用方按需解构，不直接在别处写字面数字。 */
export const NOTATION_METRICS = {
  text: TEXT_METRICS,
  line: LINE_METRICS,
} as const;
