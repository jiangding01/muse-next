/**
 * Domain —— 声部（M1.6 方案 v1.1 §1.4）。
 *
 * 别名归一化（spec §12.3）只发生在本层：AST 必须保留原始拼写。
 * 未识别的 `key=value`（含 `play=`，spec §12.2 UNVERIFIED）一律进 `unknownAttributes`，
 * 既不猜别名也不提升为布尔行为。
 */

import type { MusicEvent } from './event';
import type { NoteRef, VoiceId } from './ids';
import type { Slur, TabRelation, Tie, Tuplet } from './relation';
import type { SourceRef } from './sourceRef';

/** spec §12.6：`style` 必须可选，未知值原样保留，缺省值由渲染层决定。 */
export type KnownVoiceStyle = 'staff' | 'jianpu' | 'tab';

const KNOWN_VOICE_STYLES: readonly string[] = ['staff', 'jianpu', 'tab'];

export function isKnownVoiceStyle(value: string | undefined): value is KnownVoiceStyle {
  return value !== undefined && KNOWN_VOICE_STYLES.includes(value);
}

export interface VoiceAttribute {
  readonly key: string;
  readonly value: string;
}

export interface LyricSyllable {
  readonly text: string;
  readonly kind: 'text' | 'skip' | 'merge';
  readonly target?: NoteRef;
  readonly origin: SourceRef;
  readonly offsetInLine: number;
}

export interface LyricLine {
  readonly verseIndex: number;
  readonly syllables: readonly LyricSyllable[];
}

export interface Voice {
  readonly id: VoiceId;
  readonly name?: string;
  readonly sname?: string;
  /** 原值保留；是否为已知值用 `isKnownVoiceStyle` 判断。 */
  readonly style?: string;
  readonly instrument?: number;
  /** 正名 volume ← `volumn` / `vol`（spec §12.3）。 */
  readonly volume?: number;
  readonly bracket?: number;
  readonly brace?: number;
  readonly staves?: number;
  readonly space?: string;
  readonly gchords?: boolean;
  readonly clef?: string;
  readonly unknownAttributes: readonly VoiceAttribute[];
  readonly events: readonly MusicEvent[];
  readonly ties: readonly Tie[];
  readonly slurs: readonly Slur[];
  readonly tuplets: readonly Tuplet[];
  readonly tabRelations: readonly TabRelation[];
  readonly lyricLines: readonly LyricLine[];
  /** 同 id `V:` 重复时累加（spec §8.12 INFERRED）。 */
  readonly origins: readonly SourceRef[];
}
