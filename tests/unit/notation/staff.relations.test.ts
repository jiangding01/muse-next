/**
 * T7.3 —— 五线谱的 tie 拆段与 tuplet 括号（`src/notation/staff/staffRelations.ts`）。
 *
 * 与 `staff.layout.test.ts` 同一套方法：纯 Domain → Layout 的结构断言，零 SVG 快照，
 * `TextMeasurer` 注入 T2 的确定性实现（§2.8）。合成 fixture，不引用任何真实语料。
 *
 * 断言的核心是**本层的三条承诺**：① 跨行拆出的段共用同一个 `anchor` 且诊断只发一次；
 * ② `memberIndex` 是 Domain 原始成员下标，不是 `pitches` 的下标；③ 端点画不出来时
 * 不画也不重发 `relationEndpointMissing`（已由 `buildRenderScore` 发过）。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { DomainIndex, Score } from '../../../src/domain';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { anchorKey } from '../../../src/notation/model/types';
import type { RenderDiagnostic, RenderVoice } from '../../../src/notation/model/types';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffLayout } from '../../../src/notation/staff/staffTypes';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;
/** 这个宽度下 `CROSS_BODY` 恰好每小节一行谱（见 `stave 规格与换行` 的同款做法）。 */
const NARROW = 260;

function header(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=staff\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly upstream: readonly RenderDiagnostic[];
}

function prepare(text: string): Prepared {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return { score: loaded.score, index: loaded.index, voice, upstream: rendered.diagnostics };
}

function layout(body: string, availableWidth = WIDE): StaffLayout {
  const prepared = prepare(header(body));
  return layoutStaff(prepared.voice, {
    score: prepared.score,
    index: prepared.index,
    measurer,
    availableWidth,
  });
}

function codesOf(result: StaffLayout): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function countCode(result: StaffLayout, code: string): number {
  return codesOf(result).filter((value) => value === code).length;
}

// ---------------------------------------------------------------------------
// tie。
// ---------------------------------------------------------------------------

