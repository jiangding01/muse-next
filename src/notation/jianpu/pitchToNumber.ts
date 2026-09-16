/**
 * notation/jianpu —— `Pitch` → 简谱数字 1–7 + 八度点（M2 方案 v1.1.1 §3.2.0 / §3.2，T4）。
 *
 * **两条证据前提，等级不同，不得合写成一个 `CONFIRMED`**（§3.2.0）：
 *
 * - **P1b（`CONFIRMED`，corpus 9/9）**：`style=jianpu` 声部的正文**仍然是 ABC 字母
 *   记谱**，语料中未观察到任何用数字 1–7 记谱的正文。所以本文件的输入是 `Pitch`
 *   （字母 + 大小写 register + 八度撇号/逗号），转换完全是渲染层的事。
 * - **P1（`CONFIRMED BY DOCUMENTATION`，来源 faq，spec 原文注明为转述）**：简谱模式下
 *   音名**固定按 C 大调对应数字，`C` 对应 do（1），不随调式变化**。
 *
 * 由 P1 推出的硬规则，**不得为了「看起来更像常见简谱实现」而改**：
 *
 * - 映射固定 `C=1 D=2 E=3 F=4 G=5 A=6 B=7`，**与 `K:` 完全无关**——常见简谱实现会按
 *   调号做首调移位（`K:G` 时 G→1），本项目**明确不这样做**，那与 §12.6.3 的结论直接
 *   冲突。将来若拿到反例语料，先改 spec 并给出证据，而不是在渲染层「修正」。
 * - 因此本文件**不接受 `KeySignature` 参数**，连拿都拿不到，从类型上断掉移位的可能。
 * - `accidental` **原样透传**：不做小节内临时记号延续推断（Domain 明确未做），
 *   也不因调号的 `alter` 增删升降号（前提 P3）。
 *
 * 八度点（§14.1 / §14.2，`CONFIRMED`）：
 *
 * - `register` 是**字母大小写**这个事实：小写（`c`）比大写（`C`）高一个八度；
 * - `octaveShift` 是 `'` / `,` 的净位移，**只在标记同方向时才存在**；
 * - **混合方向**（`C,'`，U23）：`octaveShift` 整个缺席而 `octaveRaw` 非空 → 只按
 *   `register` 画基准八度并发一条诊断，**不实现抵消逻辑**（spec §14.2 明文裁决）。
 */

import type { Accidental, Pitch, PitchLetter } from '../../domain';

/** 简谱数字：固定 1–7，**不含 0**（`0` 是休止符，见 `layoutJianpu.ts`）。 */
export type JianpuNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 八度点画在数字上方还是下方；`dots === 0` 时没有方向可言，故用 `undefined` 表达。 */
export type OctaveDotDirection = 'above' | 'below';

export interface JianpuPitch {
  readonly number: JianpuNumber;
  /** 原样透传，不做任何推断（前提 P3）。 */
  readonly accidental?: Accidental;
  /** 八度点个数（≥ 0）。 */
  readonly octaveDots: number;
  readonly octaveDotDirection?: OctaveDotDirection;
  /**
   * 是否走了「混合方向八度」的保守降级（U23）：`octaveShift` 缺席而 `octaveRaw` 非空。
   * 为真时 `octaveDots` 只反映 `register`，调用方须发
   * `muse.render.jianpu.octave-mixed` 诊断（C2：降级节点至少一条诊断）。
   */
  readonly mixedOctave: boolean;
}

/**
 * 固定 C 大调映射（前提 P1）。
 *
 * 写成 `switch` 而不是一张常量表，是为了让 `PitchLetter` 的穷尽性在编译期被检查：
 * Domain 若将来扩了字母，这里会直接编译不过，而不是在运行时静默落到某个兜底值。
 */
export function pitchLetterToNumber(letter: PitchLetter): JianpuNumber {
  switch (letter) {
    case 'C':
      return 1;
    case 'D':
      return 2;
    case 'E':
      return 3;
    case 'F':
      return 4;
    case 'G':
      return 5;
    case 'A':
      return 6;
    case 'B':
      return 7;
    default: {
      const exhaustive: never = letter;
      return exhaustive;
    }
  }
}

/**
 * `register` 贡献的基准八度：小写字母高一个八度（spec §14.1）。
 *
 * 这不是「推断」，而是 Domain 已经把大小写事实归一化进 `register` 后的直接读取。
 */
function registerShift(pitch: Pitch): number {
  return pitch.register === 'lower' ? 1 : 0;
}

/** `octaveRaw` 是否记录了确实存在的八度修饰（parse 层无修饰时给空串，不给 `undefined`）。 */
function hasOctaveMarks(pitch: Pitch): boolean {
  return pitch.octaveRaw !== undefined && pitch.octaveRaw.length > 0;
}

/**
 * 纯函数：同一 `(pitch, accidental)` 必然得到逐字段相等的结果，不读任何外部状态，
 * 尤其**不读 `K:`**（前提 P1）。
 */
export function pitchToNumber(pitch: Pitch, accidental?: Accidental): JianpuPitch {
  const mixedOctave = pitch.octaveShift === undefined && hasOctaveMarks(pitch);
  // 混合方向时 `octaveShift` 缺席，只保留 register 的基准八度——**不抵消、不求和**。
  const shift = registerShift(pitch) + (pitch.octaveShift ?? 0);
  const octaveDots = Math.abs(shift);
  const base = {
    number: pitchLetterToNumber(pitch.letter),
    octaveDots,
    mixedOctave,
  };
  const direction: OctaveDotDirection = shift > 0 ? 'above' : 'below';
  const withDirection = shift === 0 ? base : { ...base, octaveDotDirection: direction };
  return accidental === undefined ? withDirection : { ...withDirection, accidental };
}
