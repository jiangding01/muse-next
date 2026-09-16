/**
 * notation/layout —— 跨记谱共享的**几何 primitive**（M2 方案 v1.1.1 §2.7 / §2.6 / D6）。
 *
 * **准入判据（只有一条，故意很严）**：四种记谱（Chord / Jianpu / TAB / Staff）是否
 * **都以完全相同的语义**使用它。只要有一种记谱需要「差不多但要加个字段」，它就不属于
 * primitive，应当留在那种记谱自己的 layout 模型里。
 *
 * 因此本文件**只有四个类型**：`Point` / `Box` / `TimeSlot` / `System`。
 *
 * 明确**不在**这里的东西：
 * - **`Anchor`**（§0d-1）：它是 render identity / reference，由 `RenderDiagnostic` 与
 *   layout node **共享同一个定义**，归 `notation/model/types.ts`；这里不设别名、不做包装
 *   （别名会让「诊断的 anchor」与「节点的 anchor」看起来是两种东西）。
 * - **`LayoutItemBase` 之类的万能基类**（§2.7）：四种记谱的几何差异是本质性的
 *   （网格 / 数字行 / 六线品位 / 五线符头），强行抽共同基类必然得到一个字段半数可选、
 *   每个消费方都要判空的联合体。`ChordLayout` / `JianpuLayout` / `TabLayout` /
 *   `StaffLayout` 是四个独立类型，互不继承、互不转换。
 * - **事件归属**：哪个 node 对应哪个事件由各记谱 node 携带的 `Anchor` 回答，
 *   不塞进 `TimeSlot` / `System`——那会让 primitive 反向依赖 Domain id。
 *
 * **单位是 abstract unit，不是像素**（D6 / §7-19）：本文件的所有数值都不绑定 px，
 * `zoom` 只作用于 renderer 外层的 `scale`，**不改变任何 layout 数值**。
 *
 * measure / system / time-slot **一律在本层派生**（§2.6）：Domain 的 `Voice.events`
 * 是扁平事件流，里面没有这些概念，渲染需求也不是往 Domain 里加音乐事实的理由。
 */

/** 一个点（abstract unit）。y 轴向下为正，与 SVG 一致。 */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** 一个轴对齐矩形：左上角 + 尺寸（abstract unit）。 */
export interface Box {
  readonly origin: Point;
  readonly width: number;
  readonly height: number;
}

/**
 * 一列：同一声部内按事件序 + 累计时值分配出的水平位置（§2.6）。
 *
 * **跨声部对齐不在 M2 范围**（多声部先各画各的），所以这里不带 voice 维度。
 * 纯几何：不持有事件 id，也不解释时值——时值加权 / 等距降级的求解在 `spacing.ts`。
 */
export interface TimeSlot {
  /** 该声部内的列序号，0-based，随事件序单调递增。 */
  readonly index: number;
  /** 列的左边界（abstract unit）。 */
  readonly x: number;
  /** 列宽（abstract unit）；`duration` 不可知时取固定宽 fallback。 */
  readonly width: number;
}

/**
 * 一行谱（§2.6 / D7）。
 *
 * 只描述「第几行、占哪块矩形」这个四种记谱完全一致的部分；行内画什么（哪些 measure、
 * 哪些音符列）属于各记谱自己的 layout 模型。M2 做到 system 级连续布局 + 按容器宽度的
 * 基本换行，**分页 / 多页不在范围内**。
 */
export interface System {
  /** 文档顺序的行序号，0-based。 */
  readonly index: number;
  /** 该行在画布中的矩形（abstract unit）。 */
  readonly box: Box;
}
