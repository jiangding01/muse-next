/**
 * M2.5 T5-4 —— T4 公共几何 → 三个 voice layout external 路径的集成（输入整理只在测试侧，生产编排归 T8）。
 *
 * - 全部 fixture × 两档宽度：每个记谱声部的 external 布局不抛错（T4 产出必然满足 T5 契约）、C1（每个
 *   RenderItem 恰一个节点、顺序不变）、shared timed x === geometry.x + xByOffsetIndex[k]、Staff stave 边界
 *   === 公共 measure；
 * - Jianpu / TAB 同 onset 三方逐位相等；真实多 group 的全局 systemIndex（第二个 group 不从 0 起）；确定性。
 */
import { describe, expect, it } from 'vitest';

import { equals } from '../../../src/domain';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import { voiceMeasureOnsets } from '../../../src/notation/layout/measureOnsets';
import { splitMeasures } from '../../../src/notation/layout/systems';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { SystemMeasureGeometry } from '../../../src/notation/system/contracts';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';
import type { ExternalInput } from './systemExternal.helpers';
import { composed, externalFor, externalMeasurer, scoreOf, screen, voiceAt } from './systemExternal.helpers';

type Source = ReturnType<typeof matrixScoreFrom>;

interface PlacedNode {
  readonly eventId: string;
  readonly x: number;
}

/** 按 `style` 分派 external 布局；返回事件序的节点 x 与（Staff 才有的）stave 边界。 */
function layoutExternal(voice: RenderVoice, source: Source, external: ExternalInput) {
  const common = { index: source.index, measurer: externalMeasurer, availableWidth: 1, external };
  const meter = source.score.meter === undefined ? {} : { meter: source.score.meter };
  const key = source.score.key === undefined ? {} : { key: source.score.key };
  const eventIdOf = (anchor: { readonly kind: string; readonly eventId?: string }): string => anchor.eventId ?? '';
  switch (voice.voice.style) {
    case 'jianpu': {
      const layout = layoutJianpu(voice, { ...common, score: { ...key, ...meter } });
      return { nodes: layout.nodes.map((n): PlacedNode => ({ eventId: eventIdOf(n.anchor), x: n.x })), staves: undefined };
    }
    case 'tab': {
      const layout = layoutTab(voice, { ...common, ...meter });
      return { nodes: layout.nodes.map((n): PlacedNode => ({ eventId: eventIdOf(n.anchor), x: n.x })), staves: undefined };
    }
    case 'staff': {
      const layout = layoutStaff(voice, { ...common, score: source.score });
      return { nodes: layout.nodes.map((n): PlacedNode => ({ eventId: eventIdOf(n.anchor), x: Number.NaN })), staves: layout.staves };
    }
    default:
      return undefined;
  }
}

function ownGeometry(input: ExternalInput, voice: RenderVoice, local: number): SystemMeasureGeometry | undefined {
  return input.measures.find((m) => m.participation.some((p) => p.voiceId === voice.voiceId && p.kind !== 'absent' && p.localMeasureIndex === local));
}

describe('T5-4 全部 fixture × 两档宽度：T4 产出满足 T5 契约', () => {
  // 单个用例内扫描并计数，下限断言不依赖用例执行顺序（review N3）。
  it('全部 fixture @ 960 / 16：不抛错、C1、shared timed x、Staff stave 边界；扫描不是空转', () => {
    const totals = { voices: 0, timed: 0, staves: 0 };
    for (const name of fixtureNames) {
      const source = matrixScoreFrom(fixtureBytes(name));
      for (const width of [960, 16]) {
        const out = composed(source.renderScore, screen(width));
        for (const voice of source.renderScore.voices) {
          const input = externalFor(out, voice.voiceId);
          const result = layoutExternal(voice, source, input);
          if (result === undefined) continue;
          totals.voices += 1;
          // C1：每个 RenderItem 恰一个节点，事件序不变。
          expect(result.nodes.map((n) => n.eventId), `${name}@${String(width)}`).toEqual(voice.items.map((item) => item.eventId));
          const xOf = new Map(result.nodes.map((n) => [n.eventId, n.x]));
          for (const slice of splitMeasures(voice.items)) {
            const g = ownGeometry(input, voice, slice.index);
            expect(g, `${name}@${String(width)} measure ${String(slice.index)}`).toBeDefined();
            if (g === undefined) continue;
            if (result.staves !== undefined) {
              const stave = result.staves.find((s) => s.measureIndex === slice.index);
              expect([stave?.systemIndex, stave?.x, stave?.width]).toEqual([g.systemIndex, g.x, g.width]);
              totals.staves += 1;
              continue;
            }
            const timeline = g.timeline;
            if (timeline === undefined) continue;
            const onsets = voiceMeasureOnsets(slice);
            if (!onsets.resolved) throw new Error('shared measure 必然 resolved');
            for (const timed of onsets.timed) {
              const k = timeline.offsets.findIndex((o) => equals(o, timed.onset));
              expect(xOf.get(slice.items[timed.itemIndex]?.eventId ?? '')).toBe(g.x + (timeline.xByOffsetIndex[k] ?? Number.NaN));
              totals.timed += 1;
            }
          }
        }
      }
    }
    // 2026-10-05 实测：72 次记谱声部布局（36 声部 × 2 宽度）、248 个 shared timed、28 个 stave；fixture 走运行时
    // glob，只钉下限，防止扫描退化成空转。
    expect(totals.voices).toBeGreaterThanOrEqual(60);
    expect(totals.timed).toBeGreaterThanOrEqual(200);
    expect(totals.staves).toBeGreaterThanOrEqual(20);
  });
});

