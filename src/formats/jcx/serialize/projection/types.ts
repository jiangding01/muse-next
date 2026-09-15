/**
 * L2 语义投影 —— 结果类型（M1.7 T6，方案 v1.1 §6 / §8 拍板 G）。
 *
 * 投影结果是**纯数据**：只有 `string` / `number` / `boolean` / `null` / 数组 /
 * 普通对象，没有 `undefined`、没有 branded id、没有 `SourceRef`。两条理由：
 *
 * 1. `toEqual` 忽略值为 `undefined` 的属性，于是「字段缺失」与「字段存在但为
 *    `undefined`」在断言里无法区分——投影一律把可选字段落成 `null`，差异就不会
 *    被断言悄悄吃掉。
 * 2. 没有 `undefined` 也意味着 `JSON.stringify` 是无损的，`projectionEquals` /
 *    `firstProjectionDifference`（见 `./compare`）可以在纯值上工作。
 *
 * **身份的表达方式**：Domain 的 `EventId` / `VoiceId` / `RelationId` 都是「单次
 * 解析快照内的序号」（`domain/ids.ts`），文本经 canonical 重排后序号必然变化，
 * 直接比较 id 字符串只会比出噪声。因此投影**不删除引用、而是归一化引用**
 * （拍板 G）：每个 `EventId` / `NoteRef` 变成 `(voiceIndex, eventIndex,
 * memberIndex)` 三元组——这是同一条关系在两份文本里都成立的位置事实。
 * 关系自身的 `RelationId`、事件自身的 `EventId`、`VoiceId` 则被删除：它们只是
 * 被引用的锚点，位置已由数组下标表达，留着反而引入序号噪声。
 */

/** 归一化后的事件/音符引用；`memberIndex` 对整事件引用恒为 `null`。 */
export interface ProjectedEventRef {
  readonly voiceIndex: number;
  readonly eventIndex: number;
  readonly memberIndex: number | null;
}

/**
 * 引用指向的 id 在本 `Score` 内找不到对应事件。
 *
 * 这是**可比较的显式值**而不是异常：投影的职责是「把两份 Domain 摆成可比形状」，
 * 悬空引用本身就是要被比出来的差异之一（一边悬空一边不悬空 = 不相等），
 * 抛异常会让整个 round-trip 用例以「崩溃」而不是「不等」的形式失败，丢掉信息。
 */
export interface ProjectedUnresolvedRef {
  readonly unresolved: true;
}

export type ProjectedRef = ProjectedEventRef | ProjectedUnresolvedRef;

export interface ProjectedRational {
  readonly num: number;
  readonly den: number;
}

export interface ProjectedPitch {
  readonly letter: string;
  readonly register: string;
  readonly octaveRaw: string | null;
  readonly octaveShift: number | null;
}

export interface ProjectedNote {
  readonly member: 'note';
  readonly pitch: ProjectedPitch;
  readonly duration: ProjectedRational | null;
  readonly durationRaw: string | null;
  readonly accidental: string | null;
}

export interface ProjectedRest {
  readonly member: 'rest';
  readonly variant: string;
  readonly duration: ProjectedRational | null;
  readonly durationRaw: string | null;
}

export interface ProjectedTabNote {
  readonly member: 'tabNote';
  readonly stringIndex: number;
  readonly fret: number | 'x';
  readonly stroke: string | null;
  readonly duration: ProjectedRational | null;
  readonly durationRaw: string | null;
}

export type ProjectedChordMember = ProjectedNote | ProjectedRest;
export type ProjectedGraceMember = ProjectedNote | ProjectedTabNote;

export interface ProjectedDecoration {
  readonly form: string;
  readonly name: string | null;
  readonly x: number | null;
  readonly y: number | null;
  readonly font: string | null;
  readonly size: number | null;
  readonly payloadRaw: string | null;
  readonly raw: string | null;
}