describe('tie —— 同行 / 跨行 / 未闭合', () => {
  it('两端同一行谱：一段 whole，两端都在，status 透传 resolved', () => {
    const result = layout('C-C | DEFG |');
    expect(result.ties).toHaveLength(1);
    const tie = result.ties[0];
    expect(tie?.segment).toBe('whole');
    expect(tie?.status).toBe('resolved');
    expect(tie?.systemIndex).toBe(0);
    expect(tie?.from?.eventId).toBeDefined();
    expect(tie?.to?.eventId).toBeDefined();
    // A 类恢复状态不成立 → 本层不发任何关系级诊断。
    expect(codesOf(result)).not.toContain(CODES.tieUnresolved);
  });

  it('tie 不带任何 x / y（stave 内 x 由 formatter 决定，T7.4 的 adapter 用 eventId 找音符）', () => {
    const tie = layout('C-C |').ties[0];
    expect(tie).toBeDefined();
    const keys = Object.keys(tie ?? {});
    expect(keys.filter((key) => /^(x|y|x1|x2|y1|y2|height|width)$/.test(key))).toEqual([]);
  });

  const CROSS_BODY = 'CDEF | GABc | CDEF | GABC-| CDEF | GABc |';

  it('跨行谱：拆成 start + end 两段，各自落在自己的 system，续行端省略', () => {
    const result = layout(CROSS_BODY, NARROW);
    expect(result.systems.length).toBeGreaterThan(1);
    expect(result.ties).toHaveLength(2);
    const [start, end] = result.ties;
    expect(start?.segment).toBe('start');
    expect(end?.segment).toBe('end');
    // `start` 的 `to` 省略 = 延到行末；`end` 的 `from` 省略 = 从行首起。
    expect(start?.to).toBeUndefined();
    expect(end?.from).toBeUndefined();
    expect(start?.from?.eventId).toBeDefined();
    expect(end?.to?.eventId).toBeDefined();
    expect(end?.systemIndex).toBe((start?.systemIndex ?? -1) + 1);
  });

  it('跨行两段共用同一个 anchor（段数是视觉事实，relation 仍只有一条）', () => {
    const result = layout(CROSS_BODY, NARROW);
    const anchors = result.ties.map((tie) => anchorKey(tie.anchor));
    expect(new Set(anchors).size).toBe(1);
    expect(result.ties.map((tie) => tie.relationId)).toEqual([
      result.ties[0]?.relationId,
      result.ties[0]?.relationId,
    ]);
    expect(result.ties[0]?.anchor.kind).toBe('relation');
  });

  it('跨行的 resolved tie 不因拆段而多发诊断（本层一条关系级诊断都不发）', () => {
    const result = layout(CROSS_BODY, NARROW);
    expect(result.diagnostics.filter((d) => d.anchor.kind === 'relation')).toEqual([]);
  });

  it('unresolved（只有 from）：单段 start + status unresolved，配一条 tieUnresolved', () => {
    const result = layout('CDE C- |');
    expect(result.ties).toHaveLength(1);
    const tie = result.ties[0];
    expect(tie?.segment).toBe('start');
    expect(tie?.status).toBe('unresolved');
    expect(tie?.to).toBeUndefined();
    expect(countCode(result, CODES.tieUnresolved)).toBe(1);
  });

  it('端点画不出来（时值无法分解 → placeholder）：不画 tie，也不重发 endpoint-missing', () => {
    // `C/5` 的时值不是 2 的幂，`toStaffDuration` 返回 unrepresentable → 占位节点。
    const result = layout('C/5-C |');
    expect(result.nodes[0]?.kind).toBe('placeholder');
    expect(result.ties).toEqual([]);
    expect(codesOf(result)).not.toContain(CODES.relationEndpointMissing);
    expect(codesOf(result)).not.toContain(CODES.tieUnresolved);
  });

  it('memberIndex 是 Domain 原始成员下标，且能在端点节点的 pitches 里按它找到那一项', () => {
    // `[zC-]`：Domain 成员是 `[休止, C]`，原始下标 1 指向 C；`pitches` 已剔除休止成员，
    // C 的**数组下标**是 0 —— adapter 不靠数组下标，而是按 `StaffNotePitch.memberIndex`
    // 反查（T6.3 `TabFretGlyph.memberIndex` 的同一条裁决），这里把这条链路走通。
    const result = layout('[zC-] [zC] |');
    const tie = result.ties[0];
    expect(tie?.from?.memberIndex).toBe(1);
    expect(tie?.to?.memberIndex).toBe(1);
    const node = result.nodes[0];
    const pitches = node?.kind === 'note' ? node.pitches : [];
    expect(pitches).toHaveLength(1);
    const keyIndex = pitches.findIndex((entry) => entry.memberIndex === tie?.from?.memberIndex);
    expect(keyIndex).toBe(0);
    expect(pitches[keyIndex]?.pitch.letter).toBe('C');
  });

  it('非和弦块端点不造 memberIndex（省略表示指整个事件）', () => {
    expect(layout('C-C |').ties[0]?.from?.memberIndex).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// tuplet。
// ---------------------------------------------------------------------------

describe('tuplet bracket —— 自有概念，不带时值缩放', () => {
  it('complete 且 q 存在：label `p:q`，eventIds 按 Domain 成员次序，status complete', () => {
    const result = layout('(3:2:3CDE |');
    expect(result.tuplets).toHaveLength(1);
    const bracket = result.tuplets[0];
    expect(bracket?.label).toBe('3:2');
    expect(bracket?.status).toBe('complete');
    expect(bracket?.eventIds).toHaveLength(3);
    expect(bracket?.systemIndex).toBe(0);
    expect(countCode(result, CODES.tupletRatioUnverified)).toBe(0);
    expect(countCode(result, CODES.tupletIncomplete)).toBe(0);
  });

  it('括号只带 label / status / eventIds —— 没有任何时值缩放字段，也没有 x / y', () => {
    const bracket = layout('(3:2:3CDE |').tuplets[0];
    expect(Object.keys(bracket ?? {}).sort()).toEqual(
      ['anchor', 'eventIds', 'label', 'relationId', 'status', 'systemIndex'].sort(),
    );
  });

  it('q 缺失：label 只有 p，发一条 tupletRatioUnverified（U25，不推算时值）', () => {
    const result = layout('(3CDE |');
    expect(result.tuplets[0]?.label).toBe('3');
    expect(countCode(result, CODES.tupletRatioUnverified)).toBe(1);
  });

  it('q === 0：同样只画 p，发 tupletRatioUnverified', () => {
    const result = layout('(3:0:3CDE |');
    expect(result.tuplets[0]?.label).toBe('3');
    expect(countCode(result, CODES.tupletRatioUnverified)).toBe(1);
  });

  it('incomplete：括号按已有成员范围画，缺失端不补，发一条 tupletIncomplete', () => {
    const result = layout('(3CD |');
    expect(result.tuplets).toHaveLength(1);
    expect(result.tuplets[0]?.status).toBe('incomplete');
    expect(result.tuplets[0]?.eventIds).toHaveLength(2);
    expect(countCode(result, CODES.tupletIncomplete)).toBe(1);
  });

  const CROSS_TUPLET = 'CDEF | GABc | CDEF | GAB(3c | CDEF | GABc |';

  it('跨行谱：按 system 拆段，成员各归其行，label 只在首段', () => {
    const result = layout(CROSS_TUPLET, NARROW);
    expect(result.tuplets).toHaveLength(2);
    const [first, second] = result.tuplets;
    expect(first?.label).toBe('3');
    expect(second?.label).toBeUndefined();
    expect(second?.systemIndex).toBe((first?.systemIndex ?? -1) + 1);
    expect(first?.eventIds).toHaveLength(1);
    expect(second?.eventIds).toHaveLength(2);
    expect(first?.status).toBe('complete');
    expect(second?.status).toBe('complete');
  });

  it('跨行两段共用同一个 anchor，诊断仍只发一次', () => {
    const result = layout(CROSS_TUPLET, NARROW);
    expect(new Set(result.tuplets.map((bracket) => anchorKey(bracket.anchor))).size).toBe(1);
    expect(countCode(result, CODES.tupletRatioUnverified)).toBe(1);
  });

  it('成员降级成占位仍在括号范围内（占位是可见列，与 tie 要求符头不同），不重发 endpoint-missing', () => {
    // 三个成员的时值都不是 2 的幂 → 全部降级成可见占位；括号是「这几列属于一个连音
    // 组」的横向标注，占位列同样占位置，漏掉它会让括号短一截、指向错误的范围。
    const result = layout('(3C/5D/5E/5 |');
    expect(result.nodes.slice(0, 3).map((node) => node.kind)).toEqual([
      'placeholder',
      'placeholder',
      'placeholder',
    ]);
    expect(result.tuplets).toHaveLength(1);
    expect(result.tuplets[0]?.eventIds).toHaveLength(3);
    expect(codesOf(result)).not.toContain(CODES.relationEndpointMissing);
  });
});

// ---------------------------------------------------------------------------
// 确定性 / 不修改输入。
// ---------------------------------------------------------------------------

describe('确定性与零 Domain 修改', () => {
  const BODY = 'CDEF | GABc | (3CDE | GABC-| CDEF | GABc |';

  it('同一输入两次布局得到逐字段相等的 ties / tuplets / diagnostics', () => {
    const prepared = prepare(header(BODY));
    const ctx = {
      score: prepared.score,
      index: prepared.index,
      measurer,
      availableWidth: NARROW,
    };
    const first = layoutStaff(prepared.voice, ctx);
    const second = layoutStaff(prepared.voice, ctx);
    expect(second.ties).toEqual(first.ties);
    expect(second.tuplets).toEqual(first.tuplets);
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it('布局不修改 Domain 的关系数组（引用与内容都不变）', () => {
    const prepared = prepare(header(BODY));
    const voice = prepared.voice.voice;
    const tiesBefore = voice.ties;
    const tupletsBefore = voice.tuplets;
    const snapshot = JSON.stringify({ ties: tiesBefore, tuplets: tupletsBefore });
    layoutStaff(prepared.voice, {
      score: prepared.score,
      index: prepared.index,
      measurer,
      availableWidth: NARROW,
    });
    expect(voice.ties).toBe(tiesBefore);
    expect(voice.tuplets).toBe(tupletsBefore);
    expect(JSON.stringify({ ties: voice.ties, tuplets: voice.tuplets })).toBe(snapshot);
  });

  it('本层诊断不与上游 buildRenderScore 的关系诊断重复（tupletTimingNotModeled 只在上游）', () => {
    const prepared = prepare(header(BODY));
    const result = layoutStaff(prepared.voice, {
      score: prepared.score,
      index: prepared.index,
      measurer,
      availableWidth: WIDE,
    });
    expect(prepared.upstream.map((d) => d.code)).toContain(CODES.tupletTimingNotModeled);
    expect(codesOf(result)).not.toContain(CODES.tupletTimingNotModeled);
  });
});
