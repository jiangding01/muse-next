import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { createDiagnosticBag } from '../../../../src/formats/jcx/lexer/diagnostics';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import {
  assignSegments,
  createUnitLengthScope,
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
  const validBodyUnitLengthLines = new Set(header.bodyUnitLengths.map((entry) => entry.lineIndex));
  const segments = assignSegments(ast, registry, voices, ctx, validBodyUnitLengthLines);
  const byLine = new Map(segments.unitLengthBindings.map((b) => [b.lineIndex, b.voiceId] as const));
  const entries = header.bodyUnitLengths.map((entry) => {
    const boundVoiceId = byLine.get(entry.lineIndex);
    return boundVoiceId === undefined ? entry : { ...entry, voiceId: boundVoiceId };
  });
  const scope = createUnitLengthScope(header.unitLength, entries);
  const scan = scanSegments(segments.segments, scope, ctx);
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

/** M1.7 T0：broken rhythm 事实关系的投影 `raw from→to`。 */
function brokenRhythms(voice: Voice): string[] {
  return voice.brokenRhythms.map((relation) => `${relation.raw} ${relation.from}→${relation.to}`);
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

describe('M1.7 T0：broken rhythm 登记为事实关系（spec §16.2）', () => {
  it('broken-rhythm-pairs：改写成功的六种形态各登记一条，未改写的不登记', () => {
    const voice = voiceOf(parseFixture('broken-rhythm-pairs').score, voiceId(1));
    expect(brokenRhythms(voice)).toEqual([
      '> v1:e0→v1:e1',
      '>> v1:e2→v1:e3',
      '>>> v1:e4→v1:e5',
      '< v1:e7→v1:e8',
      '<< v1:e9→v1:e10',
      '<<< v1:e11→v1:e12',
      '> v1:e17→v1:e18',
    ]);
    // 行尾 `B2>|` 与末尾 `D2>` 两处缺对端：只有 warning，不登记关系。
    expect(parseCodes(parseFixture('broken-rhythm-pairs').diagnostics)).toContain(
      'jcx.parse.broken-rhythm.unresolved',
    );
  });

  it('broken-rhythm-left：`<` 与 `>` 混排时逐个登记原拼写', () => {
    const voice = voiceOf(parseFixture('broken-rhythm-left').score, voiceId(1));
    expect(brokenRhythms(voice)).toEqual([
      '< v1:e0→v1:e1',
      '<< v1:e2→v1:e3',
      '> v1:e5→v1:e6',
      '>> v1:e7→v1:e8',
      '<<< v1:e10→v1:e11',
      '>>> v1:e12→v1:e13',
    ]);
  });

  it('单位音长未知（E1）时不改写时值，但关系照常登记（marker 存在是文本事实）', () => {
    const { score, diagnostics } = parseFixture('broken-rhythm-no-unit-length');
    const voice = voiceOf(score, voiceId(1));
    expect(brokenRhythms(voice)).toEqual(['> v1:e0→v1:e1']);
    expect(voice.brokenRhythms).toHaveLength(1);
    // 两侧事件本就没有 duration，`durationRaw` 保持原文。
    const first = voice.events[0];
    expect(first?.kind === 'note' ? first.note.duration : 'missing').toBeUndefined();
    expect(parseCodes(diagnostics)).toContain('jcx.parse.broken-rhythm.unresolved');
  });

  it('brokenRhythms 进 DomainIndex：两端都能反查到同一个 relation id', () => {
    const result = parseJcxDocument(buildAst(lexJcx(fixtureSource('broken-rhythm-left'))));
    const ids = result.index.relationsByNote.get('v1:e0#') ?? [];
    expect(ids).toContain('v1:brokenRhythm0');
    expect(result.index.relationsByNote.get('v1:e1#')).toContain('v1:brokenRhythm0');
    const first = ids[0];
    expect(first === undefined ? undefined : result.index.relationById.get(first)?.kind).toBe('brokenRhythm');
  });
});

describe('M1.7 T0：broken rhythm 改写越界（M1.6 debt）', () => {
  const { score, diagnostics } = parseFixture('broken-rhythm-overflow');
  const voice = voiceOf(score, voiceId(1));

  it('越界不抛异常，只发 warning 且不改写时值，但关系保留；同行其余 marker 照常', () => {
    expect(parseCodes(diagnostics)).toContain('jcx.parse.broken-rhythm.overflow');
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(brokenRhythms(voice)).toEqual(['> v1:e0→v1:e1', '> v1:e2→v1:e3']);
  });

  it('越界的两侧事件保持原时值（不改写）', () => {
    const first = voice.events[0];
    expect(first?.kind === 'note' ? first.note.durationRaw : undefined).toBe('9007199254740991');
    expect(first?.kind === 'note' ? first.note.duration : undefined).toEqual({
      num: 9007199254740991,
      den: 8,
    });
  });
});

describe('M1.7 T0：tuplet 保留原拼写（spec §20）', () => {
  it('`(3` 与 `(3:2:3` 的 raw 各按原文保留', () => {
    const voice = voiceOf(parseFixture('tuplet').score, voiceId(1));
    expect(voice.tuplets.map((t) => t.raw)).toEqual(['(3', '(3:2:3', '(3']);
  });

  it('`(3:0:3` 的 raw 保留 `0`，而 q 仍按「未给出」记录（U25 不解释）', () => {
    const voice = voiceOf(parseFixture('tuplet-incomplete').score, voiceId(1));
    expect(voice.tuplets.map((t) => `${t.raw}|q=${t.q === undefined ? 'undefined' : String(t.q)}`)).toEqual([
      '(3|q=undefined',
      '(3:2:3|q=2',
      '(3:0:3|q=undefined',
      '(3|q=undefined',
    ]);
  });
});

describe('M1.7 T0：TAB 连接标记的同弦校验（spec §26.6 CONFIRMED）', () => {
  const { score, diagnostics } = parseFixture('tab-relation-cross-string');
  const voice = voiceOf(score, voiceId(1));

  it('跨弦的 -S- / -P- 发 warning 且不建关系，同弦的 -H- 照常建立', () => {
    expect(relations(voice)).toEqual([
      { kind: 'hammer', status: 'paired', from: 'v1:e2', to: 'v1:e3' },
    ]);
    expect(parseCodes(diagnostics).filter((c) => c === 'jcx.parse.tab-relation.cross-string')).toHaveLength(2);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('端点是整个组时按「唯一同弦成员」落定，定不下来就不建关系', () => {
    const { score, diagnostics } = parseFixture('tab-relation-group-endpoints');
    const voice = voiceOf(score, voiceId(1));
    expect(relations(voice)).toEqual([
      // `a1-S-[a3c5]`：note → group，组里第 1 弦成员唯一，落到 memberIndex 0。
      { kind: 'slide', status: 'paired', from: 'v1:e0', to: 'v1:e1#0' },
      // `[b3c5]-H-b7`：group → note，组里第 2 弦成员唯一。
      { kind: 'hammer', status: 'paired', from: 'v1:e2#0', to: 'v1:e3' },
      // `[a1b2]-H-[a3c4]`：两端都是组，只有第 1 弦在两组里各自唯一。
      { kind: 'hammer', status: 'paired', from: 'v1:e8#0', to: 'v1:e9#0' },
    ]);
    // `a1-P-[a3a5]`（组内两个第 1 弦成员）与 `[a1b2]-S-[a3b4]`（两个候选弦）各一条。
    expect(parseCodes(diagnostics).filter((c) => c === 'jcx.parse.tab-relation.unresolved')).toHaveLength(2);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('同弦的既有 fixture 不受影响，不产生 cross-string', () => {
    expect(parseCodes(parseFixture('tab-relations').diagnostics)).not.toContain(
      'jcx.parse.tab-relation.cross-string',
    );
    expect(parseCodes(parseFixture('tab-relation-grace-exit').diagnostics)).not.toContain(
      'jcx.parse.tab-relation.cross-string',
    );
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
      'broken-rhythm-overflow',
      'tab-relation-cross-string',
      'tab-relation-group-endpoints',
    ]) {
      const { diagnostics } = parseFixture(name);
      expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
      expect(parseCodes(diagnostics)).not.toContain('jcx.parse.marker.unhandled');
    }
  });
});
