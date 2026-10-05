/**
 * M2.5 T8 —— `system/composeLayout.ts`：最终 vertical system 组装（用户裁决 A–L + 修复轮裁决，2026-10-05）。
 *
 * 覆盖：每个已知记谱声部恰好一个 layout、顺序、fallback 不进 voiceLayouts；空层保留基础高；TAB 补高按 (声部, system)；
 * 横向 box = T4 geometry + T6 chord ink（左右网格吸附），T4 measure / shared overlay 逐位还原、tier 3 非网格 x 在严格误差界
 * 内还原；voice layout 拿到的层 box；纵向堆叠跨 group 不重置；overlay 映射与块顶；结构不变量破坏 → RangeError；
 * 诊断拼接且不重复合并 renderScore；screen / page 纵向一致；纯函数。歌词相关见 `system.composeLayout.lyrics.test.ts`。
 */
import { describe, expect, it } from 'vitest';

import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import { lyricBandHeight } from '../../../src/notation/jianpu/jianpuVerticalDemand';
import { JIANPU_METRICS, STAFF_METRICS, SYSTEM_METRICS, TAB_METRICS } from '../../../src/notation/layout/metrics';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import { staffLayerDemands } from '../../../src/notation/staff/staffVerticalDemand';
import { planChordOverlays } from '../../../src/notation/system/chordOverlay';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import { planVoiceLayers, systemDemands } from '../../../src/notation/system/verticalDemand';
import { TAB_BAR, TAB_DEEP_BAR, compose, entryOf, jianpuOf, layerHeight, main, systemAt, tabScoreOf, xsOf } from './system.composeLayout.helpers';
import { composed, externalFor, externalMeasurer as measurer, screen, withZeroTopInsets } from './systemExternal.helpers';

const { geometryQuantum: q, chordBandGap, layerGap, systemGap } = SYSTEM_METRICS;
const onGrid = (x: number): boolean => Number.isInteger(x / q);

