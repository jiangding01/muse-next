/**
 * Domain —— 乐谱聚合根（M1.6 方案 v1.1 §1.4）。
 *
 * 所有字段要么是 AST 事实，要么是方案 §1.7 列明依据的派生值；
 * 未验证语义（`play` / `Z` 多小节 / `@` 隐藏）不得在此固化为字段。
 */

import type { Rational } from './rational';
import type { SourceRef } from './sourceRef';
import type { Voice } from './voice';

/** spec §8.4：`M:C` / `M:C|` 不换算为 4/4，只保留 raw，故 num/den 可缺省。 */
export interface Meter {
  readonly num?: number;
  readonly den?: number;
  readonly raw: string;
}

/** spec §8.6：解析不出 `beat=bpm` 形态时只留 raw，不臆造数值。 */
export interface Tempo {
  readonly beat?: Rational;
  readonly bpm?: number;
  readonly raw: string;
}

/** spec §8.7：mode / clef 不解析。 */
export interface KeySignature {
  readonly tonic?: string;
  readonly alter?: number;
  readonly raw: string;
}

export type GuitarStringState = 'muted' | 'open' | 'fretted';

export type GuitarFinger = 1 | 2 | 3 | 4;

export interface GuitarString {
  readonly state: GuitarStringState;
  /** 空弦或禁弹时为 `null`。 */
  readonly fret: number | null;
  readonly finger?: GuitarFinger;
}

/**
 * spec §10.1：横按记法 UNVERIFIED，不得自行发明。
 * 类型保留以免后续破坏性变更，但 M1.6 的 parser 恒产出空数组。
 */
export interface Barre {
  readonly fret: number;
  readonly fromString: number;
  readonly toString: number;
  readonly finger?: GuitarFinger;
}

/**
 * `%%gchord` 和弦图定义（HANDOFF §19 + spec §10.1）。
 * `capoFret` 即 `=` 后的变调夹品位（不是 legacy 误名 baseFret）。
 * `strings` 定长 6 项，顺序为第六弦 → 第一弦；项数 ≠ 6 时不构造本对象，只留 raw。
 */
export interface GuitarChord {
  readonly name: string;
  readonly capoFret: number;
  readonly strings: readonly [
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
    GuitarString,
  ];
  readonly barres: readonly Barre[];
  readonly rawValue: string;
  readonly origin: SourceRef;
}

/** `%%` 指令原样保留（spec §10.8）。 */
export interface RawDirective {
  readonly name: string;
  readonly rawValue: string;
  readonly origin: SourceRef;
}

/** `%%begintext`…`%%endtext`（spec §11）：内容行禁止 trim；未闭合时 `closed` 为 false。 */
export interface TextBlock {
  readonly lines: readonly string[];
  readonly closed: boolean;
  readonly origin: SourceRef;
}

/** header 内不认识的字段（spec §29.1）。 */
export interface UnknownField {
  readonly name: string;
  readonly rawValue: string;
  readonly origin: SourceRef;
}

/** body 内非法的 header 字段（spec §8.13，`L:`/`w:` 除外），不写入正式字段。 */
export interface IgnoredField {
  readonly name: string;
  readonly rawValue: string;
  readonly origin: SourceRef;
}

export interface Score {
  /** 多条 `T:`/`C:`/`I:` 保持有序数组，禁止拼接（spec §8.12）。 */
  readonly titles: readonly string[];
  readonly credits: readonly string[];
  readonly notes: readonly string[];
  readonly refNumber?: number;
  readonly meter?: Meter;
  /** `L:` 无法确定时留空，事件只保留 durationRaw（方案 §7 E1）。 */
  readonly unitLength?: Rational;
  readonly tempo?: Tempo;
  readonly key?: KeySignature;
  readonly voices: readonly Voice[];
  readonly chordShapes: readonly GuitarChord[];
  readonly directives: readonly RawDirective[];
  readonly showFinger?: boolean;
  readonly textBlocks: readonly TextBlock[];
  readonly unknownFields: readonly UnknownField[];
  readonly ignoredFields: readonly IgnoredField[];
  readonly origin: SourceRef;
}
