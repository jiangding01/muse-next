/**
 * T7.2 —— 五线谱声部布局（`src/notation/staff/layoutStaff.ts`）。
 *
 * 主轴是**纯 Domain → Layout 的结构断言**：零 SVG 快照、零宿主字体依赖，
 * `TextMeasurer` 一律注入 T2 的 `createDeterministicTextMeasurer`（§2.8）。
 *
 * 用例里**不出现「拍」的假设**（P1-3）：时值一律写成 `1/4` / `1/256` 这样相对全音符的
 * 绝对音长。语料相关的断言只用合成 fixture，不引用任何真实曲目。
 *
 * 大多数 fixture 走 `loadJcx`（真实 Domain 形状）；`L:` 不可知与「TAB 事件落进
 * staff 声部」这两种情形 JCX 文本造不出来，直接按 Domain 构造 `Voice`。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { eventId, voiceId } from '../../../src/domain';
import type { DomainIndex, MusicEvent, Score, Voice } from '../../../src/domain';
import { STAFF_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { anchorKey } from '../../../src/notation/model/types';
import type { RenderDiagnostic, RenderVoice } from '../../../src/notation/model/types';
import { layoutStaff } from '../../../src/notation/staff/layoutStaff';
import type { StaffContext } from '../../../src/notation/staff/layoutStaff';
import type { StaffEventNode, StaffLayout } from '../../../src/notation/staff/staffTypes';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

function header(body: string, attrs = 'style=staff', key = 'K:C', meter = 'M:4/4'): string {
  return `%MUSE2\nX:1\n${meter}\nL:1/4\n${key}\nV:1 ${attrs}\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly upstream: readonly RenderDiagnostic[];
  readonly ctx: StaffContext;
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
    upstream: rendered.diagnostics,
    ctx: { score: loaded.score, index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): StaffLayout {
  const prepared = prepare(text, availableWidth);
  return layoutStaff(prepared.voice, prepared.ctx);
}

function codesOf(result: StaffLayout): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

function nodesOfKind<K extends StaffEventNode['kind']>(
  result: StaffLayout,
  kind: K,
): readonly Extract<StaffEventNode, { kind: K }>[] {
  return result.nodes.filter(
    (node): node is Extract<StaffEventNode, { kind: K }> => node.kind === kind,
  );
}

// ---------------------------------------------------------------------------
// 手工构造 Domain（JCX 文本造不出来的两种情形）。
// ---------------------------------------------------------------------------

const VOICE_ID = voiceId(1);

function makeVoice(events: readonly MusicEvent[], overrides: Partial<Voice> = {}): Voice {
  return {
    id: VOICE_ID,
    style: 'staff',
    unknownAttributes: [],
    events,
    ties: [],
    slurs: [],
    tuplets: [],
    tabRelations: [],
    brokenRhythms: [],
    unitLengthChanges: [],
    lyricLines: [],
    origins: ['L1.0'],
    ...overrides,
  };
}

function makeRenderVoice(voice: Voice): RenderVoice {
  return {
    voiceId: voice.id,
    voice,
    items: voice.events.map((event) => ({ eventId: event.id, event, sourceRef: event.origin })),
  };
}

/** 手工 fixture 的 ctx：`score` / `index` 只需形状正确（本层只读 `key` / `meter`）。 */
function syntheticCtx(score: Partial<Score> = {}): StaffContext {
  const loaded = loadJcx(header('C |'));
  return {
    score: { ...loaded.score, ...score },
    index: loaded.index,
    measurer,
    availableWidth: WIDE,
  };
}

// ---------------------------------------------------------------------------
// 契约 C1 / C2 / C3。
// ---------------------------------------------------------------------------

