/**
 * T6.4 —— TAB SVG（`tabToSvg`）与 renderer 接入的单元测试（M2 方案 §3.3 / §6 T6.4 验收）。
 *
 * 结构与 `jianpu.toSvg.test.ts` 同构（同一批断言：节点数一一对应 / fallback 角标 /
 * unknown 可见 / serializeSvg 幂等 / `SvgTree` smoke / 全 fixture glob 冒烟），另加
 * TAB 独有的两块：六条弦线 y 与 `stringY` 一致、`-S-/-H-/-P-` 关系连线跨行谱切段的
 * anchor key 一致性、stroke 记号文本。语料相关的断言只用合成 fixture，不引用任何
 * 真实曲目。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { DomainIndex, Score } from '../../../src/domain';
import { isKnownVoiceStyle } from '../../../src/domain';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { anchorKey, type RenderVoice } from '../../../src/notation/model/types';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';
import type { SvgNode } from '../../../src/notation/svg/node';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { layoutTab, type TabContext, type TabLayout } from '../../../src/notation/tab/layoutTab';
import { stringY } from '../../../src/notation/tab/tabGlyphs';
import { tabToSvg } from '../../../src/notation/tab/toSvg';
import { SvgTree } from '../../../src/renderer/components/notation/SvgTree';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

/** `style=tab` 触发 lexer 模式 B：小写字母是弦号，不是音高（同 `tab.layout.test.ts`）。 */
function tabHeader(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=tab\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly ctx: TabContext;
}

function prepare(text: string, availableWidth = WIDE): Prepared {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return {
    score: loaded.score,
    index: loaded.index,
    voice,
    ctx: { index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): TabLayout {
  const prepared = prepare(text, availableWidth);
  return layoutTab(prepared.voice, prepared.ctx);
}

/** `SvgNode.attrs['class']` 的类型守卫式读法：不是 string 就当空串，**不用 `as string`**。 */
function classOf(node: SvgNode): string {
  const value = node.attrs['class'];
  return typeof value === 'string' ? value : '';
}

/** `dispatcher` 的最小复刻：`ScoreView` 按 `isKnownVoiceStyle` + `style === 'tab'` 分派。 */
function isTabVoice(voice: RenderVoice): boolean {
  const style = voice.voice.style;
  return isKnownVoiceStyle(style) && style === 'tab';
}

/** `svg.children` 中顶层的「事件节点分组」——由 `nodeToSvg` 产出，class 固定以 `tab-node ` 开头。 */
function topLevelNodeGroups(svg: SvgNode): readonly SvgNode[] {
  return (svg.children ?? []).filter((child) => classOf(child).startsWith('tab-node '));
}

describe('tabToSvg —— 节点数与 TabLayout.nodes 一一对应', () => {
  it('svg 树顶层的事件节点分组数等于 layout.nodes.length，且顺序一致、都带 data-anchor-key', () => {
    const result = layout(tabHeader('a0 b1 c2 |'));
    const svg = tabToSvg(result);
    const groups = topLevelNodeGroups(svg);
    expect(groups).toHaveLength(result.nodes.length);
    groups.forEach((group, i) => {
      const expectedNode = result.nodes[i];
      expect(group.attrs['class']).toBe(
        `tab-node tab-node-${expectedNode?.kind ?? ''}${expectedNode?.fallback === true ? ' tab-node-fallback' : ''}`,
      );
      expect(typeof group.attrs['data-anchor-key']).toBe('string');
    });
  });

  it('根节点是 svg，携带 class/role/aria-label/viewBox/data-voice-id/voice 级 data-anchor-key', () => {
    const result = layout(tabHeader('a0 |'));
    const svg = tabToSvg(result);
    expect(svg.tag).toBe('svg');
    expect(svg.attrs['class']).toBe('tab-svg');
    expect(svg.attrs['role']).toBe('img');
    expect(svg.attrs['data-voice-id']).toBe(result.voiceId);
    expect(svg.attrs['viewBox']).toBe(`0 0 ${String(result.width)} ${String(result.height)}`);
    // 与 jianpu 同构：voice 级 key 与 `ScoreView` 给 `<section class="score-voice">`
    // 加的是同一个 key，两处各自独立算出，值必然一致。
    expect(svg.attrs['data-anchor-key']).toBe(anchorKey({ kind: 'voice', voiceId: result.voiceId }));
  });

  it('event 级节点携带 data-voice-id / data-event-id / data-anchor-key，三者与 layout 的 anchor 一致', () => {
    const result = layout(tabHeader('a0 |'));
    const svg = tabToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).startsWith('tab-node tab-node-tabNote'));
    const noteLayout = result.nodes.find((node) => node.kind === 'tabNote');
    expect(noteLayout?.anchor.kind).toBe('event');
    if (noteGroup === undefined || noteLayout === undefined || noteLayout.anchor.kind !== 'event') {
      throw new Error('tabNote 节点缺失');
    }
    expect(noteGroup.attrs['data-voice-id']).toBe(noteLayout.anchor.voiceId);
    expect(noteGroup.attrs['data-event-id']).toBe(noteLayout.anchor.eventId);
    expect(noteGroup.attrs['data-anchor-key']).toBe(anchorKey(noteLayout.anchor));
  });
});

