/**
 * T6.4 —— `renderer/components/notation/voiceRender.ts` 的纯函数测试。
 *
 * `tests/unit/renderer/**` 目录当前不存在，按任务说明跟 jianpu 的 renderer 测试
 * （`jianpu.toSvg.test.ts` 里的 `SvgTree` smoke）放在同一个目录
 * `tests/unit/notation/`。只测两块纯函数，不测 React 组件树（组件树的 tab 分支
 * 渲染已由 `tab.toSvg.test.ts` 的 `SvgTree` smoke 间接覆盖）：
 *
 * 1. `computeAvailableWidthUnits`：容器 CSS 像素宽 → `availableWidth`（abstract
 *    unit）的换算公式——zoom 越大换行越早（可用宽度越小）、zoom 越小换行越晚。
 * 2. `buildVoiceRender`：按 `voice.style` 分派 jianpu / tab / pending / fallback
 *    四种结果种类，tab 分支产出的 `SvgNode` 能被 `tabToSvg` 独立验证过的同一套
 *    结构（这里只断言 `kind`/`width`/`diagnostics` 三个字段，不重复 `tabToSvg`
 *    自己的结构断言）。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { SCORE_VIEW_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import {
  buildVoiceRender, computeAvailableWidthUnits, PENDING_STYLE_LABEL,
} from '../../../src/renderer/components/notation/voiceRender';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

describe('computeAvailableWidthUnits —— CSS 像素宽 → abstract unit（zoom 只改可用宽度）', () => {
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

describe('buildVoiceRender —— 按 voice.style 分派（tab 分支，T6.4 新增）', () => {
  it('style=tab → kind: "tab"，width 与 diagnostics 字段齐备', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=tab\na0 b1 |\n');
    const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
    const voice = rendered.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const render = buildVoiceRender(voice, {
      score: loaded.score, index: loaded.index, measurer, availableWidth: WIDE,
    });
    expect(render.kind).toBe('tab');
    if (render.kind !== 'tab') throw new Error('分派结果应为 tab');
    expect(render.voiceId).toBe(voice.voiceId);
    expect(render.width).toBeGreaterThan(0);
    expect(Array.isArray(render.diagnostics)).toBe(true);
  });

  it('style=staff → kind: "pending"，PENDING_STYLE_LABEL 只剩 staff 一项（T7 待接入）', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=staff\nCDEF|\n');
    const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
    const voice = rendered.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const render = buildVoiceRender(voice, {
      score: loaded.score, index: loaded.index, measurer, availableWidth: WIDE,
    });
    expect(render.kind).toBe('pending');
    if (render.kind !== 'pending') throw new Error('分派结果应为 pending');
    expect(render.style).toBe('staff');
    expect(Object.keys(PENDING_STYLE_LABEL)).toEqual(['staff']);
  });
});
