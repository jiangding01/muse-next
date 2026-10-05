/**
 * M2.5 T9b —— `renderer/components/notation/systemRender.ts`：screen system 渲染模型（用户裁决 A / B / J4 / K1 / M / O）。
 *
 * 覆盖：system / 层与 T8 逐字段对应（index、box、层序、top / height、记谱种类）；左侧留白（leftGutter ≥ 0、
 * leftOffset ≥ 0、所有 system 的音乐 x = 0 落在同一位置）；容器 row-gap 流式排列恰好复现 T8 的 origin.y；fallback 提示
 * （每声部一项、文档顺序、去重、既有 summarizeEvents）；诊断合并；px 换算与 zoom；结构不变量 RangeError；确定性。
 * `computeAvailableWidthUnits` 的 4 条用例从已删除的 `scoreView.voiceRender.test.ts` 原样迁来。
 */
import { describe, expect, it } from 'vitest';

import { layoutScoreHeader } from '../../../src/notation/layout/scoreHeader';
import { summarizeEvents } from '../../../src/notation/layout/fallbackSummary';
import { SCORE_VIEW_METRICS, SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import type { ScoreLayout } from '../../../src/notation/system/composeLayout';
import {
  buildScoreRender, computeAvailableWidthUnits, cssPx, mergeScoreDiagnostics,
} from '../../../src/renderer/components/notation/systemRender';
import type { ScoreRender } from '../../../src/renderer/components/notation/systemRender';
import { compose, main } from '../notation/system.composeLayout.helpers';
import type { Source } from '../notation/system.composeLayout.helpers';
import { matrixScoreFrom } from '../notation/renderMatrix.helpers';
import { externalMeasurer as measurer, screen } from '../notation/systemExternal.helpers';

const render = (source: Source, layout: ScoreLayout): ScoreRender => buildScoreRender(layout, source.renderScore, measurer);

describe('computeAvailableWidthUnits —— CSS 像素宽 → abstract unit（zoom 只改可用宽度，公式不变）', () => {
  it('zoom = 1 时等价于原先的固定比例换算', () => {
    expect(computeAvailableWidthUnits(960, 1, 1)).toBe(960);
    expect(computeAvailableWidthUnits(480, 2, 1)).toBe(240);
  });

  it('zoom 越大，换算出的可用宽度越小（system 换行越早发生）', () => {
    const atZoom1 = computeAvailableWidthUnits(960, 1, 1);
    const atZoom2 = computeAvailableWidthUnits(960, 1, 2);
    expect(atZoom2).toBeLessThan(atZoom1);
    expect(atZoom2).toBeCloseTo(atZoom1 / 2, 10);
  });

  it('zoom 越小，换算出的可用宽度越大（system 换行越晚发生）', () => {
    const atZoom1 = computeAvailableWidthUnits(960, 1, 1);
    const atHalfZoom = computeAvailableWidthUnits(960, 1, 0.5);
    expect(atHalfZoom).toBeGreaterThan(atZoom1);
    expect(atHalfZoom).toBeCloseTo(atZoom1 * 2, 10);
  });

  it('与 SCORE_VIEW_METRICS 的 zoomMin/zoomMax 边界值一起使用不产生非有限数', () => {
    const atMin = computeAvailableWidthUnits(960, SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1, SCORE_VIEW_METRICS.zoomMin);
    const atMax = computeAvailableWidthUnits(960, SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1, SCORE_VIEW_METRICS.zoomMax);
    expect(Number.isFinite(atMin)).toBe(true);
    expect(Number.isFinite(atMax)).toBe(true);
    expect(atMin).toBeGreaterThan(atMax);
  });
});

describe('cssPx —— 所有层 / overlay / system 共用同一个 px 换算', () => {
  it.each([[0.5], [1], [1.5]] as const)('zoom %s：units × cssPixelsPerUnitAtZoom1 × zoom', (zoom) => {
    expect(cssPx(100, zoom)).toBe(`${String(100 * SCORE_VIEW_METRICS.cssPixelsPerUnitAtZoom1 * zoom)}px`);
    expect(cssPx(0, zoom)).toBe('0px');
  });
});

describe('buildScoreRender —— system / 层与 T8 逐字段对应', () => {
  for (const width of [960, 16]) {
    it(`宽 ${String(width)}：index / box / 层序 / top / height / 种类原样`, () => {
      const layout = compose(main, screen(width));
      const result = render(main, layout);
      expect(result.systems.map((s) => s.index)).toEqual(layout.composed.systems.map((s) => s.index));
      result.systems.forEach((system, i) => {
        const source = layout.composed.systems[i];
        if (source === undefined) throw new Error('system');
        expect(system.box).toBe(source.box);
        expect(system.layers.map((l) => [l.voiceId, l.notation, l.layerIndex, l.top, l.height])).toEqual(
          source.layers.map((l) => [l.voiceId, l.notation, l.layerIndex, l.top, l.height]),
        );
        expect(system.layers.map((l) => l.kind)).toEqual(
          source.layers.map((l) => (l.notation === 'fallback' ? 'empty' : l.notation === 'staff' ? 'staff' : 'svg')),
        );
        expect(system.overlay === undefined).toBe(source.chordOverlays.length === 0);
      });
    });
  }

  it('同输入两次逐字段相等', () => {
    const layout = compose(main, screen(300));
    expect(render(main, layout)).toEqual(render(main, layout));
  });
});

describe('buildScoreRender —— 左侧留白（裁决 J4）与纵向流式排列', () => {
  it('leftGutter = max(0, −origin.x)；leftOffset = leftGutter + origin.x ≥ 0；所有 system 的音乐 x = 0 都在 leftGutter', () => {
    const layout = compose(main, screen(960));
    const result = render(main, layout);
    const expected = Math.max(0, ...layout.composed.systems.map((s) => 0 - s.box.origin.x));
    expect(expected).toBeGreaterThan(0);
    expect(result.leftGutter).toBe(expected);
    expect(layout.composed.systems.some((s) => s.box.origin.x === 0)).toBe(true);
    for (const system of result.systems) {
      expect(system.leftOffset).toBeGreaterThanOrEqual(0);
      expect(system.leftOffset - system.box.origin.x).toBe(result.leftGutter);
    }
  });

  it('没有向左溢出的文档：leftGutter 恰为 +0，leftOffset 恰为 0', () => {
    const plain = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', 'V:1 style=jianpu', 'K:C', '[V:1]C D E F|G A B c|', ''].join('\n'));
    const result = render(plain, compose(plain, screen(960)));
    expect(Object.is(result.leftGutter, 0)).toBe(true);
    expect(result.systems.every((s) => s.leftOffset === 0)).toBe(true);
  });

  it('容器 row-gap = systemGap 时，第 n 个 system 的流式顶部 = Σ(前面的高度 + gap) = T8 origin.y（不读 origin.y 也恰好复现）', () => {
    const layout = compose(main, screen(16));
    const result = render(main, layout);
    expect(result.systems.length).toBeGreaterThan(2);
    let flowTop = 0;
    result.systems.forEach((system) => {
      expect(flowTop).toBe(system.box.origin.y);
      flowTop += system.box.height + SYSTEM_METRICS.systemGap;
    });
  });
});

describe('buildScoreRender —— fallback（裁决 K1 + 修复轮 M4：以 renderScore.voices 为准）', () => {
  const scoreOf = (lines: readonly string[]): Source => matrixScoreFrom(['X:1', 'M:4/4', 'L:1/8', ...lines, ''].join('\n'));
  const noticeIds = (source: Source, width = 960): string[] =>
    render(source, compose(source, screen(width))).fallbackNotices.map((n) => n.voiceId);

  it('每个 fallback 声部恰好一项（跨多个 system 也只一项）、文档顺序；摘要来自 summarizeEvents；层保留高 0 的身份', () => {
    const twoFallbacks = scoreOf([
      'V:1 bracket=3 style=foo', 'V:2 style=jianpu', 'V:3', 'K:C',
      '[V:1]C D E F G A B c|C D E F G A B c|', '[V:2]C D E F G A B c|C D E F G A B c|', '[V:3]z8|',
    ]);
    const layout = compose(twoFallbacks, screen(16));
    expect(layout.composed.systems.length).toBeGreaterThan(1);
    const result = render(twoFallbacks, layout);
    const [first, , third] = twoFallbacks.renderScore.voices;
    if (first === undefined || third === undefined) throw new Error('voices');
    expect(result.fallbackNotices).toEqual([
      { voiceId: first.voiceId, label: '未知风格 style=foo', summary: summarizeEvents(first.items.map((item) => item.event)) },
      { voiceId: third.voiceId, label: '风格未声明', summary: summarizeEvents(third.items.map((item) => item.event)) },
    ]);
    for (const system of result.systems) {
      const empty = system.layers.filter((l) => l.kind === 'empty');
      expect(empty.map((l) => [l.voiceId, l.height])).toEqual([[first.voiceId, 0], [third.voiceId, 0]]);
    }
  });

  it('没有正文的 fallback 声部单独成组（不产出任何 system）时，提示仍然存在', () => {
    const lonely = scoreOf(['V:1 style=jianpu', 'V:2 style=foo', 'K:C', '[V:1]C D E F G A B c|']);
    const layout = compose(lonely);
    const fallbackId = lonely.renderScore.voices[1]?.voiceId;
    expect(layout.composed.systems.some((s) => s.layers.some((l) => l.voiceId === fallbackId))).toBe(false);
    expect(noticeIds(lonely)).toEqual([fallbackId]);
  });

  it('没有正文的 fallback 声部在 bracket 组内：恰好一项', () => {
    const grouped = scoreOf(['V:1 bracket=2 style=jianpu', 'V:2 style=foo', 'K:C', '[V:1]C D E F G A B c|']);
    expect(noticeIds(grouped)).toEqual([grouped.renderScore.voices[1]?.voiceId]);
  });

  it('已知记谱声部（jianpu / tab / staff）不进入提示；没有 fallback 声部 → 提示为空', () => {
    const known = scoreOf([
      'V:1 style=jianpu', 'V:2 style=tab', 'V:3 style=staff', 'K:C',
      '[V:1]C D E F G A B c|', '[V:2]a0 a1 a2 a3 a4 a5 a6 a7|', '[V:3]C D E F G A B c|',
    ]);
    expect(noticeIds(known)).toEqual([]);
  });
});

describe('诊断合并（裁决 M）与结构不变量', () => {
  it('= scoreLayout.diagnostics → 页眉诊断（页眉诊断确实非空且全部保留）；不再额外合并 renderScore 诊断', () => {
    // 缺 `K:` 且有简谱声部：页眉发 key.absent（scoreHeader 的门控），用来确认页眉诊断真的进入最终列表。
    const noKey = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', 'V:1 style=jianpu', 'V:2 style=foo', '[V:1]C D E F|', '[V:2]C D E F|', ''].join('\n'));
    const layout = compose(noKey);
    const header = layoutScoreHeader(noKey.score, measurer);
    expect(header.diagnostics.length).toBeGreaterThan(0);
    const merged = mergeScoreDiagnostics(layout.diagnostics, header.diagnostics);
    expect(merged).toEqual([...layout.diagnostics, ...header.diagnostics]);
    for (const d of header.diagnostics) expect(merged.map((x) => x.id)).toContain(d.id);
    expect(new Set(merged.map((d) => d.id)).size).toBe(merged.length);
    expect(noKey.renderScore.diagnostics.length).toBeGreaterThan(0);
    for (const d of noKey.renderScore.diagnostics) expect(merged.filter((x) => x.id === d.id)).toHaveLength(1);
    const [firstDiagnostic] = layout.diagnostics;
    if (firstDiagnostic === undefined) throw new Error('diagnostic');
    expect(mergeScoreDiagnostics([firstDiagnostic, firstDiagnostic], [])).toEqual([firstDiagnostic]);
  });

  it('已知记谱层缺 voice layout 或记谱不一致 → RangeError', () => {
    const layout = compose(main);
    expect(() => render(main, { ...layout, voiceLayouts: [] })).toThrow(RangeError);
    const swapped = layout.voiceLayouts.map((e) => (e.notation === 'tab' ? { ...e, voiceId: layout.voiceLayouts[0]?.voiceId ?? e.voiceId } : e));
    expect(() => render(main, { ...layout, voiceLayouts: swapped })).toThrow(RangeError);
  });
});