describe('T8 composeLayout —— 声部层与 voice layout 调用（裁决 A / B / I / J）', () => {
  const layout = compose(main);
  const ids = main.renderScore.voices.map((v) => v.voiceId);

  it('每个已知记谱声部恰好一个 layout，group 顺序、组内 voiceIds 顺序；fallback 不进 voiceLayouts、不回退 Staff', () => {
    expect(layout.voiceLayouts.map((e) => [e.notation, e.voiceId])).toEqual([['jianpu', ids[0]], ['tab', ids[2]], ['staff', ids[3]]]);
    layout.voiceLayouts.forEach((e) => expect(e.layout.voiceId).toBe(e.voiceId));
    const first = systemAt(layout, 0);
    expect(first.layers.map((l) => [l.voiceId, l.notation, l.layerIndex])).toEqual([
      [ids[0], 'jianpu', 0],
      [ids[1], 'fallback', 1],
      [ids[2], 'tab', 2],
    ]);
    expect(first.layers[1]?.height).toBe(0);
  });

  it('层高：简谱 = 64 + 歌词带（2 行）；fallback 0 且不计 gap；TAB 含 1/32 的行补高；Staff 96', () => {
    const [jianpu, fallback, tab] = systemAt(layout, 0).layers;
    expect(jianpu?.height).toBe(JIANPU_METRICS.systemHeight + lyricBandHeight(2));
    expect(fallback?.top).toBe((jianpu?.top ?? 0) + (jianpu?.height ?? 0));
    expect(tab?.top).toBe((fallback?.top ?? 0) + layerGap);
    expect(tab?.height).toBeGreaterThan(TAB_METRICS.systemHeight);
    expect(systemAt(layout, 1).layers.map((l) => [l.notation, l.top, l.height])).toEqual([['staff', 0, STAFF_METRICS.systemHeight]]);
  });

  it('裁决 B：已知记谱声部在本行没有 measure 时保留基础高度空层，不省略；它的 voice layout 也拿到这一行', () => {
    const narrow = compose(main, screen(16));
    const groupSystems = narrow.composed.systems.filter((s) => s.groupIndex === 0);
    const tabAbsent = (s: (typeof groupSystems)[number]): boolean =>
      s.measures.every((m) => m.participation.some((p) => p.voiceId === ids[2] && p.kind === 'absent'));
    const empty = groupSystems.filter(tabAbsent);
    expect(empty.length).toBeGreaterThan(0);
    for (const system of empty) {
      expect(system.layers.map((l) => l.notation)).toEqual(['jianpu', 'fallback', 'tab']);
      expect(system.layers[2]?.height).toBe(TAB_METRICS.systemHeight);
    }
    expect(entryOf(narrow, 'tab').layout.systems.map((s) => s.index)).toEqual(groupSystems.map((s) => s.index));
  });

  it('LOW 7：TAB 补高按 (声部, system) 计——深时值只抬高本声部含它的那一行，不波及本声部其它行与同组其它声部', () => {
    const source = tabScoreOf([`${TAB_BAR}${TAB_DEEP_BAR}`, `${TAB_BAR}${TAB_BAR}`]);
    const narrow = compose(source, screen(16));
    expect(narrow.composed.systems.map((s) => s.index)).toEqual([0, 1]);
    expect(layerHeight(narrow, 0, source, 0)).toBe(TAB_METRICS.systemHeight);
    expect(layerHeight(narrow, 1, source, 0)).toBeGreaterThan(TAB_METRICS.systemHeight);
    expect(layerHeight(narrow, 0, source, 1)).toBe(TAB_METRICS.systemHeight);
    expect(layerHeight(narrow, 1, source, 1)).toBe(TAB_METRICS.systemHeight);
  });

  it('voice layout 的行谱 box = 层 box：origin.x / width 取最终 box，y = box.y + layer.top，height = layer.height', () => {
    for (const policy of [screen(960), screen(16)]) {
      const out = compose(main, policy);
      for (const entry of out.voiceLayouts) {
        for (const system of entry.layout.systems) {
          const final = systemAt(out, system.index);
          const layer = final.layers.find((l) => l.voiceId === entry.voiceId);
          expect(system.box).toEqual({
            origin: { x: final.box.origin.x, y: final.box.origin.y + (layer?.top ?? Number.NaN) },
            width: final.box.width,
            height: layer?.height,
          });
        }
      }
    }
  });

  it('LOW 4：声部计划缺少某行的纵向需求 → RangeError（不静默给 0）', () => {
    const geometry = composed(main.renderScore);
    const [first, ...rest] = planVoiceLayers(main.renderScore, geometry, (voice, owned, indices) => staffLayerDemands(voice, main.index, owned, indices));
    if (first === undefined) throw new Error('plans');
    expect(systemDemands(geometry, [first, ...rest], new Map())).toHaveLength(geometry.lines.length);
    expect(() => systemDemands(geometry, [{ ...first, heights: new Map() }, ...rest], new Map())).toThrow(RangeError);
  });
});

