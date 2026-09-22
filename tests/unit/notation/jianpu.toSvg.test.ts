/**
 * T5 —— Jianpu SVG + 头部布局 + React 接入的单元测试（M2 方案 v1.1.1 §6 T5 验收）。
 *
 * 五块内容：
 * 1. `jianpuToSvg` 结构断言：节点数与 `JianpuLayout.nodes` 一一对应、`data-*` 属性
 *    （含统一的 `data-anchor-key`，供 `ScoreView` 高亮联动）、voice 级根节点属性、
 *    fallback 角标、`unknown` 占位可见（边框 + 文本）。
 * 2. `serializeSvg` 幂等 / 确定性：同一输入两次独立走完整条流水线，逐字符相等。
 * 3. `layoutScoreHeader` 结构断言：标题顺序、`K:` 标签不含 `1=`、缺失字段不产生行、
 *    未闭合文本块的诊断、**key/meter 诊断的门控与去重**（只在存在 jianpu 消费声部时
 *    发出，且不随声部数线性增长——这是 producer 层的正确性证据，`ScoreView` 按 id
 *    去重只是兜底，不在这里被当作证明）。
 * 4. `SvgTree` 的 `renderToStaticMarkup` smoke（D10，同 `chord.test.ts` 的做法：
 *    直接调用函数组件、不建 `.tsx`、不引入 jsdom），含 voice 级 `data-anchor-key`
 *    透传到输出 HTML 的断言（P1-3 的可视对应物）。
 * 5. 全 fixture glob 冒烟（复用 `roundtrip.helpers`）：**只对 `style === 'jianpu'`
 *    的声部**跑 `layoutJianpu → jianpuToSvg → serializeSvg` 不抛异常；其余 style
 *    只计数、不调用 `layoutJianpu`。附一份显式 `style=jianpu` 的自造 fixture，先用
 *    `isJianpuVoice` 断言它确实会被判入 jianpu 分支，再跑流水线——不依赖语料库当下
 *    是否恰好含 jianpu 声部，也不绕过 dispatcher 判据直接调用。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { DomainIndex, Score } from '../../../src/domain';
import { isKnownVoiceStyle } from '../../../src/domain';
import { layoutJianpu, type JianpuContext, type JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { jianpuToSvg } from '../../../src/notation/jianpu/toSvg';
import { layoutScoreHeader } from '../../../src/notation/layout/scoreHeader';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { anchorKey, type RenderDiagnostic, type RenderVoice } from '../../../src/notation/model/types';
import { serializeSvg } from '../../../src/notation/svg/serializeSvg';
import type { SvgNode } from '../../../src/notation/svg/node';
import { SvgTree } from '../../../src/renderer/components/notation/SvgTree';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

function header(body: string, fields = 'M:4/4\nL:1/4\nK:C\n'): string {
  return `%MUSE2\nX:1\n${fields}V:1\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly ctx: JianpuContext;
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
    ctx: { score: loaded.score, index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): JianpuLayout {
  const prepared = prepare(text, availableWidth);
  return layoutJianpu(prepared.voice, { ...prepared.ctx, availableWidth });
}

/** `SvgNode.attrs['class']` 的类型守卫式读法：不是 string 就当空串，**不用 `as string`**。 */
function classOf(node: SvgNode): string {
  const value = node.attrs['class'];
  return typeof value === 'string' ? value : '';
}

/** `dispatcher` 的最小复刻：`ScoreView` 按 `isKnownVoiceStyle` + `style === 'jianpu'` 分派。 */
function isJianpuVoice(voice: RenderVoice): boolean {
  const style = voice.voice.style;
  return isKnownVoiceStyle(style) && style === 'jianpu';
}

/** `svg.children` 中顶层的「事件节点分组」——由 `nodeToSvg` 产出，class 固定以 `jianpu-node ` 开头。 */
function topLevelNodeGroups(svg: SvgNode): readonly SvgNode[] {
  return (svg.children ?? []).filter((child) => classOf(child).startsWith('jianpu-node '));
}

