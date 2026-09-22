/**
 * M2 T8 —— 最终 render matrix：C1/C2/C3 × Chord / Jianpu / TAB / Staff。
 *
 * **契约原文、各记谱的 C1 口径、「用例 × 记谱 × 契约」覆盖表全部在
 * `./renderMatrix.helpers.ts` 的文件头**（唯一权威出处，T9 同步 docs 取那里）；本文件
 * 只放断言。**不 import vexflow、不 import renderer、不引入 jsdom**；真实语料一律以
 * `corpus#NN` 形式引用（本文件不需要引用任何一条）。
 */
import { describe, expect, it } from 'vitest';

import type { EventId } from '../../../src/domain';
import { RENDER_DIAGNOSTIC_CODES } from '../../../src/notation/model/diagnostics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { RenderDiagnostic } from '../../../src/notation/model/types';
import { anchorKey } from '../../../src/notation/model/types';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import type { MatrixNotation, MatrixScore, MatrixWidthKey } from './renderMatrix.helpers';
import {
  NOTATIONS, WIDTH_KEYS, anchorResolves, fallbackAnchors, layoutDiagnostics, layoutVoiceAs,
  layoutVoiceForMatrix, matrixContext, matrixScoreFrom, upstreamDiagnostics, visibleNodesByEvent,
} from './renderMatrix.helpers';

const CODE_VALUES: readonly string[] = Object.values(RENDER_DIAGNOSTIC_CODES);

/** 合成边界用例：**不用任何真实语料**，全部是最小 JCX 字符串。 */
const GCHORD = '%%gchord C=1;0,3,2,0,1,0';
const HEAD_4_4 = 'M:4/4\nL:1/4\nK:C';
const HEAD_1_8 = 'M:4/4\nL:1/8\nK:C';
const STAFF_VOICE = 'V:1 style=staff clef=treble';
const TAB_VOICE = 'V:1 style=tab clef=standardtab';

/** 每份合成源都带一条 `%%gchord`，chord 记谱因此在每个用例上都真的跑起来，不留空格。 */
function jcx(head: string, voice: string, body: string): string {
  return `%MUSE2\n${GCHORD}\nX:1\n${head}\n${voice}\n${body}\n`;
}

const MATRIX_CASES: readonly (readonly [string, string])[] = [
  ['unknown 事件', jcx(HEAD_4_4, STAFF_VOICE, 'C?D|')],
  ['tab 事件（落入 jianpu/staff）', jcx(HEAD_1_8, TAB_VOICE, '[V:1]a1 b2 c10 |')],
  ['pitch 事件（落入 tab）', jcx(HEAD_4_4, STAFF_VOICE, 'CDE|')],
  ['grace（TabNote 成员）', jcx(HEAD_1_8, TAB_VOICE, '[V:1]{b11}b12 |')],
  ['grace（Note 成员）', jcx(HEAD_1_8, STAFF_VOICE, '{G}A2|')],
  ['decoration', jcx(HEAD_4_4, STAFF_VOICE, '!TRILL!C !st!D|')],
  ['全 Rest chord', jcx(HEAD_4_4, STAFF_VOICE, '[zz] C|')],
  ['duration undefined（L: 不可知）', jcx('K:C', STAFF_VOICE, 'CDE|')],
  ['duration 1/3', jcx('M:4/4\nL:1/3\nK:C', STAFF_VOICE, 'CDE|')],
  ['duration 1/512', jcx('M:4/4\nL:1/512\nK:C', STAFF_VOICE, 'CDE|')],
  ['duration 2/1', jcx(HEAD_4_4, STAFF_VOICE, 'C8 D8|')],
  ['Z / @ 休止', jcx(HEAD_4_4, STAFF_VOICE, 'Z2 @2 z2|')],
  ['unresolved tie', jcx(HEAD_4_4, STAFF_VOICE, 'C-|')],
  ['tuplet q=0', jcx(HEAD_1_8, STAFF_VOICE, '(3:0:3CDE|')],
  ['clef 缺席', jcx(HEAD_4_4, 'V:1 style=staff', 'CDE|')],
  ['clef 已知', jcx(HEAD_4_4, 'V:1 style=staff clef=bass', 'CDE|')],
  ['clef 未知', jcx(HEAD_4_4, 'V:1 style=staff clef=hexagram', 'CDE|')],
  ['M: raw', jcx('M:C\nL:1/4\nK:C', STAFF_VOICE, 'CDE|')],
  ['K: 缺席', jcx('M:4/4\nL:1/4', STAFF_VOICE, 'CDE|')],
  ['K:Eb', jcx('M:4/4\nL:1/4\nK:Eb', STAFF_VOICE, 'CDE|')],
  ['K:Dm', jcx('M:4/4\nL:1/4\nK:Dm', STAFF_VOICE, 'CDE|')],
  ['chordSymbol 在段末', jcx(HEAD_4_4, STAFF_VOICE, 'CDE "G"')],
  ['跨行 tie（窄宽度拆段）', jcx(HEAD_4_4, STAFF_VOICE, 'CDEF|GABc|CDEF|GAB-|c4|')],
  ['style 缺席', jcx(HEAD_4_4, 'V:1', 'CDE|')],
  ['style 未知', jcx(HEAD_4_4, 'V:1 style=hexagram', 'CDE|')],
];

