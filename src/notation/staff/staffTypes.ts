/**
 * notation/staff —— Staff（五线谱）renderer-neutral 语义类型（M2 T7.1）。
 *
 * **本任务定义「Muse Next Staff 是什么」，与 VexFlow 完全无关**：本文件的任何类型、
 * 常量、字符串字面量里都不出现 VexFlow 的编码（如 `c/4`、`q`、`8`、`#`/`b`/`n` 作为
 * 时值/音高/升降号记号、`w`/`h`/`q` 时值码），不 import 也不提及 VexFlow API。
 * 转换到 VexFlow 编码是 T7.4 在 `src/renderer/integrations/vexflow/**` 里做的事。
 *
 * 依赖方向：只 type-only import `../../domain` 与 `../layout` / `../model` 的既有
 * 类型；**不** import `jianpu/**`、`tab/**`、`chord/**`（手动遵守同一条规则）。
 *
 * T7.2 把 `StaffEventNode` / `StaffStaveSpec` / `StaffLayout` 从骨架补成实际契约
 * （构造逻辑在 `staffEventNodes.ts` / `layoutStaff.ts`，本文件仍然只有类型）；
 * T7.3 把 `StaffTie` / `StaffTupletBracket` 从骨架补成实际契约（类型在
 * `staffRelationTypes.ts`，构造在 `staffRelations.ts`）：都**不带 x / y**，跨行按
 * system 拆段。
 */

import type { Accidental, SourceRef, VoiceId } from '../../domain';
import type { MeasureSlice } from '../layout/systems';
import type { SpacedSlot } from '../layout/spacing';
import type { System } from '../layout/primitives';
import type { Anchor, RenderDiagnostic } from '../model/types';
import type { StaffTie, StaffTupletBracket } from './staffRelationTypes';

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
 * 升降号的**显示类别**（renderer-neutral 命名）：用于「要不要画一个可见的升降号」
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
 *   （128th，产品决定，见 `staffDurations.ts`），`exponent` 原样带回 `k`（`base = 2^-k`）；
 * - `unrepresentable`：`decomposeDuration` 本身分解不成立，或输入时值缺失。
 *
 * **⚠️ `undefined` 与分解失败共享 `unrepresentable`**：两者得到同一个
 * `{ kind: 'unrepresentable' }`，从返回值本身**无法**区分。调用方必须在调用
 * `toStaffDuration` **之前**自行检查原始 `duration === undefined`，据此在
 * `durationUnresolved`（缺失）与 `durationUnrepresentable`（分解失败）之间选择，
 * 不得依赖 `StaffDurationResult` 事后反推（`staffEventNodes.ts` 即按此写）。
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
// 布局节点（T7.2：从骨架补成实际契约）。
// ---------------------------------------------------------------------------

/**
 * 降级原因（能确定原因就不要留空，与既有各记谱同一口径）：`unknown` = `UnknownEvent`；
 * `outOfScope` = TAB 专属事件落在 staff 声部；`durationUnresolved` /
 * `durationUnrepresentable` / `durationBeyondGlyphRange` 对应 `toStaffDuration` 的三种
 * 非 `representable` 结果；`decoration` 只画占位；`grace` 倚音不建模专属几何；
 * `chordAllMembersRest` = 和弦块成员**全部**是休止（`[zz]`），没有音头可画但事件不能
 * 凭空消失（C1），整块降级成一个可见占位。
 */
export type StaffFallbackReason =
  | 'unknown'
  | 'outOfScope'
  | 'durationUnresolved'
  | 'durationUnrepresentable'
  | 'durationBeyondGlyphRange'
  | 'decoration'
  | 'grace'
  | 'chordAllMembersRest';

/** 列的几何占位：`slotIndex` 定序，`width` 是该列的宽度需求；**不含最终 glyph x**。 */
export interface StaffSlotGeometry {
  readonly slotIndex: number;
  readonly width: number;
}

/**
 * 所有 Staff 节点共有的字段。**刻意不带 x / y**（与 `TabNode` 的最大差别）：stave 内
 * 音符的绝对 x 由渲染器的 formatter 排（T7.4），本层只承诺次序与列宽需求，详见
 * `StaffStaveSpec`。`anchor` 与诊断共享同一定义（§0d-1）；`sourceRef` 纯透传。
 */
export interface StaffNodeBase {
  readonly anchor: Anchor;
  readonly sourceRef: SourceRef;
  readonly slot: StaffSlotGeometry;
  readonly measureIndex: number;
  readonly systemIndex: number;
  readonly fallback: boolean;
}

/**
 * `pitches` 的一项：音高 + 它的 **Domain 原始成员下标**（单音 `note` 恒为 0，和弦块
 * 取 `members` 的原始下标）。
 *
 * **端点身份显式保存，adapter 不重放筛选规则**（T6.3 已在 `TabFretGlyph.memberIndex`
 * 上裁决过同一件事）：`pitches` 已剔除和弦块里的休止成员（`[zC]` 的 C 原始下标是 1、
 * 数组下标是 0），所以 adapter（T7.4）把关系端点落到渲染器 keys 上时必须写
 * `pitches.findIndex((entry) => entry.memberIndex === endpoint.memberIndex)`，**不得**
 * 自己重放一遍「跳过休止成员」——同一条规则实现两次，两处早晚对不上。
 */
export interface StaffNotePitch {
  readonly memberIndex: number;
  readonly pitch: StaffPitch;
}

/**
 * 音符 / 和弦块：`pitches` 非空（成员里的休止已剔除并发诊断）。`duration` 是**已经
 * 能画出符头**的时值——非 `representable` 的三种结果一律走 `StaffPlaceholderNode`。
 */