describe('T8 composeLayout —— 横向：box = T4 geometry + T6 chord ink，rebase 精度契约（裁决 F + amendment）', () => {
  it.each([['960', 960], ['narrow', 16], ['300', 300]] as const)(
    '%s：T4 measure 与 shared overlay 逐位还原；同一 dx；box 左右界吸附到网格并包住墨迹',
    (_label, width) => {
      const t4 = composed(main.renderScore, screen(width));
      const plans = planChordOverlays(main.renderScore, t4, measurer).plans;
      const out = compose(main, screen(width));
      expect(out.composed.systems.some((s) => s.box.origin.x < 0)).toBe(true);
      for (const line of t4.lines) {
        const system = systemAt(out, line.systemIndex);
        const { origin, width: boxWidth } = system.box;
        const dx = 0 - origin.x;
        line.measures.forEach((g, i) => {
          expect(origin.x + (system.measures[i]?.x ?? Number.NaN)).toBe(g.x);
          expect(system.measures[i]).toEqual({ ...g, x: g.x + dx });
        });
        const own = plans.filter((p) => p.systemIndex === line.systemIndex);
        expect(system.chordOverlays).toHaveLength(own.length);
        const timings = t4.analysis.timings.groups.find((g) => g.groupIndex === line.groupIndex)?.measures ?? [];
        own.forEach((p, i) => {
          expect(timings[p.measureOrdinal]?.status).toBe('shared');
          expect(origin.x + (system.chordOverlays[i]?.x ?? Number.NaN)).toBe(p.x);
          expect(system.chordOverlays[i]?.x).toBe(p.x + dx);
        });
        const rawRight = Math.max(line.width, ...own.map((p) => p.footprint.right));
        expect(origin.x).toBeLessThanOrEqual(Math.min(0, ...own.map((p) => p.footprint.left)));
        expect(onGrid(origin.x) && onGrid(origin.x + boxWidth)).toBe(true);
        expect(origin.x + boxWidth).toBeGreaterThanOrEqual(rawRight);
        expect(origin.x + boxWidth - rawRight).toBeLessThan(q);
      }
    },
  );

  // tier 3 的 voice-local x 是任意 double：rebase 只保证语义坐标不变、误差在严格界内（不是逐位契约）。
  it.each([
    ['跨 2 的幂（57.6 + 54 进入 [64,128)，逐位不成立）', '"G"a0 a1 a2 "Am"a3 a4|'],
    ['非网格但未跨界', '"G"a0 a1 a2 a3 a4 "Am"a5 a6|'],
  ] as const)('tier 3 非网格 x：%s —— 误差 ≤ 4ε·max(1,|x|,|local|,|origin|)', (_label, body) => {
    const source = tabScoreOf([body, TAB_BAR]);
    const t4 = composed(source.renderScore);
    expect(t4.analysis.timings.groups[0]?.measures[0]?.status).toBe('not-compatible');
    const plan = planChordOverlays(source.renderScore, t4, measurer).plans.find((p) => p.displayText === 'Am');
    const system = systemAt(compose(source), 0);
    const local = system.chordOverlays.find((o) => o.displayText === 'Am')?.x ?? Number.NaN;
    if (plan === undefined) throw new Error('plan');
    expect(onGrid(plan.x)).toBe(false);
    expect(system.box.origin.x).toBeLessThan(0);
    expect(local).toBe(plan.x - system.box.origin.x);
    const tolerance = 4 * Number.EPSILON * Math.max(1, Math.abs(plan.x), Math.abs(local), Math.abs(system.box.origin.x));
    expect(Math.abs(system.box.origin.x + local - plan.x)).toBeLessThanOrEqual(tolerance);
  });

  it('voice layout 的绝对 x 不受 rebase 影响：与「T4 原坐标 + origin 0」的 external 布局逐位相等', () => {
    for (const width of [960, 16]) {
      const t4 = composed(main.renderScore, screen(width));
      const out = compose(main, screen(width));
      const ctx = { index: main.index, measurer, availableWidth: width };
      const meter = main.score.meter === undefined ? {} : { meter: main.score.meter };
      for (const entry of out.voiceLayouts) {
        const voice = main.renderScore.voices.find((v) => v.voiceId === entry.voiceId);
        if (voice === undefined) throw new Error('no voice');
        const external = externalFor(t4, entry.voiceId);
        const reference = entry.notation === 'jianpu'
          ? layoutJianpu(voice, { ...ctx, score: meter, external })
          : entry.notation === 'tab'
            ? layoutTab(voice, { ...ctx, ...meter, external })
            : layoutStaff(voice, { ...ctx, score: main.score, external: withZeroTopInsets(external) });
        expect(xsOf(entry.layout)).toEqual(xsOf(reference));
        if (entry.notation === 'jianpu' && 'lyrics' in reference) {
          expect(entry.layout.lyrics.map((l) => l.text.x)).toEqual(reference.lyrics.map((l) => l.text.x));
        }
        if (entry.notation === 'tab' && 'staffLines' in reference) {
          expect(entry.layout.staffLines.map((l) => l.lines[0]?.x1)).toEqual(reference.staffLines.map((l) => l.lines[0]?.x1));
        }
        if (entry.notation === 'staff' && 'staves' in reference) {
          expect(entry.layout.staves.map((s) => s.width)).toEqual(reference.staves.map((s) => s.width));
        }
      }
    }
  });
});