describe('jianpuToSvg —— 节点数与 JianpuLayout.nodes 一一对应', () => {
  it('svg 树顶层的事件节点分组数等于 layout.nodes.length，且顺序一致', () => {
    const result = layout(header('CDEF|GABc|'));
    const svg = jianpuToSvg(result);
    const groups = topLevelNodeGroups(svg);
    expect(groups).toHaveLength(result.nodes.length);
    groups.forEach((group, i) => {
      const expectedNode = result.nodes[i];
      expect(group.attrs['class']).toBe(
        `jianpu-node jianpu-node-${expectedNode?.kind ?? ''}${expectedNode?.fallback === true ? ' jianpu-node-fallback' : ''}`,
      );
    });
  });

  it('根节点是 svg，携带 class/role/aria-label/viewBox/data-voice-id/voice 级 data-anchor-key', () => {
    const result = layout(header('CDEF|'));
    const svg = jianpuToSvg(result);
    expect(svg.tag).toBe('svg');
    expect(svg.attrs['class']).toBe('jianpu-score');
    expect(svg.attrs['role']).toBe('img');
    expect(svg.attrs['data-voice-id']).toBe(result.voiceId);
    expect(svg.attrs['viewBox']).toBe(`0 0 ${String(result.width)} ${String(result.height)}`);
    // P1-3：根节点与 `ScoreView` 给 `<section class="score-voice">` 加的是同一个
    // voice 级 key，两处各自独立算出、互不依赖，值必然一致。
    expect(svg.attrs['data-anchor-key']).toBe(anchorKey({ kind: 'voice', voiceId: result.voiceId }));
  });

  it('event 级节点携带 data-voice-id / data-event-id / data-anchor-key，三者与 layout 的 anchor 一致', () => {
    const result = layout(header('C|'));
    const svg = jianpuToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).startsWith('jianpu-node jianpu-node-note'));
    const noteLayout = result.nodes.find((node) => node.kind === 'note');
    expect(noteLayout?.anchor.kind).toBe('event');
    if (noteGroup === undefined || noteLayout === undefined || noteLayout.anchor.kind !== 'event') {
      throw new Error('note 节点缺失');
    }
    expect(noteGroup.attrs['data-voice-id']).toBe(noteLayout.anchor.voiceId);
    expect(noteGroup.attrs['data-event-id']).toBe(noteLayout.anchor.eventId);
    expect(noteGroup.attrs['data-anchor-key']).toBe(anchorKey(noteLayout.anchor));
  });
});

describe('jianpuToSvg —— fallback 角标（契约 C2 的可视对应物）', () => {
  it('不可表示时值（1/3）→ 节点带 data-fallback="true" 且含 jianpu-fallback-marker', () => {
    const result = layout(header('C1/3 D|'));
    const svg = jianpuToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).includes('jianpu-node-fallback'));
    expect(noteGroup?.attrs['data-fallback']).toBe('true');
    const marker = noteGroup?.children?.find((child) => classOf(child) === 'jianpu-fallback-marker');
    expect(marker?.tag).toBe('polygon');
  });

  it('正常时值（1/4）→ 不带 data-fallback、不含 jianpu-fallback-marker', () => {
    const result = layout(header('C|'));
    const svg = jianpuToSvg(result);
    const noteGroup = svg.children?.find((child) => classOf(child).startsWith('jianpu-node jianpu-node-note'));
    expect(noteGroup?.attrs['data-fallback']).toBeUndefined();
    const hasMarker = noteGroup?.children?.some((child) => classOf(child) === 'jianpu-fallback-marker');
    expect(hasMarker).toBe(false);
  });
});

describe('jianpuToSvg —— UnknownEvent 可见（契约 C1）', () => {
  it('unknown 占位含虚线边框 rect + 文本，均可见（非零宽高）', () => {
    const result = layout(header('C ] D|'));
    const svg = jianpuToSvg(result);
    const unknownGroup = svg.children?.find((child) => classOf(child).includes('jianpu-node-unknown'));
    expect(unknownGroup).toBeDefined();
    const box = unknownGroup?.children?.find((child) => child.tag === 'rect');
    const text = unknownGroup?.children?.find((child) => child.tag === 'text');
    expect(box).toBeDefined();
    expect(text?.text).toBe(']');
    expect(Number(box?.attrs['width'])).toBeGreaterThan(0);
    expect(Number(box?.attrs['height'])).toBeGreaterThan(0);
  });
});

describe('jianpuToSvg —— serializeSvg 确定性', () => {
  it('同一输入独立走两遍完整流水线，序列化结果逐字符相等', () => {
    const text = header('CDEF|(3GAB|C2 z Z @|');
    const once = serializeSvg(jianpuToSvg(layout(text)));
    const twice = serializeSvg(jianpuToSvg(layout(text)));
    expect(once).toBe(twice);
    expect(once.length).toBeGreaterThan(0);
  });
});

