/**
 * Parse 层 —— body 区 `L:` 在各声部事件序列上的生效位置（M1.7 T0，M1.7 补丁按 U06
 * 裁决改为按声部作用域；spec §8.5）。
 *
 * `L:` 在源文本里按行出现，但归属已经在 T5（`body/segments.ts`）按声部拆开
 * （spec §8.5 U06 已裁决：body `L:` 只作用于它所在的声部，不泄漏到其它声部；出现
 * 在任何声部上下文之前的 `L:` 才是 global，对所有声部生效）。因此这里按**生效值
 * 的变化**来落账——遍历一个声部自己的事件，用 `scope.unitLengthAtLine(line, voiceId)`
 * 查询「该声部条目 ∪ global 条目」中在该行生效的值，凡是相邻两个事件的生效单位
 * 音长不同，就在后者上记一条 `UnitLengthChange`；声部第一个事件的生效值若不等于
 * 描述头的值，同样记一条。一条 global `L:` 仍会影响到它之后所有声部各自的
 * change 列表（`raw` / `origin` 同源，`beforeEventId` 各不相同）；一条声部专属的
 * `L:` 只影响该声部；影响不到任何事件就不产生 change。
 *
 * 这样得到的是「重放这个声部所需的全部 `L:` 事实」，与序列化时把正文拆成逐声部段落
 * 的形态天然对齐，且每一条都带原拼写与原位置引用，不派生任何语义。
 *
 * 纯函数：不发 diagnostic（`L:` 自身的诊断由 T5 在归属时发过），不抛异常。
 */

import { parseAstPath } from '../../ast';
import type { MusicEvent, Rational, UnitLengthChange, VoiceId } from '../../../../domain';
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
 * `events` 必须是该声部最终的事件序列，`voiceId` 是它们所属的声部——查询时只看
 * 「该声部条目 ∪ global 条目」（spec §8.5 U06 已裁决，见 `duration.ts`）。无法
 * 定位到 AST 行的事件（理论上不存在，保留分支是为了不抛异常）被跳过，不制造
 * 伪变化。
 */
export function collectUnitLengthChanges(
  events: readonly MusicEvent[],
  scope: UnitLengthScope,
  voiceId: VoiceId,
): readonly UnitLengthChange[] {
  const changes: UnitLengthChange[] = [];
  let current = scope.header;

  for (const event of events) {
    const lineIndex = lineIndexOf(event.origin);
    if (lineIndex === undefined) {
      continue;
    }
    const effective = scope.unitLengthAtLine(lineIndex, voiceId);
    if (sameUnitLength(effective, current)) {
      continue;
    }
    current = effective;
    const entry = scope.entryAtLine(lineIndex, voiceId);
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
