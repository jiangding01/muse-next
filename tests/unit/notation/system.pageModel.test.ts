/**
 * M2.5 T9a —— `system/pageModel.ts`：system → page 分配（用户裁决 A–N，2026-10-05）。
 *
 * 用合成 system（只有 `index` / `box.height` / `layers` 有意义）钉住：页面 box 精确几何、页内 gap 边界、零高 system、
 * index 原样、超高独占并封页、诊断（warning / 首层 voice anchor / 顺序 / id / 措辞）、非法输入 RangeError、纯度、
 * 类型边界；再用 T8 page 版式的真实输出做集成（遵守 contentWidth 前置条件）。
 */
import { describe, expect, it } from 'vitest';

import { voiceId } from '../../../src/domain';
import { SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { composeScoreLayout } from '../../../src/notation/system/composeLayout';
import type { ComposedSystemLayout, PageComposedSystemLayout, PageSpec, ScoreSystemLayout } from '../../../src/notation/system/contracts';
import { pageModel } from '../../../src/notation/system/pageModel';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import { matrixScoreFrom } from './renderMatrix.helpers';
import { externalMeasurer as measurer } from './systemExternal.helpers';

const GAP = SYSTEM_METRICS.systemGap;
const FIRST = 827;
const NEXT = 963;

/** 合成 system：首层是给定声部（默认 v1），可额外带若干层；`layerHeights[i]` 缺省为 0。 */
function sys(index: number, height: number, voices: readonly number[] = [1], layerHeights: readonly number[] = []): ScoreSystemLayout {
  return {
    index,
    box: { origin: { x: 0, y: index * 1000 }, width: 682, height },
    groupIndex: 0,
    measures: [],
    layers: voices.map((n, layerIndex) => ({
      voiceId: voiceId(n),
      notation: 'tab',
      layerIndex,
      top: 0,
      height: layerHeights[layerIndex] ?? 0,
    })),
    chordOverlays: [],
    justified: 'none',
  };
}

function page(...heights: readonly number[]): PageComposedSystemLayout {
  return { target: 'page', systems: heights.map((h, i) => sys(i, h)) };
}

const grouping = (input: PageComposedSystemLayout, spec?: PageSpec): number[][] =>
  pageModel(input, spec).model.pages.map((p) => [...p.systemIndices]);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

describe('T9a-0 页面 box（默认与自定义 PageSpec）', () => {
  it('默认首页 / 续页三个 box 精确几何；首页与续页只差 header 高', () => {
    const [first, next] = pageModel(page(FIRST, NEXT)).model.pages;
    const box = (x: number, y: number, width: number, height: number) => ({ origin: { x, y }, width, height });
    expect(first).toMatchObject({
      index: 0,
      headerBox: box(56, 56, 682, 160),
      contentBox: box(56, 216, 682, 827),
      footerBox: box(56, 1043, 682, 24),
    });
    expect(next).toMatchObject({
      index: 1,
      headerBox: box(56, 56, 682, 24),
      contentBox: box(56, 80, 682, 963),
      footerBox: box(56, 1043, 682, 24),
    });
  });

  const custom: PageSpec = {
    width: 500,
    height: 700,
    marginTop: 10,
    marginRight: 20,
    marginBottom: 30,
    marginLeft: 40,
    firstPageHeaderHeight: 50,
    continuationHeaderHeight: 60,
    footerHeight: 70,
  };
  /** 由 PageSpec 字段按公式推导的内容高（不写来源不明的数字）。 */
  const capacityOf = (spec: PageSpec, header: number): number =>
    spec.height - spec.marginTop - spec.marginBottom - header - spec.footerHeight;

  it('自定义 PageSpec 的 9 个字段各自生效；默认值取自 SYSTEM_METRICS.page（只比较值）', () => {
    const spec = custom;
    const result = pageModel(page(540, 530), spec);
    const box = (y: number, height: number) => ({ origin: { x: 40, y }, width: 440, height });
    const [first, next] = result.model.pages;
    expect([first?.headerBox, first?.contentBox, first?.footerBox]).toEqual([box(10, 50), box(60, 540), box(600, 70)]);
    expect([next?.headerBox, next?.contentBox, next?.footerBox]).toEqual([box(10, 60), box(70, 530), box(600, 70)]);
    expect([first?.overflow, next?.overflow]).toEqual([false, false]);
    expect(result.model.pageSpec).toEqual(spec);
    expect(pageModel(page(1)).model.pageSpec).toEqual(SYSTEM_METRICS.page);
  });

  it('自定义 PageSpec 的容量真正用于分页 / overflow：capacity 不溢出、capacity + 1 溢出（默认容量下都放得下）', () => {
    const first = capacityOf(custom, custom.firstPageHeaderHeight);
    const next = capacityOf(custom, custom.continuationHeaderHeight);
    expect(first + 1).toBeLessThan(FIRST);
    expect(next + 1).toBeLessThan(NEXT);
    const overflowOf = (...heights: number[]): boolean[] => pageModel(page(...heights), custom).model.pages.map((p) => p.overflow);
    expect(overflowOf(first)).toEqual([false]);
    expect(overflowOf(first + 1)).toEqual([true]);
    expect(overflowOf(first, next)).toEqual([false, false]);
    expect(overflowOf(first, next + 1)).toEqual([false, true]);
    expect(pageModel(page(first + 1)).model.pages.map((p) => p.overflow)).toEqual([false]);
  });
});

describe('T9a-1 分页与 gap 边界（裁决 C / E / K）', () => {
  it('空输入 → 0 页、0 诊断', () => {
    expect(pageModel({ target: 'page', systems: [] })).toEqual({ model: { pages: [], pageSpec: SYSTEM_METRICS.page }, diagnostics: [] });
  });

  it('1 个 system；恰好填满首页内容高不翻页、不 overflow', () => {
    expect(grouping(page(100))).toEqual([[0]]);
    expect(pageModel(page(FIRST)).model.pages.map((p) => p.overflow)).toEqual([false]);
  });

  it('两个 system + 一个 gap 恰好填满（≤）；多 1 unit 即翻页', () => {
    const half = (FIRST - GAP) / 2;
    expect(grouping(page(half, half))).toEqual([[0, 1]]);
    expect(grouping(page(half, half + 1))).toEqual([[0], [1]]);
  });

  it('页首无 gap、翻页后首 system 不继承 gap：首页恰满后，续页恰好装下 963 高', () => {
    expect(grouping(page(FIRST, NEXT))).toEqual([[0], [1]]);
    expect(pageModel(page(FIRST, NEXT)).model.pages.map((p) => p.overflow)).toEqual([false, false]);
  });

  it('首页容量小于续页：同一组 [500, 400] 在首页放不下、在续页放得下', () => {
    expect(grouping(page(500, 400))).toEqual([[0], [1]]);
    expect(grouping(page(FIRST, 500, 400))).toEqual([[0], [1, 2]]);
  });

  it('续页同样无页首 gap：500 + gap + 439 恰好装满续页 963；440 即翻页', () => {
    expect(grouping(page(FIRST, 500, NEXT - GAP - 500))).toEqual([[0], [1, 2]]);
    expect(grouping(page(FIRST, 500, NEXT - GAP - 499))).toEqual([[0], [1], [2]]);
  });

  it('零高 system 照样占相邻 gap：0 + gap + 803 恰满，804 翻页', () => {
    expect(grouping(page(0, FIRST - GAP))).toEqual([[0, 1]]);
    expect(grouping(page(0, FIRST - GAP + 1))).toEqual([[0], [1]]);
  });

  it('零高 system 作页尾不留 trailing gap；连续零高的 gap 个数正确', () => {
    expect(grouping(page(FIRST - GAP, 0, NEXT))).toEqual([[0, 1], [2]]);
    expect(grouping(page(FIRST - 2 * GAP, 0, 0))).toEqual([[0, 1, 2]]);
    expect(grouping(page(FIRST - 2 * GAP + 1, 0, 0))).toEqual([[0, 1], [2]]);
  });

  it('systemIndices 取 ScoreSystemLayout.index（4 / 7 / 11），不是数组下标；页序 0-based 连续', () => {
    const input: PageComposedSystemLayout = { target: 'page', systems: [sys(4, FIRST), sys(7, 400), sys(11, 500), sys(12, 900)] };
    const { pages } = pageModel(input).model;
    expect(pages.map((p) => [p.index, [...p.systemIndices]])).toEqual([[0, [4]], [1, [7, 11]], [2, [12]]]);
  });
});

describe('T9a-2 超高 system（裁决 F / G / N）', () => {
  const overflowOf = (input: PageComposedSystemLayout): boolean[] => pageModel(input).model.pages.map((p) => p.overflow);

  it('== 容量不 overflow；> 容量 overflow（首页 828）', () => {
    expect(overflowOf(page(FIRST))).toEqual([false]);
    expect(overflowOf(page(FIRST + 1))).toEqual([true]);
  });

  it('当前页已有内容后遇超高 → 超高另开一页并封页；其后的普通 system 再开新页', () => {
    expect(grouping(page(100, 1000, 50))).toEqual([[0], [1], [2]]);
    expect(overflowOf(page(100, 1000, 50))).toEqual([false, true, false]);
  });

  it('连续两个超高 → 两页，各自 overflow', () => {
    expect(grouping(page(1000, 1000))).toEqual([[0], [1]]);
    expect(overflowOf(page(1000, 1000))).toEqual([true, true]);
  });

  it('全谱首个 system 900 高：留在首页并 overflow（即使续页 963 放得下），不造空首页', () => {
    expect(grouping(page(900))).toEqual([[0]]);
    expect(overflowOf(page(900))).toEqual([true]);
    expect(grouping(page(900, 10))).toEqual([[0], [1]]);
    expect(overflowOf(page(FIRST, 900))).toEqual([false, false]);
  });

  it('layers 为空的 system 一律 RangeError（不只在 overflow 时检查）', () => {
    const empty: ScoreSystemLayout = { ...sys(3, 10), layers: [] };
    expect(() => pageModel({ target: 'page', systems: [sys(0, 10), empty] })).toThrow(RangeError);
  });
});

describe('T9a-2 overflow 诊断（裁决 B / G）', () => {
  it('warning、code、首层 voice anchor（首层即使高 0 也取它，不取第二层）；只含 page code', () => {
    // 首层高 0、第二层高 50：anchor 仍取首层（固定 layers[0]，不是「撑高的那层」）。
    const input: PageComposedSystemLayout = { target: 'page', systems: [sys(5, 1000, [3, 2], [0, 50])] };
    const { diagnostics } = pageModel(input);
    expect(diagnostics).toHaveLength(1);
    const anchor = { kind: 'voice', voiceId: voiceId(3) };
    expect(diagnostics[0]).toMatchObject({ code: CODES.systemPageOverflow, level: 'warning', anchor });
    expect(diagnostics[0]).not.toHaveProperty('sourceRef');
  });

  it('按 system 顺序、id 稳定：同一首层声部的两次 overflow 序号 #0 / #1；措辞只描述 system / 页事实', () => {
    const input: PageComposedSystemLayout = { target: 'page', systems: [sys(2, 1000, [1]), sys(3, 10, [2]), sys(4, 2000, [1])] };
    const { diagnostics } = pageModel(input);
    expect(diagnostics.map((d) => d.id)).toEqual([`voice:v1|${CODES.systemPageOverflow}#0`, `voice:v1|${CODES.systemPageOverflow}#1`]);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'system 2 的高度 1000 超过第 1 页内容框高度 827：独占该页，不拆分、不缩放',
      'system 4 的高度 2000 超过第 3 页内容框高度 963：独占该页，不拆分、不缩放',
    ]);
    for (const d of diagnostics) expect(d.message).not.toMatch(/v1|声部|层|导致|原因/);
  });
});