describe('契约 C1/C2/C3', () => {
  const FIXTURE = header('!trill! C "G" [Cz] {ab}D z Z @ ~~~ |]');

  it('C1：每个事件恰好一个节点（未知事件也有）', () => {
    const prepared = prepare(FIXTURE);
    const result = layoutStaff(prepared.voice, prepared.ctx);
    expect(result.nodes).toHaveLength(prepared.voice.items.length);
    expect(result.nodes.map((node) => node.anchor)).toEqual(
      prepared.voice.items.map((item) => ({
        kind: 'event',
        voiceId: prepared.voice.voiceId,
        eventId: item.eventId,
      })),
    );
  });

  it('C2：每个 fallback 节点至少关联一条诊断（含上游 buildRenderScore 发的）', () => {
    const prepared = prepare(FIXTURE);
    const result = layoutStaff(prepared.voice, prepared.ctx);
    const anchored = new Set(
      [...result.diagnostics, ...prepared.upstream].map((diagnostic) => anchorKey(diagnostic.anchor)),
    );
    const fallbacks = result.nodes.filter((node) => node.fallback);
    expect(fallbacks.length).toBeGreaterThan(0);
    for (const node of fallbacks) {
      expect(anchored.has(anchorKey(node.anchor))).toBe(true);
    }
  });

  it('C3：本层诊断的 anchor 都解析得到（voice 存在 / event 有对应节点）', () => {
    const prepared = prepare(FIXTURE);
    const result = layoutStaff(prepared.voice, prepared.ctx);
    const nodeAnchors = new Set(result.nodes.map((node) => anchorKey(node.anchor)));
    expect(result.diagnostics.length).toBeGreaterThan(0);
    for (const diagnostic of result.diagnostics) {
      if (diagnostic.anchor.kind === 'voice') {
        expect(diagnostic.anchor.voiceId).toBe(prepared.voice.voiceId);
        continue;
      }
      expect(diagnostic.anchor.kind).toBe('event');
      expect(nodeAnchors.has(anchorKey(diagnostic.anchor))).toBe(true);
    }
  });

  it('不修改输入：Domain 声部与事件仍是同一批引用', () => {
    const prepared = prepare(FIXTURE);
    const before = prepared.voice.items.map((item) => item.event);
    layoutStaff(prepared.voice, prepared.ctx);
    expect(prepared.voice.items.map((item) => item.event)).toEqual(before);
  });

  it('确定性：同一输入两次调用逐字段相等', () => {
    const prepared = prepare(FIXTURE, 240);
    expect(layoutStaff(prepared.voice, prepared.ctx)).toEqual(
      layoutStaff(prepared.voice, prepared.ctx),
    );
  });
});

// ---------------------------------------------------------------------------
// 谱号 / 拍号 / 调号。
// ---------------------------------------------------------------------------

describe('谱号三态（只读 voice.clef）', () => {
  it('缺席 → treble + staffClefAbsent(info, anchor voice)', () => {
    const result = layout(header('C |'));
    expect(result.clef).toBe('treble');
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffClefAbsent);
    expect(diagnostic?.level).toBe('info');
    expect(diagnostic?.anchor.kind).toBe('voice');
  });

  it('已知值 → 采用，不发诊断', () => {
    const result = layout(header('C |', 'style=staff clef=bass'));
    expect(result.clef).toBe('bass');
    expect(codesOf(result)).not.toContain(CODES.staffClefAbsent);
    expect(codesOf(result)).not.toContain(CODES.staffClefUnrecognized);
  });

  it('其它值 → treble + staffClefUnrecognized(warning)，消息里带原值', () => {
    const result = layout(header('C |', 'style=staff clef=treble+8'));
    expect(result.clef).toBe('treble');
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffClefUnrecognized);
    expect(diagnostic?.level).toBe('warning');
    expect(diagnostic?.message).toContain('treble+8');
  });
});

describe('拍号', () => {
  it('fraction → 行首 stave 带 timeSignature', () => {
    const result = layout(header('C |'));
    expect(result.staves[0]?.timeSignature).toEqual({ numerator: 4, denominator: 4 });
  });

  it('M:C（raw）→ 整个字段省略，且不重发 meterRaw', () => {
    const result = layout(header('C |', 'style=staff', 'K:C', 'M:C'));
    expect(result.staves[0]?.timeSignature).toBeUndefined();
    expect(codesOf(result)).not.toContain(CODES.meterRaw);
  });
});