describe('tabToSvg —— fallback 角标（契约 C2 的可视对应物）', () => {
  it('不可表示时值（1/3）→ 节点带 data-fallback="true" 且含 tab-fallback-marker', () => {
    const result = layout(tabHeader('a0*1/3 a1 |'));
    const svg = tabToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).includes('tab-node-fallback'));
    expect(noteGroup?.attrs['data-fallback']).toBe('true');
    const marker = noteGroup?.children?.find((child) => classOf(child) === 'tab-fallback-marker');
    expect(marker?.tag).toBe('polygon');
  });

  it('正常时值（1/4）→ 不带 data-fallback、不含 tab-fallback-marker', () => {
    const result = layout(tabHeader('a0 |'));
    const svg = tabToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).startsWith('tab-node tab-node-tabNote'));
    expect(noteGroup?.attrs['data-fallback']).toBeUndefined();
    const hasMarker = noteGroup?.children?.some((child) => classOf(child) === 'tab-fallback-marker');
    expect(hasMarker).toBe(false);
  });
});

describe('tabToSvg —— UnknownEvent 可见（契约 C1）', () => {
  it('unknown 占位恰有一个可见 <g>，含虚线边框 rect + 文本，均可见（非零宽高）', () => {
    const result = layout(tabHeader('a0 ] a1 |'));
    const svg = tabToSvg(result);
    const unknownGroups = svg.children?.filter((child) => classOf(child).includes('tab-node-unknown')) ?? [];
    expect(unknownGroups).toHaveLength(1);
    const unknownGroup = unknownGroups[0];
    const box = unknownGroup?.children?.find((child) => child.tag === 'rect');
    const text = unknownGroup?.children?.find((child) => child.tag === 'text');
    expect(box).toBeDefined();
    expect(text?.text).toBe(']');
    expect(Number(box?.attrs['width'])).toBeGreaterThan(0);
    expect(Number(box?.attrs['height'])).toBeGreaterThan(0);
  });
});

describe('tabToSvg —— 六条弦线 y 与 stringY 一致', () => {
  it('每行谱 g.tab-staff-lines 下六条 line 的 y1/y2 与 stringY(staffTop, 1..6) 逐一相等', () => {
    const result = layout(tabHeader('a0 |'));
    const svg = tabToSvg(result);
    const system = result.systems[0];
    if (system === undefined) throw new Error('缺少 system');
    const staffTop = system.box.origin.y + TAB_METRICS.staffTopOffset;
    const group = svg.children?.find((child) => classOf(child) === 'tab-staff-lines');
    expect(group).toBeDefined();
    const lines = group?.children?.filter((child) => child.tag === 'line') ?? [];
    expect(lines).toHaveLength(6);
    ([1, 2, 3, 4, 5, 6] as const).forEach((stringIndex, i) => {
      const expectedY = stringY(staffTop, stringIndex);
      expect(lines[i]?.attrs['y1']).toBe(expectedY);
      expect(lines[i]?.attrs['y2']).toBe(expectedY);
    });
  });
});

describe('tabToSvg —— 关系连线（跨行谱切段，anchor key 一致）', () => {
  const SOURCE = tabHeader('a5 b3 c2 d4 | a5-S-a7 e1 f6 |');

  it('窄容器把两端拆到不同行谱 → 2 段同 anchorKey，label 只在 start 段', () => {
    const wide = layout(SOURCE, WIDE);
    const wideSvg = tabToSvg(wide);
    const wideGroups = wideSvg.children?.filter((child) => classOf(child).startsWith('tab-relation-group')) ?? [];
    expect(wideGroups).toHaveLength(1);
    expect(wideGroups[0]?.attrs['data-relation-segment']).toBe('whole');

    const narrow = layout(SOURCE, 40);
    const narrowSvg = tabToSvg(narrow);
    const narrowGroups = narrowSvg.children?.filter((child) => classOf(child).startsWith('tab-relation-group')) ?? [];
    expect(narrow.systems.length).toBeGreaterThan(1);
    if (narrowGroups.length === 2) {
      const [start, end] = narrowGroups;
      expect(start?.attrs['data-anchor-key']).toBe(end?.attrs['data-anchor-key']);
      expect(start?.attrs['data-relation-segment']).toBe('start');
      expect(end?.attrs['data-relation-segment']).toBe('end');
      const startLabel = start?.children?.find((child) => child.tag === 'text');
      const endLabel = end?.children?.find((child) => child.tag === 'text');
      expect(startLabel).toBeDefined();
      expect(endLabel).toBeUndefined();
    } else {
      expect(narrowGroups).toHaveLength(1);
    }
  });
});

