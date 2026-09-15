/**
 * Domain —— 音乐事件（M1.6 方案 v1.1 §1.2）。
 *
 * 只包含「时间 / 顺序」事件。syntax marker（tuplet/slur/tie/broken rhythm/TAB 连接符）
 * 由 parse 层消费成 Relation，不得出现在事件流里（方案 §0-5）。
 *
 * 所有 `duration` 均为可选：`L:` 无法确定时（方案 §7 E1）只保留 `durationRaw`，不派生时值。
 */

import type { EventId } from './ids';
import type { Rational } from './rational';
import type { SourceRef } from './sourceRef';

export interface EventBase {
  readonly id: EventId;
  readonly origin: SourceRef;
}

// ---------------------------------------------------------------------------
// 值对象（非事件）
// ---------------------------------------------------------------------------

export type PitchLetter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';

/**
 * `register` 区分大小写字母（spec §14.1/§14.2）。
 *
 * 八度修饰是**两个字段**：
 * - `octaveRaw` 是事实——原文中全部 `'` / `,` 的拼接（没有修饰时为空串）；
 * - `octaveShift` 是派生，且**只在标记同方向时才存在**：spec §14.2 明文裁决混合叠加
 *   （如 `C,'`）的行为 UNVERIFIED、「不实现抵消逻辑，保留原文」，故混合方向时本字段
 *   整个省略，只留 `octaveRaw`（parse 层同时发 info）。
 */
export interface Pitch {
  readonly letter: PitchLetter;
  readonly register: 'upper' | 'lower';
  readonly octaveRaw?: string;
  readonly octaveShift?: number;
}

export type Accidental = '^' | '^^' | '_' | '__' | '=';

export interface Note {
  readonly pitch: Pitch;
  /** durationRaw × unitLength；unitLength 未知时省略（方案 §7 E1）。 */
  readonly duration?: Rational;
  readonly durationRaw?: string;
  readonly accidental?: Accidental;
  readonly origin: SourceRef;
}

/**
 * `variant` 保留原字符，三种休止**不合并**：
 * `Z` 不赋多小节语义、`@` 不赋隐藏行为（spec §15.2/§15.3 均为 UNVERIFIED / DOC-ONLY）。
 */
export interface Rest {
  readonly variant: 'z' | 'Z' | '@';
  readonly duration?: Rational;
  readonly durationRaw?: string;
  readonly origin: SourceRef;
}

/** `stringIndex` 为 a..f → 1..6（spec §26.2）；`fret` 的 `'x'` 表示禁止弹奏。 */
export interface TabNote {
  readonly stringIndex: 1 | 2 | 3 | 4 | 5 | 6;
  readonly fret: number | 'x';
  /** V/U/A/B/… 原字符，值域开放（spec §26.4）。 */
  readonly stroke?: string;
  readonly duration?: Rational;
  readonly durationRaw?: string;
  readonly origin: SourceRef;
}

/** spec §23：简单记号只留名字；复合形态尽力解析参数，失败降级只留 raw。 */
export type Decoration =
  | { readonly form: 'simple'; readonly name: string }
  | {
      readonly form: 'complex';
      readonly x?: number;
      readonly y?: number;
      readonly font?: string;
      readonly size?: number;
      readonly payloadRaw: string;
      readonly raw: string;
    };

/** spec §25：root/quality 不解析，避免推断。`""` 为 empty，`displayOnly` 见 §25.3。 */
export interface ChordSymbol {
  readonly raw: string;
  readonly empty: boolean;
  readonly displayOnly: boolean;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

export interface NoteEvent extends EventBase {
  readonly kind: 'note';
  readonly note: Note;
}

export interface RestEvent extends EventBase {
  readonly kind: 'rest';
  readonly rest: Rest;
}

/** 组时值取首音（spec §14.4，CONFIRMED BY DOCUMENTATION）。 */
export interface ChordEvent extends EventBase {
  readonly kind: 'chord';
  readonly members: readonly (Note | Rest)[];
  readonly duration?: Rational;
}

/** 装饰音不占时值（spec §21）。`after` 表示后倚音。 */
export interface GraceEvent extends EventBase {
  readonly kind: 'grace';
  readonly members: readonly (Note | TabNote)[];
  readonly after: boolean;
}

/** repeat / 跳房子形态只存 raw，语义留 M2/M4（spec §19）。 */
export interface BarlineEvent extends EventBase {
  readonly kind: 'barline';
  readonly raw: string;
}

/** 独立事件，不挂在某个音符上（方案 §7 E2）。 */
export interface DecorationEvent extends EventBase {
  readonly kind: 'decoration';
  readonly decoration: Decoration;
}

export interface ChordSymbolEvent extends EventBase {
  readonly kind: 'chordSymbol';
  readonly symbol: ChordSymbol;
}

export interface TabNoteEvent extends EventBase {
  readonly kind: 'tabNote';
  readonly note: TabNote;
}

/** 组时值取末音（spec §26.8，CONFIRMED BY DOCUMENTATION）。 */
export interface TabGroupEvent extends EventBase {
  readonly kind: 'tabGroup';
  readonly members: readonly TabNote[];
  readonly stroke?: string;
  readonly duration?: Rational;
}

/** 无法归类的 token：只保留原文与 lexer 给出的 token 类别。 */
export interface UnknownEvent extends EventBase {
  readonly kind: 'unknown';
  readonly raw: string;
  readonly tokenKind: string;
}

export type MusicEvent =
  | NoteEvent
  | RestEvent
  | ChordEvent
  | GraceEvent
  | BarlineEvent
  | DecorationEvent
  | ChordSymbolEvent
  | TabNoteEvent
  | TabGroupEvent
  | UnknownEvent;