describe('调号四态（不新发诊断）', () => {
  const KEY_CODES = [CODES.keyAbsent, CODES.keyUnresolved, CODES.keyModeUnrecognized];

  it('干净的 K:Eb → 产出 renderer-neutral 调号', () => {
    const result = layout(header('C |', 'style=staff', 'K:Eb'));
    expect(result.staves[0]?.keySignature).toEqual({ tonic: 'E', alter: -1 });
  });

  it('K:Dm（含调式文本）→ 不产出调号', () => {
    const result = layout(header('C |', 'style=staff', 'K:Dm'));
    expect(result.staves[0]?.keySignature).toBeUndefined();
  });

  it('K:Eb major → 不产出调号', () => {
    const result = layout(header('C |', 'style=staff', 'K:Eb major'));
    expect(result.staves[0]?.keySignature).toBeUndefined();
  });

  it('K: 缺席 → 不产出调号', () => {
    const text = '%MUSE2\nX:1\nM:4/4\nL:1/4\nV:1 style=staff\nC |\n';
    const result = layout(text);
    expect(result.staves[0]?.keySignature).toBeUndefined();
  });

  it('四态都不新发 key 相关诊断（那是 scoreHeader 的职责）', () => {
    for (const key of ['K:Eb', 'K:Dm', 'K:Eb major']) {
      const codes = codesOf(layout(header('C |', 'style=staff', key)));
      for (const code of KEY_CODES) expect(codes).not.toContain(code);
    }
  });
});

// ---------------------------------------------------------------------------
// 事件 → 节点。
// ---------------------------------------------------------------------------

