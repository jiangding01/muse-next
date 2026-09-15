/**
 * L2 投影 —— 引用归一化（M1.7 T6，方案 v1.1 §8 拍板 G）。
 *
 * Domain 的 `EventId` 是「单次解析快照内的序号」（`domain/ids.ts`），canonical
 * 重排文本后必然变化，直接比字符串只会比出噪声。投影因此把每个引用换成
 * `(voiceIndex, eventIndex, memberIndex)`——同一条关系在两份文本里都成立的位置
 * 事实。找不到目标时返回可比较的 `{ unresolved: true }` 而不是抛异常（理由见
 * `./types` 的 `ProjectedUnresolvedRef`）。
 */

import type { EventId, NoteRef, Rational, Score } from '../../../../domain';
import type { ProjectedRational, ProjectedRef } from './types';

/** key 用裸字符串：`EventId` 是 branded string，其值在一份 `Score` 内全局唯一。 */
export type EventPositions = ReadonlyMap<
  string,
  { readonly voiceIndex: number; readonly eventIndex: number }
>;

export function buildEventPositions(score: Score): EventPositions {
  const positions = new Map<string, { voiceIndex: number; eventIndex: number }>();
  score.voices.forEach((voice, voiceIndex) => {
    voice.events.forEach((event, eventIndex) => {
      positions.set(event.id, { voiceIndex, eventIndex });
    });
  });
  return positions;
}

export function refOf(
  positions: EventPositions,
  id: EventId,
  memberIndex?: number,
): ProjectedRef {
  const found = positions.get(id);
  if (found === undefined) {
    return { unresolved: true };
  }
  return {
    voiceIndex: found.voiceIndex,
    eventIndex: found.eventIndex,
    memberIndex: memberIndex === undefined ? null : memberIndex,
  };
}

export function noteRefOf(positions: EventPositions, ref: NoteRef): ProjectedRef {
  return refOf(positions, ref.eventId, ref.memberIndex);
}

export function rationalOf(value: Rational | undefined): ProjectedRational | null {
  return value === undefined ? null : { num: value.num, den: value.den };
}
