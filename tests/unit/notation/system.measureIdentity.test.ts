/**
 * M2.5 T2 —— `alignMeasures`：跨声部 measure identity（`docs/M2.5_SYSTEM_LAYOUT_PLAN.md` v1.0 §Q2
 * + 用户 2026-10-04 裁决 A–H）与 `eventTiming` 计时分类。
 *
 * **语料口径**：本文件是 **synthetic shape coverage**——用自造源码复刻 corpus#02/#10/#11 的已知
 * 形态（68/69、59/61、22/23 小节数不等，以及中段零时值小节），由 CI 覆盖；**不代表真实语料在
 * 本轮重新跑过**。fixture 一律走运行时 glob，数量不写死。
 */
import { describe, expect, it } from 'vitest';

import type { Rational } from '../../../src/domain';
import { voiceId } from '../../../src/domain';
import { loadJcx } from '../../../src/formats/jcx';
import { itemSlotWidth, timedSlotWidth } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { RenderDiagnostic, RenderItem, RenderVoice } from '../../../src/notation/model/types';
import { anchorKey } from '../../../src/notation/model/types';
import type { SystemGroup } from '../../../src/notation/system/contracts';
import { groupVoices } from '../../../src/notation/system/groupVoices';
import type { MeasureAlignment } from '../../../src/notation/system/measureIdentity';
import { alignMeasures } from '../../../src/notation/system/measureIdentity';
import { eventTiming } from '../../../src/notation/system/timedDuration';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import type { MatrixScore } from './renderMatrix.helpers';
import { anchorResolves, matrixScoreFrom } from './renderMatrix.helpers';

/** 一个 bracket group 的合成源码：`bodies[i]` 是第 i+1 个声部的正文（空串 = 该声部无事件）。 */
function groupSource(bodies: readonly string[]): string {
  const declarations = bodies.map((_body, i) => `V:${String(i + 1)}${i === 0 && bodies.length > 1 ? ` bracket=${String(bodies.length)}` : ''}`);
  const lines = bodies.flatMap((body, i) => (body === '' ? [] : [`[V:${String(i + 1)}]${body}`]));
  return ['X:1', 'M:4/4', 'L:1/4', ...declarations, 'K:C', ...lines, ''].join('\n');
}

interface Run {
  readonly matrix: MatrixScore;
  readonly groups: readonly SystemGroup[];
  readonly alignment: MeasureAlignment;
}

function run(bodies: readonly string[]): Run {
  const matrix = matrixScoreFrom(groupSource(bodies));
  const { groups } = groupVoices(matrix.score.voices);
  return { matrix, groups, alignment: alignMeasures(groups, matrix.renderScore.voices) };
}

/** `'compatible:p0,-'`：verdict + 每个成员（p/i + localMeasureIndex，`-` = absent）。 */
function shape(alignment: MeasureAlignment, group = 0): string[] {
  return (alignment.groups[group]?.measures ?? []).map((measure) => {
    const members = measure.members.map((member) =>
      'slice' in member ? `${member.participation.kind[0] ?? ''}${String(member.participation.localMeasureIndex)}` : '-',
    );
    return `${measure.verdict}:${members.join(',')}`;
  });
}

const KEY_BY_CODE = new Map<string, string>(Object.entries(CODES).map(([key, code]) => [code, key]));

/** `'voice:v1 systemMeasureCountMismatch'`，按产出顺序。 */
function diagnosticShape(diagnostics: readonly RenderDiagnostic[]): string[] {
  return diagnostics.map((d) => `${anchorKey(d.anchor)} ${KEY_BY_CODE.get(d.code) ?? d.code}`);
}

/** 第 g 个 group 第 k 个 ordinal 上各成员的 S3（`'1/1'` / `'undefined'` / `'-'`）。 */
function totals(alignment: MeasureAlignment, k: number, g = 0): string[] {
  return (alignment.groups[g]?.measures[k]?.members ?? []).map((member) => {
    if (!('slice' in member)) return '-';
    return member.total.resolved ? `${String(member.total.value.num)}/${String(member.total.value.den)}` : member.total.reason;
  });
}

