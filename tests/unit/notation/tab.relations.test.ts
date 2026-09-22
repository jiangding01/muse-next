/**
 * T6.3 —— TAB 关系连线（`-S-`/`-H-`/`-P-`）与单音 stroke 记号（纯数据）测试
 * （M2 方案 §3.3 / §6 T6.3）。
 *
 * 只测**几何数据 + 诊断**，不涉及 `toSvg` / renderer（T6.4）。纯合成 fixture，不引用
 * 任何真实曲目。
 *
 * **同弦契约**（用户裁决，覆盖早前对「跨弦画斜线」的错误期待）：spec §26.6 与
 * `src/formats/jcx/parse/body/pairTabRelations.ts` 的 `resolveSameString` 已经保证
 * `TabRelation` 恒为同弦——两端弦号不同时 parse 层发
 * `jcx.parse.tab-relation.cross-string` 并**不建立关系**，这样的输入根本不会进入
 * `buildTabRelations`。因此下面**没有**任何「跨弦」的合法关系测试，只有一条防御性
 * 用例——手造一条违反此 Domain 不变量的 `TabRelation` 直接喂给 layout，只断言不抛错
 * 且坐标有限，标题明确写出它不是合法 JCX 行为。
 */
import { describe, expect, it } from 'vitest';

import type { DomainIndex, Note, Score, TabRelation } from '../../../src/domain';
import { relationId as makeRelationId, voiceId as makeVoiceId } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { anchorKey } from '../../../src/notation/model/types';
import type { RenderScore } from '../../../src/notation/model/types';
import { layoutTab } from '../../../src/notation/tab/layoutTab';
import type { TabContext, TabLayout } from '../../../src/notation/tab/layoutTab';
import { stringY } from '../../../src/notation/tab/tabGlyphs';
import type { TabNode } from '../../../src/notation/tab/tabGlyphs';
import { TAB_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

/** `style=tab` 触发 lexer 的模式 B（spec §26.1）：小写字母是弦号，不是音高。 */
function tabHeader(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=tab\n${body}\n`;
}

function loaded(text: string): { readonly score: Score; readonly index: DomainIndex } {
  return loadJcx(text);
}

function renderScoreOf(text: string): RenderScore {
  const { score, index } = loaded(text);
  return buildRenderScore({ score, index });
}

function layout(text: string, availableWidth = WIDE): TabLayout {
  const { score, index } = loaded(text);
  const rendered = buildRenderScore({ score, index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  const ctx: TabContext = { index, measurer, availableWidth };
  return layoutTab(voice, ctx);
}

/** 用手造 `Score` 布局：调用方负责保证 `index` 与传入的 `patchedScore` 事件集合一致。 */
function layoutPatched(
  patchedScore: Score,
  index: DomainIndex,
  availableWidth = WIDE,
): TabLayout {
  const rendered = buildRenderScore({ score: patchedScore, index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  const ctx: TabContext = { index, measurer, availableWidth };
  return layoutTab(voice, ctx);
}

function nodesOfKind<K extends TabNode['kind']>(
  result: TabLayout,
  kind: K,
): readonly Extract<TabNode, { kind: K }>[] {
  return result.nodes.filter(
    (node): node is Extract<TabNode, { kind: K }> => node.kind === kind,
  );
}

function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === 'number') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) numbersIn(entry, out);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) numbersIn(entry, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// ① 同弦关系：slide / pull 正常建线；hammer 的跨弦写法不建关系（parse 层已拦）
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 同弦 slide（spec §26.6）', () => {
  it('a5-S-a7|：同弦水平线 + label S，y1 === y2 === 第 1 弦线的 y', () => {
    const result = layout(tabHeader('a5-S-a7 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    if (line === undefined) throw new Error('缺少关系线');
    expect(line.kind).toBe('slide');
    expect(line.segment).toBe('whole');
    expect(line.y1).toBe(line.y2);
    const notes = nodesOfKind(result, 'tabNote');
    const first = notes[0];
    if (first === undefined) throw new Error('缺少 tabNote 节点');
    expect(line.y1).toBe(stringY(first.y, 1));
    expect(line.label?.text).toBe('S');
    expect(line.x1).toBeLessThanOrEqual(line.x2);
  });

  it('a5-P-a3|：pull 同构，label P', () => {
    const result = layout(tabHeader('a5-P-a3 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    if (line === undefined) throw new Error('缺少关系线');
    expect(line.kind).toBe('pull');
    expect(line.label?.text).toBe('P');
    expect(line.y1).toBe(line.y2);
  });
});

describe('TAB 关系连线 —— 跨弦写法不建立关系（parse 层已裁决，不是渲染层的事）', () => {
  it('a5-H-b7|：parse 不建 TabRelation，只发 cross-string warning；layout 不补关系、不重发诊断', () => {
    const source = tabHeader('a5-H-b7 |');
    const { score } = loaded(source);
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    expect(voice.tabRelations).toEqual([]);

    const { diagnostics: lexParseDiagnostics } = loadJcx(source);
    expect(lexParseDiagnostics.map((d) => d.code)).toContain('jcx.parse.tab-relation.cross-string');

    const result = layout(source);
    expect(result.relations).toEqual([]);
    // layout 层没有任何关于 cross-string 的 render 诊断（不重复报，§4.2）。
    for (const diagnostic of result.diagnostics) {
      expect(diagnostic.code).not.toMatch(/cross-string/);
    }
  });
});

// ---------------------------------------------------------------------------
// ② 组内 source → 组外 target 两种主形态
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 组内 source → 组外 target（语料主形态）', () => {
  it('{d8-S-}d10*6|：grace 成员 → 之后的 tabNote，端点取各自字形、不与 bbox 相交', () => {
    const result = layout(tabHeader('{d8-S-}d10*6 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    if (line === undefined) throw new Error('缺少关系线');
    expect(line.kind).toBe('slide');
    expect(line.y1).toBe(line.y2);

    const grace = nodesOfKind(result, 'grace')[0];
    const note = nodesOfKind(result, 'tabNote')[0];
    if (grace === undefined || note === undefined) throw new Error('缺少 grace / tabNote 节点');
    const sourceFret = grace.frets[0];
    if (sourceFret === undefined) throw new Error('grace 应有一个品位字形');
    const sourceRight = sourceFret.backdrop.origin.x + sourceFret.backdrop.width;
    const targetLeft = note.fret.backdrop.origin.x;

    expect(line.x1).toBeGreaterThan(sourceRight);
    expect(line.x2).toBeLessThan(targetLeft);
    expect(line.x1).toBeLessThanOrEqual(line.x2);
  });

  it('[a0/b2]-S-a3|：tabGroup 端成员通过同弦匹配定位（a0 在第 1 弦，与 a3 同弦），非 grace 也能产出该形态', () => {
    const result = layout(tabHeader('[a0/b2]-S-a3 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    if (line === undefined) throw new Error('缺少关系线');
    expect(line.y1).toBe(line.y2);
    expect(line.y1).toBe(stringY(nodesOfKind(result, 'tabGroup')[0]?.y ?? 0, 1));
  });
});

// ---------------------------------------------------------------------------
// ②b 端点身份映射：按 `TabFretGlyph.memberIndex`（Domain 原始下标）直接查找，
// 不靠重放 `tabEventNodes.ts` 的排序算法反推（用户裁决的返工点）。
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 端点身份映射按 memberIndex（Domain 原始下标），不靠重放排序', () => {
  it('reordered tabGroup：[b2/a0]-S-a3|，写入顺序是 b2 在前、a0 在后（memberIndex 1），排序显示却是 a0 在前——relation 命中的是 memberIndex 1（a0，第 1 弦、fret "0"），不是显示位置 0', () => {
    const result = layout(tabHeader('[b2/a0]-S-a3 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    const group = nodesOfKind(result, 'tabGroup')[0];
    if (line === undefined || group === undefined) throw new Error('缺少关系线或 tabGroup 节点');

    const a0Fret = group.frets.find((fret) => fret.memberIndex === 1);
    if (a0Fret === undefined) throw new Error('缺少 memberIndex 1（a0）的字形');
    expect(a0Fret.stringIndex).toBe(1);
    expect(a0Fret.text.text).toBe('0');
    expect(line.y1).toBe(stringY(group.y, 1));
  });

  it('同弦重复 [a0/a12]（parse 因组内同弦成员不唯一而判定 unresolved、不建关系；手造 relation 显式给 memberIndex 1）：按 memberIndex 命中 a12，不会因两个成员同为第 1 弦而误取 memberIndex 0（a0）', () => {
    const { score, index } = loaded(tabHeader('[a0/a12] a15 |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    // 先实测：parse 确实因「组内同弦成员不唯一」判定 unresolved，不自己建这条关系。
    expect(voice.tabRelations).toEqual([]);

    const group = voice.events.find((event) => event.kind === 'tabGroup');
    const targetNote = voice.events.find((event) => event.kind === 'tabNote');
    if (group === undefined || group.kind !== 'tabGroup' || targetNote === undefined) {
      throw new Error('fixture 应含一个 tabGroup 与一个 tabNote');
    }
    expect(group.members).toHaveLength(2);
    expect(group.members[0]?.stringIndex).toBe(group.members[1]?.stringIndex); // 前提：确实同弦

    const relation: TabRelation = {
      id: makeRelationId(makeVoiceId(1), 'slide', 96),
      kind: 'slide',
      origins: [],
      from: { eventId: group.id, memberIndex: 1 },
      to: { eventId: targetNote.id },
    };
    const patchedScore: Score = {
      ...score,
      voices: [{ ...voice, tabRelations: [relation] }],
    };

    const result = layoutPatched(patchedScore, index);
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    const groupNode = nodesOfKind(result, 'tabGroup')[0];
    if (line === undefined || groupNode === undefined) throw new Error('缺少关系线或 tabGroup 节点');

    const expected = groupNode.frets.find((fret) => fret.memberIndex === 1);
    const wrong = groupNode.frets.find((fret) => fret.memberIndex === 0);
    if (expected === undefined || wrong === undefined) throw new Error('缺少品位字形');
    expect(expected.text.text).toBe('12'); // a12
    expect(wrong.text.text).toBe('0'); // a0——两位数与一位数宽度不同，可用 x1 区分命中的是哪一个
    const expectedX1 = expected.backdrop.origin.x + expected.backdrop.width + TAB_METRICS.relationEndGap;
    const wrongX1 = wrong.backdrop.origin.x + wrong.backdrop.width + TAB_METRICS.relationEndGap;
    expect(line.x1).toBe(expectedX1);
    expect(line.x1).not.toBe(wrongX1);
  });

  it('（手造输入：TAB 模式下 parse 从不产出混排 grace——pitch 字母会被独立切成 unknown token，不会被 grace 吸收成成员，见下方"实测"用例）混排 GraceEvent.members = [pitch Note, TabNote]，relation 的 memberIndex 指向下标 1（TabNote）：仍能按原始下标查到该 TabNote 字形，不被 pitch 成员错位', () => {
    const { score, index } = loaded(tabHeader('{d8}d10 |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const grace = voice.events.find((event) => event.kind === 'grace');
    const targetNote = voice.events.find((event) => event.kind === 'tabNote');
    if (grace === undefined || grace.kind !== 'grace' || targetNote === undefined) {
      throw new Error('fixture 应含一个 grace 与一个 tabNote');
    }
    const tabMember = grace.members[0];
    if (tabMember === undefined || 'pitch' in tabMember) throw new Error('fixture grace 成员应为 TabNote');

    // 手造：在 Domain 原始下标 0 处插入一个 pitch 模式 `Note`，TabNote 被推到下标 1——
    // 这是 parse 层在 TAB 声部里不会产生的形态（见文件末尾「实测」小节），仅用于验证
    // `fretGlyphFor` 按 memberIndex 直接查找、不受 pitch 成员混入影响。
    const pitchMember: Note = { pitch: { letter: 'C', register: 'upper' }, origin: tabMember.origin };
    const patchedGrace = { ...grace, members: [pitchMember, tabMember] };
    const patchedEvents = voice.events.map((event) => (event.id === grace.id ? patchedGrace : event));

    const relation: TabRelation = {
      id: makeRelationId(makeVoiceId(1), 'slide', 95),
      kind: 'slide',
      origins: [],
      from: { eventId: grace.id, memberIndex: 1 },
      to: { eventId: targetNote.id },
    };
    const patchedScore: Score = {
      ...score,
      voices: [{ ...voice, events: patchedEvents, tabRelations: [relation] }],
    };
    // `index.eventById` 也要同步改写：`resolveVoiceRelations` 查端点走的是 index，不是
    // `patchedScore` 本身——只改 Score 不改 index，端点会解析到旧的（未混排的）grace。
    const patchedEventById = new Map(index.eventById);
    const foundGrace = patchedEventById.get(grace.id);
    if (foundGrace === undefined) throw new Error('index 应含该 grace 事件');
    patchedEventById.set(grace.id, { ...foundGrace, event: patchedGrace });
    const patchedIndex: DomainIndex = { ...index, eventById: patchedEventById };

    const result = layoutPatched(patchedScore, patchedIndex);
    expect(result.relations).toHaveLength(1);
    const graceNode = nodesOfKind(result, 'grace')[0];
    if (graceNode === undefined) throw new Error('缺少 grace 节点');
    expect(graceNode.frets).toHaveLength(1);
    expect(graceNode.frets[0]?.memberIndex).toBe(1);
    expect(graceNode.outOfScopeTexts).toHaveLength(1); // pitch 成员画成 out-of-scope 占位
  });
});

// ---------------------------------------------------------------------------
// ③ 跨行谱切段
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 跨行谱切段', () => {
  const SOURCE = tabHeader('a5 b3 c2 d4 | a5-S-a7 e1 f6 |');

  /** 每段的 x1/x2 都必须落在它自己所属 system 的 box 内（/check P2：显式 clamp 的可观察结果）。 */
  function expectWithinBox(result: TabLayout, line: { readonly systemIndex: number; readonly x1: number; readonly x2: number }): void {
    const system = result.systems[line.systemIndex];
    if (system === undefined) throw new Error('关系线指向了不存在的 system');
    const left = system.box.origin.x;
    const right = system.box.origin.x + system.box.width;
    expect(line.x1).toBeGreaterThanOrEqual(left);
    expect(line.x1).toBeLessThanOrEqual(right);
    expect(line.x2).toBeGreaterThanOrEqual(left);
    expect(line.x2).toBeLessThanOrEqual(right);
  }

  it('窄容器把两端拆到不同行谱 → 2 段同 anchorKey，label 只在 start 段，每段坐标都落在自己的 system box 内', () => {
    const wide = layout(SOURCE, WIDE);
    expect(wide.systems.length).toBe(1);
    expect(wide.relations).toHaveLength(1);

    const narrow = layout(SOURCE, 40);
    expect(narrow.systems.length).toBeGreaterThan(1);
    const segments = narrow.relations;
    for (const line of segments) expectWithinBox(narrow, line);

    if (segments.length === 2) {
      const [start, end] = segments;
      if (start === undefined || end === undefined) throw new Error('缺少切段');
      expect(start.segment).toBe('start');
      expect(end.segment).toBe('end');
      expect(start.label).toBeDefined();
      expect(end.label).toBeUndefined();
      expect(start.systemIndex).not.toBe(end.systemIndex);
      expect(anchorKey(start.anchor)).toBe(anchorKey(end.anchor));
    } else {
      // 端点仍落在同一行谱（换行边界与关系跨度无关时）：退化为一段，属性照旧成立。
      expect(segments).toHaveLength(1);
    }
  });

  it('诊断数（layout 层）与不换行时相同：切段不产生新的诊断', () => {
    const wideCodes = layout(SOURCE, WIDE).diagnostics.map((d) => d.code).sort();
    const narrowCodes = layout(SOURCE, 40).diagnostics.map((d) => d.code).sort();
    expect(narrowCodes).toEqual(wideCodes);
  });
});

// ---------------------------------------------------------------------------
// ④ 端点缺失（B 类悬空）：不画、不重发诊断
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 端点缺失（B 类悬空）不画、不重发诊断', () => {
  it('memberIndex 越界的手造 TabRelation：不画线，layout 诊断不含 endpoint-missing（已由 buildRenderScore 发过）', () => {
    const { score, index } = loaded(tabHeader('[a0/b2] a3 |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const groupId = voice.events.find((event) => event.kind === 'tabGroup')?.id;
    if (groupId === undefined) throw new Error('fixture 应含一个 tabGroup');

    const danglingRelation: TabRelation = {
      id: makeRelationId(makeVoiceId(1), 'slide', 99),
      kind: 'slide',
      origins: [],
      from: { eventId: groupId, memberIndex: 99 },
      to: { eventId: groupId, memberIndex: 0 },
    };
    const patchedScore: Score = {
      ...score,
      voices: [{ ...voice, tabRelations: [danglingRelation] }],
    };

    const result = layoutPatched(patchedScore, index);
    expect(result.relations).toEqual([]);
    expect(result.diagnostics.map((d) => d.code)).not.toContain(CODES.relationEndpointMissing);

    // 对照：`buildRenderScore` 确实已经发过这条诊断（不是被吞掉了，是分层各司其职）。
    const renderScore = buildRenderScore({ score: patchedScore, index });
    expect(renderScore.diagnostics.map((d) => d.code)).toContain(CODES.relationEndpointMissing);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 手造违反「同弦」不变量的输入（不是合法 JCX 行为，只测不崩、坐标有限）
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 防御性：手造跨弦 TabRelation（违反 Domain 不变量，不是 JCX 合法行为/产品语义）', () => {
  it('直接构造两端弦号不同的 TabRelation 喂给 layout：不抛错，几何仍为有限数（不做斜线特判，也不做跨弦校验）', () => {
    const { score, index } = loaded(tabHeader('a5 b7 |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const [firstId, secondId] = voice.events
      .filter((event) => event.kind === 'tabNote')
      .map((event) => event.id);
    if (firstId === undefined || secondId === undefined) throw new Error('fixture 应含两个 tabNote');

    // 正常 JCX 管线永远不会产出这样的关系（parse 层的 `resolveSameString` 会拦下并发
    // `cross-string` warning、不建立关系）——这里绕过 parse 直接手造，只是为了确认
    // layout 不会因为「万一喂进不该出现的数据」而崩溃，不代表这是一种支持的输入。
    const crossStringRelation: TabRelation = {
      id: makeRelationId(makeVoiceId(1), 'slide', 98),
      kind: 'slide',
      origins: [],
      from: { eventId: firstId },
      to: { eventId: secondId },
    };
    const patchedScore: Score = {
      ...score,
      voices: [{ ...voice, tabRelations: [crossStringRelation] }],
    };

    const result = layoutPatched(patchedScore, index);
    expect(result.relations).toHaveLength(1);
    for (const value of numbersIn(result.relations)) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// ⑥ relationEndGap：线段不与字形 bbox 相交
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— relationEndGap：线段端点不与字形 bbox 相交', () => {
  it('a5-S-a7|：x1 严格大于源字形右缘，x2 严格小于目标字形左缘', () => {
    const result = layout(tabHeader('a5-S-a7 |'));
    const line = result.relations[0];
    const notes = nodesOfKind(result, 'tabNote');
    const [first, second] = notes;
    if (line === undefined || first === undefined || second === undefined) {
      throw new Error('缺少关系线或音符节点');
    }
    const sourceRight = first.fret.backdrop.origin.x + first.fret.backdrop.width;
    const targetLeft = second.fret.backdrop.origin.x;
    expect(line.x1).toBeGreaterThan(sourceRight);
    expect(line.x2).toBeLessThan(targetLeft);
    expect(line.x1).toBeLessThanOrEqual(line.x2);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 整体不变量：坐标有限、确定性
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 整体不变量', () => {
  const MIXED_SOURCE = tabHeader('a5-S-a7 b3-H-c2 | {d8-S-}d10 [a0/b2]-P-a3 |');

  it('所有坐标都是有限数', () => {
    const result = layout(MIXED_SOURCE, 60);
    const values = numbersIn(result.relations);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(Number.isFinite(value)).toBe(true);
  });

  it('纯函数：同一输入两次布局逐字段相等', () => {
    expect(layout(MIXED_SOURCE, 60)).toEqual(layout(MIXED_SOURCE, 60));
  });
});

// ===========================================================================
// stroke —— 单音拨弦 / 扫弦方向记号
// ===========================================================================

describe('TAB stroke —— 单音记号（spec §26.4）', () => {
  it('Va5|：V 记号画在第 1 弦上方，x 落在该列内', () => {
    const result = layout(tabHeader('Va5 |'));
    expect(result.strokes).toHaveLength(1);
    const mark = result.strokes[0];
    const note = nodesOfKind(result, 'tabNote')[0];
    if (mark === undefined || note === undefined) throw new Error('缺少 stroke 记号或 tabNote 节点');
    expect(mark.text.text).toBe('V');
    expect(mark.text.x).toBeGreaterThanOrEqual(note.x);
    expect(mark.text.x).toBeLessThan(note.x + note.width);
    expect(mark.text.y).toBeLessThan(stringY(note.y, 1));
  });

  it('Ha5|：H 记号 + tabStrokeHoldInferred info（I15 位置消歧）', () => {
    const result = layout(tabHeader('Ha5 |'));
    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0]?.text.text).toBe('H');
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabStrokeHoldInferred);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('info');
  });

  it('无 stroke 时不画记号（a5| 没有前缀）', () => {
    const result = layout(tabHeader('a5 |'));
    expect(result.strokes).toEqual([]);
  });

  it('表外字符（手造，lexer 的 strokePrefix 字符表只收 9 种已知符号，正常 JCX 文本产不出表外值）：仍画原字符 + tabStrokeUnrecognized warning', () => {
    const { score, index } = loaded(tabHeader('a5 |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const [event] = voice.events;
    if (event === undefined || event.kind !== 'tabNote') throw new Error('fixture 应以一个 tabNote 开头');

    const patchedEvent = { ...event, note: { ...event.note, stroke: 'Q' } };
    const patchedScore: Score = {
      ...score,
      voices: [{ ...voice, events: [patchedEvent, ...voice.events.slice(1)] }],
    };

    const result = layoutPatched(patchedScore, index);
    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0]?.text.text).toBe('Q');
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabStrokeUnrecognized);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('warning');
  });
});

describe('TAB stroke —— tabGroupStrokeNotModeled（2026-09-22 起不再发放：code 保留仅为兼容/历史，见 model/diagnostics.ts）', () => {
  it('单音声部：不发该 code（`tabStrokes.ts` 已删掉那条无条件 sink 调用）', () => {
    const result = layout(tabHeader('a5 |'));
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabGroupStrokeNotModeled);
    expect(hits).toEqual([]);
  });

  it('含 tabGroup 的声部同样不发（组级 stroke 现在直接画出，不再需要「组不支持」这条降级说明）', () => {
    const result = layout(tabHeader('a5 b3 c2 [a0/b2] {d8}d10 |'));
    const hits = result.diagnostics.filter((d) => d.code === CODES.tabGroupStrokeNotModeled);
    expect(hits).toEqual([]);
  });

  it('非 TAB 声部同样不发（该 code 现在对任何声部都不再发放）', () => {
    const jianpuSource = '%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=jianpu\nC D E F |\n';
    const renderScore = renderScoreOf(jianpuSource);
    expect(renderScore.diagnostics.map((d) => d.code)).not.toContain(CODES.tabGroupStrokeNotModeled);
  });
});

describe('TAB stroke —— tabGroup 成员级 stroke（[Va0/Ub2] 实测可达，parse 逐成员填充）', () => {
  it('两个成员各带 stroke → 一个事件只画一个记号，字符按成员顺序拼接为 "VU"', () => {
    const result = layout(tabHeader('[Va0/Ub2] |'));
    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0]?.text.text).toBe('VU');
  });

  it('槽宽下界并入拼接后的 stroke 文本宽度：槽宽 ≥ "VU" 的量出宽度 + 2×fretPaddingX', () => {
    const result = layout(tabHeader('[Va0/Ub2] |'), 20);
    const group = nodesOfKind(result, 'tabGroup')[0];
    if (group === undefined) throw new Error('缺少 tabGroup 节点');
    const strokeWidth = measurer.measure('VU', { fontSize: TAB_METRICS.strokeFontSize }).width;
    expect(group.width).toBeGreaterThanOrEqual(strokeWidth + 2 * TAB_METRICS.fretPaddingX);
  });

  it('`TabGroupEvent.stroke`（组级前缀 V[...]）parse 层已回填（M2.5 formats preflight，2026-09-22）：组级记号被画出，且不再发 tabGroupStrokeNotModeled', () => {
    const { score } = loaded(tabHeader('V[a0/b2] |'));
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
    const group = voice.events.find((event) => event.kind === 'tabGroup');
    if (group === undefined || group.kind !== 'tabGroup') throw new Error('fixture 应含一个 tabGroup');
    expect(group.stroke).toBe('V');
    expect(group.members.every((member) => member.stroke === undefined)).toBe(true);

    const layoutResult = layout(tabHeader('V[a0/b2] |'));
    expect(layoutResult.strokes).toHaveLength(1);
    expect(layoutResult.strokes[0]?.text.text).toBe('V');
    // `tabStrokes.ts` 已删掉那条无条件 sink：组级 stroke 现在直接画出，不再需要
    // 「组不支持」这条降级说明；code 本身仍保留在 diagnostics.ts（兼容/历史）。
    const hits = layoutResult.diagnostics.filter((d) => d.code === CODES.tabGroupStrokeNotModeled);
    expect(hits).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 跨行谱续行段的最小可见跨度（T6.5，产品决定）
// ---------------------------------------------------------------------------

describe('TAB 关系连线 —— 跨行谱续行段的最小可见跨度（T6.5，产品决定）', () => {
  /** `-S-` 写成独立 marker 才可能把两端分到不同 measure，进而被换行拆到不同行谱。 */
  const CROSS = tabHeader('a5 -S- | a7 |');

  function boxOf(result: TabLayout, systemIndex: number): { left: number; right: number } {
    const system = result.systems[systemIndex];
    if (system === undefined) throw new Error(`第 ${String(systemIndex)} 行谱必须存在`);
    return { left: system.box.origin.x, right: system.box.origin.x + system.box.width };
  }

  it('正常跨行：start / end 两段都至少有 relationContinuationMinSpan 的跨度', () => {
    const result = layout(CROSS, 40);
    expect(result.systems.length).toBeGreaterThan(1);
    expect(result.relations).toHaveLength(2);
    for (const line of result.relations) {
      expect(line.x2 - line.x1).toBeGreaterThanOrEqual(TAB_METRICS.relationContinuationMinSpan);
      const box = boxOf(result, line.systemIndex);
      expect(line.x1).toBeGreaterThanOrEqual(box.left);
      expect(line.x2).toBeLessThanOrEqual(box.right);
    }
    const [start, end] = result.relations;
    if (start === undefined || end === undefined) throw new Error('缺少切段');
    expect(start.segment).toBe('start');
    expect(end.segment).toBe('end');
    // label 仍只在 start 段（续行段没有对端可标注）。
    expect(start.label).toBeDefined();
    expect(end.label).toBeUndefined();
  });

  it('极窄 box（比最小跨度还窄）允许退化：夹在 box 内、仍 finite、不反向', () => {
    // `availableWidth = 1` → 每个 measure 独占一行谱；末行谱只有一个十六分音符、
    // 又没有收尾小节线，box 比 `relationContinuationMinSpan` 还窄。
    const result = layout(tabHeader('a5 -S- | a7/16'), 1);
    expect(result.relations).toHaveLength(2);
    const end = result.relations[1];
    if (end === undefined) throw new Error('缺少 end 段');
    const endBox = boxOf(result, end.systemIndex);
    expect(endBox.right - endBox.left).toBeLessThan(TAB_METRICS.relationContinuationMinSpan);
    expect(end.x2 - end.x1).toBeLessThan(TAB_METRICS.relationContinuationMinSpan);
    for (const line of result.relations) {
      const box = boxOf(result, line.systemIndex);
      expect(Number.isFinite(line.x1)).toBe(true);
      expect(Number.isFinite(line.x2)).toBe(true);
      expect(line.x1).toBeLessThanOrEqual(line.x2);
      expect(line.x1).toBeGreaterThanOrEqual(box.left);
      expect(line.x2).toBeLessThanOrEqual(box.right);
    }
  });

  it('同一行谱的 whole 关系不受影响：两端仍精确等于字形边缘 ± relationEndGap', () => {
    const result = layout(tabHeader('a5-S-a7 |'));
    expect(result.relations).toHaveLength(1);
    const line = result.relations[0];
    if (line === undefined) throw new Error('缺少关系线');
    expect(line.segment).toBe('whole');
    const notes = nodesOfKind(result, 'tabNote');
    const [from, to] = notes;
    if (from === undefined || to === undefined) throw new Error('fixture 必须有两个 tabNote');
    expect(line.x1).toBe(from.fret.backdrop.origin.x + from.fret.backdrop.width + TAB_METRICS.relationEndGap);
    expect(line.x2).toBe(to.fret.backdrop.origin.x - TAB_METRICS.relationEndGap);
  });
});