export interface ProjectedEvent {
  readonly kind: string;
  readonly note: ProjectedNote | ProjectedTabNote | null;
  readonly rest: ProjectedRest | null;
  readonly members: readonly (ProjectedChordMember | ProjectedGraceMember)[] | null;
  readonly duration: ProjectedRational | null;
  readonly stroke: string | null;
  readonly after: boolean | null;
  readonly raw: string | null;
  readonly tokenKind: string | null;
  readonly decoration: ProjectedDecoration | null;
  readonly chordSymbol: {
    readonly raw: string;
    readonly empty: boolean;
    readonly displayOnly: boolean;
  } | null;
}

export interface ProjectedRelation {
  readonly kind: string;
  readonly status: string | null;
  readonly raw: string | null;
  readonly from: ProjectedRef;
  readonly to: ProjectedRef | null;
  readonly p: number | null;
  readonly q: number | null;
  readonly r: number | null;
  readonly members: readonly ProjectedRef[] | null;
}

export interface ProjectedUnitLengthChange {
  readonly beforeEvent: ProjectedRef;
  readonly unitLength: ProjectedRational;
  readonly raw: string;
}

export interface ProjectedLyricSyllable {
  readonly text: string;
  readonly kind: string;
  readonly target: ProjectedRef | null;
  /** 恒为 `0`：行内偏移是源文本排版事实，canonical 会重排，不参与语义比较。 */
  readonly offsetInLine: 0;
}

export interface ProjectedLyricLine {
  readonly verseIndex: number;
  readonly syllables: readonly ProjectedLyricSyllable[];
  readonly bodyRange: {
    readonly first: ProjectedRef;
    readonly last: ProjectedRef;
  } | null;
}

export interface ProjectedVoice {
  readonly name: string | null;
  readonly sname: string | null;
  readonly style: string | null;
  readonly instrument: number | null;
  readonly volume: number | null;
  readonly bracket: number | null;
  readonly brace: number | null;
  readonly staves: number | null;
  readonly space: string | null;
  readonly gchords: boolean | null;
  readonly clef: string | null;
  readonly unknownAttributes: readonly { readonly key: string; readonly value: string }[];
  readonly events: readonly ProjectedEvent[];
  readonly ties: readonly ProjectedRelation[];
  readonly slurs: readonly ProjectedRelation[];
  readonly tuplets: readonly ProjectedRelation[];
  readonly tabRelations: readonly ProjectedRelation[];
  readonly brokenRhythms: readonly ProjectedRelation[];
  readonly unitLengthChanges: readonly ProjectedUnitLengthChange[];
  readonly lyricLines: readonly ProjectedLyricLine[];
}

export interface ProjectedGuitarString {
  readonly state: string;
  readonly fret: number | null;
  readonly finger: number | null;
}

export interface ProjectedGuitarChord {
  readonly name: string;
  readonly capoFret: number;
  readonly strings: readonly ProjectedGuitarString[];
  readonly barres: readonly {
    readonly fret: number;
    readonly fromString: number;
    readonly toString: number;
    readonly finger: number | null;
  }[];
  readonly rawValue: string;
}

export interface ProjectedNamedValue {
  readonly name: string;
  readonly rawValue: string;
}

export interface ProjectedScore {
  readonly titles: readonly string[];
  readonly credits: readonly string[];
  readonly notes: readonly string[];
  readonly refNumber: number | null;
  readonly meter: {
    readonly kind: string;
    readonly num: number | null;
    readonly den: number | null;
    readonly raw: string;
  } | null;
  readonly unitLength: ProjectedRational | null;
  readonly tempo: {
    readonly beat: ProjectedRational | null;
    readonly bpm: number | null;
    readonly raw: string;
  } | null;
  readonly key: {
    readonly tonic: string | null;
    readonly alter: number | null;
    readonly raw: string;
  } | null;
  readonly voices: readonly ProjectedVoice[];
  readonly chordShapes: readonly ProjectedGuitarChord[];
  /** `rawValue` 已按 canonical normalization 做 `trimStart`（方案 §3 / 决策 10）。 */
  readonly directives: readonly ProjectedNamedValue[];
  readonly showFinger: boolean | null;
  readonly textBlocks: readonly {
    readonly lines: readonly string[];
    readonly closed: boolean;
  }[];
  readonly unknownFields: readonly ProjectedNamedValue[];
  readonly ignoredFields: readonly ProjectedNamedValue[];
}
