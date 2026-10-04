/**
 * notation/layout —— 事件的**计时分类**（M2.5 T2 追加，T2 / T3 / T3.5 共用；用户 2026-10-04 裁决 F）。
 *
 * T3.5（用户裁决 Q1-a）把它从 `system/timedDuration.ts` 原样下沉到 `layout/`：TAB / 简谱的
 * beam 分组（`layout/beamGroups.ts`）也要用它，而记谱目录按 §B.2 只能 import `system/contracts`；
 * `system/timedDuration.ts` 保留为 re-export 转接，T2 / T3 的调用点与测试不变。
 *
 * 只回答「这个事件在小节内时间上占不占位、占多少」：
 * - timed：`note` / `rest` / `tabNote` / `chord` / `tabGroup`（`duration` 可能缺失 = `L:` 不可知）；
 * - untimed：`grace`（spec §21 不占时值）/ `barline` / `decoration` / `chordSymbol`（zero-time
 *   overlay）/ `unknown`。
 *
 * 与 `layout/spacing.ts` 的私有 `timedDurationOf`、`model/buildRenderScore.ts` 的
 * `timedDuration` **同源于 Domain 的事件定义、各写一份**（`spacing.ts` 文件内注释记录的
 * 既有惯例）：穷尽 `switch` 让 Domain 新增事件类型时三处同时报错；分类一致性由
 * `system.measureIdentity.test.ts` 对 `itemSlotWidth()` 的 cross-check 钉住。
 * **不依赖** metrics、spacing 几何或 `Meter`。
 */

import type { MusicEvent, Rational } from '../../domain';

export type EventTiming =
  | { readonly timed: false }
  | { readonly timed: true; readonly duration: Rational | undefined };

export function eventTiming(event: MusicEvent): EventTiming {
  switch (event.kind) {
    case 'note':
      return { timed: true, duration: event.note.duration };
    case 'rest':
      return { timed: true, duration: event.rest.duration };
    case 'tabNote':
      return { timed: true, duration: event.note.duration };
    case 'chord':
    case 'tabGroup':
      return { timed: true, duration: event.duration };
    case 'grace':
    case 'barline':
    case 'decoration':
    case 'chordSymbol':
    case 'unknown':
      return { timed: false };
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}
