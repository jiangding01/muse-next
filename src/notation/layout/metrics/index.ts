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

import { TEXT_METRICS, LINE_METRICS, SLOT_SPACING_METRICS, SCORE_HEADER_METRICS, SCORE_VIEW_METRICS } from './shared';
import { CHORD_METRICS } from './chord';
import { JIANPU_METRICS } from './jianpu';
import { TAB_METRICS } from './tab';
import { STAFF_METRICS } from './staff';

export { TEXT_METRICS, LINE_METRICS, SLOT_SPACING_METRICS, SCORE_HEADER_METRICS, SCORE_VIEW_METRICS } from './shared';
export { CHORD_METRICS } from './chord';
export { JIANPU_METRICS } from './jianpu';
export { TAB_METRICS } from './tab';
export { STAFF_METRICS } from './staff';

/** 尺寸常量的唯一汇总入口；调用方按需解构，不直接在别处写字面数字。 */
export const NOTATION_METRICS = {
  text: TEXT_METRICS,
  line: LINE_METRICS,
  chord: CHORD_METRICS,
  slot: SLOT_SPACING_METRICS,
  jianpu: JIANPU_METRICS,
  tab: TAB_METRICS,
  staff: STAFF_METRICS,
  scoreHeader: SCORE_HEADER_METRICS,
  scoreView: SCORE_VIEW_METRICS,
} as const;
