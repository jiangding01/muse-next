/**
 * renderer/integrations/vexflow —— **Staff renderer-neutral 语义 → VexFlow 编码**的
 * 唯一映射层（M2 T7.4）。
 *
 * 这里是「`notation/staff/**` 零 VexFlow 编码」这条约束的另一端：`staffTypes.ts` 只说
 * 「一个四分音符的 C4 带一个升号」，本文件才说「VexFlow 写作 `c#/4` + `'q'` + 一个
 * `Accidental('#')`」。两边各说一次、只在这里对齐。
 *
 * **本文件不 import vexflow**（纯字符串/字面量映射，可在 node 环境下的 vitest 里直接
 * 测，不需要 DOM，也不需要字体）：VexFlow 的枚举值（`BarlineType.SINGLE` 之类）在这里
 * 只以**名字**的形式出现（`'SINGLE'`），由 `renderStaff.ts` 查一张 `Record<名字, 枚举>`
 * 换成真正的枚举——这样 adapter 的「翻译表」全部可单测，而「拿到枚举」是一行查表。
 *
 * 依据（全部实测自 `node_modules/vexflow@5.0.0` 的 d.ts / esm 源码，不是 v4 教程）：
 * - `Tables.keyProperties` 把 `keys` 里的 `c#/4` 拆成 `pieces[0].toUpperCase()` 去查
 *   `notesInfo`，该表**含** `C#` / `C##` / `CB` / `CBB` / `CN` 六种形态，且它们的
 *   `index`（= 谱线位置）与自然音**相同**、只有 `intVal` 不同。所以升降号写进 key 里
 *   不会挪动符头位置，它只让 VexFlow 知道实际音高；**可见的升降号字形仍必须另外
 *   `addModifier(new Accidental(...))`**——两件事都要做，缺一不可。
 * - `Tables.durations` 的合法键只有 `'1/2' '1' '2' '4' '8' '16' '32' '64' '128' '256'`，
 *   外加别名 `w→1` `h→2` `q→4` `b→256`。本层最细到 128th（`StaffDurationBase` 的上限
 *   就是 `hundredTwentyEighth`），`'256'` 不会出现。
 * - 附点**不进时值码**（不写 `'qd'`——那根本不是合法时值）：由 `Dot.buildAndAttach`
 *   追加，见 `vexTickables.ts`。
 */

import type { Accidental } from '../../../domain';
import type {
  StaffBarlineForm,
  StaffClef,
  StaffDurationBase,
  StaffKeySignature,
  StaffPitch,
  StaffTimeSignature,
} from '../../../notation/staff/staffTypes';

/** VexFlow `Accidental` 构造参数里合法的五个记号（`Tables.accidentals` 的子集，本层只用这五个）。 */
export type VexAccidentalCode = '#' | '##' | 'b' | 'bb' | 'n';

/**
 * `BarlineType` 的**名字**，**按位置分成两个互不相同的子集**（值由 `renderStaff.ts`
 * 查表得到，本文件不 import vexflow）。
 *
 * 实测依据 `node_modules/vexflow/build/esm/src/stave.js`：
 * - `setBegBarType(type)` 只在 `type` 是 `SINGLE` / `REPEAT_BEGIN` / `NONE` 时才生效，
 *   其余取值**被静默忽略**（既不报错也不改变，是最难查的那种 bug）；
 * - `setEndBarType(type)` 只拒绝 `REPEAT_BEGIN`，其余全部接受。
 *
 * 所以**不能**做一张两边复用的 `form → BarlineType` 表：同一个 `repeatBoth` 在行首要
 * 画成 `REPEAT_BEGIN`、在行尾才是 `REPEAT_BOTH`；而 `DOUBLE` / `END` 放到行首会被
 * 悄悄吞掉。两个函数各自只产**该位置合法**的枚举名。
 */
export type VexBeginBarlineTypeName = 'SINGLE' | 'REPEAT_BEGIN' | 'NONE';
export type VexEndBarlineTypeName =
  | 'SINGLE'
  | 'DOUBLE'
  | 'END'
  | 'REPEAT_END'
  | 'REPEAT_BOTH'
  | 'NONE';