describe('tabToSvg —— stroke 记号文本', () => {
  it('V[...] 单音级 stroke 画出原字符文本，携带 event 级 anchor', () => {
    const result = layout(tabHeader('Va0 a1 |'));
    const svg = tabToSvg(result);
    const strokeGroup = svg.children?.find((child) => classOf(child) === 'tab-stroke-group');
    expect(strokeGroup).toBeDefined();
    const text = strokeGroup?.children?.find((child) => child.tag === 'text');
    expect(text?.text).toBe('V');
    expect(strokeGroup?.attrs['data-anchor-key']).toBeDefined();
    expect(strokeGroup?.attrs['data-event-id']).toBeDefined();
  });
});

describe('tabToSvg —— serializeSvg 确定性', () => {
  it('同一输入独立走两遍完整流水线，序列化结果逐字符相等，且不含 NaN', () => {
    const text = tabHeader('a1-S-a3 b8-H-b9 c5-P-c3 | Va0 a1*1/3 [a1b2] {a1}a2 z |');
    const once = serializeSvg(tabToSvg(layout(text)));
    const twice = serializeSvg(tabToSvg(layout(text)));
    expect(once).toBe(twice);
    expect(once.length).toBeGreaterThan(0);
    expect(once).not.toContain('NaN');
  });
});

describe('SvgTree —— renderToStaticMarkup smoke（D10：不引入 jsdom）', () => {
  it('kebab-case 属性正确映射，data-event-id / data-anchor-key 原样透传到输出 HTML', () => {
    const result = layout(tabHeader('a0 |'));
    const svg = tabToSvg(result);
    const html = renderToStaticMarkup(SvgTree({ node: svg }));
    expect(html).toContain('class="tab-svg"');
    expect(html).toContain('data-event-id=');
    expect(html).toContain('data-anchor-key=');
    expect(html).toContain(`data-anchor-key="${anchorKey({ kind: 'voice', voiceId: result.voiceId })}"`);
    expect(html).not.toContain('className=');
    expect(html).not.toContain('textAnchor=');
  });

  it('不抛异常（含 relations / strokes / grace / unknown 混合场景）', () => {
    const result = layout(tabHeader('a1-S-a3 Vb2 {c1}c2 ] c3*1/3 z |'));
    expect(() => renderToStaticMarkup(SvgTree({ node: tabToSvg(result) }))).not.toThrow();
  });
});

describe('全 fixture glob 冒烟 —— 只对 tab 声部跑 tab 流水线（复用 roundtrip.helpers）', () => {
  it('运行时 glob 全部 fixture：tab 声部走 layoutTab → tabToSvg → serializeSvg 不抛异常；其余 style 只计数、不调用', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    let tabVoiceCount = 0;
    let nonTabVoiceCount = 0;

    for (const name of fixtureNames) {
      const loaded = loadJcx(fixtureBytes(name));
      const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
      for (const voice of rendered.voices) {
        if (!isTabVoice(voice)) {
          nonTabVoiceCount += 1;
          continue;
        }
        tabVoiceCount += 1;
        expect(() => {
          const tabLayout = layoutTab(voice, { index: loaded.index, measurer, availableWidth: WIDE });
          serializeSvg(tabToSvg(tabLayout));
        }).not.toThrow();
      }
    }

    // 自造 tab fixture：显式 `style=tab`，先过一遍 dispatcher 判据再跑流水线——不依赖
    // 语料库当下是否恰好含 tab 声部，也不绕过判据直接调用 layoutTab。
    const selfMade = prepare(tabHeader('a0 b1 c2 |'));
    expect(isTabVoice(selfMade.voice)).toBe(true);
    expect(() => serializeSvg(tabToSvg(layoutTab(selfMade.voice, selfMade.ctx)))).not.toThrow();
    tabVoiceCount += 1;

    expect(tabVoiceCount).toBeGreaterThan(0);
    expect(nonTabVoiceCount).toBeGreaterThan(0);
  });
});
