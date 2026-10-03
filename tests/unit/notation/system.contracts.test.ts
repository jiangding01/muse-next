/**
 * M2.5 T0 —— `system/contracts.ts` 类型契约、`SYSTEM_METRICS` 与 9 条新诊断码
 * （`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §B.3 / §C / §D T0，T0 裁决 2026-10-04）。
 *
 * 类型级断言用 `@ts-expect-error`：`npm run typecheck` 覆盖 `tests/**`，指令下面那行
 * 如果**不再报错**（契约被放宽），tsc 会以「未使用的 @ts-expect-error」失败。
 * 运行期部分只钉码表与 metrics 的几何合法性；T0 不做任何分页 / 对齐算法。
 */
import { describe, expect, it } from 'vitest';

import { eventId, relationId, voiceId } from '../../../src/domain';
import { NOTATION_METRICS, SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { RENDER_DIAGNOSTIC_CODES } from '../../../src/notation/model/diagnostics';
import type {
  ChordDiagramOverlay,
  ComposedSystemLayout,
  MeasureParticipation,
  PageComposedSystemLayout,
  PageSpec,
} from '../../../src/notation/system/contracts';

const v1 = voiceId(1);

describe('M2.5 T0 —— 9 条新诊断码（只追加、不发放）', () => {
  const EXPECTED = {
    systemGroupSpanOverflow: 'muse.render.system.group-span-overflow',
    systemConnectorNotModeled: 'muse.render.system.connector-not-modeled',
    systemMeasureCountMismatch: 'muse.render.system.measure-count-mismatch',
    systemMeasureStructureConflict: 'muse.render.system.measure-structure-conflict',
    systemMeasureTimingDegraded: 'muse.render.system.measure-timing-degraded',
    chordNameAmbiguous: 'muse.render.chord.name-ambiguous',
    chordSymbolConflict: 'muse.render.chord.symbol-conflict',
    chordDiagramCollision: 'muse.render.chord.diagram-collision',
    systemPageOverflow: 'muse.render.system.page-overflow',
  } as const;

  it.each(Object.entries(EXPECTED))('%s = %s', (key, code) => {
    expect(Object.entries(RENDER_DIAGNOSTIC_CODES)).toContainEqual([key, code]);
  });

  it('整张码表 muse.render. 前缀、值无重复', () => {
    const values: readonly string[] = Object.values(RENDER_DIAGNOSTIC_CODES);
    expect(values.every((code) => code.startsWith('muse.render.'))).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('M2.5 T0 —— ChordDiagramOverlay.anchor 只接受 event 分支（裁决 A）', () => {
  const base = { displayText: 'C', x: 0, y: 0, systemIndex: 0 } as const;

  it('event anchor 可以通过；document / voice / relation 在编译期被拒绝', () => {
    const ok: ChordDiagramOverlay = { ...base, anchor: { kind: 'event', voiceId: v1, eventId: eventId(v1, 0) } };
    // @ts-expect-error document anchor 不是 event 分支
    const documentAnchor: ChordDiagramOverlay = { ...base, anchor: { kind: 'document' } };
    // @ts-expect-error voice anchor 不是 event 分支
    const voiceAnchor: ChordDiagramOverlay = { ...base, anchor: { kind: 'voice', voiceId: v1 } };
    const relationAnchor: ChordDiagramOverlay = {
      ...base,
      // @ts-expect-error relation anchor 不是 event 分支
      anchor: { kind: 'relation', voiceId: v1, relationId: relationId(v1, 'tie', 0) },
    };
    expect(ok.anchor.kind).toBe('event');
    expect([documentAnchor, voiceAnchor, relationAnchor]).toHaveLength(3);
  });
});

describe('M2.5 T0 —— MeasureParticipation 是真正的判别联合', () => {
  it('present / incompatible 必带 localMeasureIndex；absent 不得带', () => {
    const present: MeasureParticipation = { voiceId: v1, kind: 'present', localMeasureIndex: 0 };
    const incompatible: MeasureParticipation = { voiceId: v1, kind: 'incompatible', localMeasureIndex: 2 };
    const absent: MeasureParticipation = { voiceId: v1, kind: 'absent' };
    // @ts-expect-error present 缺 localMeasureIndex
    const presentWithoutIndex: MeasureParticipation = { voiceId: v1, kind: 'present' };
    // @ts-expect-error absent 不得携带 localMeasureIndex
    const absentWithIndex: MeasureParticipation = { voiceId: v1, kind: 'absent', localMeasureIndex: 1 };
    expect([present, incompatible, absent, presentWithoutIndex, absentWithIndex]).toHaveLength(5);
  });
});

describe('M2.5 T0 —— PageComposedSystemLayout 在编译期拒绝 screen 产物（§Q6.4）', () => {
  function acceptsPageOnly(input: PageComposedSystemLayout): number {
    return input.systems.length;
  }

  it('page 产物可传入；screen 字面量与未收窄的 ComposedSystemLayout 都传不进去', () => {
    const screen: ComposedSystemLayout = { target: 'screen', systems: [] };
    expect(acceptsPageOnly({ target: 'page', systems: [] })).toBe(0);
    // @ts-expect-error screen 产物不得进入 pageModel 管线
    expect(acceptsPageOnly({ target: 'screen', systems: [] })).toBe(0);
    // @ts-expect-error target 未收窄为 'page' 的 compose 产物同样拒绝
    expect(acceptsPageOnly(screen)).toBe(0);
  });
});

describe('M2.5 T0 —— SYSTEM_METRICS（产品初值，abstract unit）', () => {
  const page = SYSTEM_METRICS.page satisfies PageSpec;

  it('经 NOTATION_METRICS.system 汇总导出', () => {
    expect(NOTATION_METRICS.system).toBe(SYSTEM_METRICS);
  });

  it('整表等于 2026-10-04 裁决的初值', () => {
    expect(SYSTEM_METRICS).toEqual({
      systemGap: 24,
      layerGap: 8,
      chordBandGap: 6,
      maxJustifyRatio: 1.5,
      minJustifySlack: 2,
      page: {
        width: 794,
        height: 1123,
        marginTop: 56,
        marginRight: 56,
        marginBottom: 56,
        marginLeft: 56,
        firstPageHeaderHeight: 160,
        continuationHeaderHeight: 24,
        footerHeight: 24,
      },
    });
  });

  it('页面几何合法：左右/上下边距之和小于纸张，首页与续页可用高度都 > 0', () => {
    expect(page.width).toBeGreaterThan(page.marginLeft + page.marginRight);
    expect(page.height).toBeGreaterThan(page.marginTop + page.marginBottom);
    const usable = (headerHeight: number): number =>
      page.height - page.marginTop - page.marginBottom - headerHeight - page.footerHeight;
    expect(usable(page.firstPageHeaderHeight)).toBeGreaterThan(0);
    expect(usable(page.continuationHeaderHeight)).toBeGreaterThan(0);
  });

  it('justify 上限是放大比例（> 1），剩余宽阈值非负', () => {
    expect(SYSTEM_METRICS.maxJustifyRatio).toBeGreaterThan(1);
    expect(SYSTEM_METRICS.minJustifySlack).toBeGreaterThanOrEqual(0);
  });
});