describe('T9a 输入校验（裁决 D）', () => {
  const base = SYSTEM_METRICS.page;
  /** 让某种页内容高恰好为 0 的 header 高（由默认 spec 按公式推导）。 */
  const zeroContentHeader = base.height - base.marginTop - base.marginBottom - base.footerHeight;
  it.each([
    ['width 0', { width: 0 }],
    ['width Infinity', { width: Number.POSITIVE_INFINITY }],
    ['height NaN', { height: Number.NaN }],
    ['height 负', { height: -1 }],
    ['marginTop 负', { marginTop: -1 }],
    ['marginRight NaN', { marginRight: Number.NaN }],
    ['marginBottom Infinity', { marginBottom: Number.POSITIVE_INFINITY }],
    ['marginLeft 负', { marginLeft: -0.5 }],
    ['firstPageHeaderHeight 负', { firstPageHeaderHeight: -1 }],
    ['continuationHeaderHeight NaN', { continuationHeaderHeight: Number.NaN }],
    ['footerHeight 负', { footerHeight: -1 }],
    ['内容宽 = 0', { marginLeft: base.width - base.marginRight }],
    ['首页内容高 = 0', { firstPageHeaderHeight: zeroContentHeader }],
    ['续页内容高 = 0（首页仍为正）', { continuationHeaderHeight: zeroContentHeader }],
    ['续页内容高 < 0（首页仍为正）', { continuationHeaderHeight: zeroContentHeader + 1 }],
  ] as const)('PageSpec %s → RangeError', (_label, patch) => {
    expect(() => pageModel(page(10), { ...base, ...patch })).toThrow(RangeError);
  });

  it('PageSpec 对所有调用均校验：systems 为空时非法 spec 仍 RangeError', () => {
    const empty: PageComposedSystemLayout = { target: 'page', systems: [] };
    expect(() => pageModel(empty, { ...base, width: 0 })).toThrow(RangeError);
    expect(() => pageModel(empty, { ...base, continuationHeaderHeight: zeroContentHeader })).toThrow(RangeError);
  });

  it('边距 / 页眉页脚为 0 合法', () => {
    const zero: PageSpec = {
      ...base,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      marginLeft: 0,
      firstPageHeaderHeight: 0,
      continuationHeaderHeight: 0,
      footerHeight: 0,
    };
    expect(pageModel(page(base.height), zero).model.pages[0]?.overflow).toBe(false);
  });

  it.each([['NaN', Number.NaN], ['负', -1], ['Infinity', Number.POSITIVE_INFINITY]] as const)(
    'system 高度 %s → RangeError',
    (_label, height) => {
      expect(() => pageModel(page(10, height))).toThrow(RangeError);
    },
  );
});

