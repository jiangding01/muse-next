/**
 * notation/staff —— Staff（五线谱）renderer-neutral 语义类型（M2 T7.1）。
 *
 * **本任务定义「Muse Next Staff 是什么」，与 VexFlow 完全无关**：本文件的任何类型、
 * 常量、字符串字面量里都不出现 VexFlow 的编码（如 `c/4`、`q`、`8`、`#`/`b`/`n` 作为
 * 时值/音高/升降号记号、`w`/`h`/`q` 时值码），不 import 也不提及 VexFlow API。
 * 转换到 VexFlow 编码是 T7.4 在 `src/renderer/integrations/vexflow/**` 里做的事。
 *
 * 依赖方向：只 type-only import `../../domain`；**不** import `jianpu/**`、
 * `tab/**`、`chord/**`（守卫见 architecture 测试，本文件手动遵守同一条规则）。
 *
 * 本文件里 `StaffEventNode` / `StaffStaveSpec` / `StaffTie` / `StaffTupletBracket` /
 * `StaffLayout` 只是**类型骨架 + JSDoc**——具体产出这些值的算法（`layoutStaff.ts`
 * 等）是后续任务（T7.2+）的事，本任务只把字段语义钉死，不写任何构造逻辑。
 */

import type { Accidental, EventId, RelationId, VoiceId } from '../../domain';

// ---------------------------------------------------------------------------
// 谱号 / 音高 / 时值——本任务的核心产出，`staffPitch.ts` / `staffDurations.ts` 消费。
// ---------------------------------------------------------------------------

/** 谱号：G/F/C 谱号的四种常见位置（renderer-neutral 命名，不借用 VexFlow 的 clef 字符串）。 */
export type StaffClef = 'treble' | 'bass' | 'alto' | 'tenor';

/**
 * Staff 语义下的音高：scientific pitch notation 的八度编号（中央 C 所在八度 = 4），
 * 与 Domain `Pitch` 的 `register` / `octaveRaw` / `octaveShift` 解耦——`toStaffPitch`
 * 是两者之间唯一的转换点（见 `staffPitch.ts`）。
 */
export interface StaffPitch {
  readonly letter: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G';
  /** scientific octave；中央 C 所在八度 = 4。 */
  readonly octave: number;
  /** Domain 升降号原样透传（type-only import 自 `src/domain`），本层不做拼写/enharmonic 归一化。 */
  readonly accidental?: Accidental;
  /** `octaveShift` 缺席但 `octaveRaw` 非空（混合方向 UNVERIFIED，spec §14.2）：只按 `register` 定基准八度。 */
  readonly mixedOctave: boolean;
}

/**
 * Staff 语义下的升降号**显示类别**——renderer-neutral 命名，不是 VexFlow 的
 * `'#'`/`'b'`/`'n'` 单字符记号。用于「这个音符要不要画一个可见的升降号符号」
 * 这类展示判断（如同一小节内是否已出现过），不参与音高计算。
 */
export type StaffAccidentalDisplay = 'sharp' | 'doubleSharp' | 'flat' | 'doubleFlat' | 'natural';

export type StaffDurationBase =
  | 'breve'
  | 'whole'
  | 'half'
  | 'quarter'
  | 'eighth'
  | 'sixteenth'
  | 'thirtySecond'
  | 'sixtyFourth'
  | 'hundredTwentyEighth';

/** 分解成功的时值：`base` + 附点个数，renderer-neutral 命名（不是 VexFlow 的 `'w'`/`'h'`/`'q'` 时值码）。 */
export interface StaffDuration {
  readonly base: StaffDurationBase;
  readonly dots: 0 | 1 | 2;
}

/**
 * `toStaffDuration` 的返回形状——判别联合，覆盖三种互斥结果：
 * - `representable`：能画出具体的符头/附点组合；
 * - `beyondGlyphRange`：`decomposeDuration` 能分解，但细过本层的 glyph 范围上限
 *   （128th 分音符，产品决定，见 `staffDurations.ts`），`exponent` 原样带回
 *   `decomposeDuration` 给出的 `k`（`base = 2^-k`）供诊断消息使用；
 * - `unrepresentable`：`decomposeDuration` 本身分解不成立，或输入时值缺失。
 *
 * **⚠️ `undefined` 与分解失败共享 `unrepresentable`**：本类型没有单独的「时值缺失」
 * 分支——`toStaffDuration(undefined)` 与 `toStaffDuration(<不可分解的 Rational>)`
 * 得到的是同一个 `{ kind: 'unrepresentable' }`，从这个返回值本身**无法**区分两者。
 * 调用方（构造 `StaffEventNode.fallbackReason` 的算法）必须在调用 `toStaffDuration`
 * **之前**自行检查原始 `duration === undefined`，据此在 `durationUnresolved`
 * （缺失）与 `durationUnrepresentable`（分解失败）两条诊断 code 之间做选择——
 * 不得依赖 `StaffDurationResult` 事后反推。
 */
export type StaffDurationResult =
  | { readonly kind: 'representable'; readonly duration: StaffDuration }
  | { readonly kind: 'beyondGlyphRange'; readonly exponent: number }
  | { readonly kind: 'unrepresentable' };