export interface StaffNoteNode extends StaffNodeBase {
  readonly kind: 'note';
  readonly pitches: readonly StaffNotePitch[];
  readonly duration: StaffDuration;
}

/** 休止：`variant` 原样透传（`z` / `Z` / `@` 不合并，spec §15.2/§15.3）。 */
export interface StaffRestNode extends StaffNodeBase {
  readonly kind: 'rest';
  readonly variant: 'z' | 'Z' | '@';
  readonly duration: StaffDuration;
}

/** 和弦符号（spec §25）：overlay 列，零宽，不占节奏位置；`text` 已剥掉 JCX 的定界引号。 */
export interface StaffChordSymbolNode extends StaffNodeBase {
  readonly kind: 'chordSymbol';
  readonly text: string;
}

/** 小节线：`raw` 原文 + 归类后的 `form`（表外形态归 `unrecognized`，画普通单线）。 */
export interface StaffBarlineNode extends StaffNodeBase {
  readonly kind: 'barline';
  readonly raw: string;
  readonly form: StaffBarlineForm;
}

/**
 * 可见占位：画不出正规字形时的降级产物，`fallback` 恒为真。`text` 是**原样转述**
 * （音名 + 原始时值文本、装饰原文、未知 token 原文……），不假装是任何一种记谱法。
 */
export interface StaffPlaceholderNode extends StaffNodeBase {
  readonly kind: 'placeholder';
  readonly text: string;
  readonly reason: StaffFallbackReason;
}

/** 一个事件在 Staff 布局里的节点——**每个事件恰好一个**（契约 C1）。 */
export type StaffEventNode =
  | StaffNoteNode
  | StaffRestNode
  | StaffChordSymbolNode
  | StaffBarlineNode
  | StaffPlaceholderNode;

// ---------------------------------------------------------------------------
// 谱表规格（每个 (system, measure) 一条）。
// ---------------------------------------------------------------------------

/** 拍号：`Meter` 的 `fraction` 分支直译；`raw` 分支与缺席一律省略整个字段（adapter 不画拍号）。 */
export interface StaffTimeSignature {
  readonly numerator: number;
  readonly denominator: number;
}

/**
 * 调号：**renderer-neutral**——`tonic` 是音名原文，`alter` 是它自己的升降记号
 * （`-1`/`0`/`1`），**不是**渲染器的调号名，也不是「调号里有几个升降号」。
 */
export interface StaffKeySignature {
  readonly tonic: string;
  readonly alter?: number;
}

/**
 * 一个 (system, measure) 的谱表规格——**adapter 建 stave 的唯一输入**。
 *
 * **横向布局的真源在哪里**（T7.2 裁决，务必照此消费）：`layout/spacing.ts` +
 * `layout/systems.ts` 只负责 measure / system 切分、system 打包、每个 stave 的**目标
 * 宽度**与换行的确定性。`SpacedSlot.slot.x` 是 system packing 的**输入**，**不是**
 * 最终音符 x——stave 内每个音符画在哪里由渲染器的 formatter 决定（T7.4）。故本类型
 * 只承诺 stave 自己的矩形（`x`/`y`/`width`），节点只承诺 `measureIndex` /
 * `systemIndex` / `slotIndex`，**谁都不承诺 glyph x**。
 *
 * `clef` / `keySignature` / `timeSignature` **只出现在每行谱的行首 stave**（五线谱
 * 每行重画谱号调号是记谱惯例，产品决定，不是 JCX 格式事实）。`beginBarline` /
 * `endBarline` 同样是「有就有、没有就省略」：后者存在当且仅当这一小节以一个
 * `BarlineEvent` 收尾，前者存在当且仅当这一小节的**首项**就是小节线（`|: CDE` 的
 * 起始线自成一个 measure）。缺席表示作者没写，**不代表「普通单线」**。
 */
export interface StaffStaveSpec {
  readonly systemIndex: number;
  readonly measureIndex: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly clef?: StaffClef;
  readonly keySignature?: StaffKeySignature;
  readonly timeSignature?: StaffTimeSignature;
  readonly beginBarline?: StaffBarlineForm;
  readonly endBarline?: StaffBarlineForm;
}

// 布局产出。
/**
 * 一个声部在 Staff 记谱下的完整布局产出（`layoutStaff.ts`）。与 `TabLayout` /
 * `JianpuLayout` **互不继承、互不转换**（§2.7）。`diagnostics` 只含**本层新发**的：
 * `durationUnresolved` / `durationUnrepresentable` 已由 `buildRenderScore` 在 event
 * 级发出，本层只产可见占位，不重复报告（§4.2）。
 */
export interface StaffLayout {
  readonly voiceId: VoiceId;
  /** 本声部采用的谱号（`voice.clef` 缺席 / 不可识别时已降级成默认值并发过诊断）。 */
  readonly clef: StaffClef;
  readonly systems: readonly System[];
  readonly measures: readonly MeasureSlice[];
  readonly slots: readonly SpacedSlot[];
  /** 每个 (system, measure) 一条，与 `measures` 同序。 */
  readonly staves: readonly StaffStaveSpec[];
  readonly nodes: readonly StaffEventNode[];
  /** tie 段（跨行已拆段，同一条 relation 的各段共用 `anchor`）。 */
  readonly ties: readonly StaffTie[];
  /** tuplet 括号段（跨行已按 system 拆段，`label` 只在首段）。 */
  readonly tuplets: readonly StaffTupletBracket[];
  readonly width: number;
  readonly height: number;
  readonly diagnostics: readonly RenderDiagnostic[];
}
