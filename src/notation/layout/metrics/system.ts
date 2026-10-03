/**
 * System / Page 专属几何（M2.5 T0 追加；`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §C / F-8）。
 *
 * **每一项都是产品决定，不是格式事实**（M5 可调）：spec 从未规定复合 system 的间距、
 * 两端对齐上限或纸张尺寸。初值由用户 2026-10-04 整表裁决，T9b 真实 system 页面出来后
 * 再做视觉标定，T0 不提前优化。
 *
 * 单位是 abstract unit（D6），**不是像素**。与其它记谱 metrics 平行且独立：不 import
 * 任何文件（`page` 可赋值给 `system/contracts.ts` 的 `PageSpec` 由测试的 `satisfies`
 * 证明，无多余字段由同一测试的整表 `toEqual` 钉住；metrics 不反向依赖 system）。
 * `system/**` 不得写任何裸数字，一律从这里取（§C「尺寸只来自 metrics」）。
 */
export const SYSTEM_METRICS = {
  /**
   * 相邻两个**完整复合 system** 之间的垂直留白。它不是 voice 内的 `systemGap`
   * （简谱 12、TAB/Staff 16），而是 Brief「层内紧凑、系统间明显留白」的系统间呼吸空间。
   */
  systemGap: 24,
  /** 同一 system 内相邻两个 voice 层之间的垂直间距。 */
  layerGap: 8,
  /** 和弦图 overlay 带与最上面一个 voice 层之间的间距（§Q5.3）；无和弦的 system 不留带。 */
  chordBandGap: 6,
  /**
   * 两端对齐时单个 measure 最多放大到 `demandWidth × maxJustifyRatio`（§Q4.5 的
   * water-filling 上限 R）。全部触顶仍有剩余宽 → 右侧留白，`justified = 'partial'`。
   */
  maxJustifyRatio: 1.5,
  /** 行剩余宽小于该值时不拉伸（§Q4.5「剩余宽小于阈值」），只为吸收浮点噪声。 */
  minJustifySlack: 2,
  /**
   * 默认页面规格（F-8，形状 = `PageSpec`）。
   *
   * 数值以 A4 在 96dpi 下的数值尺度作为**产品初始标定来源**，但在 notation / page
   * model 中仍是 abstract unit；这**不建立** abstract unit 与 CSS px 的契约
   * （renderer 层的 `cssPixelsPerUnitAtZoom1` 是另一件事）。M5 可重新标定或映射到
   * 实际打印单位。
   */
  page: {
    width: 794,
    height: 1123,
    marginTop: 56,
    marginRight: 56,
    marginBottom: 56,
    marginLeft: 56,
    /** 首页页眉：标题 / 演唱 / 原调-选调 / 作词-作曲（Brief §2.7.1）。 */
    firstPageHeaderHeight: 160,
    /** 续页页眉。 */
    continuationHeaderHeight: 24,
    /** 页脚（页码带）。 */
    footerHeight: 24,
  },
} as const;
