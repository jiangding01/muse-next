/**
 * notation/staff —— `Pitch` → `StaffPitch`（M2 T7.1）。
 *
 * 与 `notation/jianpu/pitchToNumber.ts` 同构（八度事实的读取方式照抄，但不 import
 * jianpu 模块——`staff/**` 不得依赖 `jianpu/**`，见 architecture 守卫与本任务约束）：
 * `register` 是字母大小写这个事实，`octaveShift` 是 `'`/`,` 的净位移且只在标记
 * 同方向时才存在，混合方向（如 `C,'`）时 `octaveShift` 整个缺席、`octaveRaw` 非空
 * （spec §14.2，UNVERIFIED，不实现抵消逻辑）。
 *
 * 本文件把同一份 Domain 事实换算成**五线谱语义**——`register` 贡献的基准八度不再是
 * 「差一个八度」这个相对说法，而是 scientific pitch notation 的**绝对八度号**
 * （中央 C 所在八度 = 4）：
 *
 * **`register` 与大小写的对应关系（易错点，务必对照 Domain 实现）**：`register` 的
 * 字面值 `'upper'`/`'lower'` 描述的是「字母本身的大小写」，**不是**「音高的高低」——
 * `src/formats/jcx/parse/body/scanPitch.ts` 里 `register: letterRaw === letterRaw.toUpperCase()
 * ? 'upper' : 'lower'`：**`'upper'` = 大写字母，`'lower'` = 小写字母**。
 *
 * `INFERRED / product decision`（依据 spec §14.1：「大写为较低八度区，小写为其上
 * 一个八度」——这只钉死了「大写比小写低一个八度」这个相对关系，没有钉死绝对八度号）。
 * 本层选择「大写字母（`register: 'upper'`）落在中央 C 所在的八度 4，小写字母
 * （`register: 'lower'`）落在 5」：ABC/JCX 记谱习惯里裸字母（不加任何八度撇号）代表
 * 的正是五线谱高音谱号五线内最常见的中央音域，中央 C 及其上方一个八度正落在这个
 * 范围，因此取「大写字母 = 4，小写字母 = 5」而不是反过来。这是产品决定，不是格式
 * 事实——spec 从未规定五线谱的绝对八度对应，未来若有反例语料应先改 spec 再改本函数。
 */

import type { Accidental, Pitch } from '../../domain';
import type { StaffPitch } from './staffTypes';

/** `octaveRaw` 是否记录了确实存在的八度修饰（parse 层无修饰时给空串，不给 `undefined`）。 */
function hasOctaveMarks(pitch: Pitch): boolean {
  return pitch.octaveRaw !== undefined && pitch.octaveRaw.length > 0;
}

/**
 * `register` 贡献的基准八度（scientific pitch notation，中央 C 所在八度 = 4）。
 *
 * 字面量写在函数体内部而不是顶层常量：`src/notation/**` 的尺寸/数值常量唯一来源是
 * `layout/metrics/**`，八度号不是几何尺寸、不属于 metrics 表的管辖范围，但同样不得
 * 在别处以顶层裸数字常量的形式出现（numeric-guard 只放行函数体内部的字面量）。
 * 大写字母（`register: 'upper'`）= 4，小写字母（`register: 'lower'`）比大写高一个
 * 八度 = 5（spec §14.1 CONFIRMED 的相对关系 + 文件头 INFERRED 的绝对八度号选择）。
 */
function baseOctave(pitch: Pitch): number {
  return pitch.register === 'lower' ? 5 : 4;
}

/**
 * 纯函数：同一 `(pitch, accidental)` 必然得到逐字段相等的结果，不读任何外部状态
 * （尤其不读 `K:`——升降号原样透传，不因调号增删）。
 *
 * `accidental` 是可选的第二参数而不是 `Pitch` 自身的字段：Domain 里升降号挂在
 * `Note.accidental`，与 `Note.pitch` 是同级的兄弟字段，`toStaffPitch` 与
 * `pitchToNumber` 一样在调用处把两者重新拼在一起（同构照抄 `pitchToNumber` 的
 * 签名形状，不 import 该模块）。
 */
export function toStaffPitch(pitch: Pitch, accidental?: Accidental): StaffPitch {
  const mixedOctave = pitch.octaveShift === undefined && hasOctaveMarks(pitch);
  // 混合方向时 `octaveShift` 缺席，只保留 register 的基准八度——不抵消、不求和。
  const octave = baseOctave(pitch) + (pitch.octaveShift ?? 0);
  const base = { letter: pitch.letter, octave, mixedOctave };
  return accidental === undefined ? base : { ...base, accidental };
}
