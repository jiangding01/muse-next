import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import {
  assignSegments,
  onceKeyed,
  pairMarkers,
  parseHeader,
  parseJcxDocument,
  parseVoices,
  scanSegments,
} from '../../../../src/formats/jcx/parse';
import type { ParseContext } from '../../../../src/formats/jcx/parse';
import type { MusicEvent, Rational, Score, Voice, VoiceId } from '../../../../src/domain';
import { noteRefKey, voiceId } from '../../../../src/domain';

/**
 * M1.6 T7：全部走 `lexJcx → buildAst → parseJcxDocument` 真实链路。
 *
 * 只对投影断言：relation 三元组 `{kind, status, from, to}`、tuplet 摘要、`durations()`、
 * diagnostic code。不做整树快照，`origin` / `span` / relation id 一律排除。
 */
function fixtureSource(name: string): string {
  return readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
}

function parseFixture(name: string): { score: Score; diagnostics: readonly JcxDiagnostic[] } {
  const result = parseJcxDocument(buildAst(lexJcx(fixtureSource(name))));
  return { score: result.score, diagnostics: result.diagnostics };
}

/** `unhandled` 只活在 parse 层内部，测试沿同一条链路重跑一次取它。 */
function unhandledMarkerKinds(name: string): string[] {
  const ast = buildAst(lexJcx(fixtureSource(name)));
  const bag = createDiagnosticBag();
  const ctx: ParseContext = { bag, once: onceKeyed(bag) };
  const header = parseHeader(ast, ctx);
  const { voices, registry } = parseVoices(header.voiceFields, ctx);
  const segments = assignSegments(ast, registry, voices, ctx);
  const scan = scanSegments(segments.segments, header.unitLengthScope, ctx);
  const leftovers: string[] = [];
  for (const [id, result] of scan) {
    for (const marker of pairMarkers(result, id, ctx).unhandled) {
      leftovers.push(`${id}:${marker.kind}`);
    }
  }
  return leftovers;
}

function voiceOf(score: Score, id: VoiceId): Voice {
  const voice = score.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) {
    throw new Error(`voice ${id} not found`);
  }
  return voice;
}

interface RelationTriple {
  readonly kind: string;
  readonly status: string;
  readonly from: string;
  readonly to: string;
}

/** 整事件引用去掉 `noteRefKey` 的空 `#` 后缀，让期望值更可读。 */
function refKey(ref: Parameters<typeof noteRefKey>[0]): string {
  return noteRefKey(ref).replace(/#$/, '');
}

/** tie / slur / tabRelation 的统一三元组投影（tuplet 另有摘要投影）。 */
function relations(voice: Voice): RelationTriple[] {
  const out: RelationTriple[] = [];
  for (const tie of voice.ties) {
    out.push({
      kind: 'tie',
      status: tie.status,
      from: refKey(tie.from),
      to: tie.status === 'resolved' ? refKey(tie.to) : '',
    });
  }
  for (const slur of voice.slurs) {
    out.push({
      kind: 'slur',
      status: slur.status,
      from: slur.from,
      to: slur.status === 'closed' ? slur.to : '',
    });
  }
  for (const relation of voice.tabRelations) {
    out.push({
      kind: relation.kind,
      status: 'paired',
      from: refKey(relation.from),
      to: refKey(relation.to),
    });
  }
  return out;
}

function tuplets(voice: Voice): string[] {
  return voice.tuplets.map(
    (tuplet) =>
      `${tuplet.status} p=${String(tuplet.p)} q=${tuplet.q === undefined ? 'undefined' : String(tuplet.q)} r=${String(tuplet.r)} [${tuplet.members.join(',')}]`,
  );
}

function durationOf(event: MusicEvent): Rational | undefined {
  switch (event.kind) {
    case 'note':
      return event.note.duration;
    case 'rest':
      return event.rest.duration;
    case 'tabNote':
      return event.note.duration;
    case 'chord':
    case 'tabGroup':
      return event.duration;
    default:
      return undefined;
  }
}

function durations(voice: Voice): (Rational | undefined)[] {
  return voice.events.map(durationOf);
}

function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.')).map((d) => d.code);
}

