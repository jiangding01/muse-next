/**
 * notation/system —— 事件计时分类的**转接**（T3.5 用户裁决 Q1-a）。实现已原样下沉到
 * `layout/eventTiming.ts`（记谱目录的 beam 分组也要用，而它们按 §B.2 不得 import `system/`）；
 * 本文件只 re-export，T2 / T3 的调用点与测试不变。
 */

export type { EventTiming } from '../layout/eventTiming';
export { eventTiming } from '../layout/eventTiming';
