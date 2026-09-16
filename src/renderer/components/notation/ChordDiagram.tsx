/**
 * 和弦图（`%%gchord`）。M2 T3 迁移：本文件从 `src/notation/chord/` 迁入
 * `src/renderer/components/notation/`（M2 方案 v1.1.1 §2.2「两处迁移」/ P1-4）——
 * 它是 React 组件，留在 `notation/` 下会让「notation 零 React」这条架构守卫从第一天
 * 起就需要豁免。
 *
 * 组件本身不再手写几何：`layoutChord`（纯数据布局）→ `chordToSvg`（layout → SvgNode）
 * → `SvgTree`（SvgNode → React 元素）。对外 `ChordDiagramProps` 与迁移前基本一致，
 * 只新增一个可选的 `showFinger`——迁移前的组件从未读取过 `Score.showFinger`，M2 才
 * 新接线三态（见 `layoutChord.ts` 文件头）。默认值 `undefined` 与迁移前「有指法就画
 * 数字」的行为完全一致，因此**不传 `showFinger` 时几何与迁移前逐点等价**（真正把
 * `Score.showFinger` 接到这里是 T5 `ScoreView` 的职责，不在 T3 范围内）。
 *
 * - `baseFret` → `capoFret`（legacy 误名，见 `src/domain/score.ts`）；
 * - `strings` 是定长 6 项元组（第六弦 → 第一弦），弦序由数组下标给出；
 * - `barres` 在 M1.6 恒为空数组（spec §10.1 横按记法 UNVERIFIED），本组件不渲染横按。
 */

import { useMemo } from 'react';

import type { GuitarChord } from '../../../domain';
import { chordToSvg } from '../../../notation/chord/toSvg';
import { layoutChord, type ShowFinger } from '../../../notation/chord/layoutChord';
import { createDeterministicTextMeasurer } from '../../../notation/layout/textMeasurer';
import { SvgTree } from './SvgTree';

interface ChordDiagramProps {
  chord: GuitarChord;
  width?: number;
  showFinger?: ShowFinger;
}

/**
 * 生产与测试共用的确定性文本度量实现（M2 方案 §2.8：不接 DOM `measureText`，避免
 * 布局随宿主字体漂移）。模块级常量而非每次渲染重建——它是无状态的纯查表实现，
 * 复用不影响 `layoutChord` 每次调用仍是纯函数。
 */
const TEXT_MEASURER = createDeterministicTextMeasurer();

export function ChordDiagram({ chord, width, showFinger }: ChordDiagramProps) {
  const svgNode = useMemo(
    () =>
      chordToSvg(
        layoutChord(chord, {
          showFinger,
          measurer: TEXT_MEASURER,
          ...(width !== undefined ? { width } : {}),
        }),
      ),
    [chord, showFinger, width],
  );

  return <SvgTree node={svgNode} />;
}