describe('T5-4 Jianpu / TAB 同 onset 三方逐位相等', () => {
  const source = scoreOf([['jianpu', '!trill!C2 {g}E F G A B c|C4 "G"D2 E2|'], ['tab', '"Am"a0 a1 [a0b1] a3 a4 a5 a6 a7|a0/2 a1/2 a2 a3 a4 a5 a6 a7 a8|']]);
  const render = source.renderScore;

  it.each([['960', 960], ['narrow', 16]] as const)('%s：两层共有的每个 onset，jianpu x === tab x === geometry.x + xByOffsetIndex[k]', (_label, width) => {
    const out = composed(render, screen(width));
    const [jianpu, tab] = [voiceAt(render, 0), voiceAt(render, 1)];
    const ji = externalFor(out, jianpu.voiceId);
    const ti = externalFor(out, tab.voiceId);
    const jx = layoutExternal(jianpu, source, ji);
    const tx = layoutExternal(tab, source, ti);
    const xByOnset = (voice: RenderVoice, nodes: readonly PlacedNode[], input: ExternalInput): Map<string, number> => {
      const xOf = new Map(nodes.map((n) => [n.eventId, n.x]));
      const map = new Map<string, number>();
      for (const slice of splitMeasures(voice.items)) {
        const g = ownGeometry(input, voice, slice.index);
        const onsets = voiceMeasureOnsets(slice);
        if (g?.timeline === undefined || !onsets.resolved) continue;
        for (const timed of onsets.timed) {
          const k = g.timeline.offsets.findIndex((o) => equals(o, timed.onset));
          map.set(`${String(g.measureOrdinal)}/${String(k)}`, xOf.get(slice.items[timed.itemIndex]?.eventId ?? '') ?? Number.NaN);
          expect(map.get(`${String(g.measureOrdinal)}/${String(k)}`)).toBe(g.x + (g.timeline.xByOffsetIndex[k] ?? Number.NaN));
        }
      }
      return map;
    };
    const jm = xByOnset(jianpu, jx?.nodes ?? [], ji);
    const tm = xByOnset(tab, tx?.nodes ?? [], ti);
    const common = [...jm.keys()].filter((key) => tm.has(key));
    expect(common.length).toBe(10);
    for (const key of common) expect(jm.get(key)).toBe(tm.get(key));
  });
});

describe('T5-4 真实多 group 的全局 systemIndex 与确定性', () => {
  const source = scoreOf([['tab', 'a0 a1 a2 a3 a4 a5 a6 a7|'.repeat(3)], ['jianpu', 'C D E F G A B c|'.repeat(3)]], 'M:4/4\nL:1/8', false);
  const render = source.renderScore;
  const out = composed(render, screen(16));
  const jianpu = voiceAt(render, 1);

  it('第二个 group 的行谱 index 接在第一个 group 之后（不从 0 起）；节点 systemIndex 即 T4 的全局序号', () => {
    const input = externalFor(out, jianpu.voiceId);
    expect(input.systems.map((s) => s.index)).toEqual([3, 4, 5]);
    const layout = layoutJianpu(jianpu, { score: { ...(source.score.meter === undefined ? {} : { meter: source.score.meter }) }, index: source.index, measurer: externalMeasurer, availableWidth: 1, external: input });
    expect([...new Set(layout.nodes.map((n) => n.systemIndex))]).toEqual([3, 4, 5]);
    expect(layout.systems.map((s) => s.index)).toEqual([3, 4, 5]);
  });

  it('同一输入两次布局逐字段相等', () => {
    const input = externalFor(out, jianpu.voiceId);
    const run = () => layoutJianpu(jianpu, { score: {}, index: source.index, measurer: externalMeasurer, availableWidth: 1, external: input });
    expect(run()).toEqual(run());
  });
});
