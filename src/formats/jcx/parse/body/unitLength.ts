/**
 * Parse 层 —— body 区 `L:` 在各声部事件序列上的生效位置（M1.7 T0；spec §8.5）。
 *
 * 为什么不是「把每条 `L:` 行按当时的 current voice 归属」：`L:` 在源文本里是**文档级**
 * 的一行，它同时影响此后所有声部的正文；而 Domain 里没有「行」，只有逐声部的事件序列。
 * 因此这里按**生效值的变化**来落账——遍历一个声部的事件，凡是相邻两个事件的生效单位
 * 音长不同，就在后者上记一条 `UnitLengthChange`；声部第一个事件的生效值若不等于描述头
 * 的值，同样记一条。一条全局 `L:` 影响到 N 个声部就产生 N 条 change（`raw` / `origin`
 * 同源，`beforeEventId` 各不相同），影响不到任何事件就不产生 change。
 *
 * 这样得到的是「重放这个声部所需的全部 `L:` 事实」，与序列化时把正文拆成逐声部段落
 * 的形态天然对齐，且每一条都带原拼写与原位置引用，不派生任何语义。
 *
 * 纯函数：不发 diagnostic（`L:` 自身的诊断由 `header.ts` 在收集时发过），不抛异常。
 */

import { parseAstPath } from '../../ast';
import type { MusicEvent, Rational, UnitLengthChange } from '../../../../domain';
import { equals } from '../../../../domain';
import type { UnitLengthScope } from '../duration';

/** 事件所在的 AST 行下标；`origin` 不是行路径时返回 `undefined`（不参与定位）。 */
function lineIndexOf(origin: string): number | undefined {
  const parsed = parseAstPath(origin);
  return parsed === null || parsed.kind !== 'line' ? undefined : parsed.line;
}

function sameUnitLength(a: Rational | undefined, b: Rational | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return equals(a, b);
}

/**
 * 算出一个声部的 `unitLengthChanges`（文档顺序）。
 *
 * `events` 必须是该声部最终的事件序列。无法定位到 AST 行的事件（理论上不存在，
 * 保留分支是为了不抛异常）被跳过，不制造伪变化。
 */
export function collectUnitLengthChanges(
  events: readonly MusicEvent[],
  scope: UnitLengthScope,
): readonly UnitLengthChange[] {
  const changes: UnitLengthChange[] = [];
  let current = scope.header;

  for (const event of events) {
    const lineIndex = lineIndexOf(event.origin);
    if (lineIndex === undefined) {
      continue;
    }
    const effective = scope.unitLengthAtLine(lineIndex);
    if (sameUnitLength(effective, current)) {
      continue;
    }
    current = effective;
    const entry = scope.entryAtLine(lineIndex);
    if (effective === undefined || entry === undefined) {
      // 变化只可能由某条 body `L:` 引起（描述头的值是起点，不会「变回」未知），
      // 故此分支不可达；保留它是为了不用 `as` 也不抛异常地收窄类型。
      continue;
    }
    changes.push({
      beforeEventId: event.id,
      unitLength: effective,
      raw: entry.raw,
      origin: entry.origin,
    });
  }

  return changes;
}