describe('T8 composeLayout —— 纵向堆叠、和弦带与 overlay（裁决 E / G）', () => {
  const layout = compose(main);
  const plans = planChordOverlays(main.renderScore, composed(main.renderScore), measurer).plans;

  it('y 从 0 起，systemGap 只在 system 之间，跨 group 不重置', () => {
    const systems = layout.composed.systems;
    expect(systems.map((s) => s.groupIndex)).toEqual([0, 1]);
    expect(systems[0]?.box.origin.y).toBe(0);
    expect(systems[1]?.box.origin.y).toBe((systems[0]?.box.height ?? Number.NaN) + systemGap);
  });

  it('有和弦的 system：第一层 top = max(footprint.height) + chordBandGap；overlay y = 块顶、块底对齐带底', () => {
    const first = systemAt(layout, 0);
    const own = plans.filter((p) => p.systemIndex === 0);
    const band = Math.max(...own.map((p) => p.footprint.height)) + chordBandGap;
    expect(first.layers[0]?.top).toBe(band);
    own.forEach((p, i) => expect(first.chordOverlays[i]?.y).toBe(band - chordBandGap - p.footprint.height));
    expect(systemAt(layout, 1).chordOverlays).toEqual([]);
  });

  it('overlay 直接由 T6 plan 映射：顺序、anchor、displayText、shapeIndex 有无、systemIndex', () => {
    const overlays = layout.composed.systems.flatMap((s) => s.chordOverlays);
    expect(overlays.map((o) => [o.anchor, o.displayText, o.shapeIndex, o.systemIndex])).toEqual(
      plans.map((p) => [p.anchor, p.displayText, p.shapeIndex, p.systemIndex]),
    );
    expect(overlays.some((o) => o.shapeIndex !== undefined)).toBe(true);
    expect(overlays.some((o) => !('shapeIndex' in o))).toBe(true);
  });

  it('screen 与 page 同宽度：纵向结果一致；justified / groupIndex 原样取 T4', () => {
    const page = compose(main, { kind: 'page', contentWidth: 960 });
    expect(page.composed.target).toBe('page');
    expect(page.composed.systems).toEqual(layout.composed.systems);
    const t4 = composed(main.renderScore);
    expect(layout.composed.systems.map((s) => [s.groupIndex, s.justified])).toEqual(t4.lines.map((l) => [l.groupIndex, l.justified]));
  });
});

describe('T8 composeLayout —— meter、诊断与纯度（裁决 H）', () => {
  it('TAB 与简谱都拿到文档 meter：beam 分组生效', () => {
    const layout = compose(main);
    const tab = entryOf(layout, 'tab').layout;
    expect('beams' in tab && tab.beams.length > 0).toBe(true);
    expect(jianpuOf(layout).beams.length).toBeGreaterThan(0);
  });

  it('诊断 = composed（含 renderScore / T1 / T2 / T3）→ T6 → voice layouts；renderScore 诊断不被重复合并', () => {
    const t4 = composed(main.renderScore);
    const chords = planChordOverlays(main.renderScore, t4, measurer);
    const layout = compose(main);
    expect(main.renderScore.diagnostics.length).toBeGreaterThan(0);
    const voiceDiagnostics = layout.voiceLayouts.flatMap((e) => e.layout.diagnostics);
    expect(layout.diagnostics).toEqual([...t4.diagnostics, ...chords.diagnostics, ...voiceDiagnostics]);
    for (const d of main.renderScore.diagnostics) {
      expect(layout.diagnostics.filter((x) => JSON.stringify(x) === JSON.stringify(d))).toHaveLength(1);
    }
  });

  it('纯函数：同输入逐字段相等，不改 renderScore', () => {
    const snapshot = JSON.stringify(main.renderScore);
    expect(compose(main, screen(300))).toEqual(compose(main, screen(300)));
    expect(JSON.stringify(main.renderScore)).toBe(snapshot);
  });
});