function countCode(diagnostics: readonly JcxDiagnostic[], code: string): number {
  return diagnostics.filter((d) => d.code === code).length;
}

describe('tie 配对（spec §22.1；tie-chord-members fixture）', () => {
  const { score, diagnostics } = parseFixture('tie-chord-members');
  const voice = voiceOf(score, voiceId(1));

  it('`[C-E-][EC]`：组内标记向后连到下一事件，按音高交叉匹配（不按下标）', () => {
    expect(relations(voice).slice(0, 2)).toEqual([
      { kind: 'tie', status: 'resolved', from: 'v1:e0#0', to: 'v1:e1#1' },
      { kind: 'tie', status: 'resolved', from: 'v1:e0#1', to: 'v1:e1#0' },
    ]);
  });

  it('`[CD-]D`（corpus 已确认形态）：组末尾的 `-` 属于 D，连到组外的同音高 D', () => {
    expect(relations(voice)[2]).toEqual({
      kind: 'tie',
      status: 'resolved',
      from: 'v1:e2#1',
      to: 'v1:e3',
    });
  });

  it('`[C-D]E`：后继事件里没有同音高的音 → unresolved + warning，不硬配', () => {
    expect(relations(voice)[3]).toEqual({
      kind: 'tie',
      status: 'unresolved',
      from: 'v1:e4#0',
      to: '',
    });
  });

  it('`C-|C` 允许跨小节线配对（spec §22.1 明文承认 `abc-|cba`）', () => {
    expect(relations(voice)[4]).toEqual({
      kind: 'tie',
      status: 'resolved',
      from: 'v1:e7',
      to: 'v1:e9',
    });
  });

  it('单音 ↔ 单音音高不符照建 tie，只发 info；不引入 pitchMatched 之类的推断字段', () => {
    expect(relations(voice)[5]).toEqual({
      kind: 'tie',
      status: 'resolved',
      from: 'v1:e10',
      to: 'v1:e11',
    });
    expect(countCode(diagnostics, 'jcx.parse.tie.pitch-mismatch')).toBe(1);
    expect(Object.keys(voice.ties[5] ?? {})).toEqual(
      expect.not.arrayContaining(['pitchMatched', 'inferred']),
    );
  });

  it('声部尾的 `-` 记为 unresolved（parse-recovery fact），共两条 unresolved warning', () => {
    expect(relations(voice)[6]).toEqual({
      kind: 'tie',
      status: 'unresolved',
      from: 'v1:e12',
      to: '',
    });
    expect(countCode(diagnostics, 'jcx.parse.tie.unresolved')).toBe(2);
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('tie-chord-members')).toEqual([]);
  });
});

describe('tie 逐成员结算（tie-partial-members fixture）', () => {
  const { score, diagnostics } = parseFixture('tie-partial-members');
  const voice = voiceOf(score, voiceId(1));

  it('`[CEG]-[CE]`：C/E 配上，G 单独记一条 unresolved（不因别的成员配上而沉默）', () => {
    expect(relations(voice).slice(0, 3)).toEqual([
      { kind: 'tie', status: 'resolved', from: 'v1:e0#0', to: 'v1:e1#0' },
      { kind: 'tie', status: 'resolved', from: 'v1:e0#1', to: 'v1:e1#1' },
      { kind: 'tie', status: 'unresolved', from: 'v1:e0#2', to: '' },
    ]);
  });

  it('`[CE]-D`：组 → 单音且无同音高 → 两个成员各一条 unresolved', () => {
    expect(relations(voice).slice(3)).toEqual([
      { kind: 'tie', status: 'unresolved', from: 'v1:e2#0', to: '' },
      { kind: 'tie', status: 'unresolved', from: 'v1:e2#1', to: '' },
    ]);
    expect(countCode(diagnostics, 'jcx.parse.tie.unresolved')).toBe(3);
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('tie-partial-members')).toEqual([]);
  });
});