const CASE_ROWS: readonly (readonly [string, string, MatrixNotation, MatrixWidthKey])[] =
  MATRIX_CASES.flatMap(([label, source]) =>
    NOTATIONS.flatMap((notation) =>
      WIDTH_KEYS.map((width) => [label, source, notation, width] as const),
    ),
  );

const FIXTURE_ROWS: readonly (readonly [string, MatrixWidthKey])[] = fixtureNames.flatMap((name) =>
  WIDTH_KEYS.map((width) => [name, width] as const),
);

const fixtureCache = new Map<string, MatrixScore>();
function fixtureScore(name: string): MatrixScore {
  const cached = fixtureCache.get(name);
  if (cached !== undefined) return cached;
  const built = matrixScoreFrom(fixtureBytes(name));
  fixtureCache.set(name, built);
  return built;
}

function firstVoice(source: MatrixScore): MatrixScore['renderScore']['voices'][number] {
  const voice = source.renderScore.voices[0];
  if (voice === undefined) throw new Error('合成用例必须至少有一个声部');
  return voice;
}

/** C1 的判定：返回未满足「恰好一个可见节点」的项，空数组即通过。 */
function c1Offenders(
  items: readonly { readonly eventId: EventId; readonly event: { readonly kind: string } }[],
  counts: ReadonlyMap<EventId, number>,
): readonly string[] {
  return items
    .filter((item) => counts.get(item.eventId) !== 1)
    .map((item) => `${item.eventId}(${item.event.kind})=${String(counts.get(item.eventId) ?? 0)}`);
}

/** C2 的判定：返回没有任何诊断指向它的 fallback 节点 anchorKey，空数组即通过。 */
function c2Offenders(anchors: readonly string[], diagnostics: readonly RenderDiagnostic[]): readonly string[] {
  const covered = new Set(diagnostics.map((diagnostic) => anchorKey(diagnostic.anchor)));
  return anchors.filter((key) => !covered.has(key));
}

/** C3 的判定：返回 anchor 解析不了的诊断，空数组即通过。 */
function c3Offenders(diagnostics: readonly RenderDiagnostic[], source: MatrixScore): readonly string[] {
  return diagnostics
    .filter((diagnostic) => !anchorResolves(diagnostic.anchor, source))
    .map((diagnostic) => `${diagnostic.code}@${anchorKey(diagnostic.anchor)}`);
}