/** 防御性输入：把某声部全部 note 的 duration 改成给定值（`undefined` = 去掉 duration）。 */
function withNoteDuration(voice: RenderVoice | undefined, duration: Rational | undefined): RenderVoice[] {
  if (voice === undefined) return [];
  const items = voice.items.map((item): RenderItem => {
    if (item.event.kind !== 'note') return item;
    const { duration: _dropped, ...note } = item.event.note;
    return { ...item, event: { ...item.event, note: duration === undefined ? note : { ...note, duration } } };
  });
  return [{ ...voice, items }];
}

/** 递归冻结：任何对入参的写入都会在严格模式下抛错。 */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('M2.5 T2 —— ordinal 对齐与兼容性矩阵', () => {
  it('#1 2 声部同步 → 全 present，无诊断', () => {
    const { alignment } = run(['CDEF|GABc|', 'CDEF|GABc|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0', 'compatible:p1,p1']);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('#2 3 声部同步 → participation 顺序严格等于 group.voiceIds', () => {
    const { alignment, groups } = run(['CDEF|', 'C2D2|', 'C4|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0,p0']);
    const ids = alignment.groups[0]?.measures[0]?.members.map((member) => member.participation.voiceId);
    expect(ids).toEqual(groups[0]?.voiceIds);
  });

  it('#3 / #5 count 2 vs 3 → 尾部 absent，每个声部各一条 count warning', () => {
    const { alignment } = run(['CDEF|GABc|', 'CDEF|GABc|cBAG|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0', 'compatible:p1,p1', 'compatible:-,p2']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual(['voice:v1 systemMeasureCountMismatch', 'voice:v2 systemMeasureCountMismatch']);
  });

  it('#4 / #5 count 3 / 2 / 3 → 只有中间声部尾部 absent，count warning 条数 = 声部数', () => {
    const { alignment } = run(['C4|D4|E4|', 'C4|D4|', 'C4|D4|E4|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0,p0', 'compatible:p1,p1,p1', 'compatible:p2,-,p2']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'voice:v1 systemMeasureCountMismatch',
      'voice:v2 systemMeasureCountMismatch',
      'voice:v3 systemMeasureCountMismatch',
    ]);
  });

  it('#6 S1 `|:` vs `|]` → structure-conflict，双方 incompatible 且保留 localMeasureIndex', () => {
    const { alignment } = run(['CDEF|:', 'CDEF|]']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureStructureConflict',
      'event:v2/v2:e0 systemMeasureStructureConflict',
    ]);
  });

  it('#6b S1 不建等价表：`|` vs `||` 同样冲突', () => {
    expect(shape(run(['CDEF|', 'CDEF||']).alignment)).toEqual(['structure-conflict:i0,i0']);
  });

  it('#7 开头孤立小节线 vs 直接内容 → k=0 S2 冲突，后续 ordinal 不平移', () => {
    const { alignment } = run(['|CDEF|GABc|', 'CDEF|GABc|']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0', 'compatible:p1,p1', 'compatible:p2,-']);
  });

  it('#8 tail vs 正常收尾、total 相等 → compatible（S4 不单独触发冲突）', () => {
    expect(shape(run(['CDEF|GABc', 'CDEF|GABc|']).alignment)).toEqual(['compatible:p0,p0', 'compatible:p1,p1']);
  });

  it('#8b tail vs 正常收尾、total 不等 → total-mismatch', () => {
    expect(shape(run(['CDEF|GAB', 'CDEF|GABc|']).alignment)).toEqual(['compatible:p0,p0', 'total-mismatch:i1,i1']);
  });

  it('#9 同结构、绝对 total 1 vs 1（节奏不同）→ compatible', () => {
    const { alignment } = run(['C2D2|', 'CDEF|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['1/1', '1/1']);
  });

  it('#10 total 1 vs 1/2 → total-mismatch，报 measure-timing-degraded（info），不是 structure-conflict', () => {
    const { alignment } = run(['CDEF|', 'CD|']);
    expect(shape(alignment)).toEqual(['total-mismatch:i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureTimingDegraded',
      'event:v2/v2:e0 systemMeasureTimingDegraded',
    ]);
    expect(alignment.diagnostics.map((d) => d.level)).toEqual(['info', 'info']);
  });

  it('#11 零时值小节 total 0 vs 1 → total-mismatch，不补偿、不跳过、不移位', () => {
    const { alignment } = run(['"C"|GABc|', 'CDEF|GABc|']);
    expect(shape(alignment)).toEqual(['total-mismatch:i0,i0', 'compatible:p1,p1']);
    expect(totals(alignment, 0)).toEqual(['0/1', '1/1']);
  });

  it('#12 total 0 vs 0 → compatible（孤立线 vs 孤立线；只有 overlay 的小节 vs 同形态）', () => {
    expect(shape(run(['|CDEF|', '|CDEF|']).alignment)).toEqual(['compatible:p0,p0', 'compatible:p1,p1']);
    expect(shape(run(['"C"|', '"G"|']).alignment)).toEqual(['compatible:p0,p0']);
  });

  it('#13 弱起：两边首小节都 1/4 → 兼容，无特殊诊断', () => {
    const { alignment } = run(['C|DEFG|', 'G,|CDEF|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0', 'compatible:p1,p1']);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('#14 unrepresentable（1/3）仍参与精确比较：相等兼容、不等 mismatch', () => {
    const equal = run(['C4/3 C4/3 C4/3|', 'CDEF|']);
    expect(equal.matrix.renderScore.diagnostics.map((d) => d.code)).toContain(CODES.durationUnrepresentable);
    expect(shape(equal.alignment)).toEqual(['compatible:p0,p0']);
    expect(shape(run(['C4/3|', 'C|']).alignment)).toEqual(['total-mismatch:i0,i0']);
  });

  it('#15 chordSymbol / decoration / grace / unknown / barline 不计入 S3', () => {
    const { alignment } = run(['!trill!C {g}D "C"E F x|', 'CDEF|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['1/1', '1/1']);
  });

  it('#17 tuplet 只按字面 duration 比较，T2 不读 tuplet、不发 timing 诊断', () => {
    const same = run(['(3CDE F|', 'CDEF|']);
    expect(shape(same.alignment)).toEqual(['compatible:p0,p0']);
    expect(same.alignment.diagnostics).toEqual([]);
    expect(shape(run(['(3CDE|', 'CD|']).alignment)).toEqual(['total-mismatch:i0,i0']);
  });

  it('#18 singleton group：ordinal / participation 完整，无任何跨声部诊断', () => {
    const one = run(['CDEF|GAB|c']);
    expect(shape(one.alignment)).toEqual(['compatible:p0', 'compatible:p1', 'compatible:p2']);
    expect(one.alignment.diagnostics).toEqual([]);
    // 无 bracket 的 3 声部：各自一组，小节数不同也不报 count mismatch。
    const matrix = matrixScoreFrom(['X:1', 'M:4/4', 'L:1/4', 'V:1', 'V:2', 'V:3', 'K:C', '[V:1]C4|', '[V:2]C4|D4|', '[V:3]|C4|]', ''].join('\n'));
    const alignment = alignMeasures(groupVoices(matrix.score.voices).groups, matrix.renderScore.voices);
    expect([0, 1, 2].map((g) => shape(alignment, g))).toEqual([
      ['compatible:p0'],
      ['compatible:p0', 'compatible:p1'],
      ['compatible:p0', 'compatible:p1'],
    ]);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('#19 防御：零 voice、空 group、0 个 measure 的已解析声部', () => {
    expect(alignMeasures([], [])).toEqual({ groups: [], diagnostics: [] });
    expect(alignMeasures([{ index: 0, voiceIds: [], connector: 'none', evidence: 'singleton' }], [])).toEqual({
      groups: [{ groupIndex: 0, measures: [] }],
      diagnostics: [],
    });
    const { alignment } = run(['CDEF|', '']);
    expect(shape(alignment)).toEqual(['compatible:p0,-']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual(['voice:v1 systemMeasureCountMismatch', 'voice:v2 systemMeasureCountMismatch']);
  });

  it('#25 三声部不做多数投票：total 1 / 1 / 1/2 → 整个 measure incompatible，三条 timing', () => {
    const { alignment } = run(['CDEF|', 'CDEF|', 'CD|']);
    expect(shape(alignment)).toEqual(['total-mismatch:i0,i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureTimingDegraded',
      'event:v2/v2:e0 systemMeasureTimingDegraded',
      'event:v3/v3:e0 systemMeasureTimingDegraded',
    ]);
  });

  it('#26 三声部不做多数投票：S1 `|` / `|` / `||` → 整个 measure incompatible，三条 structure', () => {
    const { alignment } = run(['CDEF|', 'CDEF|', 'CDEF||']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureStructureConflict',
      'event:v2/v2:e0 systemMeasureStructureConflict',
      'event:v3/v3:e0 systemMeasureStructureConflict',
    ]);
  });

  it('#27 absent 参与者不收 measure 诊断；诊断按 count → ordinal → 声部序排列', () => {
    const { alignment } = run(['CDEF|:GABc|', 'CDEF|]', 'CDEF|:GA|']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0,i0', 'total-mismatch:i1,-,i1']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'voice:v1 systemMeasureCountMismatch',
      'voice:v2 systemMeasureCountMismatch',
      'voice:v3 systemMeasureCountMismatch',
      'event:v1/v1:e0 systemMeasureStructureConflict',
      'event:v2/v2:e0 systemMeasureStructureConflict',
      'event:v3/v3:e0 systemMeasureStructureConflict',
      'event:v1/v1:e5 systemMeasureTimingDegraded',
      'event:v3/v3:e5 systemMeasureTimingDegraded',
    ]);
  });

  it('#29 D3 优先于 D4：结构冲突且总量不等时只报 structure，不再报 timing', () => {
    const { alignment } = run(['CDEF|:', 'CD|]']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureStructureConflict',
      'event:v2/v2:e0 systemMeasureStructureConflict',
    ]);
  });

  it('#30 S2 单独生效：孤立 `|` vs 只有 overlay 的 `"C"|`（raw 相同、总量都为 0）→ structure', () => {
    const { alignment } = run(['|', '"C"|']);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0']);
    expect(totals(alignment, 0)).toEqual(['0/1', '0/1']);
  });

  it('#31 chord 计入 S3：`[C2E2G2] C2` 与 `C4` 总量相等', () => {
    const { alignment } = run(['[C2E2G2] C2|', 'C4|']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['1/1', '1/1']);
  });

  it('#24 不做错位重搜索：中间多一个小节后，后续仍按 ordinal 配对', () => {
    const { alignment } = run(['C4|D4|G4|E4|F4|', 'C4|D4|E4|F4|']);
    expect(shape(alignment)).toEqual([
      'compatible:p0,p0',
      'compatible:p1,p1',
      'compatible:p2,p2',
      'compatible:p3,p3',
      'compatible:p4,-',
    ]);
  });
});

describe('M2.5 T2 —— 绝对 Rational 精确比较（禁止浮点）', () => {
  it('浮点累加会出误差的组合：1/10 + 2/10 与 3/10 精确相等 → compatible', () => {
    const { alignment } = run(['C2/5 C4/5|', 'C6/5|']);
    expect(totals(alignment, 0)).toEqual(['3/10', '3/10']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
  });

  it('num/den 浮点相等但 Rational 不等 → total-mismatch', () => {
    const { matrix, groups } = run(['C|', 'C|']);
    const [v1, v2] = matrix.renderScore.voices;
    const a: Rational = { num: 2 ** 52, den: 2 ** 52 + 1 };
    const b: Rational = { num: 2 ** 52 + 1, den: 2 ** 52 + 2 };
    expect(a.num / a.den).toBe(b.num / b.den);
    const alignment = alignMeasures(groups, [...withNoteDuration(v1, a), ...withNoteDuration(v2, b)]);
    expect(shape(alignment)).toEqual(['total-mismatch:i0,i0']);
  });

  it('非规范化输入 {2,4} 经 add 规范化后与 1/2 相等', () => {
    const { matrix, groups } = run(['C|', 'C2|']);
    const [v1, v2] = matrix.renderScore.voices;
    const alignment = alignMeasures(groups, [...withNoteDuration(v1, { num: 2, den: 4 }), ...(v2 === undefined ? [] : [v2])]);
    expect(totals(alignment, 0)).toEqual(['1/2', '1/2']);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
  });
});

describe('M2.5 T2 —— S3 unresolved（防御性输入，裁决 G）', () => {
  const base = run(['CDEF|', 'CDEF|', 'CD|']);
  const [v1, v2, v3] = base.matrix.renderScore.voices;
  const withDurations = withNoteDuration;

  it('#16 duration===undefined → present + unresolved，不参与比较，T2 不发诊断', () => {
    const voices = [...withDurations(v1, undefined), ...(v2 === undefined ? [] : [v2])];
    const alignment = alignMeasures(base.groups.map((g) => ({ ...g, voiceIds: g.voiceIds.slice(0, 2) })), voices);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['duration-undefined', '1/1']);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('#16b unresolved + 两个已知 total 不等 → total-mismatch，全体 incompatible', () => {
    const voices = [...withDurations(v1, undefined), ...(v2 === undefined ? [] : [v2]), ...(v3 === undefined ? [] : [v3])];
    const alignment = alignMeasures(base.groups, voices);
    expect(shape(alignment)).toEqual(['total-mismatch:i0,i0,i0']);
    expect(diagnosticShape(alignment.diagnostics)).toEqual([
      'event:v1/v1:e0 systemMeasureTimingDegraded',
      'event:v2/v2:e0 systemMeasureTimingDegraded',
      'event:v3/v3:e0 systemMeasureTimingDegraded',
    ]);
  });

  it('#28 Rational 累加越界 → unresolved(arithmetic-overflow)，不抛、不标 incompatible、不发诊断', () => {
    const big: Rational = { num: Number.MAX_SAFE_INTEGER, den: 1 };
    const voices = [...withDurations(v1, big), ...(v2 === undefined ? [] : [v2])];
    const alignment = alignMeasures(base.groups.map((g) => ({ ...g, voiceIds: g.voiceIds.slice(0, 2) })), voices);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['arithmetic-overflow', '1/1']);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('只捕获 RangeError：其它异常照常抛出', () => {
    const hostile: Rational = {
      num: 1,
      get den(): number {
        throw new TypeError('hostile duration');
      },
    };
    const voices = withDurations(v1, hostile);
    expect(() => alignMeasures([{ index: 0, voiceIds: [voiceId(1)], connector: 'none', evidence: 'singleton' }], voices)).toThrow(TypeError);
  });
});

describe('M2.5 T2 —— 防御：missing / duplicate VoiceId（裁决 H）', () => {
  it('missing id + 已解析声部间同时存在 count mismatch / D3 / D4 → 整组诊断为空，alignment 照常返回', () => {
    const { matrix, alignment: intact } = run(['CDEF|:GABc|', 'CDEF|]GA|C|']);
    // 对照：同样两个声部在完整 group 里三种诊断都会出现。
    expect(new Set(diagnosticShape(intact.diagnostics).map((entry) => entry.split(' ')[1]))).toEqual(
      new Set(['systemMeasureCountMismatch', 'systemMeasureStructureConflict', 'systemMeasureTimingDegraded']),
    );
    const group: SystemGroup = { index: 0, voiceIds: [voiceId(1), voiceId(2), voiceId(99)], connector: 'bracket', evidence: 'declared' };
    const alignment = alignMeasures([group], matrix.renderScore.voices);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0,-', 'total-mismatch:i1,i1,-', 'compatible:-,p2,-']);
    expect(alignment.diagnostics).toEqual([]);
  });

  it('missing id → absent，不抛、不发任何 source-facing 诊断（即使其余声部冲突）', () => {
    const { matrix } = run(['CDEF|:', 'CDEF|]|']);
    const group: SystemGroup = { index: 0, voiceIds: [voiceId(1), voiceId(2), voiceId(99)], connector: 'bracket', evidence: 'declared' };
    const alignment = alignMeasures([group], matrix.renderScore.voices);
    expect(shape(alignment)).toEqual(['structure-conflict:i0,i0,-', 'compatible:-,p1,-']);
    expect(alignment.diagnostics).toEqual([]);
    expect(alignMeasures([group], matrix.renderScore.voices)).toEqual(alignment);
  });

  it('duplicate id → 取首次出现（取末次会变成 total-mismatch）', () => {
    const { matrix } = run(['CDEF|', 'CD|', 'CDEF|']);
    const [first, second, third] = matrix.renderScore.voices;
    expect(first !== undefined && second !== undefined && third !== undefined).toBe(true);
    if (first === undefined || second === undefined || third === undefined) return;
    const voices = [first, { ...second, voiceId: first.voiceId }, third];
    const group: SystemGroup = { index: 0, voiceIds: [first.voiceId, third.voiceId], connector: 'bracket', evidence: 'declared' };
    const alignment = alignMeasures([group], voices);
    expect(shape(alignment)).toEqual(['compatible:p0,p0']);
    expect(totals(alignment, 0)).toEqual(['1/1', '1/1']);
  });
});

describe('M2.5 T2 —— 诊断契约、引用与确定性', () => {
  const CASES: readonly (readonly string[])[] = [
    ['CDEF|GABc|', 'CDEF|GABc|cBAG|'],
    ['CDEF|:', 'CDEF|]'],
    ['|CDEF|GABc|', 'CDEF|GABc|'],
    ['CDEF|', 'CD|'],
    ['"C"|GABc|', 'CDEF|GABc|'],
    ['C4|D4|E4|', 'C4|D4|', 'C4|D4|E4|'],
  ];
  const LEVEL = new Map<string, string>([
    [CODES.systemMeasureCountMismatch, 'warning'],
    [CODES.systemMeasureStructureConflict, 'warning'],
    [CODES.systemMeasureTimingDegraded, 'info'],
  ]);

  it.each(CASES.map((bodies) => [bodies.join(' / '), bodies] as const))('#22 %s：code / level / C3 / ownership / sourceRef / id', (_name, bodies) => {
    const { matrix, alignment } = run(bodies);
    expect(alignment.diagnostics.length).toBeGreaterThan(0);
    for (const d of alignment.diagnostics) {
      expect(d.level).toBe(LEVEL.get(d.code));
      expect(anchorResolves(d.anchor, matrix)).toBe(true);
      expect(d.message).not.toMatch(/非法|不合法|invalid/i);
      if (d.anchor.kind === 'event') {
        const owner = matrix.index.eventById.get(d.anchor.eventId);
        expect(owner?.voiceId).toBe(d.anchor.voiceId);
        expect(d.sourceRef).toBe(owner?.event.origin);
      } else if (d.anchor.kind === 'voice') {
        const voice = matrix.score.voices.find((v) => d.anchor.kind === 'voice' && v.id === d.anchor.voiceId);
        expect(d.sourceRef).toBe(voice?.origins[0]);
      } else {
        expect.unreachable(`unexpected anchor kind ${d.anchor.kind}`);
      }
    }
    expect(new Set(alignment.diagnostics.map((d) => d.id)).size).toBe(alignment.diagnostics.length);
  });

  it('#22 id 精确且按文档顺序派生', () => {
    expect(run(['CDEF|:', 'CDEF|]']).alignment.diagnostics.map((d) => d.id)).toEqual([
      `event:v1/v1:e0|${CODES.systemMeasureStructureConflict}#0`,
      `event:v2/v2:e0|${CODES.systemMeasureStructureConflict}#0`,
    ]);
  });

  it('#20 / #21 / #23 不改入参、切片是原引用、两次逐字段相等、localMeasureIndex = splitMeasures 下标', () => {
    const { matrix, groups, alignment } = run(['|CDEF|GABc|', 'CDEF|GABc|cBAG|']);
    const snapshot = JSON.stringify([matrix.renderScore.voices, groups]);
    expect(alignMeasures(deepFreeze(groups), deepFreeze(matrix.renderScore.voices))).toEqual(alignment);
    expect(JSON.stringify([matrix.renderScore.voices, groups])).toBe(snapshot);
    for (const measure of alignment.groups[0]?.measures ?? []) {
      for (const [i, member] of measure.members.entries()) {
        if (!('slice' in member)) continue;
        const voice = matrix.renderScore.voices[i];
        const expected = voice === undefined ? undefined : splitMeasures(voice.items)[member.slice.index];
        expect(member.participation.localMeasureIndex).toBe(member.slice.index);
        expect(member.slice.items).toEqual(expected?.items);
        member.slice.items.forEach((item, j) => {
          expect(item).toBe(voice?.items[member.slice.startIndex + j]);
        });
      }
    }
  });
});

describe('M2.5 T2 —— synthetic shape coverage for corpus#02/#10/#11（非真实语料）', () => {
  const measures = (n: number): string => 'C4|'.repeat(n);

  it.each([
    [68, 69],
    [59, 61],
    [22, 23],
  ])('%i / %i 小节：前缀对齐，短声部尾部 absent，双方各一条 count warning', (a, b) => {
    const { alignment } = run([measures(a), measures(b)]);
    const aligned = shape(alignment);
    expect(aligned).toHaveLength(b);
    expect(aligned.slice(a)).toEqual(Array.from({ length: b - a }, (_v, i) => `compatible:-,p${String(a + i)}`));
    expect(aligned.slice(0, a).every((entry) => entry.startsWith('compatible:p'))).toBe(true);
    expect(diagnosticShape(alignment.diagnostics)).toEqual(['voice:v1 systemMeasureCountMismatch', 'voice:v2 systemMeasureCountMismatch']);
  });

  it('中段零时值小节（E-5 形态）：该 ordinal 落 total-mismatch，后续按 ordinal 继续（F-1 的保守后果）', () => {
    const { alignment } = run([`${measures(3)}"C"|${measures(3)}`, measures(6)]);
    const aligned = shape(alignment);
    expect(aligned[3]).toBe('total-mismatch:i3,i3');
    expect(aligned[6]).toBe('compatible:p6,-');
  });
});

describe('M2.5 T2 —— eventTiming 与 itemSlotWidth 的分类一致（防分叉，裁决 F）', () => {
  const items = fixtureNames.flatMap((name) => {
    const loaded = loadJcx(fixtureBytes(name));
    return buildRenderScore({ score: loaded.score, index: loaded.index }).voices.flatMap((voice) => voice.items);
  });

  it('fixture 全集覆盖全部 10 种事件', () => {
    expect(new Set(items.map((item) => item.event.kind))).toEqual(
      new Set(['note', 'rest', 'tabNote', 'chord', 'tabGroup', 'grace', 'barline', 'decoration', 'chordSymbol', 'unknown']),
    );
  });

  it('timed ⇔ itemSlotWidth 为 timed / fallback；duration 缺失 ⇔ fallback', () => {
    for (const item of items) {
      const timing = eventTiming(item.event);
      const { kind } = itemSlotWidth(item);
      expect(timing.timed ? ['timed', 'fallback'] : ['untimed', 'overlay']).toContain(kind);
      expect(timing.timed && timing.duration === undefined).toBe(kind === 'fallback');
      if (timing.timed && timing.duration !== undefined) {
        expect(itemSlotWidth(item).width).toBe(timedSlotWidth(timing.duration));
      }
    }
  });
});