describe('slur 配对（spec §22.2；slur-cross-line fixture）', () => {
  const { score, diagnostics } = parseFixture('slur-cross-line');
  const voice = voiceOf(score, voiceId(1));

  it('简单 / 跨小节与和弦符号 / 嵌套 / 跨行全部闭合，端点只落在发声事件上', () => {
    expect(relations(voice).slice(0, 5)).toEqual([
      { kind: 'slur', status: 'closed', from: 'v1:e0', to: 'v1:e1' },
      // `(C |"G" D)`：barline(e3) 与 chordSymbol(e4) 被跳过，终点落在 D(e5)。
      { kind: 'slur', status: 'closed', from: 'v1:e2', to: 'v1:e5' },
      // 嵌套：内层 (EF) 先闭合，外层 (C…G) 后闭合。
      { kind: 'slur', status: 'closed', from: 'v1:e7', to: 'v1:e8' },
      { kind: 'slur', status: 'closed', from: 'v1:e6', to: 'v1:e9' },
      // 跨行：`(AB` 在下一行的 `c)` 闭合。
      { kind: 'slur', status: 'closed', from: 'v1:e11', to: 'v1:e13' },
    ]);
  });

  it('声部尾未闭合的 `(` 记为 unclosed + warning', () => {
    expect(relations(voice)[5]).toEqual({
      kind: 'slur',
      status: 'unclosed',
      from: 'v1:e15',
      to: '',
    });
    expect(countCode(diagnostics, 'jcx.parse.slur.unclosed')).toBe(1);
  });

  it('孤立 `)` 只发 warning，不建关系', () => {
    expect(countCode(diagnostics, 'jcx.parse.slur.unopened')).toBe(1);
    expect(voice.slurs).toHaveLength(6);
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('slur-cross-line')).toEqual([]);
  });
});

describe('tuplet 配对（spec §20；tuplet-incomplete fixture）', () => {
  const { score, diagnostics } = parseFixture('tuplet-incomplete');
  const voice = voiceOf(score, voiceId(1));

  it('`(3` / `(3:2:3` / `(3:0:3` / 成员不足四种形态', () => {
    expect(tuplets(voice)).toEqual([
      'complete p=3 q=undefined r=3 [v1:e0,v1:e1,v1:e2]',
      'complete p=3 q=2 r=3 [v1:e3,v1:e4,v1:e5]',
      // `(3:0:3`：q===0 记为 undefined（U25 UNVERIFIED，不猜语义）。
      'complete p=3 q=undefined r=3 [v1:e7,v1:e8,v1:e9]',
      'incomplete p=3 q=undefined r=3 [v1:e10,v1:e11]',
    ]);
  });

  it('`q===0` 发一次 info；成员不足发 warning', () => {
    expect(countCode(diagnostics, 'jcx.parse.tuplet.q-zero')).toBe(1);
    expect(countCode(diagnostics, 'jcx.parse.tuplet.incomplete')).toBe(1);
  });

  it('不派生任何时值缩放：三连音成员仍是隐含 1 倍单位音长（1/8），不是 1/12', () => {
    const noted = voice.events.filter((event) => event.kind === 'note');
    expect(noted.map(durationOf)).toEqual(noted.map(() => ({ num: 1, den: 8 })));
    for (const tuplet of voice.tuplets) {
      expect(Object.keys(tuplet)).toEqual(
        expect.not.arrayContaining(['ratio', 'scale', 'duration']),
      );
    }
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('tuplet-incomplete')).toEqual([]);
  });
});