describe('事件 → 节点', () => {
  it('note → note 节点，pitch 与时值都是 renderer-neutral 语义值', () => {
    const result = layout(header('C |'));
    const notes = nodesOfKind(result, 'note');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.pitches).toEqual([
      { memberIndex: 0, pitch: { letter: 'C', octave: 4, mixedOctave: false } },
    ]);
    expect(notes[0]?.duration).toEqual({ base: 'quarter', dots: 0 });
    expect(notes[0]?.fallback).toBe(false);
  });

  it('和弦块含休止成员 → 只画音符成员 + staffChordMemberRestNotModeled(info)', () => {
    const result = layout(header('[Cz] |'));
    const notes = nodesOfKind(result, 'note');
    expect(notes[0]?.pitches).toHaveLength(1);
    expect(notes[0]?.fallback).toBe(true);
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffChordMemberRestNotModeled);
    expect(diagnostic?.level).toBe('info');
    expect(diagnostic?.anchor.kind).toBe('event');
  });

  it('和弦块含休止成员：pitches 的 memberIndex 是 **Domain 原始下标**，不是过滤后的下标', () => {
    // `[zCE]`：Domain 成员是 `[休止, C, E]`；`pitches` 只剩 C / E，但它们必须分别记下
    // 原始下标 1 / 2——T7.4 的 adapter 只能靠这个下标把关系端点落到 keys 上（T6.3
    // `TabFretGlyph.memberIndex` 的同一条裁决），不得自己重放「跳过休止成员」的规则。
    const notes = nodesOfKind(layout(header('[zCE] |')), 'note');
    expect(notes[0]?.pitches.map((entry) => entry.memberIndex)).toEqual([1, 2]);
    expect(notes[0]?.pitches.map((entry) => entry.pitch.letter)).toEqual(['C', 'E']);
  });

  it('和弦块成员全是休止 → 可见占位（**不是** pitches 为空的音符节点）+ 同一条诊断', () => {
    const result = layout(header('[zz] |'));
    expect(nodesOfKind(result, 'note')).toHaveLength(0);
    const placeholders = nodesOfKind(result, 'placeholder');
    expect(placeholders).toHaveLength(1);
    expect(placeholders[0]?.reason).toBe('chordAllMembersRest');
    expect(placeholders[0]?.text).not.toBe('');
    expect(codesOf(result)).toContain(CODES.staffChordMemberRestNotModeled);
  });

  it('混合方向八度 → staffOctaveMixed(warning, anchor event)，不抵消', () => {
    const result = layout(header("C,' |"));
    expect(nodesOfKind(result, 'note')[0]?.pitches[0]).toEqual({
      memberIndex: 0,
      pitch: { letter: 'C', octave: 4, mixedOctave: true },
    });
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffOctaveMixed);
    expect(diagnostic?.level).toBe('warning');
    expect(diagnostic?.anchor.kind).toBe('event');
  });

  it('rest：z 正常，Z / @ 各发各的 code 且都照常占位', () => {
    const result = layout(header('z Z @ |'));
    const rests = nodesOfKind(result, 'rest');
    expect(rests.map((node) => node.variant)).toEqual(['z', 'Z', '@']);
    expect(rests.map((node) => node.fallback)).toEqual([false, true, true]);
    expect(codesOf(result)).toContain(CODES.restMultiMeasureNotModeled);
    expect(codesOf(result)).toContain(CODES.restInvisibleNotModeled);
  });

  it('倚音 → 每个 grace event 一条 staffGraceNotModeled，anchor 指向该 event', () => {
    const result = layout(header('{ab}C {ab}D |'));
    const graces = nodesOfKind(result, 'placeholder').filter((node) => node.reason === 'grace');
    expect(graces).toHaveLength(2);
    // 文本是小写音名序列（不猜时值、不猜弦品）。
    expect(graces[0]?.text).toBe('ab');
    const diagnostics = result.diagnostics.filter((d) => d.code === CODES.staffGraceNotModeled);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.map((d) => d.anchor.kind)).toEqual(['event', 'event']);
  });

  it('装饰 / 未知 / 和弦符号 / 小节线各自的节点与诊断', () => {
    const result = layout(header('!trill! "G" ~~~ |]'));
    expect(nodesOfKind(result, 'chordSymbol')[0]?.text).toBe('G');
    expect(nodesOfKind(result, 'chordSymbol')[0]?.fallback).toBe(false);
    expect(nodesOfKind(result, 'barline')[0]?.form).toBe('final');
    expect(codesOf(result)).toContain(CODES.decorationPlaceholder);
    expect(codesOf(result)).toContain(CODES.eventUnknown);
  });

  it('spec §18 的九种小节线形态逐条归类，表外形态才发 barlineUnrecognized', () => {
    const result = layout(header('C || D [| E :| F |: G :: A [:] B [|] c |'));
    expect(nodesOfKind(result, 'barline').map((node) => node.form)).toEqual([
      'double', 'start', 'repeatEnd', 'repeatStart', 'repeatBoth', 'dashed', 'invisible', 'single',
    ]);
    expect(codesOf(result)).not.toContain(CODES.barlineUnrecognized);
  });

  it('时值细过符头范围上限 → 占位 + staffDurationBeyondGlyphRange(warning)', () => {
    const text = '%MUSE2\nX:1\nM:4/4\nL:1/256\nK:C\nV:1 style=staff\nC |\n';
    const result = layout(text);
    const placeholders = nodesOfKind(result, 'placeholder');
    expect(placeholders[0]?.reason).toBe('durationBeyondGlyphRange');
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffDurationBeyondGlyphRange);
    expect(diagnostic?.level).toBe('warning');
  });

  it('不可表示的时值（1/3）→ 占位，但**不重发**上游的 durationUnrepresentable', () => {
    const text = '%MUSE2\nX:1\nM:4/4\nL:1/3\nK:C\nV:1 style=staff\nC |\n';
    const prepared = prepare(text);
    const result = layoutStaff(prepared.voice, prepared.ctx);
    expect(nodesOfKind(result, 'placeholder')[0]?.reason).toBe('durationUnrepresentable');
    expect(codesOf(result)).not.toContain(CODES.durationUnrepresentable);
    expect(prepared.upstream.map((d) => d.code)).toContain(CODES.durationUnrepresentable);
  });
});

