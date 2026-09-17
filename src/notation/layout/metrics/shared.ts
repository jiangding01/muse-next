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
  /**
   * **overlay 列**（`SlotWidthKind === 'overlay'`）的列宽：恒为 0。
   *
   * 和弦符号（spec §25）标注的是「此处开始是这个和弦」，它不消费任何节奏时间，也不
   * 该在主谱行（简谱数字行 / TAB 六线）里挤出一个空档——人工复验里 TAB 每小节的
   * `"C"` 都在六线和节奏带上撕开一道 12u 的口子（`|||| ||||`）。零宽列让和弦符号
   * 贴在**后续第一个有实际列宽的事件**左缘上（列宽为 0 → 累计 x 不前进 → 下一列的
   * x 与它相同），位于 measure 末尾时则贴在该 measure 的末端，两种情形都不推宽。
   *
   * 写成常量而不是字面 0：`notation/**` 的尺寸只有 `metrics.ts` 一个来源。
   */
  overlaySlotWidth: 0,
} as const;

/**
 * 谱面头部（`Score.titles/credits/notes/meter/key/tempo`，§3.5 P2-11）专属字号表
 * （M2 方案 v1.1.1 §3.5，T5 追加）。
 *
 * `layoutScoreHeader` 用它们驱动注入的 `TextMeasurer`；**输出路径是 HTML**（P2-E），
 * `ScoreView` 只消费这里产出的 `.text` 字符串，字号由 `global.css` 按语义 class
 * （title / subtitle / credit / note / metadata）决定——测出的 `width`/`fontSize`
 * 是 abstract unit，**不得当 CSS px 写进内联样式**（D6），只为 M5 的 `toSvg` 预留。
 */
export const SCORE_HEADER_METRICS = {
  /** 主标题字号。 */
  titleFontSize: 24,
  /** 副标题字号（`titles[1..]`，§8.12 有序、逐行、不拼接）。 */
  subtitleFontSize: 14,
  /** credits 字号。 */
  creditFontSize: 11,
  /** notes（`I:`）字号。 */
  noteFontSize: 10,
  /** meter / key / tempo 一行次要信息带的字号。 */
  metaFontSize: 12,
  /** `Score.textBlocks` 段落字号。 */
  textBlockFontSize: 11,
} as const;

/**
 * `ScoreView` 自身的布局常量（T5 追加）。
 *
 * `defaultAvailableWidth` 是简谱 system 换行（D7）的固定阈值——**不是**容器的真实
 * CSS 像素宽度：M2 未引入 `zoom`（T6 才有），`<svg>` 用自己的 `viewBox` 表达内部
 * abstract-unit 几何，外层用 `width: 100%` 让浏览器按容器实际宽度整体缩放，
 * 二者不混在一起（D6：abstract unit 与 px 不建立契约性换算关系）。
 */
export const SCORE_VIEW_METRICS = {
  defaultAvailableWidth: 960,
  /**
   * 容器 CSS 像素 → abstract unit 的固定换算比例（**产品决定，不是格式事实**）。
   *
   * 这不是把「1u ≈ 1px」写成 layout 层的契约（D6 明确禁止的是那种写法）：本常量
   * 只活在 `ScoreView`（renderer 层）用真实 `ResizeObserver` 宽度换算
   * `availableWidth` 这一处，`notation/**` 内部仍然只谈 abstract unit，换算比例
   * 可以随时调整，不影响任何 layout 数值的语义。T6.4 起参与 `zoom` 换算的公式，
   * 见 `zoomMin`/`zoomMax`/`zoomStep` 与 `renderer/components/notation/voiceRender.ts`
   * 的 `computeAvailableWidthUnits`。
   */
  cssPixelsPerUnitAtZoom1: 1,
  /**
   * 缩放范围与步进（T6.4 新增，**产品决定**）：只作用于 renderer 层的外层像素换算
   * （容器 CSS 宽 ÷ (`cssPixelsPerUnitAtZoom1` × zoom) 得到 `availableWidth`，
   * 谱面画布 CSS 宽 = `layout.width × cssPixelsPerUnitAtZoom1 × zoom`），不改任何
   * `notation/**` 内部的 layout 数值（D6）。
   */
  zoomMin: 0.5,
  zoomMax: 3,
  zoomStep: 0.25,
} as const;