describe('T9a 纯度与类型边界（裁决 A / H / I）', () => {
  it('深冻结输入照常工作、不改输入；两次结果逐字段相等；不写 barsPerStaffHint', () => {
    const input = page(300, 400, 1000, 0, 500);
    const snapshot = JSON.stringify(input);
    const frozen = deepFreeze(page(300, 400, 1000, 0, 500));
    expect(pageModel(frozen)).toEqual(pageModel(input));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect('barsPerStaffHint' in pageModel(input).model).toBe(false);
  });

  it('分页只看顺序与 box.height：打乱 origin.x / origin.y / width 不影响结果', () => {
    const input = page(300, 400, 1000, 0, 500, 600, 700);
    const scrambled: PageComposedSystemLayout = {
      target: 'page',
      systems: input.systems.map((s, i) => ({ ...s, box: { ...s.box, origin: { x: -54 * i, y: -7 * s.box.origin.y }, width: 9999 } })),
    };
    expect(pageModel(scrambled)).toEqual(pageModel(input));
  });

  it('screen 产物与未收窄的 ComposedSystemLayout 在编译期被拒绝', () => {
    const screenLayout: ComposedSystemLayout = { target: 'screen', systems: [] };
    // @ts-expect-error screen 产物不得进入 pageModel
    expect(() => pageModel({ target: 'screen', systems: [] })).not.toThrow();
    // @ts-expect-error target 未收窄为 'page' 的 compose 产物同样拒绝
    expect(() => pageModel(screenLayout)).not.toThrow();
  });
});