describe('手工构造的 Domain 声部', () => {
  it('duration 缺失 → durationUnresolved 占位（文本 = 字母 + 原始时值文本），本层不发诊断', () => {
    const event: MusicEvent = {
      kind: 'note',
      id: eventId(VOICE_ID, 0),
      origin: 'L6.0',
      note: {
        pitch: { letter: 'C', register: 'upper', octaveRaw: '', octaveShift: 0 },
        durationRaw: '2',
        origin: 'L6.0',
      },
    };
    const result = layoutStaff(makeRenderVoice(makeVoice([event])), syntheticCtx());
    const placeholders = nodesOfKind(result, 'placeholder');
    expect(placeholders[0]?.reason).toBe('durationUnresolved');
    expect(placeholders[0]?.text).toBe('C2');
    expect(codesOf(result)).not.toContain(CODES.durationUnresolved);
  });

  it('TAB 专属事件落进 staff 声部 → outOfScope 占位 + staffEventOutOfScope(warning)', () => {
    const event: MusicEvent = {
      kind: 'tabNote',
      id: eventId(VOICE_ID, 0),
      origin: 'L6.0',
      note: { stringIndex: 1, fret: 0, duration: { num: 1, den: 4 }, origin: 'L6.0' },
    };
    const result = layoutStaff(makeRenderVoice(makeVoice([event])), syntheticCtx());
    expect(nodesOfKind(result, 'placeholder')[0]?.reason).toBe('outOfScope');
    const diagnostic = result.diagnostics.find((d) => d.code === CODES.staffEventOutOfScope);
    expect(diagnostic?.level).toBe('warning');
  });

  it('TAB 倚音成员不猜成音高：占位文本是 `<弦号>/<品位>`', () => {
    const event: MusicEvent = {
      kind: 'grace',
      id: eventId(VOICE_ID, 0),
      origin: 'L6.0',
      after: false,
      members: [{ stringIndex: 3, fret: 5, origin: 'L6.0.1' }],
    };
    const result = layoutStaff(makeRenderVoice(makeVoice([event])), syntheticCtx());
    expect(nodesOfKind(result, 'placeholder')[0]?.text).toBe('3/5');
  });
});

describe('声部级「未建模」诊断', () => {
  it('存在 slur → 一条 staffSlurNotModeled(info, anchor voice)', () => {
    const result = layout(header('(CD) |'));
    const diagnostics = result.diagnostics.filter((d) => d.code === CODES.staffSlurNotModeled);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.anchor.kind).toBe('voice');
  });

  it('存在歌词 → 一条 staffLyricsNotModeled(info, anchor voice)', () => {
    const result = layout(`%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=staff\nCD |\nw: la la\n`);
    const diagnostics = result.diagnostics.filter((d) => d.code === CODES.staffLyricsNotModeled);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.anchor.kind).toBe('voice');
  });

  it('两者都没有时一条都不发', () => {
    const codes = codesOf(layout(header('CD |')));
    expect(codes).not.toContain(CODES.staffSlurNotModeled);
    expect(codes).not.toContain(CODES.staffLyricsNotModeled);
  });
});

// ---------------------------------------------------------------------------
// 横向布局：行首预留、换行、stave 规格。
// ---------------------------------------------------------------------------

