/**
 * M2.5 T8 —— `system/verticalLayout.ts`：纯纵向堆叠与 box（用户裁决 B / E / F / G / I）。
 *
 * 只喂合成需求（不经任何 layout）：和弦带高、层 top 递推与 `layerGap`、fallback 0 高不计 gap、`systemGap` 在 box 外、
 * 按 systemIndex 升序堆叠、box 横向包含和弦墨迹（左界量化到 tick 网格、rebase 逐位还原）、overlay 块顶底对齐。
 */
import { describe, expect, it } from 'vitest';

import { voiceId } from '../../../src/domain';
import { SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import type { ChordOverlayFootprint } from '../../../src/notation/system/chordOverlay';
import type { VoiceLayerNotation } from '../../../src/notation/system/contracts';
import { chordBandHeight, overlayTop, stackSystems } from '../../../src/notation/system/verticalLayout';
import type { LayerDemand, SystemDemand } from '../../../src/notation/system/verticalLayout';

const { layerGap, systemGap, chordBandGap, geometryQuantum } = SYSTEM_METRICS;

const layer = (n: number, notation: VoiceLayerNotation, height: number): LayerDemand => ({ voiceId: voiceId(n), notation, height });
const chord = (left: number, right: number, height: number): ChordOverlayFootprint => ({ left, right, height });

function demand(
  systemIndex: number,
  layers: readonly LayerDemand[],
  chords: readonly ChordOverlayFootprint[] = [],
  width = 400,
): SystemDemand {
  return { systemIndex, width, layers, chords };
}

function only(demands: readonly SystemDemand[]): ReturnType<typeof stackSystems>[number] {
  const [frame] = stackSystems(demands);
  if (frame === undefined) throw new Error('no frame');
  return frame;
}

describe('T8 verticalLayout —— 和弦带与 overlay 块顶（§Q5.3 / F-11 / 裁决 E）', () => {
  it('无和弦 → 带高 0（不留 gap）；有和弦 → max(height) + chordBandGap（不是 sum / 首项）', () => {
    expect(chordBandHeight([])).toBe(0);
    expect(chordBandHeight([chord(0, 10, 20), chord(20, 30, 124), chord(40, 50, 60)])).toBe(124 + chordBandGap);
    expect(chordBandHeight([chord(0, 10, 17)])).toBe(17 + chordBandGap);
  });

  it('overlay y = 块顶，块底对齐带底：y + height === bandHeight − chordBandGap', () => {
    const band = chordBandHeight([chord(0, 10, 124), chord(20, 30, 18)]);
    expect(overlayTop(band, 124)).toBe(0);
    expect(overlayTop(band, 18)).toBe(band - chordBandGap - 18);
    expect(overlayTop(band, 18) + 18).toBe(band - chordBandGap);
  });

  it('第一层 top = 带高（带在全部层之上）；无和弦时第一层 top = 0', () => {
    const withChord = only([demand(0, [layer(1, 'tab', 92)], [chord(0, 10, 40)])]);
    expect(withChord.bandHeight).toBe(40 + chordBandGap);
    expect(withChord.layers[0]?.top).toBe(40 + chordBandGap);
    expect(withChord.box.height).toBe(40 + chordBandGap + 92);
    expect(only([demand(0, [layer(1, 'tab', 92)])]).layers[0]?.top).toBe(0);
  });
});

describe('T8 verticalLayout —— 层栈（裁决 B / I）', () => {
  it('层 top 逐层递推，layerGap 只在相邻两层之间；box 高 = 带 + Σ层高 + gap × (n − 1)', () => {
    const frame = only([demand(0, [layer(1, 'jianpu', 112), layer(2, 'tab', 96), layer(3, 'staff', 96)])]);
    expect(frame.layers.map((l) => [l.voiceId, l.notation, l.layerIndex, l.top, l.height])).toEqual([
      [voiceId(1), 'jianpu', 0, 0, 112],
      [voiceId(2), 'tab', 1, 112 + layerGap, 96],
      [voiceId(3), 'staff', 2, 112 + layerGap + 96 + layerGap, 96],
    ]);
    expect(frame.box.height).toBe(112 + 96 + 96 + 2 * layerGap);
  });

  it('fallback 层高 0、不计 layerGap（首 / 中 / 尾三个位置）；layerIndex 连续含 fallback', () => {
    const layers = [layer(7, 'fallback', 0), layer(1, 'jianpu', 64), layer(8, 'fallback', 0), layer(2, 'tab', 92), layer(9, 'fallback', 0)];
    const frame = only([demand(0, layers)]);
    expect(frame.layers.map((l) => [l.layerIndex, l.top, l.height])).toEqual([
      [0, 0, 0],
      [1, 0, 64],
      [2, 64, 0],
      [3, 64 + layerGap, 92],
      [4, 64 + layerGap + 92, 0],
    ]);
    expect(frame.box.height).toBe(64 + layerGap + 92);
  });

  it('fallback 即使带了非零高度也按 0 处理；全 fallback 的 system 高 0', () => {
    const frame = only([demand(0, [layer(9, 'fallback', 50)])]);
    expect(frame.layers[0]?.height).toBe(0);
    expect(frame.box.height).toBe(0);
  });

  it('已知记谱层原样采用需求高度（空层的基础高度由 prepass 给出，这里不省略、不改写）', () => {
    const frame = only([demand(0, [layer(1, 'jianpu', 64), layer(2, 'tab', 92)])]);
    expect(frame.layers).toHaveLength(2);
    expect(frame.layers[1]?.height).toBe(92);
  });
});

describe('T8 verticalLayout —— system 纵向堆叠（裁决 G）', () => {
  it('y 从 0 起，systemGap 只在相邻 system 之间、不计入 box；全 fallback system 仍加 gap', () => {
    const frames = stackSystems([
      demand(0, [layer(1, 'jianpu', 64)], [chord(0, 10, 30)]),
      demand(1, [layer(9, 'fallback', 0)]),
      demand(2, [layer(2, 'tab', 92)]),
    ]);
    const first = 30 + chordBandGap + 64;
    expect(frames.map((f) => [f.systemIndex, f.box.origin.y, f.box.height])).toEqual([
      [0, 0, first],
      [1, first + systemGap, 0],
      [2, first + systemGap + 0 + systemGap, 92],
    ]);
  });

  it('按 systemIndex 升序堆叠，不依赖输入顺序；不改输入数组', () => {
    const input = [demand(2, [layer(3, 'tab', 92)]), demand(0, [layer(1, 'tab', 100)]), demand(1, [layer(2, 'tab', 50)])];
    const snapshot = JSON.stringify(input);
    const frames = stackSystems(input);
    expect(frames.map((f) => f.systemIndex)).toEqual([0, 1, 2]);
    expect(frames.map((f) => f.box.origin.y)).toEqual([0, 100 + systemGap, 100 + systemGap + 50 + systemGap]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('T8 verticalLayout —— box 横向包含和弦墨迹（裁决 F）', () => {
  it('无溢出：origin.x 恰为 +0、dx 恰为 +0、width = 行宽', () => {
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(10, 100, 20)], 400)]);
    expect(Object.is(frame.box.origin.x, 0)).toBe(true);
    expect(Object.is(frame.dx, 0)).toBe(true);
    expect(frame.box.width).toBe(400);
    expect(Object.is(only([demand(0, [layer(1, 'tab', 92)])]).box.origin.x, 0)).toBe(true);
  });

  it('左溢出（tick 网格上的值）：left = min(footprint.left)，不是首项；width = right − left；dx = −left', () => {
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(-20, 40, 20), chord(-54, 54, 124), chord(-10, 5, 18)], 400)]);
    expect(frame.box.origin.x).toBe(-54);
    expect(frame.dx).toBe(54);
    expect(frame.box.width).toBe(400 + 54);
  });

  it('右溢出（网格上的值）：right = max(行宽, footprint.right)，不是首项', () => {
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(300, 460, 20), chord(380, 420, 20)], 400)]);
    expect(frame.box.origin.x).toBe(0);
    expect(frame.box.width).toBe(460);
  });

  it('非网格右界：向上吸附到 2⁻¹⁰ 网格（≥ 原值且不足一个 tick）；未溢出时恰为行宽', () => {
    const raw = 410.3;
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(300, raw, 20)], 400)]);
    const right = frame.box.origin.x + frame.box.width;
    expect(right).toBeGreaterThanOrEqual(raw);
    expect(right - raw).toBeLessThan(geometryQuantum);
    expect(right / geometryQuantum).toBe(Math.round(right / geometryQuantum));
    expect(only([demand(0, [layer(1, 'tab', 92)], [chord(10, 399.7, 20)], 400)]).box.width).toBe(400);
  });

  it('左右同时非网格溢出：width = right − left 恰为网格差，box 两侧都包住墨迹', () => {
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(-10.3, 30, 20), chord(300, 410.3, 20)], 400)]);
    const { origin, width } = frame.box;
    expect(origin.x).toBeLessThanOrEqual(-10.3);
    expect(origin.x + width).toBeGreaterThanOrEqual(410.3);
    expect(width / geometryQuantum).toBe(Math.round(width / geometryQuantum));
  });

  it('非网格左界：向下量化到 2⁻¹⁰ 网格（仍包住墨迹且不足一个 tick），rebase 后 T4 x 逐位还原', () => {
    const raw = -10.3;
    const frame = only([demand(0, [layer(1, 'tab', 92)], [chord(raw, 30, 20)], 400)]);
    const left = frame.box.origin.x;
    expect(left).toBeLessThanOrEqual(raw);
    expect(raw - left).toBeLessThan(geometryQuantum);
    expect(left / geometryQuantum).toBe(Math.round(left / geometryQuantum));
    expect(frame.dx).toBe(-left);
    expect(frame.box.width).toBe(400 - left);
    // T4 的 measure x 都在网格上：rebase（+dx）再加回 origin.x 必须逐位等于原值（未量化时语料里有 ulp 级偏差）。
    // 21.787109375 等是网格 x 中「未量化 left = −10.3 时 (x + 10.3) − 10.3 !== x」的实例（守住量化本身）。
    const xs = [0, 13.5, 21.787109375, 21.8818359375, 21.9765625, 377.123046875, 959.9990234375];
    expect(xs.some((x) => raw + (x - raw) !== x)).toBe(true);
    for (const x of xs) expect(left + (x + frame.dx)).toBe(x);
  });
});