describe('SvgTree —— renderToStaticMarkup smoke（D10：不引入 jsdom）', () => {
  it('kebab-case 属性正确映射，data-event-id / data-anchor-key 原样透传到输出 HTML', () => {
    const result = layout(header('C|'));
    const svg = jianpuToSvg(result);
    const html = renderToStaticMarkup(SvgTree({ node: svg }));
    expect(html).toContain('class="jianpu-score"');
    expect(html).toContain('data-event-id=');
    expect(html).toContain('data-anchor-key=');
    // voice 级 key（P1-3）也要在输出里能找到，不只是 event 级的。
    expect(html).toContain(`data-anchor-key="${anchorKey({ kind: 'voice', voiceId: result.voiceId })}"`);
    expect(html).not.toContain('className=');
    expect(html).not.toContain('textAnchor=');
  });

  it('不抛异常', () => {
    const result = layout(header('CDEF|GABc| z Z @|(3CDE|'));
    expect(() => renderToStaticMarkup(SvgTree({ node: jianpuToSvg(result) }))).not.toThrow();
  });
});

describe('layoutScoreHeader —— 标题顺序 / K 标签 / 缺失字段（§3.5 / P1-2）', () => {
  it('主标题取 titles[0]，副标题保持 titles[1..] 的原始顺序、逐条独立', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nT:Primary\nT:Second\nT:Third\nK:C\nV:1\nC|\n');
    const result = layoutScoreHeader(loaded.score, measurer);
    expect(result.title?.text).toBe('Primary');
    expect(result.subtitles.map((line) => line.text)).toEqual(['Second', 'Third']);
  });

  it('K: 标签原样转述 raw，不生成 1=<tonic>', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nK:G\nV:1 style=jianpu\nC|\n');
    const result = layoutScoreHeader(loaded.score, measurer);
    expect(result.key?.text).toBe('K: G');
    expect(result.key?.text).not.toContain('1=');
  });

  it('titles / key / meter / tempo 整体缺席时对应字段省略，不产生占位行', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nV:1\nC|\n');
    const result = layoutScoreHeader(loaded.score, measurer);
    expect(result.title).toBeUndefined();
    expect(result.subtitles).toEqual([]);
    expect(result.key).toBeUndefined();
    expect(result.meter).toBeUndefined();
    expect(result.tempo).toBeUndefined();
  });

  it('未闭合文本块：照常渲染 + 发一条 text-block.unclosed 诊断（且只有这一种 code）', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nK:C\n%%begintext\nhello\nV:1\nC|\n');
    const unclosed = loaded.score.textBlocks.find((block) => !block.closed);
    expect(unclosed).toBeDefined();
    const result = layoutScoreHeader(loaded.score, measurer);
    expect(result.diagnostics.some((d) => d.code === CODES.textBlockUnclosed)).toBe(true);
    expect(result.diagnostics.every((d) => d.anchor.kind === 'document')).toBe(true);
  });
});

