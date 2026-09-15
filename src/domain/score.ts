/**
 * Domain —— 乐谱聚合根（M1.6 方案 v1.1 §1.4）。
 *
 * 所有字段要么是 AST 事实，要么是方案 §1.7 列明依据的派生值；
 * 未验证语义（`play` / `Z` 多小节 / `@` 隐藏）不得在此固化为字段。
 */

import type { Rational } from './rational';
import type { SourceRef } from './sourceRef';
import type { Voice } from './voice';

/** spec §8.4 语料形态：`<整数>/<整数>`。 */
export interface FractionMeter {
  readonly kind: 'fraction';
  readonly num: number;
  readonly den: number;
  readonly raw: string;
}

/**
 * spec §8.4：`M:C` / `M:C|`（DOC-ONLY）与 `M:none` / 复合拍号（UNVERIFIED）
 * **不换算**，只保留 raw。
 */
export interface RawMeter {
  readonly kind: 'raw';
  readonly raw: string;
}

/**
 * 判别联合而非「num/den 可选」：后者允许 `{ num: 4, den: undefined }` 这种
 * 半解析状态存在，调用方必须逐字段判空；`kind` 一次判别即可收窄。
 */
export type Meter = FractionMeter | RawMeter;

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

/**
 * `%%` 指令原样保留（spec §10.8）。
 *
 * 与 `chordShapes` 的分工（方案 v1.1 §1.7，T9 实现时遵守）：
 * `Score.directives` **永久保留全部指令**，包括每一条 `%%gchord` 的原文——
 * 它是「事实」层，序列化回写只认它；`chordShapes` 是「派生」层，只对能成功
 * 解析的 gchord 额外生成结构化对象。形态不合法（如项数 ≠ 6，§10.1 INFERRED）
 * 的 gchord 不构造 `GuitarChord`，只留在 `directives` 里并发 warning，
 * 于是「解析失败」永远不等于「原文丢失」。
 */
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
  /** 派生层：只含解析成功的 gchord；malformed 的只留在 `directives`（见 `RawDirective` 注释）。 */
  readonly chordShapes: readonly GuitarChord[];
  /** 事实层：全部 `%%` 指令原文，含已进入 `chordShapes` 的那些。 */
  readonly directives: readonly RawDirective[];
  readonly showFinger?: boolean;
  readonly textBlocks: readonly TextBlock[];
  readonly unknownFields: readonly UnknownField[];
  readonly ignoredFields: readonly IgnoredField[];
  readonly origin: SourceRef;
}
