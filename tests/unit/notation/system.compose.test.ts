/**
 * M2.5 T4-2 —— 公共 measure 几何编排（`system/composeSystem.ts`）。
 *
 * 覆盖：packing（单行 / 多行 / 超宽独占 / 顺序 / group 独立 / systemIndex 全局）、行首预留（packing 前扣、
 * 只加行首、不参与 justify）、justify 标记与整数级严格填满、shared timeline 几何（lead / 段 / tail / 零 timed）、
 * tier 3、策略（screen / page / barsPerStaff）、诊断透传、输入不变、确定性，以及全部 fixture 的不变量扫描。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import type { RenderScore } from '../../../src/notation/model/types';
import type { PackingPolicy, SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import { composeSystemGeometry } from '../../../src/notation/system/composeSystem';
import type { ComposedSystemGeometry, SystemLineGeometry } from '../../../src/notation/system/composeSystem';
import { ceilTicks, floorTicks } from '../../../src/notation/system/geometryTicks';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import { justifyCap } from '../../../src/notation/system/justify';
import { createVoiceSpacings, voicesOf } from '../../../src/notation/system/measureDemand';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import { buildMeasureTimings } from '../../../src/notation/system/timeline';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';

const measurer = createDeterministicTextMeasurer();
const TICK = SYSTEM_METRICS.geometryQuantum;
const screen = (availableWidth: number): PackingPolicy => ({ kind: 'screen', availableWidth });

function renderOf(bodies: readonly (readonly [string, string])[], header = 'M:4/4\nL:1/8', extraDecl: readonly string[] = []): RenderScore {
  const decl = bodies.map(([style], i) => `V:${String(i + 1)}${i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''}${style === '' ? '' : ` style=${style}`}`);
  const lines = bodies.map(([, body], i) => `[V:${String(i + 1)}]${body}`);
  return matrixScoreFrom(['X:1', header, ...decl, ...extraDecl, 'K:C', ...lines, ''].join('\n')).renderScore;
}

const compose = (render: RenderScore, policy: PackingPolicy = screen(960)): ComposedSystemGeometry => composeSystemGeometry(render, measurer, policy);
const allMeasures = (out: ComposedSystemGeometry): SystemMeasureGeometry[] => out.lines.flatMap((line) => line.measures);
const ticks = (units: number): number => units / TICK;
const lineTicks = (line: SystemLineGeometry): number => line.measures.reduce((sum, m) => sum + ticks(m.width), 0);

const LONG = 'CDEF GABc|cBAG FEDC|CDEF GABc|cBAG FEDC|CDEF GABc|cBAG FEDC|';

describe('T4-2 —— packing（§Q4.3 / F-5）', () => {
  it('宽容器单行；窄容器每行一个 measure；measure 顺序不变、ordinal 不重编号', () => {
    const render = renderOf([['jianpu', LONG], ['tab', 'a0 a1 a2 a3 a4 a5 a6 a7 |'.repeat(6)]]);
    expect(compose(render, screen(100_000)).lines).toHaveLength(1);
    const narrow = compose(render, screen(16));
    expect(narrow.lines).toHaveLength(6);
    expect(allMeasures(narrow).map((m) => m.measureOrdinal)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(narrow.lines.every((line) => line.measures.length === 1)).toBe(true);
  });

  it('单个超宽 measure 独占一行不拆；行内 x 首尾相接', () => {
    const out = compose(renderOf([['jianpu', 'C|CDEFGABcdefgab|C|']]), screen(100));
    expect(out.lines.map((line) => line.measures.map((m) => m.measureOrdinal))).toEqual([[0], [1], [2]]);
    for (const line of out.lines) {
      line.measures.forEach((m, i) => {
        const prev = line.measures[i - 1];
        expect(m.x).toBe(prev === undefined ? 0 : prev.x + prev.width);
      });
    }
  });

  it('贪心：除单 measure 行外，每行内容需求 ≤ 阈值，且再放下一个就会超阈值', () => {
    const out = compose(renderOf([['jianpu', LONG]]), screen(300));
    expect(out.lines.some((line) => line.measures.length > 1)).toBe(true);
    const demands = allMeasures(out).map((m) => ticks(m.demandWidth));
    const threshold = floorTicks(300);
    let start = 0;
    for (const line of out.lines) {
      const end = start + line.measures.length;
      const sum = demands.slice(start, end).reduce((a, b) => a + b, 0);
      if (line.measures.length > 1) expect(sum).toBeLessThanOrEqual(threshold);
      if (end < demands.length) expect(sum + (demands[end] ?? 0)).toBeGreaterThan(threshold);
      start = end;
    }
  });

  it('不同 group 独立 packing：各自从 lineIndex 0 起；systemIndex 全文档按 group 文档顺序连续累加', () => {
    const render = renderOf([['jianpu', LONG], ['jianpu', 'C|']], 'M:4/4\nL:1/8');
    // 无 bracket（各自 singleton）：用两个独立声部声明。
    const two = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/8', 'V:1 style=jianpu', 'V:2 style=jianpu', 'K:C', `[V:1]${LONG}`, '[V:2]C|', ''].join('\n')).renderScore;
    const out = compose(two, screen(150));
    expect(out.lines.map((line) => line.systemIndex)).toEqual(out.lines.map((_, i) => i));
    const byGroup = (g: number): SystemLineGeometry[] => out.lines.filter((line) => line.groupIndex === g);
    expect(byGroup(0).map((line) => line.lineIndex)).toEqual(byGroup(0).map((_, i) => i));
    expect(byGroup(1)).toHaveLength(1);
    expect(byGroup(1)[0]?.lineIndex).toBe(0);
    expect(out.lines.findIndex((line) => line.groupIndex === 1)).toBe(byGroup(0).length);
    expect(compose(render, screen(150)).lines.every((line) => line.groupIndex === 0)).toBe(true);
  });

  it('同一 group 各 voice 同步：每个 measure 的 participation 覆盖全部 voice，顺序同 voiceIds', () => {
    const render = renderOf([['tab', 'a0 a1 |a2 a3 |'], ['jianpu', 'CD|EF|']]);
    const ids = groupVoices(render.score.voices).groups[0]?.voiceIds ?? [];
    for (const m of allMeasures(compose(render, screen(16)))) {
      expect(m.participation.map((p) => p.voiceId)).toEqual(ids);
    }
  });
});

describe('T4-2 —— 行首预留（§Q4.4，裁决 F / G）', () => {
  it('Staff：每行首 measure contentOffsetX = lineStartReserve 且计入 width；其余 measure 为 0；不重复加', () => {
    const out = compose(renderOf([['staff', LONG]]), screen(300));
    expect(out.lines.length).toBeGreaterThan(1);
    for (const line of out.lines) {
      expect(line.lineStartReserve).toBeGreaterThan(0);
      line.measures.forEach((m, i) => {
        expect(m.contentOffsetX).toBe(i === 0 ? line.lineStartReserve : 0);
        expect(m.width).toBeGreaterThanOrEqual(m.contentOffsetX + m.demandWidth);
      });
    }
  });

  it('预留在 packing 前扣：两小节放得进 W 却放不进 W − 预留 → 每行只排一个；TAB / 简谱预留为 0', () => {
    const wide = compose(renderOf([['staff', LONG]]), screen(100_000));
    const reserve = wide.lines[0]?.lineStartReserve ?? 0;
    const [d0, d1] = allMeasures(wide).map((m) => m.demandWidth);
    if (d0 === undefined || d1 === undefined) throw new Error('demands');
    // W 恰好装得下两个 measure 的内容，但扣掉预留后装不下：先扣预留 → 每行 1 个；排完再补 → 每行 2 个。
    const width = d0 + d1;
    expect(width - reserve).toBeLessThan(d0 + d1);
    const lines = compose(renderOf([['staff', LONG]]), screen(width)).lines;
    expect(lines.map((line) => line.measures.length)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(compose(renderOf([['jianpu', LONG]]), screen(width)).lines.length).toBeLessThan(lines.length);
    expect(compose(renderOf([['jianpu', LONG], ['jianpu', LONG]]), screen(300)).lines.every((line) => line.lineStartReserve === 0)).toBe(true);
    expect(compose(renderOf([['tab', 'a0 a1 |']])).lines[0]?.lineStartReserve).toBe(0);
  });

  it('预留不参与 justify / cap：full 行内容宽之和 = 可用宽 − 预留，每个内容宽 ≤ ⌊需求 × 3/2⌋', () => {
    // Staff 每小节需求 360：宽 1200 → 阈值 1200 − 预留，每行 3 个，非末行有剩余宽可拉。
    const out = compose(renderOf([['staff', LONG]]), screen(1200));
    const full = out.lines.filter((line) => line.justified === 'full');
    expect(full.length).toBeGreaterThan(0);
    for (const line of full) {
      const content = line.measures.reduce((sum, m) => sum + ticks(m.width) - ticks(m.contentOffsetX), 0);
      expect(content).toBe(floorTicks(1200) - ticks(line.lineStartReserve));
      for (const m of line.measures) expect(ticks(m.width) - ticks(m.contentOffsetX)).toBeLessThanOrEqual(justifyCap(ticks(m.demandWidth)));
    }
  });
});

describe('T4-2 —— justify 标记（§Q4.5 / F-3）', () => {
  it('full：非末行 Σwidth tick 严格等于可用宽 tick；末行 none；唯一一行 none', () => {
    const out = compose(renderOf([['jianpu', LONG]]), screen(150));
    const last = out.lines.at(-1);
    expect(last?.justified).toBe('none');
    for (const line of out.lines.slice(0, -1)) {
      if (line.justified === 'full') expect(lineTicks(line)).toBe(floorTicks(150));
    }
    expect(compose(renderOf([['jianpu', 'CD|EF|']]), screen(100_000)).lines.map((line) => line.justified)).toEqual(['none']);
  });

  it('partial：小 measure 后接超宽 measure 被迫换行 → 全部触顶仍留白，Σ < 可用宽', () => {
    const out = compose(renderOf([['jianpu', 'CD|CDEFGABcdefgabCDEFGABcdefgab|']]), screen(200));
    const first = out.lines[0];
    if (first === undefined) throw new Error('line');
    expect(first.justified).toBe('partial');
    expect(lineTicks(first)).toBeLessThan(floorTicks(200));
    for (const m of first.measures) expect(ticks(m.width)).toBe(justifyCap(ticks(m.demandWidth)));
  });
});

describe('T4-2 —— shared timeline 几何（裁决 C / D/E）', () => {
  const timelineOf = (m: SystemMeasureGeometry | undefined) => {
    if (m?.timeline === undefined) throw new Error('timeline missing');
    return m.timeline;
  };

  it('xByOffsetIndex[0] = contentOffsetX + lead；单调递增；endX = 收尾 barline x；width = endX + tail', () => {
    const out = compose(renderOf([['jianpu', '!trill!C D E F|'], ['jianpu', 'C D E F|']]), screen(100_000));
    const m = allMeasures(out)[0];
    const t = timelineOf(m);
    expect(t.xByOffsetIndex[0]).toBe((m?.contentOffsetX ?? 0) + 12);
    t.xByOffsetIndex.forEach((x, i) => expect(x).toBeGreaterThan(i === 0 ? -1 : (t.xByOffsetIndex[i - 1] ?? 0)));
    expect(t.endX).toBe((m?.x ?? 0) + (m?.width ?? 0) - 12 - (m?.x ?? 0));
    expect(t.offsets.map((o) => `${String(o.num)}/${String(o.den)}`)).toEqual(['0/1', '1/8', '1/4', '3/8']);
  });

  it('同 onset 的段宽 ≥ 每个 voice 在该段的需求（不按时值比例）；拉伸后段按需求比例增长', () => {
    const render = renderOf([['jianpu', 'C !trill!!mordent!D E F|CD|'], ['jianpu', 'C D E F|CD|']]);
    const natural = timelineOf(allMeasures(compose(render, screen(100_000)))[0]);
    const seg = (t: { readonly xByOffsetIndex: readonly number[]; readonly endX: number }, i: number): number =>
      (t.xByOffsetIndex[i + 1] ?? t.endX) - (t.xByOffsetIndex[i] ?? 0);
    expect([0, 1, 2, 3].map((i) => seg(natural, i))).toEqual([36, 12, 12, 12]);
    // 宽 100：两个 measure（84 + 36）放不进一行 → 首行非末行，拉伸到 100。
    const stretched = compose(render, screen(100));
    const first = stretched.lines[0];
    expect(first?.justified).toBe('full');
    const t = timelineOf(first?.measures[0]);
    const ratio = seg(t, 0) / 36;
    // 每段终宽与精确比例份额最多差 1 tick（余数逐 tick 补），比例误差 < 2 tick / 段需求。
    for (const i of [1, 2, 3]) expect(Math.abs(seg(t, i) / 12 - ratio)).toBeLessThan((2 * TICK) / 12);
    expect(ratio).toBeGreaterThan(1);
  });

  it('零 timed shared measure 保留空 timeline：barline-only / decoration+barline / grace / unknown / chordSymbol / 无收尾线', () => {
    const cases: readonly (readonly [string, number, number])[] = [
      // body, lead（local 列宽）, tail（收尾 barline 列）
      ['|', 0, 12], ['!trill!|', 12, 12], ['{g}|', 12, 12], ['x|', 12, 12], ['"G"|', 0, 12], ['!trill!', 12, 0],
    ];
    for (const [body, lead, tail] of cases) {
      const out = compose(renderOf([['jianpu', `CD| ${body}`], ['jianpu', `CD| ${body}`]]), screen(100_000));
      const m = allMeasures(out)[1];
      const t = timelineOf(m);
      expect([t.offsets, t.xByOffsetIndex]).toEqual([[], []]);
      expect(t.endX).toBe((m?.contentOffsetX ?? 0) + lead);
      expect(m?.width).toBe(t.endX + tail);
    }
    // 行首（带预留）+ 被拉伸的零 timed：Staff 单声部，窄宽度使每个 measure 各成一行；中间那行不是末行会被拉伸。
    const staffRender = renderOf([['staff', 'CD| !trill!| CD|']]);
    const staffWide = compose(staffRender, screen(100_000));
    const zeroDemand = allMeasures(staffWide)[1]?.demandWidth ?? 0;
    const staff = compose(staffRender, screen((staffWide.lines[0]?.lineStartReserve ?? 0) + zeroDemand + 3));
    expect(staff.lines.map((line) => line.measures.length)).toEqual([1, 1, 1]);
    const mid = staff.lines[1];
    const zm = mid?.measures[0];
    const zt = timelineOf(zm);
    expect(mid?.justified).not.toBe('none');
    expect(zm?.contentOffsetX).toBe(mid?.lineStartReserve);
    expect(zm?.contentOffsetX).toBeGreaterThan(0);
    expect(zt.endX).toBeGreaterThan(zm?.contentOffsetX ?? 0);
    expect(zm?.width).toBeGreaterThan(zt.endX);
    expect((zm?.width ?? 0) - (zm?.contentOffsetX ?? 0)).toBeGreaterThan(zm?.demandWidth ?? 0);
    const empty = allMeasures(compose(renderOf([['jianpu', 'CD| "G"'], ['jianpu', 'CD| "G"']]), screen(100_000)))[1];
    expect([empty?.width, timelineOf(empty).endX]).toEqual([0, 0]);
  });
});

describe('T4-2 —— tier 3：有公共 x / width，无 timeline，照常参与 packing', () => {
  const cases: readonly (readonly [string, readonly [string, string]])[] = [
    ['structure-conflict', ['CDEF|', 'CDEF||']],
    ['total-mismatch', ['CDEFGA|', 'CD|']],
    ['degraded（tuplet）', ['(3CDE F|', 'CDEF|']],
  ];
  for (const [label, [a, b]] of cases) {
    it(label, () => {
      const out = compose(renderOf([['jianpu', a], ['jianpu', b]]), screen(100_000));
      const m = allMeasures(out)[0];
      expect(m?.timeline).toBeUndefined();
      expect(m?.width).toBeGreaterThan(0);
      expect(out.lines[0]?.measures[0]).toBe(m);
    });
  }

  it('desynced：锁存后的 measure 无 timeline 但仍在行里', () => {
    const out = compose(renderOf([['jianpu', 'CD E2 F4|CD E2 F4|CD E2 F4|'], ['jianpu', '|CD E2 F4|CD E2 F4|']]), screen(100_000));
    const ms = allMeasures(out);
    expect(ms).toHaveLength(3);
    expect(ms[2]?.timeline).toBeUndefined();
    expect(ms[2]?.width).toBeGreaterThan(0);
  });
});

describe('T4-2 —— 策略（§Q6.1–Q6.3，裁决 H）', () => {
  const render = renderOf([['jianpu', LONG]]);

  it('screen 用 availableWidth、page 用 contentWidth；target 与策略一致', () => {
    expect(compose(render, screen(150))).toEqual({ ...compose(render, { kind: 'page', contentWidth: 150 }), target: 'screen' });
    expect(compose(render, { kind: 'page', contentWidth: 150 }).target).toBe('page');
  });

  it('page + barsPerStaff：放得下则强制 N 个（honored），放不下退回自动（false）；screen 无该字段', () => {
    const honored = compose(render, { kind: 'page', contentWidth: 100_000, barsPerStaff: 2 });
    expect(honored.lines.map((line) => [line.measures.length, line.barsPerStaffHonored])).toEqual([[2, true], [2, true], [2, true]]);
    const fallback = compose(render, { kind: 'page', contentWidth: 80, barsPerStaff: 3 });
    expect(fallback.lines.every((line) => line.barsPerStaffHonored === false)).toBe(true);
    expect(fallback.lines.every((line) => line.measures.length === 1)).toBe(true);
    expect(compose(render, screen(150)).lines.every((line) => !('barsPerStaffHonored' in line))).toBe(true);
  });

  it('barsPerStaff 裁决 a：6 个 measure、N = 4、都放得下 → [4, 2]，两行都 honored（末行不足 N 是文档结束，不是回退）', () => {
    const out = compose(render, { kind: 'page', contentWidth: 100_000, barsPerStaff: 4 });
    expect(out.lines.map((line) => [line.measures.length, line.barsPerStaffHonored])).toEqual([[4, true], [2, true]]);
  });

  it('barsPerStaff 裁决 b：全零 fallback group + 有效 N → 仍只有一行、全部 measure 在这一行、none、不带 honored', () => {
    const fallback = renderOf([['', 'CDEF|GABc|CDEF|GABc|CDEF|']]);
    const out = compose(fallback, { kind: 'page', contentWidth: 100, barsPerStaff: 2 });
    expect(out.lines).toHaveLength(1);
    expect(out.lines[0]?.measures.map((m) => m.measureOrdinal)).toEqual([0, 1, 2, 3, 4]);
    expect(out.lines[0]?.justified).toBe('none');
    expect(out.lines[0] !== undefined && 'barsPerStaffHonored' in out.lines[0]).toBe(false);
  });

  it('barsPerStaff 裁决 c：非法 hint（0 / −1 / 1.5 / NaN / ±Infinity / MAX_SAFE_INTEGER + 1）与不给 hint 输出完全一致、不带 honored', () => {
    const none = compose(render, { kind: 'page', contentWidth: 300 });
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const out = compose(render, { kind: 'page', contentWidth: 300, barsPerStaff: bad });
      expect(out).toStrictEqual(none);
      expect(out.lines.every((line) => !('barsPerStaffHonored' in line))).toBe(true);
    }
    // 有效边界 1 与 MAX_SAFE_INTEGER 都算有效 hint（带 honored）。
    for (const ok of [1, Number.MAX_SAFE_INTEGER]) {
      expect(compose(render, { kind: 'page', contentWidth: 300, barsPerStaff: ok }).lines.every((line) => 'barsPerStaffHonored' in line)).toBe(true);
    }
  });

  it('barsPerStaff：`<=` 边界恰好放得下即强制；同一输出里 honored 行与回退行可以混排', () => {
    const mixed = renderOf([['jianpu', 'CD|CD|CDEFGABc|cBAGFEDC|']]);
    const wide = compose(mixed, screen(100_000));
    const [d0, d1] = allMeasures(wide).map((m) => m.demandWidth);
    const exact = (d0 ?? 0) + (d1 ?? 0);
    const out = compose(mixed, { kind: 'page', contentWidth: exact, barsPerStaff: 2 });
    expect(out.lines.map((line) => [line.measures.map((m) => m.measureOrdinal), line.barsPerStaffHonored])).toEqual([
      [[0, 1], true], [[2], false], [[3], false],
    ]);
    const short = compose(mixed, { kind: 'page', contentWidth: exact - TICK, barsPerStaff: 2 });
    expect(short.lines[0]?.barsPerStaffHonored).toBe(false);
  });
});

describe('T4-2 —— fallback、诊断、输入不变、确定性、源码约束', () => {
  it('只有 fallback 声部的 group：一行、none、宽 0', () => {
    const out = compose(renderOf([['', 'CDEF|GABc|']]), screen(100));
    expect(out.lines.map((line) => [line.measures.length, line.justified, line.width])).toEqual([[2, 'none', 0]]);
  });

  it('diagnostics = renderScore + T1 + T2 + T3，顺序固定，不新增码', () => {
    // measure 0：结构冲突（T2）；measure 1：tuplet 退化（T3，多声部才发）；V:3 brace（T1）。
    // C0：零时值 → RenderScore 级 duration.unrepresentable。
    const render = renderOf([['jianpu', 'CDEF| (3CDE F|C0 D|'], ['jianpu', 'CDEF|| CDEF|']], 'M:4/4\nL:1/8', ['V:3 brace=2 style=jianpu']);
    const grouping = groupVoices(render.score.voices);
    const alignment = alignMeasures(grouping.groups, render.voices);
    const expected = [...render.diagnostics, ...grouping.diagnostics, ...alignment.diagnostics, ...buildMeasureTimings(alignment).diagnostics];
    expect(compose(render).diagnostics).toEqual(expected);
    expect([render.diagnostics.length, grouping.diagnostics.length, alignment.diagnostics.length, buildMeasureTimings(alignment).diagnostics.length].every((n) => n > 0)).toBe(true);
  });

  it('不修改输入；同输入两次逐字段相等', () => {
    const render = renderOf([['tab', 'a0/ a1/ a2/ a3/ |a0 |'], ['jianpu', 'C/D/E/F/|C|']]);
    const before = JSON.stringify(render);
    expect(compose(render, screen(60))).toEqual(compose(render, screen(60)));
    expect(JSON.stringify(render)).toBe(before);
  });

  it('T1 / T2 / T3 在 composeSystem 中各只调用一次（不在 group / measure 循环里重算）', () => {
    const src = readFileSync(join(import.meta.dirname, '../../../src/notation/system/composeSystem.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*import\b[^;]*;/gm, '');
    for (const name of ['groupVoices', 'alignMeasures', 'buildMeasureTimings', 'createVoiceSpacings']) {
      expect([...src.matchAll(new RegExp(`\\b${name}\\(`, 'g'))]).toHaveLength(1);
    }
  });
});

describe('T4-2 —— 全部 fixture 的不变量（§Q4.6、裁决 I / 额外约束 4 / 5）', () => {
  it('width ≥ demandWidth ≥ 每个 raw voice demand；shared 段宽 ≥ 每段需求；full 行严格填满；x 首尾相接', () => {
    let fullLines = 0;
    let sharedChecked = 0;
    for (const [name, width] of fixtureNames.flatMap((n) => [300, 600, 1200].map((w) => [n, w] as const))) {
      const render = matrixScoreFrom(fixtureBytes(name)).renderScore;
      const out = compose(render, screen(width));
      const grouping = groupVoices(render.score.voices);
      const alignment = alignMeasures(grouping.groups, render.voices);
      const timings = buildMeasureTimings(alignment);
      const spacings = createVoiceSpacings(render.score, measurer);
      for (const line of out.lines) {
        const group = alignment.groups[line.groupIndex];
        const groupTimings = timings.groups[line.groupIndex]?.measures ?? [];
        if (line.justified === 'full') {
          fullLines += 1;
          expect(lineTicks(line)).toBe(floorTicks(width));
        }
        line.measures.forEach((m, i) => {
          const prev = line.measures[i - 1];
          expect(m.x).toBe(prev === undefined ? 0 : prev.x + prev.width);
          expect(m.width - m.contentOffsetX).toBeGreaterThanOrEqual(m.demandWidth);
          for (const member of group?.measures[m.measureOrdinal]?.members ?? []) {
            if ('renderVoice' in member) expect(m.demandWidth).toBeGreaterThanOrEqual(spacings(member.renderVoice)[member.slice.index]?.width ?? 0);
          }
          // 独立重算（不经 measureDemand）：按 T3 的 itemIndex → offsetIndex 把每个 voice 的列归到 lead / 段 / tail，
          // 断言几何上的 lead、每段、tail 都 ≥ 该 voice 的 raw 需求（unit，不经量化）。
          const timing = groupTimings[m.measureOrdinal];
          const t = m.timeline;
          if (t !== undefined && timing?.status === 'shared') {
            sharedChecked += 1;
            const edges = [...t.xByOffsetIndex, t.endX];
            const members = group?.measures[m.measureOrdinal]?.members ?? [];
            for (const voiceTiming of timing.voices) {
              const member = members[voiceTiming.memberIndex];
              if (member === undefined || !('renderVoice' in member)) continue;
              const slots = spacings(member.renderVoice)[member.slice.index]?.slots ?? [];
              const offsetOf = new Map(voiceTiming.timed.map((x) => [x.itemIndex, x.offsetIndex]));
              const raw = { lead: 0, tail: 0, segs: edges.slice(1).map(() => 0) };
              let cur = -1;
              member.slice.items.forEach((item, j) => {
                cur = offsetOf.get(j) ?? cur;
                const w = slots[j]?.slot.width ?? 0;
                if (j === member.slice.items.length - 1 && item.event.kind === 'barline') raw.tail += w;
                else if (cur < 0) raw.lead += w;
                else raw.segs[cur] = (raw.segs[cur] ?? 0) + w;
              });
              expect((t.xByOffsetIndex[0] ?? t.endX) - m.contentOffsetX).toBeGreaterThanOrEqual(raw.lead);
              raw.segs.forEach((need, k) => expect((edges[k + 1] ?? 0) - (edges[k] ?? 0)).toBeGreaterThanOrEqual(need));
              expect(m.width - t.endX).toBeGreaterThanOrEqual(raw.tail);
            }
          }
        });
      }
      expect(voicesOf([], render.voices)).toEqual([]);
    }
    expect(fullLines).toBeGreaterThan(0);
    expect(sharedChecked).toBeGreaterThan(0);
  });
});
