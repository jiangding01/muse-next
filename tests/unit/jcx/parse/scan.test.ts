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
  parseHeader,
  parseJcxDocument,
  parseVoices,
  scanSegments,
} from '../../../../src/formats/jcx/parse';
import type { ParseContext, ScanByVoice } from '../../../../src/formats/jcx/parse';
import type { MusicEvent, Rational, Score, Voice, VoiceId } from '../../../../src/domain';
import { voiceId } from '../../../../src/domain';

/**
 * M1.6 T6：全部走 `lexJcx → buildAst → parseJcxDocument` 真实链路（marker 列表用
 * 同样的真实链路再跑一遍 `scanSegments`，因为 marker 按方案 §0-5 不进 `Score`）。
 *
 * 只对投影断言：事件 kind 序列、时值的 `num/den`、marker 三元组、诊断 code。
 * 不做整树快照，`origin` / `span` 一律排除。
 */
function fixtureSource(name: string): string {
  return readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
}

function parseFixture(name: string): { score: Score; diagnostics: readonly JcxDiagnostic[] } {
  const result = parseJcxDocument(buildAst(lexJcx(fixtureSource(name))));
  return { score: result.score, diagnostics: result.diagnostics };
}

/** marker 只活在 parse 层内部，测试按同一条链路重跑一次取它。 */
function scanFixture(name: string): ScanByVoice {
  const ast = buildAst(lexJcx(fixtureSource(name)));
  const bag = createDiagnosticBag();
  const ctx: ParseContext = { bag, once: onceKeyed(bag) };
  const header = parseHeader(ast, ctx);
  const { voices, registry } = parseVoices(header.voiceFields, ctx);
  const segments = assignSegments(ast, registry, voices, ctx);
  return scanSegments(segments.segments, header.unitLengthScope, ctx);
}

function voiceOf(score: Score, id: VoiceId): Voice {
  const voice = score.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) {
    throw new Error(`voice ${id} not found`);
  }
  return voice;
}

function eventKinds(voice: Voice): string[] {
  return voice.events.map((event) => event.kind);
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

function markerTriples(scan: ScanByVoice, id: VoiceId): string[] {
  return (scan.get(id)?.markers ?? []).map((marker) =>
    marker.anchor === 'event'
      ? `${marker.kind}@e${String(marker.beforeEventIndex)}:${marker.raw}`
      : `${marker.kind}@e${String(marker.eventIndex)}m${String(marker.beforeMemberIndex)}:${marker.raw}`,
  );
}

function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.')).map((d) => d.code);
}

