/**
 * renderer/integrations/vexflow —— 一个 `(system, staff 声部)` 的绘制输入（M2.5 T9b，用户裁决 H / I / 6）。
 *
 * **纯类型，不 import vexflow**：组装层（`components/notation/systemSlices.ts`）先从 T8 的 `StaffLayout` 切出这一段，
 * adapter（`renderStaff.ts`）只负责画，不再拿整份 layout 查 system、不重新拆关系。
 *
 * - `staves` 已平移到层内坐标：`x − 层 box.origin.x`、`y − 层 box.origin.y`（T9b.S 起 = 该行的 Staff 上内缩
 *   `topExtra`，由 notation 层算好；本层不重新计算纵向需求）；
 * - `nodes` 只含本 system 且已去掉 `chordSymbol`（systemized renderer 不画任何声部内和弦符号）；
 * - `ties` / `tuplets` 是 notation 层已按 system 拆好的段，原样筛选；
 * - `width` / `height` = 该层 box 的宽高（viewBox `0 0 width height`）；
 * - `timeSignature` 沿用旧 `renderStaff` 的语义：**整份 StaffLayout** 第一条带拍号的 stave（只用于构造 `Voice`），
 *   不按本 system 重新查找。
 */

import type { VoiceId } from '../../../domain';
import type { StaffTie, StaffTupletBracket } from '../../../notation/staff/staffRelationTypes';
import type { StaffClef, StaffEventNode, StaffStaveSpec, StaffTimeSignature } from '../../../notation/staff/staffTypes';

export interface StaffSystemSlice {
  readonly voiceId: VoiceId;
  readonly systemIndex: number;
  readonly clef: StaffClef;
  readonly width: number;
  readonly height: number;
  readonly timeSignature?: StaffTimeSignature;
  readonly staves: readonly StaffStaveSpec[];
  readonly nodes: readonly StaffEventNode[];
  readonly ties: readonly StaffTie[];
  readonly tuplets: readonly StaffTupletBracket[];
}
