/**
 * Domain —— 声部（M1.6 方案 v1.1 §1.4）。
 *
 * 别名归一化（spec §12.3）只发生在本层：AST 必须保留原始拼写。
 * 未识别的 `key=value`（含 `play=`，spec §12.2 UNVERIFIED）一律进 `unknownAttributes`，
 * 既不猜别名也不提升为布尔行为。
 */

import type { MusicEvent } from './event';
import type { EventId, NoteRef, VoiceId } from './ids';
import type { Rational } from './rational';
import type { BrokenRhythm, Slur, TabRelation, Tie, Tuplet } from './relation';
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

/**
 * 该 `w:` 行所绑定的那条正文（独立 bodyLine 或 `[V:x] CDE` 的同行尾随正文）
 * **产生的全部事件**的首尾 id —— 含 grace / rest / barline 等不可唱事件，
 * 与 `LyricSyllable.target` 的可唱事件子序列无关。
 *
 * 它是「行边界」这一文本事实的 Domain 表达：Domain 不建模源文本的行，
 * 这一对引用是恢复行边界的唯一依据。同一条正文被多条 `w:` 绑定（多段歌词）时，
 * 各 `LyricLine` 共用同一个范围。
 */
export interface LyricBodyRange {
  readonly firstEventId: EventId;
  readonly lastEventId: EventId;
}

export interface LyricLine {
  readonly verseIndex: number;
  readonly syllables: readonly LyricSyllable[];
  /**
   * 绑定目标产生的事件范围；**该 `w:` 行没有绑定目标、或目标行一个事件都没有产生时
   * 为 `null`**（显式的「无范围」，绝不伪造一个不存在的 `EventId` 去凑首尾）。
   */
  readonly bodyRange: LyricBodyRange | null;
}

/**
 * 声部事件序列上「生效单位音长发生变化」的位置（spec §8.5 的 body 区 `L:`）。
 *
 * **这是 effective normalized fact，不是纯源位置事实**：它由「每个声部的事件序列 ×
 * 该位置生效的 `L:`」派生出的 unit-length transition，而不是源文本里 `L:` 行的清单。
 * `L:` 在源文本里是文档级的一行，Domain 里却没有「行」，只有各声部的事件序列，所以
 * 一条源码 `L:` 影响到 N 个声部就对应 N 条 voice-local change（`raw` / `origin` 同源，
 * `beforeEventId` 各不相同），影响不到任何事件就一条都不产生。
 *
 * 因此**不要试图把它压回源码的 `L:` 行数**：两者不是一一对应，条数相等只是巧合。
 * 每条 change 里 `raw` / `origin` 仍是原拼写与原位置引用（可直接写回），
 * `beforeEventId` 则是该声部内「从它起新值生效」的那个事件，故恒存在，无 `null` 分支。
 */
export interface UnitLengthChange {
  readonly beforeEventId: EventId;
  readonly unitLength: Rational;
  /** 引发这次变化的 `L:` 行的值原文（如 `1/8`）。 */
  readonly raw: string;
  readonly origin: SourceRef;
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
  /** spec §16.2 的 `>` / `<`：时值已改写进事件，marker 本身作为事实存于此。 */
  readonly brokenRhythms: readonly BrokenRhythm[];
  /** body 区 `L:` 在本声部事件序列上的生效位置（文档顺序）。 */
  readonly unitLengthChanges: readonly UnitLengthChange[];
  readonly lyricLines: readonly LyricLine[];
  /** 同 id `V:` 重复时累加（spec §8.12 INFERRED）。 */
  readonly origins: readonly SourceRef[];
}