describe('TAB 连接标记（spec §26.6；tab-relations fixture）', () => {
  const { score, diagnostics } = parseFixture('tab-relations');
  const voice = voiceOf(score, voiceId(1));

  it('`-S-` / `-H-` / `-P-` 三种 + 组内 member 锚点', () => {
    expect(relations(voice).slice(1)).toEqual([
      { kind: 'slide', status: 'paired', from: 'v1:e0', to: 'v1:e1' },
      { kind: 'hammer', status: 'paired', from: 'v1:e2', to: 'v1:e3' },
      { kind: 'pull', status: 'paired', from: 'v1:e4', to: 'v1:e5' },
      // `{a1-S-a3}`：倚音组内部，两端带 memberIndex。
      { kind: 'slide', status: 'paired', from: 'v1:e8#0', to: 'v1:e8#1' },
      // `{b5-P-}b7`：语料主形态——标记在组末尾，另一端是组外的下一个 TAB 事件。
      { kind: 'pull', status: 'paired', from: 'v1:e10#0', to: 'v1:e11' },
    ]);
  });

  it('TAB 模式的普通 `-` 走 Tie（与 pitch 同一类型）', () => {
    expect(relations(voice)[0]).toEqual({
      kind: 'tie',
      status: 'resolved',
      from: 'v1:e6',
      to: 'v1:e7',
    });
  });

  it('缺左侧 / 缺右侧各发一次 warning，且不建关系', () => {
    expect(countCode(diagnostics, 'jcx.parse.tab-relation.unresolved')).toBe(2);
    expect(voice.tabRelations).toHaveLength(5);
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('tab-relations')).toEqual([]);
  });
});

describe('broken rhythm（spec §16.2；broken-rhythm-pairs fixture）', () => {
  const { score, diagnostics } = parseFixture('broken-rhythm-pairs');
  const voice = voiceOf(score, voiceId(1));

  it('`>` / `>>` / `>>>` 按 (2 − 1/2ⁿ) : 1/2ⁿ 改写相邻时值（L:1/8，基数 2 → 1/4）', () => {
    expect(durations(voice).slice(0, 6)).toEqual([
      { num: 3, den: 8 },
      { num: 1, den: 8 },
      { num: 7, den: 16 },
      { num: 1, den: 16 },
      { num: 15, den: 32 },
      { num: 1, den: 32 },
    ]);
  });

  it('`<` / `<<` / `<<<` 左右镜像，并发一次 left-unobserved info（语料 0 次）', () => {
    expect(durations(voice).slice(7, 13)).toEqual([
      { num: 1, den: 8 },
      { num: 3, den: 8 },
      { num: 1, den: 16 },
      { num: 7, den: 16 },
      { num: 1, den: 32 },
      { num: 15, den: 32 },
    ]);
    expect(countCode(diagnostics, 'jcx.parse.broken-rhythm.left-unobserved')).toBe(1);
  });

  it('无时值原文的 `C>D` 也照常改写（T6 已物化隐含 1 倍单位音长）', () => {
    // e17 = C → 1/8 × 3/2 = 3/16，e18 = D → 1/8 × 1/2 = 1/16。
    expect(durations(voice).slice(17, 19)).toEqual([
      { num: 3, den: 16 },
      { num: 1, den: 16 },
    ]);
  });

  it('`B2>|c2`（后继是小节线）与声部尾的 `D2>` 都不改写', () => {
    expect(durations(voice)[14]).toEqual({ num: 1, den: 4 });
    expect(durations(voice)[19]).toEqual({ num: 1, den: 4 });
    expect(countCode(diagnostics, 'jcx.parse.broken-rhythm.unresolved')).toBe(2);
  });

  it('改写保留 durationRaw 事实字段并产出新的事件对象', () => {
    const first = voice.events[0];
    expect(first?.kind).toBe('note');
    if (first?.kind === 'note') {
      expect(first.note.durationRaw).toBe('2');
    }
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('broken-rhythm-pairs')).toEqual([]);
  });
});

describe('broken rhythm —— 无 unitLength 时不改写（方案 §7 E1）', () => {
  const { score, diagnostics } = parseFixture('broken-rhythm-no-unit-length');
  const voice = voiceOf(score, voiceId(1));

  it('两侧都没有 duration → 只发 unresolved warning，不凭空造时值', () => {
    expect(durations(voice)).toEqual([undefined, undefined]);
    expect(parseCodes(diagnostics)).toEqual([
      'jcx.parse.unit-length.unresolved',
      'jcx.parse.broken-rhythm.unresolved',
    ]);
  });
});

