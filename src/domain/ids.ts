/**
 * Domain —— 标识符与音符引用（M1.6 方案 v1.1 §1.1）。
 *
 * 生成规则：
 * - `voiceId   = 'v' + 声明序号（1-based）`
 * - `eventId   = voiceId + ':e' + 事件流下标`
 * - `relationId= voiceId + ':' + kind + n`
 *
 * 重要：这些 id 均为**单次解析快照内的序号，不跨编辑稳定**。任何一次重新解析
 * （包括用户在源文本中插入一个音符）都可能让同一个音乐对象获得不同的 id。
 * 跨编辑的稳定 identity（HANDOFF §45 的 source ↔ visual sync）留到 M3 的 reconciliation。
 */

export type VoiceId = string & { readonly __brand: 'VoiceId' };
export type EventId = string & { readonly __brand: 'EventId' };
export type RelationId = string & { readonly __brand: 'RelationId' };

/**
 * 唯一的断言点：branded string 无法由 TS 从字面量推导出来，只能在此处贴牌。
 * 三个工厂函数共用本函数，模块外不导出。
 */
function brand<T extends string>(value: string): T {
  return value as T;
}

function assertIndex(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/** 声部 id；`n` 为声明序号（1-based）。 */
export function voiceId(n: number): VoiceId {
  assertIndex('voiceId index', n);
  return brand<VoiceId>(`v${String(n)}`);
}

/** 事件 id；`index` 为该声部事件流中的下标（0-based）。 */
export function eventId(voice: VoiceId, index: number): EventId {
  assertIndex('eventId index', index);
  return brand<EventId>(`${voice}:e${String(index)}`);
}

/** 关系 id；`kind` 取 `tie` / `slur` / `tuplet` / `slide` 等，`n` 为该 kind 内序号。 */
export function relationId(voice: VoiceId, kind: string, n: number): RelationId {
  assertIndex('relationId index', n);
  return brand<RelationId>(`${voice}:${kind}${String(n)}`);
}

/**
 * 指向一个音符位置：省略 `memberIndex` 表示整个事件（非和弦块，或整块）。
 * 和弦成员没有独立生命周期，所以不设独立的 NoteId。
 */
export interface NoteRef {
  readonly eventId: EventId;
  readonly memberIndex?: number;
}

/** 反查 key：`${eventId}#${memberIndex ?? ''}`。 */
export function noteRefKey(ref: NoteRef): string {
  return `${ref.eventId}#${ref.memberIndex === undefined ? '' : String(ref.memberIndex)}`;
}