describe('render matrix —— 102 个 fixture × 声部 × 两档宽度（按 voice.style 分派）', () => {
  it.each(FIXTURE_ROWS)('C1：%s @ %s —— 每个事件恰好一个可见节点', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      // style 缺席 / 未知：D12 下 notation 层不产 layout，C1 不适用，由下面的 D12 用例覆盖。
      if (model === undefined) continue;
      expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
    }
  });

  it.each(FIXTURE_ROWS)('C2：%s @ %s —— 每个 fallback 节点至少一条诊断', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      if (model === undefined) continue;
      const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnostics(source)];
      expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
    }
  });

  it.each(FIXTURE_ROWS)('C3：%s @ %s —— 每条诊断的 anchor 可经 DomainIndex 解析', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    const diagnostics = [...upstreamDiagnostics(source)];
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      if (model === undefined) continue;
      diagnostics.push(...layoutDiagnostics(model));
    }
    expect(c3Offenders(diagnostics, source)).toEqual([]);
  });

  /** D12：`style` 缺席 / 未知的声部没有 layout，但必须有一条声部级诊断并且它可解析。 */
  it.each(fixtureNames)('D12：%s —— style 缺席/未知的声部有可解析的声部级诊断', (name) => {
    const source = fixtureScore(name);
    const styleless = source.renderScore.voices.filter(
      (voice) => layoutVoiceForMatrix(voice, matrixContext(source, 'wide')) === undefined,
    );
    for (const voice of styleless) {
      const own = source.renderScore.diagnostics.filter(
        (diagnostic) => anchorKey(diagnostic.anchor) === `voice:${voice.voiceId}`,
      );
      expect(own.map((diagnostic) => diagnostic.code)).toContainEqual(
        voice.voice.style === undefined
          ? RENDER_DIAGNOSTIC_CODES.voiceStyleAbsent
          : RENDER_DIAGNOSTIC_CODES.voiceStyleUnknown,
      );
      expect(c3Offenders(own, source)).toEqual([]);
    }
  });

  /** chord 的 C1 口径（见文件头）：只在真的有 `%%gchord` 的 fixture 上跑。 */
  it.each(fixtureNames)('C1′：%s —— 每个 GuitarChord 恰好一个 ChordLayout', (name) => {
    const source = fixtureScore(name);
    const voice = source.renderScore.voices[0];
    if (voice === undefined || source.score.chordShapes.length === 0) return;
    const model = layoutVoiceAs('chord', voice, matrixContext(source, 'wide'));
    if (model.notation !== 'chord') throw new Error('分派错误');
    expect(model.chords).toHaveLength(source.score.chordShapes.length);
    for (const chord of model.chords) {
      expect(chord.anchor).toEqual({ kind: 'document' });
      expect(chord.strings).toHaveLength(6);
    }
    expect(visibleNodesByEvent(model).size).toBe(0);
    expect(fallbackAnchors(model)).toEqual([]);
  });
});

describe('render matrix —— 合成边界用例 × 四种记谱 × 两档宽度', () => {
  it.each(CASE_ROWS)('C1：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const voice = firstVoice(source);
    const model = layoutVoiceAs(notation, voice, matrixContext(source, width));
    const counts = visibleNodesByEvent(model);
    if (notation === 'chord') {
      // chord 口径（见文件头）：不消费事件，按 chordShapes 计数。
      expect(counts.size).toBe(0);
      expect(model.notation === 'chord' ? model.chords.length : -1).toBe(source.score.chordShapes.length);
      return;
    }
    expect(c1Offenders(voice.items, counts)).toEqual([]);
  });

  it.each(CASE_ROWS)('C2：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width));
    const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnostics(source)];
    expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
  });

  it.each(CASE_ROWS)('C3：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width));
    expect(c3Offenders([...layoutDiagnostics(model), ...upstreamDiagnostics(source)], source)).toEqual([]);
  });

  /** 反空转哨兵：矩阵若一个 fallback 节点都没走到，C2 会全绿但什么也没证明。 */
  it.each(['jianpu', 'tab', 'staff'] as const)('%s 在合成矩阵里确实走到过 fallback 节点', (notation) => {
    const total = MATRIX_CASES.reduce((sum, [, text]) => {
      const source = matrixScoreFrom(text);
      const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, 'wide'));
      return sum + fallbackAnchors(model).length;
    }, 0);
    expect(total).toBeGreaterThan(0);
  });

  it('跨行 tie 用例在窄宽度下真的拆成了多行谱', () => {
    const row = MATRIX_CASES.find(([label]) => label.startsWith('跨行 tie'));
    if (row === undefined) throw new Error('用例表缺少跨行 tie');
    const source = matrixScoreFrom(row[1]);
    const model = layoutVoiceAs('staff', firstVoice(source), matrixContext(source, 'narrow'));
    expect(model.notation === 'staff' ? model.layout.systems.length : 0).toBeGreaterThan(1);
  });
});

