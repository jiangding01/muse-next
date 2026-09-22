/**
 * M2 T8.1 —— 渲染矩阵的**合成用例表**（从 `render.matrix.test.ts` 拆出，只为行数预算；
 * 断言仍全部在测试文件里，覆盖表与口径仍在 `renderMatrix.helpers.ts` 的文件头）。
 *
 * **全部是最小 JCX 字符串，不用任何真实语料**：文件名 / 标题 / 歌词 / 本地路径一律
 * 不出现，真实语料只在需要时以 `corpus#NN` 形式引用（本文件不需要引用任何一条）。
 */

import { RENDER_DIAGNOSTIC_CODES } from '../../../src/notation/model/diagnostics';

const HEAD_4_4 = 'M:4/4\nL:1/4\nK:C';
const HEAD_1_8 = 'M:4/4\nL:1/8\nK:C';
const STAFF_VOICE = 'V:1 style=staff clef=treble';
const TAB_VOICE = 'V:1 style=tab clef=standardtab';

export function jcx(head: string, voice: string, body: string): string {
  return `%MUSE2\nX:1\n${head}\n${voice}\n${body}\n`;
}

export const MATRIX_CASES: readonly (readonly [string, string])[] = [
  ['unknown 事件', jcx(HEAD_4_4, STAFF_VOICE, 'C?D|')],
  ['tab 事件（落入 jianpu/staff）', jcx(HEAD_1_8, TAB_VOICE, '[V:1]a1 b2 c10 |')],
  ['pitch 事件（落入 tab）', jcx(HEAD_4_4, STAFF_VOICE, 'CDE|')],
  ['grace（TabNote 成员）', jcx(HEAD_1_8, TAB_VOICE, '[V:1]{b11}b12 |')],
  ['grace（Note 成员）', jcx(HEAD_1_8, STAFF_VOICE, '{G}A2|')],
  ['decoration', jcx(HEAD_4_4, STAFF_VOICE, '!TRILL!C !st!D|')],
  ['全 Rest chord', jcx(HEAD_4_4, STAFF_VOICE, '[zz] C|')],
  ['duration undefined（L: 不可知）', jcx('K:C', STAFF_VOICE, 'CDE|')],
  ['duration 1/3', jcx('M:4/4\nL:1/3\nK:C', STAFF_VOICE, 'CDE|')],
  ['duration 1/512', jcx('M:4/4\nL:1/512\nK:C', STAFF_VOICE, 'CDE|')],
  ['duration 2/1', jcx(HEAD_4_4, STAFF_VOICE, 'C8 D8|')],
  ['Z / @ 休止', jcx(HEAD_4_4, STAFF_VOICE, 'Z2 @2 z2|')],
  ['unresolved tie', jcx(HEAD_4_4, STAFF_VOICE, 'C-|')],
  ['tuplet q=0', jcx(HEAD_1_8, STAFF_VOICE, '(3:0:3CDE|')],
  ['clef 缺席', jcx(HEAD_4_4, 'V:1 style=staff', 'CDE|')],
  ['clef 已知', jcx(HEAD_4_4, 'V:1 style=staff clef=bass', 'CDE|')],
  ['clef 未知', jcx(HEAD_4_4, 'V:1 style=staff clef=hexagram', 'CDE|')],
  ['M: raw', jcx('M:C\nL:1/4\nK:C', STAFF_VOICE, 'CDE|')],
  ['K: 缺席', jcx('M:4/4\nL:1/4', STAFF_VOICE, 'CDE|')],
  ['K:Eb', jcx('M:4/4\nL:1/4\nK:Eb', STAFF_VOICE, 'CDE|')],
  ['K:Dm', jcx('M:4/4\nL:1/4\nK:Dm', STAFF_VOICE, 'CDE|')],
  ['chordSymbol 在段末', jcx(HEAD_4_4, STAFF_VOICE, 'CDE "G"')],
  ['歌词 overlay（jianpu lyrics 是 voice anchor）', jcx(HEAD_4_4, 'V:1 style=jianpu', 'CDEF|\nw: la li lu la')],
  ['tab stroke overlay（event anchor）', jcx(HEAD_1_8, TAB_VOICE, '[V:1]Va1 Ub2 Ha3 |')],
  ['跨行 tie（窄宽度拆段）', jcx(HEAD_4_4, STAFF_VOICE, 'CDEF|GABc|CDEF|GAB-|c4|')],
];

/** D12：`style` 缺席 / 未知——声部级 fallback summary，没有 layout、没有 fallback node。 */
export const D12_CASES: readonly (readonly [string, string, string])[] = [
  ['style 缺席', jcx(HEAD_4_4, 'V:1', 'CDE|'), RENDER_DIAGNOSTIC_CODES.voiceStyleAbsent],
  ['style 未知', jcx(HEAD_4_4, 'V:1 style=hexagram', 'CDE|'), RENDER_DIAGNOSTIC_CODES.voiceStyleUnknown],
];

/** document chord matrix 的合成源：capo=1（nut 线）、capo>1（`{n}fr` 标签 + 禁弹 X）、showFinger=0。 */
export const CHORD_SOURCES: readonly (readonly [string, string])[] = [
  ['capo=1 + 指法号', `%MUSE2\n%%gchord G=1;3(3),2(2),0,0,0,3(4)\nX:1\n${HEAD_4_4}\n${STAFF_VOICE}\nCDE|\n`],
  ['capo>1 + 禁弹 X', `%MUSE2\n%%gchord Cm=5;X,8(1),10(3),10(4),9(2),8(1)\nX:1\n${HEAD_4_4}\n${STAFF_VOICE}\nCDE|\n`],
  ['showFinger=0', `%MUSE2\n%%showfinger 0\n%%gchord Em=1;0,2(2),2(3),0,0,0\nX:1\n${HEAD_4_4}\n${STAFF_VOICE}\nCDE|\n`],
];

/** dangling relation 端点用例的基底：一条 resolved tie，随后由测试剪掉它的 `to` 端点。 */
export const DANGLING_SOURCE = jcx(HEAD_4_4, STAFF_VOICE, 'C-C D|');

/** 确定性用例：一口气塞满 decoration / unknown / 全休止和弦 / tuplet / Z / @ / 和弦符号 / 跨行 tie。 */
export const DETERMINISM_SOURCE = jcx(HEAD_1_8, STAFF_VOICE, '!TRILL!C?D [zz] (3:0:3EFG Z2 @2 "Am"c4-|c4|');