describe('T9a 集成：T8 page 版式真实输出直接喂入（遵守 contentWidth 前置条件）', () => {
  const specs: readonly PageSpec[] = [SYSTEM_METRICS.page, { ...SYSTEM_METRICS.page, width: 600, height: 520 }];

  it.each(fixtureNames.map((name) => [name] as const))('%s', (name) => {
    const source = matrixScoreFrom(fixtureBytes(name));
    for (const spec of specs) {
      const contentWidth = spec.width - spec.marginLeft - spec.marginRight;
      const composed = composeScoreLayout(source.renderScore, source.index, measurer, { kind: 'page', contentWidth }).composed;
      if (composed.target !== 'page') throw new Error('page target');
      const { model, diagnostics } = pageModel({ target: composed.target, systems: composed.systems }, spec);
      expect(model.pages.flatMap((p) => p.systemIndices)).toEqual(composed.systems.map((s) => s.index));
      const heightOf = new Map(composed.systems.map((s) => [s.index, s.box.height]));
      for (const p of model.pages) {
        const used = p.systemIndices.reduce((sum, i, k) => sum + (k === 0 ? 0 : GAP) + (heightOf.get(i) ?? Number.NaN), 0);
        if (p.overflow) expect(p.systemIndices).toHaveLength(1);
        else expect(used).toBeLessThanOrEqual(p.contentBox.height);
      }
      expect(diagnostics.map((d) => d.code)).toEqual(model.pages.filter((p) => p.overflow).map(() => CODES.systemPageOverflow));
    }
  });
});