// ---------------------------------------------------------------------------
// 小节线——renderer-neutral 命名，覆盖 spec §18 的已知形态表 + 一个 unrecognized 兜底。
// ---------------------------------------------------------------------------

export type StaffBarlineForm =
  /** `|` 普通小节线。 */
  | 'single'
  /** `|]` 终止线（细 + 粗）。 */
  | 'final'
  /** `||` 细双线。 */
  | 'double'
  /** `[|` 起始线（粗 + 细）。 */
  | 'start'
  /** `:|` 右反复。 */
  | 'repeatEnd'
  /** `|:` 左反复。 */
  | 'repeatStart'
  /** `::` 双反复。 */
  | 'repeatBoth'
  /** `[:]` 虚小节线。 */
  | 'dashed'
  /** `[|]` 不可见小节线（仅影响分行）。 */
  | 'invisible'
  /** 不在已知形态表内：画普通单线，同时发 `staffClefUnrecognized` 类比的 barline 诊断（由调用方决定用哪条既有 code）。 */
  | 'unrecognized';

// ---------------------------------------------------------------------------
// 布局节点骨架（T7.2+ 填充逻辑，本任务只钉字段语义）。
// ---------------------------------------------------------------------------

/**
 * 降级原因：与既有各记谱的 fallback 语义保持同一套判断口径（能确定原因就不要留空）。
 * - `unknown`：`UnknownEvent`；
 * - `outOfScope`：TAB 专属事件落在了 staff 声部（`staffEventOutOfScope`）；
 * - `durationUnresolved` / `durationUnrepresentable` / `durationBeyondGlyphRange`：
 *   对应 `toStaffDuration` 的三种非 `representable` 结果；
 * - `decoration`：`DecorationEvent`，只画占位；
 * - `grace`：倚音，`staffGraceNotModeled`（本任务只发诊断，不建模倚音专属几何）。
 */
export type StaffFallbackReason =
  | 'unknown'
  | 'outOfScope'
  | 'durationUnresolved'
  | 'durationUnrepresentable'
  | 'durationBeyondGlyphRange'
  | 'decoration'
  | 'grace';

/**
 * 单个音符列在 system 内的几何占位——**是 system packing 的输入，不是最终 glyph x**：
 * `slotIndex` 定序，`width` 参与 `spacing.ts` 式的列宽累加，真正落到 `<svg>` 上的
 * x 坐标由布局算法（T7.2+）二次计算，本类型不直接携带最终坐标。
 */
export interface StaffSlotGeometry {
  readonly slotIndex: number;
  readonly width: number;
}

/**
 * 一个事件在 Staff 布局里的节点骨架。
 *
 * `pitches` 为空数组表示这不是音高事件（休止/小节线/装饰等），非空时可能不止一个
 * （和弦块）。`fallback` 为真时 `fallbackReason` 必须存在——本任务只声明这条约束，
 * 不写运行时校验（那是构造该值的算法自己的职责）。
 */
export interface StaffEventNode {
  readonly eventId: EventId;
  readonly slot: StaffSlotGeometry;
  readonly pitches: readonly StaffPitch[];
  readonly duration: StaffDurationResult;
  readonly fallback: boolean;
  readonly fallbackReason?: StaffFallbackReason;
}

/** 一行谱的谱表规格：谱号 + 固定线数（`STAFF_METRICS.lineCount`，本类型不重复携带这个格式事实）。 */
export interface StaffStaveSpec {
  readonly clef: StaffClef;
}

/**
 * tie（连音线）在 Staff 布局里的骨架。
 *
 * `segment` 区分「完整画在一行内」还是「跨行谱续行的哪一半」：
 * - `whole`：起止都在同一行谱内，画一条完整弧；
 * - `start`：本行谱只画到 tie 的起点，弧延伸到下一行谱；
 * - `end`：本行谱只画 tie 落到本行谱内的终点那一半。
 *
 * `status` 原样透传 Domain `Tie.status`（`resolved` / `unresolved`），`unresolved`
 * 画半开弧（悬空端），同 jianpu/tab 既有约定。
 */
export interface StaffTie {
  readonly relationId: RelationId;
  readonly segment: 'whole' | 'start' | 'end';
  readonly status: 'resolved' | 'unresolved';
}

/**
 * tuplet 括号骨架——**只带 `label` 与 `status`，不带时值缩放**（M2 不按 `p`/`q`
 * 推算 effective duration，`q === 0` 语义 UNVERIFIED，见 `model/duration.ts`）。
 * `status: 'incomplete'` 时括号按已有成员范围画，缺失端不补，同既有约定。
 */
export interface StaffTupletBracket {
  readonly relationId: RelationId;
  readonly label: string;
  readonly status: 'complete' | 'incomplete';
}

/** 一个声部在 Staff 记谱下的完整布局产出骨架（T7.2+ 填充）。 */
export interface StaffLayout {
  readonly voiceId: VoiceId;
  readonly stave: StaffStaveSpec;
  readonly events: readonly StaffEventNode[];
  readonly ties: readonly StaffTie[];
  readonly tuplets: readonly StaffTupletBracket[];
}