/** Domain 升降号 → VexFlow 记号。五个取值一一对应，没有兜底分支（联合类型已穷尽）。 */
const ACCIDENTAL_CODE: Record<Accidental, VexAccidentalCode> = {
  '^': '#',
  '^^': '##',
  _: 'b',
  __: 'bb',
  '=': 'n',
};

export function vexAccidentalCode(accidental: Accidental): VexAccidentalCode {
  return ACCIDENTAL_CODE[accidental];
}

/**
 * `StaffPitch` → VexFlow key（`c/4`、`e_b/4`? 不——`eb/4`）。
 *
 * 形态：**小写音名 + 升降后缀 + `/` + scientific octave**。后缀直接复用
 * `vexAccidentalCode`（`notesInfo` 用的是大写键，而 `keyProperties` 会先 `toUpperCase()`，
 * 所以 `eb/4` 与 `EB/4` 等价；统一写小写，与 VexFlow 文档/测试的惯例一致）。
 *
 * `mixedOctave`（`octaveShift` 缺席但 `octaveRaw` 非空的 UNVERIFIED 情形）在这里**不
 * 参与编码**：`StaffPitch.octave` 已经是 `staffPitch.ts` 按 `register` 定好的最终八度，
 * adapter 不再二次解释一个自己没有证据的事实。
 */
export function vexKey(pitch: StaffPitch): string {
  const accidental = pitch.accidental === undefined ? '' : vexAccidentalCode(pitch.accidental);
  return `${pitch.letter.toLowerCase()}${accidental}/${String(pitch.octave)}`;
}

/** `StaffDurationBase` → VexFlow 时值码（**不含附点**，见文件头）。 */
const DURATION_CODE: Record<StaffDurationBase, string> = {
  breve: '1/2',
  whole: 'w',
  half: 'h',
  quarter: 'q',
  eighth: '8',
  sixteenth: '16',
  thirtySecond: '32',
  sixtyFourth: '64',
  hundredTwentyEighth: '128',
};

export function vexDurationCode(base: StaffDurationBase): string {
  return DURATION_CODE[base];
}

/** 休止的时值码：在音符时值码后加 `'r'`（VexFlow 的 `NoteStruct.duration` 后缀约定）。 */
export function vexRestDurationCode(base: StaffDurationBase): string {
  return `${vexDurationCode(base)}r`;
}

/**
 * 休止符的**定位** key（休止没有音高，但 VexFlow 需要一个 key 决定画在第几线）。
 *
 * 取值是**产品决定**（记谱惯例：休止画在谱表中央那一格/线上），按谱号各给一个：
 * treble 的中央是 B4、bass 是 D3、alto 是 C4、tenor 是 A3。
 */
const REST_KEY: Record<StaffClef, string> = {
  treble: 'b/4',
  bass: 'd/3',
  alto: 'c/4',
  tenor: 'a/3',
};

export function vexRestKey(clef: StaffClef): string {
  return REST_KEY[clef];
}

/**
 * `StaffClef` → VexFlow clef 名。四个名字**恰好同形**，但仍然显式写一张表：两边同形是
 * 巧合不是契约，哪天 `StaffClef` 加一个 `percussion` 也能在这里被类型系统逼着处理。
 */
const CLEF_NAME: Record<StaffClef, string> = {
  treble: 'treble',
  bass: 'bass',
  alto: 'alto',
  tenor: 'tenor',
};

export function vexClefName(clef: StaffClef): string {
  return CLEF_NAME[clef];
}

