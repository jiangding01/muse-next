/**
 * Domain 公共入口（M1.6 方案 v1.1 §1.6）。
 *
 * 铁律：`src/domain/**` 不得 import `formats/` / `renderer/` / `main/` / `preload/` /
 * `notation/` / `node:` / `electron`（方案 §0-2，由 architecture 守卫测试保证）。
 * 因此 `ParseResult`（引用 `JcxDiagnostic`）属于 parse 层，不在此定义。
 */

import type { MusicEvent } from './event';
import type { EventId, RelationId, VoiceId } from './ids';
import type { Relation } from './relation';
import type { SourceRef } from './sourceRef';
import type { Voice } from './voice';

/**
 * parse 层产出的反查索引，随解析结果返回，不写进 Domain 节点。
 * 所有 key 都是快照内序号，不跨编辑稳定（见 `ids.ts`）。
 */
export interface DomainIndex {
  readonly byPath: ReadonlyMap<SourceRef, EventId | VoiceId | RelationId>;
  readonly eventById: ReadonlyMap<EventId, { readonly voiceId: VoiceId; readonly event: MusicEvent }>;
  readonly relationById: ReadonlyMap<RelationId, Relation>;
  /** key 为 `noteRefKey(ref)`，即 `${eventId}#${memberIndex ?? ''}`。 */
  readonly relationsByNote: ReadonlyMap<string, readonly RelationId[]>;
  readonly voiceById: ReadonlyMap<VoiceId, Voice>;
}

export type { Rational } from './rational';
export { ONE, ZERO, add, cmp, equals, fromParts, mul } from './rational';
export type { SourceRef } from './sourceRef';
export type { EventId, NoteRef, RelationId, VoiceId } from './ids';
export { eventId, noteRefKey, relationId, voiceId } from './ids';
export type {
  Accidental,
  BarlineEvent,
  ChordEvent,
  ChordSymbol,
  ChordSymbolEvent,
  Decoration,
  DecorationEvent,
  EventBase,
  GraceEvent,
  MusicEvent,
  Note,
  NoteEvent,
  Pitch,
  PitchLetter,
  Rest,
  RestEvent,
  TabGroupEvent,
  TabNote,
  TabNoteEvent,
  UnknownEvent,
} from './event';
export type { Relation, RelationBase, Slur, TabRelation, Tie, Tuplet } from './relation';
export type {
  KnownVoiceStyle,
  LyricLine,
  LyricSyllable,
  Voice,
  VoiceAttribute,
} from './voice';
export { isKnownVoiceStyle } from './voice';
export type {
  Barre,
  GuitarChord,
  GuitarFinger,
  GuitarString,
  GuitarStringState,
  IgnoredField,
  KeySignature,
  Meter,
  RawDirective,
  Score,
  Tempo,
  TextBlock,
  UnknownField,
} from './score';