describe('stave 规格与换行', () => {
  const BODY = 'CDEF | GABc | CDEF | GABc | CDEF | GABc |';

  it('宽容器：一行谱，行首 stave 带 clef/key/time，其余 stave 都不带', () => {
    const result = layout(header(BODY));
    expect(result.systems).toHaveLength(1);
    expect(result.staves[0]?.clef).toBe('treble');
    expect(result.staves[0]?.keySignature).toEqual({ tonic: 'C', alter: 0 });
    expect(result.staves[0]?.timeSignature).toEqual({ numerator: 4, denominator: 4 });
    for (const stave of result.staves.slice(1)) {
      expect(stave.clef).toBeUndefined();
      expect(stave.keySignature).toBeUndefined();
      expect(stave.timeSignature).toBeUndefined();
    }
  });

  it('缩小 availableWidth 触发换行，且**每一行**的行首 stave 都带 clef/key/time', () => {
    const result = layout(header(BODY), 260);
    expect(result.systems.length).toBeGreaterThan(1);
    const lineStarts = new Map<number, typeof result.staves[number]>();
    for (const stave of result.staves) {
      if (!lineStarts.has(stave.systemIndex)) lineStarts.set(stave.systemIndex, stave);
    }
    expect(lineStarts.size).toBe(result.systems.length);
    for (const stave of result.staves) {
      const isLineStart = lineStarts.get(stave.systemIndex) === stave;
      expect(stave.clef === undefined).toBe(!isLineStart);
      expect(stave.timeSignature === undefined).toBe(!isLineStart);
    }
  });

  /**
   * T7.4 修正：行首预留**加在行首 stave 的 `width` 上**，不是把整行内容右移。
   * 谱号 / 调号 / 拍号是渲染器画在 stave **内部**的，右移整行只会在每行左侧留下一段
   * 谁都不画的死区，同时把行首小节的音符区压掉同样宽度（实测过：五线谱每行左边空一
   * 大块）。下面四条断言把新几何钉死。
   */
  describe('行首预留的几何（T7.4 修正）', () => {
    /**
     * 取 600 而不是别处用的 260：`STAFF_METRICS.minNoteSlotWidth` 在 T7.4 按真实符头
     * 重新标定成 40 之后，`CDEF |` 一小节就要 5 × 40 = 200u，再加一份行首预留 104u
     * 就是 304u——**单个小节比整行还宽**时任何布局器都只能溢出，这里断言的
     * 「右缘 ≤ availableWidth」对那种退化情形本来就不成立。600u 能放下两小节并仍然
     * 换行（BODY 有 6 小节），既检验得到不变式，也检验得到换行本身。
     */
    const availableWidth = 600;
    const reserve = STAFF_METRICS.headerReserve;
    const RESERVE = reserve.clefWidth
      + reserve.keySignatureWidthPerAccidental * reserve.keySignatureAccidentalReserve
      + reserve.timeSignatureWidth;

    function lineStartStaves(result: ReturnType<typeof layout>): ReadonlyMap<number, number> {
      const first = new Map<number, number>();
      for (const [index, stave] of result.staves.entries()) {
        if (!first.has(stave.systemIndex)) first.set(stave.systemIndex, index);
      }
      return first;
    }

    it('每行 stave 右缘不超过 availableWidth（packing 用的是 availableWidth − reserve）', () => {
      const result = layout(header(BODY), availableWidth);
      for (const stave of result.staves) {
        expect(stave.x + stave.width).toBeLessThanOrEqual(availableWidth);
      }
    });

    it('行首 stave 的 x 就是所属 system box 的左边（不再被右移一份 reserve）', () => {
      const result = layout(header(BODY), availableWidth);
      const starts = lineStartStaves(result);
      expect(starts.size).toBe(result.systems.length);
      for (const [systemIndex, staveIndex] of starts) {
        const stave = result.staves[staveIndex];
        expect(stave?.x).toBe(result.systems[systemIndex]?.box.origin.x);
      }
    });

    it('行首 stave 的 width 比同一小节的内容宽**正好**多出一份 reserve（直接对照：去掉 K:/M: 后差值等于它们的预留）', () => {
      // 同一段 body、同样的可用宽度，只把 `K:`/`M:` 拿掉：reserve 少了调号与拍号两块，
      // 行首 stave 的 width 就该少同样多，而内容宽（这一小节的音符列）一个字都没变。
      const withKeyMeter = layout(header('CDEF|'), WIDE);
      const clefOnly = layout(
        '%MUSE2\nX:1\nL:1/4\nV:1 style=staff\nCDEF|\n',
        WIDE,
      );
      const delta = reserve.keySignatureWidthPerAccidental * reserve.keySignatureAccidentalReserve
        + reserve.timeSignatureWidth;
      const a = withKeyMeter.staves[0];
      const b = clefOnly.staves[0];
      expect(a?.keySignature).toBeDefined();
      expect(a?.timeSignature).toBeDefined();
      expect(b?.keySignature).toBeUndefined();
      expect(b?.timeSignature).toBeUndefined();
      expect((a?.width ?? 0) - (b?.width ?? 0)).toBe(delta);
      // 两种情形下行首 stave 都贴着 box 左边——reserve 从来不是左边距。
      expect(a?.x).toBe(0);
      expect(b?.x).toBe(0);
    });

    it('只有行首 stave 带 clef / 调号 / 拍号，非行首一律缺席', () => {
      const result = layout(header(BODY), availableWidth);
      const startIndexes = new Set(lineStartStaves(result).values());
      for (const [index, stave] of result.staves.entries()) {
        if (startIndexes.has(index)) {
          expect(stave.clef).toBeDefined();
          expect(stave.width).toBeGreaterThan(RESERVE);
        } else {
          expect(stave.clef).toBeUndefined();
          expect(stave.keySignature).toBeUndefined();
          expect(stave.timeSignature).toBeUndefined();
        }
      }
    });

    it('同一 system 内相邻 stave 首尾相接：prev.x + prev.width === next.x', () => {
      const result = layout(header(BODY), availableWidth);
      for (const [index, stave] of result.staves.entries()) {
        const prev = result.staves[index - 1];
        if (prev === undefined || prev.systemIndex !== stave.systemIndex) continue;
        expect(prev.x + prev.width).toBe(stave.x);
      }
    });

  });

  it('每个 (system, measure) 一条 stave，与 measures 同序；y 取所属 system 的顶边', () => {
    const result = layout(header(BODY), 260);
    expect(result.staves).toHaveLength(result.measures.length);
    expect(result.staves.map((stave) => stave.measureIndex)).toEqual(
      result.measures.map((measure) => measure.index),
    );
    for (const stave of result.staves) {
      expect(stave.y).toBe(result.systems[stave.systemIndex]?.box.origin.y);
    }
  });

  it('小节线形态落在 stave 的 endBarline 上；只含一根线的 measure 不重复记 beginBarline', () => {
    const result = layout(header('|: CDE :|'));
    expect(result.staves[0]?.endBarline).toBe('repeatStart');
    expect(result.staves[0]?.beginBarline).toBeUndefined();
    expect(result.staves[1]?.endBarline).toBe('repeatEnd');
  });

  it('每个有时值的列至少 minNoteSlotWidth 宽', () => {
    const result = layout(header('C/16 D/16 |'));
    const timed = result.slots.filter((slot) => slot.widthKind !== 'overlay');
    expect(timed.length).toBeGreaterThan(0);
    for (const slot of timed) {
      expect(slot.slot.width).toBeGreaterThanOrEqual(STAFF_METRICS.minNoteSlotWidth);
    }
  });

  it('空声部：零 system、零 stave，不造一个空行', () => {
    const voice = makeRenderVoice(makeVoice([]));
    const result = layoutStaff(voice, syntheticCtx());
    expect(result.systems).toEqual([]);
    expect(result.staves).toEqual([]);
    expect(result.height).toBe(0);
  });

  it('T7.3 的关系字段在本步恒为空数组', () => {
    const result = layout(header('(CD) |'));
    expect(result.ties).toEqual([]);
    expect(result.tuplets).toEqual([]);
  });
});