/**
 * `StaffKeySignature { tonic, alter }` → VexFlow 调号 spec（`'Eb'` / `'F#'` / `'C'`）。
 *
 * `alter` 是**主音自己的升降记号**（`-1`/`0`/`1`），不是调号里升降号的个数——拼接成
 * `tonic + 记号` 正好就是 VexFlow `Tables.keySignatures` 的键名形态。`alter` 不在本层
 * 认识的取值里（重升重降、或将来新编码）时返回 `undefined` = **不画调号**，绝不静默当
 * 自然音（与 `notation/layout/keySpelling.ts` 的 `accidentalFromAlter` 同一裁决）。
 *
 * 返回值仍需经 `VexFlow.hasKeySignature(spec)` 校验才能交给 `Stave.addKeySignature`
 * （见 `renderStaff.ts`）：本函数只保证拼写形态，不保证这个调在 VexFlow 表里存在。
 */
export function vexKeySpec(key: StaffKeySignature): string | undefined {
  if (key.alter === undefined || key.alter === 0) return key.tonic;
  if (key.alter === 1) return `${key.tonic}#`;
  if (key.alter === -1) return `${key.tonic}b`;
  return undefined;
}

/** `StaffTimeSignature` → `'4/4'`（`Stave.addTimeSignature` 的 spec 形态）。 */
export function vexTimeSpec(time: StaffTimeSignature): string {
  return `${String(time.numerator)}/${String(time.denominator)}`;
}

/**
 * `StaffBarlineForm` → **行首**的 `BarlineType` 名（合法集合只有三个）。
 *
 * `repeatStart`（`|:`）与 `repeatBoth`（`::`）在行首都是「反复开始」；`invisible`
 * （`[|]`，只影响分行）→ `NONE`；其余形态（`single` / `double` / `final` / `start` /
 * `dashed` / `unrecognized`）在行首**一律退回 `SINGLE`**——行首位置画不出细双线、终止
 * 线、虚线这些字形（`setBegBarType` 会把它们静默吞掉），画一条普通起始线是能表达
 * 「这里有一条小节线」的最接近的真话。
 */
const BEGIN_BARLINE_TYPE_NAME: Record<StaffBarlineForm, VexBeginBarlineTypeName> = {
  single: 'SINGLE',
  final: 'SINGLE',
  double: 'SINGLE',
  start: 'SINGLE',
  repeatEnd: 'SINGLE',
  repeatStart: 'REPEAT_BEGIN',
  repeatBoth: 'REPEAT_BEGIN',
  dashed: 'SINGLE',
  invisible: 'NONE',
  unrecognized: 'SINGLE',
};

export function vexBeginBarlineTypeName(form: StaffBarlineForm): VexBeginBarlineTypeName {
  return BEGIN_BARLINE_TYPE_NAME[form];
}

/**
 * `StaffBarlineForm` → **行尾**的 `BarlineType` 名。
 *
 * 三处**有意的降级**（VexFlow 5.0.0 的 `BarlineType` 只有 7 个取值，没有对应字形）：
 * - `start`（`[|` 粗 + 细）→ `DOUBLE`（细 + 细）：保留「加重的小节线」的可读性，不假装
 *   画出了粗线；
 * - `dashed`（`[:]` 虚小节线）→ `SINGLE`：VexFlow 没有虚线小节线类型，画实线好过不画；
 * - `repeatStart`（`|:`）落在行尾 → `SINGLE`：`setEndBarType` 明确拒绝 `REPEAT_BEGIN`，
 *   传进去等于什么都没发生，所以这里就退回普通单线，不制造「以为画了其实没画」。
 *
 * `unrecognized` → `SINGLE` 与 `staffTypes.ts` 写明的「画普通单线」一致；
 * `invisible` → `NONE` 不是降级：它本来就不该画出任何东西。
 */
const END_BARLINE_TYPE_NAME: Record<StaffBarlineForm, VexEndBarlineTypeName> = {
  single: 'SINGLE',
  final: 'END',
  double: 'DOUBLE',
  start: 'DOUBLE',
  repeatEnd: 'REPEAT_END',
  repeatStart: 'SINGLE',
  repeatBoth: 'REPEAT_BOTH',
  dashed: 'SINGLE',
  invisible: 'NONE',
  unrecognized: 'SINGLE',
};

export function vexEndBarlineTypeName(form: StaffBarlineForm): VexEndBarlineTypeName {
  return END_BARLINE_TYPE_NAME[form];
}