/**
 * dangling relation 端点：靠**人为剪掉 `index.eventById` 里的一项**制造。
 *
 * 本块**刻意不跑通用 C3**：index 已被故意破坏，`event:` 分支的 anchor 当然解析不了，
 * 那正是被造出来的故障本身（tab 记谱下的 `tab.event-out-of-scope` 就挂在被剪掉的事件
 * 上）。改为定点断言 C3 的 relation 分支——`relationById` 完好，诊断必须挂在 relation
 * 上而不是挂在查不到的事件上。
 */
describe('render matrix —— dangling relation 端点（index 被人为破坏）', () => {
  const BASE = jcx(HEAD_4_4, STAFF_VOICE, 'C-C D|');

  function prunedSource(): MatrixScore {
    const base = matrixScoreFrom(BASE);
    const victim = firstVoice(base).items[1];
    if (victim === undefined) throw new Error('用例至少要有两个事件');
    const eventById = new Map(base.index.eventById);
    eventById.delete(victim.eventId);
    const index = { ...base.index, eventById };
    return { ...base, index, renderScore: buildRenderScore({ score: base.score, index }) };
  }

  it('C3（relation 分支）：发出 relationEndpointMissing，且 anchor 落在可解析的 relation 上', () => {
    const source = prunedSource();
    const dangling = source.renderScore.diagnostics.filter(
      (diagnostic) => diagnostic.code === RENDER_DIAGNOSTIC_CODES.relationEndpointMissing,
    );
    expect(dangling).toHaveLength(1);
    expect(dangling.map((diagnostic) => diagnostic.anchor.kind)).toEqual(['relation']);
    expect(c3Offenders(dangling, source)).toEqual([]);
  });

  it.each(CASE_NOTATION_WIDTHS())('C1/C2 仍成立：%s @ %s（布局只读 voice.items，不读 index）', (notation, width) => {
    const source = prunedSource();
    const voice = firstVoice(source);
    const model = layoutVoiceAs(notation, voice, matrixContext(source, width));
    if (notation !== 'chord') {
      expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
    }
    const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnostics(source)];
    expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
  });
});

function CASE_NOTATION_WIDTHS(): readonly (readonly [MatrixNotation, MatrixWidthKey])[] {
  return NOTATIONS.flatMap((notation) => WIDTH_KEYS.map((width) => [notation, width] as const));
}

describe('render matrix —— 确定性与诊断码来源', () => {
  const DETERMINISM_SOURCE = jcx(HEAD_1_8, STAFF_VOICE, '!TRILL!C?D [zz] (3:0:3EFG Z2 @2 "Am"c4-|c4|');

  it.each(NOTATIONS)('%s：同输入两次 layout 逐字段相等', (notation) => {
    const source = matrixScoreFrom(DETERMINISM_SOURCE);
    const voice = firstVoice(source);
    const ctx = matrixContext(source, 'narrow');
    expect(layoutVoiceAs(notation, voice, ctx)).toEqual(layoutVoiceAs(notation, voice, ctx));
  });

  it('全矩阵诊断的 code 都来自 RENDER_DIAGNOSTIC_CODES（禁止手写字符串）', () => {
    const codes = new Set<string>();
    const collect = (diagnostics: readonly RenderDiagnostic[]): void => {
      for (const diagnostic of diagnostics) codes.add(diagnostic.code);
    };
    for (const name of fixtureNames) {
      const source = fixtureScore(name);
      collect(upstreamDiagnostics(source));
      for (const width of WIDTH_KEYS) {
        const ctx = matrixContext(source, width);
        for (const voice of source.renderScore.voices) {
          const model = layoutVoiceForMatrix(voice, ctx);
          if (model !== undefined) collect(layoutDiagnostics(model));
        }
      }
    }
    for (const [, text] of MATRIX_CASES) {
      const source = matrixScoreFrom(text);
      collect(upstreamDiagnostics(source));
      for (const width of WIDTH_KEYS) {
        for (const notation of NOTATIONS) {
          collect(layoutDiagnostics(layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width))));
        }
      }
    }
    expect([...codes].filter((code) => !CODE_VALUES.includes(code))).toEqual([]);
    expect(codes.size).toBeGreaterThan(10);
  });
});