describe('scan-markers fixture：marker 不进事件流，但全部被消费', () => {
  const { score } = parseFixture('scan-markers');

  it('pitch 声部产出 tie / slur / tuplet，TAB 声部产出 tabRelation', () => {
    expect(relations(voiceOf(score, voiceId(1)))).toEqual([
      { kind: 'tie', status: 'resolved', from: 'v1:e0', to: 'v1:e1' },
      // `[C-C] [CD-]`：组内标记一律向后连到下一个 chord 的同音高 member。
      { kind: 'tie', status: 'resolved', from: 'v1:e9#0', to: 'v1:e10#0' },
      // `[CD-]` 之后是倚音（不可作 tie 端点）→ unresolved。
      { kind: 'tie', status: 'unresolved', from: 'v1:e10#1', to: '' },
      { kind: 'tie', status: 'unresolved', from: 'v1:e12', to: '' },
      { kind: 'slur', status: 'closed', from: 'v1:e5', to: 'v1:e6' },
    ]);
    expect(tuplets(voiceOf(score, voiceId(1)))).toEqual([
      'complete p=3 q=undefined r=3 [v1:e2,v1:e3,v1:e4]',
    ]);
    expect(relations(voiceOf(score, voiceId(2)))).toEqual([
      { kind: 'slide', status: 'paired', from: 'v2:e0', to: 'v2:e1' },
      { kind: 'slide', status: 'paired', from: 'v2:e2#0', to: 'v2:e2#1' },
    ]);
  });

  it('事件流里没有任何 marker 事件（方案 §0-5）', () => {
    for (const voice of score.voices) {
      for (const event of voice.events) {
        expect(event.kind).not.toBe('unknown');
      }
    }
  });

  it('全部 marker 都被消费，且从不产出 jcx.parse.marker.unhandled', () => {
    expect(unhandledMarkerKinds('scan-markers')).toEqual([]);
  });
});

describe('TAB 连接标记的语料主形态（`{d8-S-}d10`；tab-relation-grace-exit fixture）', () => {
  const { score } = parseFixture('tab-relation-grace-exit');
  const voice = voiceOf(score, voiceId(1));

  it('倚音组内的 source 连到组外的 target；组内相邻成员之间照常配对', () => {
    expect(relations(voice)).toEqual([
      // `{d8-S-}d10*6`：source 是组的末成员，target 在组外。
      { kind: 'slide', status: 'paired', from: 'v1:e0#0', to: 'v1:e1' },
      // `{b8-H-b9-P-}b8`：组内 `-H-` 连两个成员，组末尾的 `-P-` 连到组外。
      { kind: 'hammer', status: 'paired', from: 'v1:e2#0', to: 'v1:e2#1' },
      { kind: 'pull', status: 'paired', from: 'v1:e2#1', to: 'v1:e3' },
    ]);
  });

  it('全部 marker 都被消费', () => {
    expect(unhandledMarkerKinds('tab-relation-grace-exit')).toEqual([]);
  });
});

describe('DomainIndex 自动登记 relationsByNote', () => {
  it('relation 两端都能反查到 relation id', () => {
    const result = parseJcxDocument(buildAst(lexJcx(fixtureSource('tie-chord-members'))));
    const ids = result.index.relationsByNote.get('v1:e0#0') ?? [];
    expect(ids).toContain('v1:tie0');
    const first = ids[0];
    expect(first === undefined ? undefined : result.index.relationById.get(first)?.kind).toBe('tie');
  });

  it('语料级不变量：新 fixture 全部无 error 级诊断', () => {
    for (const name of [
      'tie-chord-members',
      'tie-partial-members',
      'slur-cross-line',
      'tuplet-incomplete',
      'tab-relations',
      'tab-relation-grace-exit',
      'broken-rhythm-pairs',
      'broken-rhythm-no-unit-length',
    ]) {
      const { diagnostics } = parseFixture(name);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(parseCodes(diagnostics)).not.toContain('jcx.parse.marker.unhandled');
    }
  });
});