describe('scan-pitch-kinds fixture（spec §14–§25 的 pitch 形态全覆盖）', () => {
  const { score, diagnostics } = parseFixture('scan-pitch-kinds');
  const voice = voiceOf(score, voiceId(1));

  it('事件 kind 序列覆盖 note/rest/chord/grace/barline/decoration/chordSymbol/unknown', () => {
    expect(eventKinds(voice)).toEqual([
      'note', 'note', 'note', 'note', 'rest', 'rest', 'rest', 'barline',
      'chord', 'chord', 'chord', 'grace', 'note', 'grace', 'note', 'barline',
      'decoration', 'note', 'decoration', 'note',
      'chordSymbol', 'chordSymbol', 'chordSymbol', 'barline',
      'barline', 'barline', 'unknown', 'barline',
      'note', 'note', 'note', 'note', 'note', 'note', 'barline',
    ]);
  });

  it('时值 = durationRaw × L:1/8（§16.1：N / N/ / /N / //）', () => {
    // `^C,2`=2、`_b'/`=1/2、`=D3/`=3/2、`E//`=1/4、`z2`=2、`Z4`=4、`@2`=2
    expect(durations(voice).slice(0, 7)).toEqual([
      { num: 1, den: 4 },
      { num: 1, den: 16 },
      { num: 3, den: 16 },
      { num: 1, den: 32 },
      { num: 1, den: 4 },
      { num: 1, den: 2 },
      { num: 1, den: 4 },
    ]);
  });

  it('note 的 pitch / accidental / register / octaveShift 均为事实字段', () => {
    const first = voice.events[0];
    const second = voice.events[1];
    if (first?.kind !== 'note' || second?.kind !== 'note') {
      throw new Error('expected note events');
    }
    expect(first.note).toMatchObject({
      pitch: { letter: 'C', register: 'upper', octaveRaw: ',', octaveShift: -1 },
      accidental: '^',
      durationRaw: '2',
    });
    expect(second.note).toMatchObject({
      pitch: { letter: 'B', register: 'lower', octaveShift: 1 },
      accidental: '_',
    });
  });

  it('rest 三种 variant 不合并（§15.1/§15.2/§15.3）', () => {
    const variants = voice.events
      .filter((event) => event.kind === 'rest')
      .map((event) => (event.kind === 'rest' ? event.rest.variant : ''));
    expect(variants).toEqual(['z', 'Z', '@']);
  });

  it('chord 组时值严格取首个成员，成员可含 rest（§14.4）', () => {
    const [first, second, third] = voice.events.filter((event) => event.kind === 'chord');
    if (first?.kind !== 'chord' || second?.kind !== 'chord' || third?.kind !== 'chord') {
      throw new Error('expected chord events');
    }
    expect(first.duration).toEqual({ num: 1, den: 4 });
    expect(first.members).toHaveLength(3);
    expect(second.duration).toEqual({ num: 1, den: 2 });
    expect(second.members.map((member) => ('pitch' in member ? 'note' : 'rest'))).toEqual([
      'note',
      'rest',
    ]);
    // `[CE2G]`：首音没有时值原文 → 隐含 1 倍单位音长（1/8），组时值**严格**取首音，
    // 不去后面写了 `2` 的成员里找替补。
    expect(third.duration).toEqual({ num: 1, den: 8 });
    expect(third.members[0]?.durationRaw).toBeUndefined();
    expect(third.members[1]?.duration).toEqual({ num: 1, den: 4 });
  });

  it('同方向八度修饰按净位移派生（§14.2）：`C\'\'` = +2、`c,,` = -2', () => {
    const notes = voice.events.filter((event) => event.kind === 'note');
    expect(notes.map((event) => (event.kind === 'note' ? event.note.pitch : undefined))).toContainEqual(
      { letter: 'C', register: 'upper', octaveRaw: "''", octaveShift: 2 },
    );
    expect(notes.map((event) => (event.kind === 'note' ? event.note.pitch : undefined))).toContainEqual(
      { letter: 'C', register: 'lower', octaveRaw: ',,', octaveShift: -2 },
    );
  });

  it('`/N` 形态（`C/3`）= 1/3 单位音长（§16.1）', () => {
    const third = voice.events[voice.events.length - 2];
    if (third?.kind !== 'note') {
      throw new Error('expected note event');
    }
    expect(third.note).toMatchObject({ durationRaw: '/3', duration: { num: 1, den: 24 } });
  });

  it("混合方向的八度修饰只留 octaveRaw，不抵消（§14.2 UNVERIFIED）", () => {
    const mixed = voice.events.find(
      (event) => event.kind === 'note' && event.note.pitch.octaveRaw === ",'",
    );
    if (mixed?.kind !== 'note') {
      throw new Error('expected note event');
    }
    expect(mixed.note.pitch).toEqual({ letter: 'C', register: 'upper', octaveRaw: ",'" });
    expect(parseCodes(diagnostics).filter((code) => code === 'jcx.parse.pitch.mixed-octave-marks')).toEqual([
      'jcx.parse.pitch.mixed-octave-marks',
    ]);
  });

  it('grace 无时值，`{@` 为后倚音（§21）', () => {
    const graces = voice.events.filter((event) => event.kind === 'grace');
    expect(graces.map((event) => (event.kind === 'grace' ? event.after : undefined))).toEqual([
      false,
      true,
    ]);
    expect(graces.map(durationOf)).toEqual([undefined, undefined]);
  });

  it('barline / repeatEnding 都是 barline 事件，只存 raw（§18/§19.2）', () => {
    const raws = voice.events
      .filter((event) => event.kind === 'barline')
      .map((event) => (event.kind === 'barline' ? event.raw : ''));
    expect(raws).toEqual(['|', '|', '|]', '||', '|', '[1', '|']);
  });

  it('decoration 两形态：simple 存名字，complex 拆出 x/y/font/size/payload（§23）', () => {
    const [simple, complex] = voice.events.filter((event) => event.kind === 'decoration');
    if (simple?.kind !== 'decoration' || complex?.kind !== 'decoration') {
      throw new Error('expected decoration events');
    }
    expect(simple.decoration).toEqual({ form: 'simple', name: 'TRILL' });
    expect(complex.decoration).toEqual({
      form: 'complex',
      x: 16,
      y: 10,
      font: 'SimSun',
      size: 15,
      payloadRaw: 'AB',
      raw: "!@x'16'@y'10'$f'SimSun'$s'15'AB!",
    });
  });

  it('chordSymbol 保留 raw，`""` 为空占位、`"^x"` 为只显示文字（§25.2/§25.3）', () => {
    const symbols = voice.events
      .filter((event) => event.kind === 'chordSymbol')
      .map((event) => (event.kind === 'chordSymbol' ? event.symbol : undefined));
    expect(symbols).toEqual([
      { raw: '"C"', empty: false, displayOnly: false },
      { raw: '""', empty: true, displayOnly: false },
      { raw: '"^x"', empty: false, displayOnly: true },
    ]);
  });

  it('`|||2` 残留的裸时值落成 UnknownEvent + warning（§29.3 / 方案 §2 U26）', () => {
    const unknown = voice.events.find((event) => event.kind === 'unknown');
    expect(unknown).toMatchObject({ kind: 'unknown', raw: '2', tokenKind: 'duration' });
    expect(parseCodes(diagnostics)).toContain('jcx.parse.body.unknown-event');
  });

  it('`Z` / `@` 各发一次 info，且没有 error 级诊断', () => {
    expect(parseCodes(diagnostics).filter((code) => code === 'jcx.parse.rest.uppercase-z')).toEqual([
      'jcx.parse.rest.uppercase-z',
    ]);
    expect(parseCodes(diagnostics).filter((code) => code === 'jcx.parse.rest.hidden')).toEqual([
      'jcx.parse.rest.hidden',
    ]);
    expect(diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('事件 id 为 `voiceId:e<下标>`，origin 为 AST path', () => {
    expect(voice.events[0]?.id).toBe('v1:e0');
    expect(voice.events[1]?.id).toBe('v1:e1');
    expect(voice.events[0]?.origin.startsWith('L')).toBe(true);
  });
});

describe('scan-tab-kinds fixture（spec §26）', () => {
  const { score } = parseFixture('scan-tab-kinds');
  const voice = voiceOf(score, voiceId(1));

  it('TAB 事件 kind 序列', () => {
    expect(eventKinds(voice)).toEqual([
      'tabNote',
      'tabNote',
      'tabNote',
      'tabNote',
      'tabNote',
      'rest',
      'tabGroup',
      'tabGroup',
      'tabNote',
      'barline',
    ]);
  });

  it('TAB 时值由 `*` / `/` 引出（§26.5），tabGroup 取末音（§26.8）', () => {
    // `a1*2`=2、`ax`/`Va1` 无时值原文 → 隐含 1 倍（1/8）、`c10/`=1/2、`ax//`=1/4、
    // `z*2`=2、`V[ax/bx/]` 取末音 `bx/`=1/2、`[a1*2bx]` 取末音 `bx`（隐含 1 倍 = 1/8）。
    expect(durations(voice)).toEqual([
      { num: 1, den: 4 },
      { num: 1, den: 8 },
      { num: 1, den: 8 },
      { num: 1, den: 16 },
      { num: 1, den: 32 },
      { num: 1, den: 4 },
      { num: 1, den: 16 },
      { num: 1, den: 8 },
      // `a1/2`：§26.5 的 `/N` 形态 = 1/2 单位音长。
      { num: 1, den: 16 },
      undefined,
    ]);
  });

  it('`/N` 形态（`a1/2`）= 1/N 单位音长（§26.5）', () => {
    const note = voice.events[8];
    if (note?.kind !== 'tabNote') {
      throw new Error('expected tabNote event');
    }
    expect(note.note).toMatchObject({ durationRaw: '/2', duration: { num: 1, den: 16 } });
  });

  it('tabGroup 严格取末音：`[a1*2bx]` 取 `bx` 的隐含 1 倍，首音的 `*2` 不顶替（§26.8）', () => {
    const group = voice.events[7];
    if (group?.kind !== 'tabGroup') {
      throw new Error('expected tabGroup event');
    }
    expect(group.duration).toEqual({ num: 1, den: 8 });
    expect(group.members[1]?.durationRaw).toBeUndefined();
    expect(group.members[0]?.duration).toEqual({ num: 1, den: 4 });
  });

  it('stringIndex 由 a–f 映射，fret 支持数字与 `x`，stroke 保留原字符', () => {
    const notes = voice.events
      .filter((event) => event.kind === 'tabNote')
      .map((event) => (event.kind === 'tabNote' ? event.note : undefined));
    expect(notes[0]).toMatchObject({ stringIndex: 1, fret: 1, durationRaw: '*2' });
    expect(notes[1]).toMatchObject({ stringIndex: 1, fret: 'x' });
    expect(notes[2]).toMatchObject({ stringIndex: 1, fret: 1, stroke: 'V' });
    expect(notes[3]).toMatchObject({ stringIndex: 3, fret: 10, durationRaw: '/' });
    // §26.5 的四种形态各一例：`*N` / `/N`（`c10/` 即 `/2` 简写）/ `/` / `//`（后者借 §16.1 的 1/4）。
    expect(notes[4]).toMatchObject({ stringIndex: 1, fret: 'x', durationRaw: '//' });
  });

  it('TAB 声部内的休止同样走 §26.5 的时值写法（§26.9）', () => {
    const rest = voice.events.find((event) => event.kind === 'rest');
    expect(rest).toMatchObject({ kind: 'rest', rest: { variant: 'z', durationRaw: '*2' } });
  });

  it('作用于弦组的 `V` 不进 events，作为 marker 交 T7（§26.4）', () => {
    expect(markerTriples(scanFixture('scan-tab-kinds'), voiceId(1))).toEqual(['strokePrefix@e6:V']);
  });
});

describe('scan-markers fixture（方案 §0-5：marker 不进 events、时值不被改写）', () => {
  const { score } = parseFixture('scan-markers');
  const scan = scanFixture('scan-markers');
  const pitchVoice = voiceOf(score, voiceId(1));
  const tabVoice = voiceOf(score, voiceId(2));

  it('events 中不含任何 marker kind', () => {
    const kinds = [...eventKinds(pitchVoice), ...eventKinds(tabVoice)];
    for (const marker of ['tie', 'slurOpen', 'slurClose', 'tupletStart', 'brokenRhythm', 'tabRelation', 'strokePrefix']) {
      expect(kinds).not.toContain(marker);
    }
    expect(eventKinds(pitchVoice)).toEqual([
      'note', 'note', 'note', 'note', 'note', 'note', 'note', 'note', 'note',
      'chord', 'chord', 'grace', 'note',
    ]);
    expect(eventKinds(tabVoice)).toEqual(['tabNote', 'tabNote', 'grace', 'barline']);
  });

  it('marker 列表记录 kind / raw / 事件流位置', () => {
    expect(markerTriples(scan, voiceId(1))).toEqual([
      'tie@e1:-',
      'tupletStart@e2:(3',
      'slurOpen@e5:(',
      'slurClose@e7:)',
      'brokenRhythm@e8:>',
      // `[C-C]`：组内 marker 锚到 chord 事件 9 的成员 1 之前。
      'tie@e9m1:-',
      // `[CD-]`：组末尾 marker，`beforeMemberIndex === members.length`。
      'tie@e10m2:-',
      // 行尾 `-`：`beforeEventIndex === events.length`。
      'tie@e13:-',
    ]);
    expect(markerTriples(scan, voiceId(2))).toEqual([
      'tabRelation@e1:-S-',
      // `{a1-S-a3}`：grace 内部 marker 同样锚到 member 之间。
      'tabRelation@e2m1:-S-',
    ]);
  });

  it('顶层末尾 marker 的 beforeEventIndex 等于事件总数', () => {
    const markers = scan.get(voiceId(1))?.markers ?? [];
    const last = markers[markers.length - 1];
    expect(last?.anchor).toBe('event');
    expect(last?.anchor === 'event' ? last.beforeEventIndex : -1).toBe(pitchVoice.events.length);
  });

  it('grace 事件本身无时值，但成员的 durationRaw / duration 保留（`{C2}`）', () => {
    const grace = pitchVoice.events[11];
    if (grace?.kind !== 'grace') {
      throw new Error('expected grace event');
    }
    expect(durationOf(grace)).toBeUndefined();
    expect(grace.members[0]).toMatchObject({ durationRaw: '2', duration: { num: 1, den: 4 } });
  });

  it('扫描期不改写 broken rhythm 两侧时值（改写在 T7 配对层，见 pairing.test.ts）', () => {
    // 断言对象改为**扫描输出**而不是 Score：T7 接入后 Score 里的 `C2>D2` 已按 §16.2 改写。
    const scanned = scan.get(voiceId(1))?.events ?? [];
    // 无时值原文的音符取隐含 1 倍（1/8）；`C2>D2` 两侧在扫描期仍是各自的 1/4。
    expect(scanned.map(durationOf).slice(0, 10)).toEqual([
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 8 },
      { num: 1, den: 8 },
      { num: 1, den: 8 },
      { num: 1, den: 8 },
      { num: 1, den: 8 },
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 8 },
    ]);
  });
});

describe('scan-unit-length-scope fixture（方案 §7 E1 + body 区 L: 作用域）', () => {
  const { score, diagnostics } = parseFixture('scan-unit-length-scope');
  const voice = voiceOf(score, voiceId(1));

  it('无 L: 且无 M: 时省略 duration，只保留 durationRaw', () => {
    expect(durations(voice).slice(0, 2)).toEqual([undefined, undefined]);
    const first = voice.events[0];
    expect(first?.kind === 'note' ? first.note.durationRaw : undefined).toBe('2');
    expect(parseCodes(diagnostics)).toContain('jcx.parse.unit-length.unresolved');
  });

  it('E1 同样作用于组合事件：chord 的组时值与成员时值都省略，只留 durationRaw', () => {
    const chord = voice.events[2];
    if (chord?.kind !== 'chord') {
      throw new Error('expected chord event');
    }
    expect(chord.duration).toBeUndefined();
    expect(chord.members[0]).toMatchObject({ durationRaw: '2' });
    expect(chord.members[0]?.duration).toBeUndefined();
  });

  it('body 区 `L:1/4` 之后的事件恢复时值', () => {
    expect(durations(voice).slice(4, 6)).toEqual([{ num: 1, den: 2 }, { num: 1, den: 8 }]);
  });
});

describe('body-field-l fixture（body 内 L: 之后时值随之改变，spec §8.5 U06）', () => {
  const { score } = parseFixture('body-field-l');
  const voice = voiceOf(score, voiceId(1));

  it('同样的 `X2` 在 `L:1/4` 段是 1/2、在 `L:1/8` 段是 1/4', () => {
    // 第 1 行 `C2D2E2F2`（header L:1/4），第 3 行 `c2B2A2G2`（body L:1/8）。
    expect(durations(voice).slice(0, 4)).toEqual([
      { num: 1, den: 2 },
      { num: 1, den: 2 },
      { num: 1, den: 2 },
      { num: 1, den: 2 },
    ]);
    expect(durations(voice).slice(10, 14)).toEqual([
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 4 },
    ]);
  });
});