describe('layoutScoreHeader —— key/meter 诊断门控 + 去重（P1-2：只在存在 jianpu 消费者时发一次）', () => {
  const KEY_METER_CODES = [CODES.keyAbsent, CODES.keyUnresolved, CODES.keyModeUnrecognized, CODES.meterRaw];

  function countByCode(diagnostics: readonly RenderDiagnostic[]): ReadonlyMap<string, number> {
    const counts = new Map<string, number>();
    for (const diagnostic of diagnostics) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
    return counts;
  }

  it('0 个 jianpu 声部 → 四类诊断都不出现，即便 K:/M: 本身就有问题（raw 调号 + raw 拍号）', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nM:C\nK:???\nV:1\nC|\n');
    expect(loaded.score.voices.some((voice) => voice.style === 'jianpu')).toBe(false);
    const counts = countByCode(layoutScoreHeader(loaded.score, measurer).diagnostics);
    for (const code of KEY_METER_CODES) expect(counts.get(code) ?? 0).toBe(0);
  });

  it('1 个 jianpu 声部 + key/meter 都缺席 → key.absent / meter.raw 各最多一条', () => {
    const loaded = loadJcx('%MUSE2\nX:1\nM:C\nV:1 style=jianpu\nC|\n');
    const counts = countByCode(layoutScoreHeader(loaded.score, measurer).diagnostics);
    expect(counts.get(CODES.keyAbsent)).toBe(1);
    expect(counts.get(CODES.meterRaw)).toBe(1);
  });

  it('2 个 jianpu 声部 → key.absent / meter.raw 仍各只有一条，不随声部数线性增长；全部诊断 id 唯一', () => {
    const loaded = loadJcx(
      '%MUSE2\nX:1\nM:C\nV:1 style=jianpu\nV:2 style=jianpu\n[V:1]\nC|\n[V:2]\nD|\n',
    );
    expect(loaded.score.voices.filter((voice) => voice.style === 'jianpu')).toHaveLength(2);
    const result = layoutScoreHeader(loaded.score, measurer);
    const counts = countByCode(result.diagnostics);
    expect(counts.get(CODES.keyAbsent)).toBe(1);
    expect(counts.get(CODES.meterRaw)).toBe(1);
    // producer 层自身保证 id 唯一——不依赖 ScoreView 合并诊断时的去重兜底。
    const ids = result.diagnostics.map((diagnostic) => diagnostic.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('全 fixture glob 冒烟 —— 只对 jianpu 声部跑 jianpu 流水线（复用 roundtrip.helpers）', () => {
  it('运行时 glob 全部 fixture：jianpu 声部走 layoutJianpu → jianpuToSvg → serializeSvg 不抛异常；其余 style 只计数、不调用', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    let jianpuVoiceCount = 0;
    let nonJianpuVoiceCount = 0;

    for (const name of fixtureNames) {
      const loaded = loadJcx(fixtureBytes(name));
      const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
      for (const voice of rendered.voices) {
        if (!isJianpuVoice(voice)) {
          nonJianpuVoiceCount += 1;
          continue;
        }
        jianpuVoiceCount += 1;
        expect(() => {
          const jianpuLayout = layoutJianpu(voice, {
            score: loaded.score, index: loaded.index, measurer, availableWidth: WIDE,
          });
          serializeSvg(jianpuToSvg(jianpuLayout));
        }).not.toThrow();
      }
    }

    // 自造 jianpu fixture：显式 `style=jianpu`，先过一遍 dispatcher 判据再跑流水线
    // ——不依赖语料库当下是否恰好含 jianpu 声部，也不绕过判据直接调用 layoutJianpu。
    const selfMade = prepare('%MUSE2\nX:1\nM:4/4\nL:1/8\nK:G\nV:1 style=jianpu\nCDEF|GABc|\n');
    expect(isJianpuVoice(selfMade.voice)).toBe(true);
    expect(() => serializeSvg(jianpuToSvg(layoutJianpu(selfMade.voice, selfMade.ctx)))).not.toThrow();
    jianpuVoiceCount += 1;

    expect(jianpuVoiceCount).toBeGreaterThan(0);
    expect(nonJianpuVoiceCount).toBeGreaterThan(0);
  });
});

/**
 * T7.4 —— `layoutScoreHeader` 的 `keyText` 第三态修正 + `staff` 并入消费者谓词。
 *
 * 原判据 `key.raw.trim() !== key.tonic` 没把 `alter` 算进来：`K:Eb` 的 `tonic` 是 `E`，
 * `raw` 是 `Eb`，于是一个干净的降 E 调被误报成「含未识别的调式文本」。现在改用
 * `notation/layout/keySpelling.ts` 的 `keyHasExtraText`（先拼规范形式再比），与五线谱
 * 「画不画调号」用的是同一个判断。
 */
describe('layoutScoreHeader —— keyText 的「额外 mode 文本」判据（T7.4 修正）', () => {
  function keyCodes(source: string): readonly string[] {
    const loaded = loadJcx(source);
    return layoutScoreHeader(loaded.score, measurer).diagnostics.map((d) => d.code);
  }

  function header(key: string, style: string): string {
    return `%MUSE2\nX:1\nM:4/4\nL:1/4\n${key}\nV:1 ${style}\nCDEF|\n`;
  }

  it.each(['K:Eb', 'K:F#', 'K:Bb'])('%s 是干净的调号拼写 → 不发 key.mode-unrecognized', (key) => {
    expect(keyCodes(header(key, 'style=jianpu'))).not.toContain(CODES.keyModeUnrecognized);
  });

  it.each(['K:Dm', 'K:Eb major'])('%s 含规范拼写以外的文本 → 发 key.mode-unrecognized', (key) => {
    expect(keyCodes(header(key, 'style=jianpu'))).toContain(CODES.keyModeUnrecognized);
  });

  it('干净的调号仍原样转述 raw（判据变了，展示文本没变）', () => {
    const loaded = loadJcx(header('K:Eb', 'style=jianpu'));
    expect(layoutScoreHeader(loaded.score, measurer).key?.text).toBe('K: Eb');
  });

  it('style=staff 也是 key/meter 的消费者（T7.4 起并入谓词）', () => {
    const codes = keyCodes(header('K:Dm', 'style=staff'));
    expect(codes).toContain(CODES.keyModeUnrecognized);
  });

  it('既无 jianpu 也无 staff 声部 → 四类 key/meter 诊断一条都不发', () => {
    const codes = keyCodes(header('K:Dm', 'style=tab'));
    for (const code of [CODES.keyAbsent, CODES.keyUnresolved, CODES.keyModeUnrecognized, CODES.meterRaw]) {
      expect(codes).not.toContain(code);
    }
  });
});
