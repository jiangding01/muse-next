/**
 * notation/staff —— 谱号解析与谱号的谱表参考位置（M2.5 T9b.S，用户裁决 G / M5-S1）。
 *
 * **谱号三态规则的唯一实现**：缺省值与已知谱号集合只在本文件。`resolveStaffClef` 是纯函数、**不发诊断**，
 * 只返回解析结果与状态；`layoutStaff.ts` 按 `status` 发原有的两条诊断，`staffVerticalDemand.ts` 只用 `clef`
 * ——两处对同一个声部必然得到同一个谱号，且诊断只发一次。
 *
 * 只读 `voice.clef`，不解析 `K:` 里的谱号文本（spec §8.7 明写 `K:` 的 clef 不解析）。
 */

import type { StaffClef } from './staffTypes';

/** 缺省谱号：`treble`（**产品决定**——spec 从未规定 `clef` 缺席时的缺省值）。 */
export const DEFAULT_STAFF_CLEF: StaffClef = 'treble';

/**
 * 三态：`declared` = 值落在 `{treble, bass, alto, tenor}`；`absent` = 未声明；`unrecognized` = 其它值（含
 * `standardtab`、`treble+8` 这类 `INFERRED` 写法——能不能出现在 `.jcx` 里本层没有证据），后两者都取缺省谱号。
 */
export type StaffClefResolution =
  | { readonly status: 'declared'; readonly clef: StaffClef }
  | { readonly status: 'absent'; readonly clef: StaffClef }
  | { readonly status: 'unrecognized'; readonly clef: StaffClef; readonly raw: string };

function isKnownClef(value: string): value is StaffClef {
  return value === 'treble' || value === 'bass' || value === 'alto' || value === 'tenor';
}

/** 纯函数：同一输入必得同一结果；不读外部状态、不发诊断。 */
export function resolveStaffClef(clef: string | undefined): StaffClefResolution {
  if (clef === undefined) return { status: 'absent', clef: DEFAULT_STAFF_CLEF };
  if (isKnownClef(clef)) return { status: 'declared', clef };
  return { status: 'unrecognized', clef: DEFAULT_STAFF_CLEF, raw: clef };
}

/**
 * 谱号的第五线（最下一条谱线）所在音高（标准记谱事实，与 VexFlow 的 clef line shift 一致）：
 * treble = E4、bass = G2、alto = F3、tenor = D3。八度号是音高事实、不是尺寸，写在函数体内（不进 metrics 表）。
 */
export function staffClefBottomLine(clef: StaffClef): { readonly letter: 'D' | 'E' | 'F' | 'G'; readonly octave: number } {
  switch (clef) {
    case 'treble':
      return { letter: 'E', octave: 4 };
    case 'bass':
      return { letter: 'G', octave: 2 };
    case 'alto':
      return { letter: 'F', octave: 3 };
    case 'tenor':
      return { letter: 'D', octave: 3 };
  }
}
