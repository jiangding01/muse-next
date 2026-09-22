/**
 * M2 T8 / T8.1 —— 最终 render matrix：C1/C2/C3 × Jianpu / TAB / Staff（voice matrix）
 * ＋ 独立的 document chord matrix。
 *
 * **契约原文、各记谱的 C1 口径、「用例 × 记谱 × 契约」覆盖表、两处 N/A 格的理由全部在
 * `./renderMatrix.helpers.ts` 的文件头**（唯一权威出处，T9 同步 docs 取那里）；本文件
 * 只放断言。**不 import vexflow、不 import renderer、不引入 jsdom**；真实语料一律以
 * `corpus#NN` 形式引用（本文件不需要引用任何一条），fixture 一律走运行时 glob
 * `fixtureNames`，**数量不写死**。
 */
import { describe, expect, it } from 'vitest';

import type { EventId } from '../../../src/domain';
import { summarizeEvents } from '../../../src/notation/layout/fallbackSummary';
import { RENDER_DIAGNOSTIC_CODES } from '../../../src/notation/model/diagnostics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { Anchor, RenderDiagnostic } from '../../../src/notation/model/types';
import { anchorKey } from '../../../src/notation/model/types';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';
import {
  CHORD_SOURCES, D12_CASES, DANGLING_SOURCE, DETERMINISM_SOURCE, MATRIX_CASES,
} from './renderMatrix.cases';
import type { MatrixScore, MatrixWidthKey, VoiceNotation } from './renderMatrix.helpers';
import {
  VOICE_NOTATIONS, WIDTH_KEYS, allDiagnosticsForC3, anchorResolves, fallbackAnchors,
  layoutChordShapes, layoutDiagnostics, layoutVoiceAs, layoutVoiceForMatrix, matrixContext,
  matrixScoreFrom, overlayEventAnchorCount, upstreamDiagnosticsForC2, visibleNodesByEvent,
} from './renderMatrix.helpers';

const CODE_VALUES: readonly string[] = Object.values(RENDER_DIAGNOSTIC_CODES);

const CASE_ROWS: readonly (readonly [string, string, VoiceNotation, MatrixWidthKey])[] =
  MATRIX_CASES.flatMap(([label, source]) =>
    VOICE_NOTATIONS.flatMap((notation) =>
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

/** C1 的判定：返回未满足「恰好一个 primary 可见节点」的项，空数组即通过。 */
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

/** C3 的判定：返回 anchor 解析不了（含 ownership 不符）的诊断，空数组即通过。 */
function c3Offenders(diagnostics: readonly RenderDiagnostic[], source: MatrixScore): readonly string[] {
  return diagnostics
    .filter((diagnostic) => !anchorResolves(diagnostic.anchor, source))
    .map((diagnostic) => `${diagnostic.code}@${anchorKey(diagnostic.anchor)}`);
}

describe('voice matrix —— 全部 runtime fixture × 声部 × 两档宽度（jianpu / tab / staff）', () => {
  it('fixture 清单来自运行时 glob，非空', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    expect(FIXTURE_ROWS).toHaveLength(fixtureNames.length * WIDTH_KEYS.length);
  });

  it.each(FIXTURE_ROWS)('C1：%s @ %s —— 每个事件恰好一个 primary 可见节点', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      // style 缺席 / 未知：无 layout，走 D12 的声部级 fallback summary 用例，不在此断言。
      if (model === undefined) continue;
      expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
    }
  });

  it.each(FIXTURE_ROWS)('C2：%s @ %s —— fallback 节点 ⊆ layout + RenderScore 诊断', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      if (model === undefined) continue;
      const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnosticsForC2(source)];
      expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
    }
  });

  it.each(FIXTURE_ROWS)('C3：%s @ %s —— anchor 可解析且归属正确（含 header 文档级诊断）', (name, width) => {
    const source = fixtureScore(name);
    const ctx = matrixContext(source, width);
    const diagnostics = [...allDiagnosticsForC3(source)];
    for (const voice of source.renderScore.voices) {
      const model = layoutVoiceForMatrix(voice, ctx);
      if (model === undefined) continue;
      diagnostics.push(...layoutDiagnostics(model));
    }
    expect(c3Offenders(diagnostics, source)).toEqual([]);
  });
});

/**
 * document chord matrix：输入是 `Score.chordShapes`，**不经过任何 `RenderVoice`**。
 * C1(RenderItem) 与 C2(fallback node) 对它 **N/A**——它不消费事件，`ChordLayout` 也没有
 * `fallback` 字段（理由见 helpers 文件头裁决①）。
 */
describe('document chord matrix —— chordShapes → ChordLayout（C1/C2 N/A，只跑计数与 C3）', () => {
  const chordFixtures = fixtureNames.filter((name) => fixtureScore(name).score.chordShapes.length > 0);

  it('至少有一个带 %%gchord 的 fixture，矩阵不空转', () => {
    expect(chordFixtures.length).toBeGreaterThan(0);
  });

  it.each([...chordFixtures, ...CHORD_SOURCES.map(([label]) => label)])(
    '%s —— 每个 GuitarChord 恰好一个 ChordLayout、anchor 为可解析的 document',
    (key) => {
      const synthetic = CHORD_SOURCES.find(([label]) => label === key);
      const source = synthetic === undefined ? fixtureScore(key) : matrixScoreFrom(synthetic[1]);
      const chords = layoutChordShapes(source);
      expect(chords).toHaveLength(source.score.chordShapes.length);
      for (const chord of chords) {
        expect(chord.anchor).toEqual({ kind: 'document' });
        expect(anchorResolves(chord.anchor, source)).toBe(true);
        expect(chord.strings).toHaveLength(6);
      }
    },
  );

  it.each(CHORD_SOURCES)('%s —— 同输入两次 layoutChordShapes 逐字段相等', (_label, text) => {
    const source = matrixScoreFrom(text);
    expect(layoutChordShapes(source)).toEqual(layoutChordShapes(source));
  });
});

/**
 * D12：`style` 缺席 / 未知是**声部级 fallback summary**，没有 layout、没有
 * `fallback: true` 的 event node——这里**不伪造 C2 node**，只断言真实存在的三件事。
 */
describe('D12 —— style 缺席 / 未知的声部级 fallback summary', () => {
  it.each(D12_CASES)('%s —— 恰好一条声部级诊断，anchor 为 voice 且可解析', (_label, text, code) => {
    const source = matrixScoreFrom(text);
    const voice = firstVoice(source);
    expect(layoutVoiceForMatrix(voice, matrixContext(source, 'wide'))).toBeUndefined();
    const own = source.renderScore.diagnostics.filter(
      (diagnostic) => anchorKey(diagnostic.anchor) === `voice:${voice.voiceId}`,
    );
    expect(own.map((diagnostic) => diagnostic.code)).toEqual([code]);
    expect(own.map((diagnostic) => diagnostic.anchor.kind)).toEqual(['voice']);
    expect(c3Offenders(own, source)).toEqual([]);
  });

  it.each(D12_CASES)('%s —— summarizeEvents 对同一声部两次调用逐字段相等', (_label, text) => {
    const source = matrixScoreFrom(text);
    const events = firstVoice(source).items.map((item) => item.event);
    expect(summarizeEvents(events)).toEqual(summarizeEvents(events));
    expect(summarizeEvents(events).length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s —— fixture 里无 layout 的声部必带可解析的声部级诊断', (name) => {
    const source = fixtureScore(name);
    for (const voice of source.renderScore.voices) {
      if (layoutVoiceForMatrix(voice, matrixContext(source, 'wide')) !== undefined) continue;
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
});

describe('voice matrix —— 合成边界用例 × 三种记谱 × 两档宽度', () => {
  it.each(CASE_ROWS)('C1：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const voice = firstVoice(source);
    const model = layoutVoiceAs(notation, voice, matrixContext(source, width));
    expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
  });

  it.each(CASE_ROWS)('C2：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width));
    const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnosticsForC2(source)];
    expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
  });

  it.each(CASE_ROWS)('C3：%s / %s / %s @ %s', (_label, text, notation, width) => {
    const source = matrixScoreFrom(text);
    const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width));
    expect(c3Offenders([...layoutDiagnostics(model), ...allDiagnosticsForC3(source)], source)).toEqual([]);
  });

  /** 反空转哨兵：矩阵若一个 fallback 节点都没走到，C2 会全绿但什么也没证明。 */
  it.each([...VOICE_NOTATIONS])('%s 在合成矩阵里确实走到过 fallback 节点', (notation) => {
    const total = MATRIX_CASES.reduce((sum, [, text]) => {
      const source = matrixScoreFrom(text);
      const model = layoutVoiceAs(notation, firstVoice(source), matrixContext(source, 'wide'));
      return sum + fallbackAnchors(model).length;
    }, 0);
    expect(total).toBeGreaterThan(0);
  });

  /**
   * C1 过滤规则的正面证据（裁决⑤）：TAB 的 stroke 记号是**真的带 event anchor** 的
   * overlay（`TabStrokeMark.anchor` 为 `{ kind: 'event' }`），它住在 `layout.strokes`
   * 而不是 `layout.nodes`。断言：该用例确实产出了这类 overlay，而 C1 仍恰好 1 ——
   * 说明「只看 `nodes`」的过滤规则真的挡住了重复计数。
   */
  it('TAB stroke overlay 带 event anchor，但不被数成第二个 primary 节点', () => {
    const row = MATRIX_CASES.find(([label]) => label.startsWith('tab stroke overlay'));
    if (row === undefined) throw new Error('用例表缺少 tab stroke overlay');
    const source = matrixScoreFrom(row[1]);
    const voice = firstVoice(source);
    const model = layoutVoiceAs('tab', voice, matrixContext(source, 'wide'));
    expect(overlayEventAnchorCount(model)).toBeGreaterThan(0);
    expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
  });

  it('跨行 tie 用例在窄宽度下真的拆成了多行谱', () => {
    const row = MATRIX_CASES.find(([label]) => label.startsWith('跨行 tie'));
    if (row === undefined) throw new Error('用例表缺少跨行 tie');
    const source = matrixScoreFrom(row[1]);
    const model = layoutVoiceAs('staff', firstVoice(source), matrixContext(source, 'narrow'));
    expect(model.layout.systems.length).toBeGreaterThan(1);
  });
});

/**
 * dangling relation 端点：靠**人为剪掉 `index.eventById` 里的一项**制造。
 *
 * 本块**刻意不跑通用 C3**（理由见 helpers 文件头），改为定点断言 C3 的 relation 分支。
 * 也**不要求** `relationEndpointMissing` 一定伴随一个可见的 relation glyph——端点查不到
 * 时画不出连线正是预期行为，强求 glyph 等于要求本层去猜一个不存在的端点位置。
 */
describe('voice matrix —— dangling relation 端点（index 被人为破坏）', () => {
  const ROWS = VOICE_NOTATIONS.flatMap((notation) =>
    WIDTH_KEYS.map((width) => [notation, width] as const),
  );

  function prunedSource(): MatrixScore {
    const base = matrixScoreFrom(DANGLING_SOURCE);
    const victim = firstVoice(base).items[1];
    if (victim === undefined) throw new Error('用例至少要有两个事件');
    const eventById = new Map(base.index.eventById);
    eventById.delete(victim.eventId);
    const index = { ...base.index, eventById };
    return { ...base, index, renderScore: buildRenderScore({ score: base.score, index }) };
  }

  it('C3（relation 分支）：发出 relationEndpointMissing，anchor 落在归属本声部的 relation 上', () => {
    const source = prunedSource();
    const dangling = source.renderScore.diagnostics.filter(
      (diagnostic) => diagnostic.code === RENDER_DIAGNOSTIC_CODES.relationEndpointMissing,
    );
    expect(dangling).toHaveLength(1);
    expect(dangling.map((diagnostic) => diagnostic.anchor.kind)).toEqual(['relation']);
    expect(c3Offenders(dangling, source)).toEqual([]);
  });

  it.each(ROWS)('C1/C2 仍成立：%s @ %s（布局只读 voice.items，不读 index）', (notation, width) => {
    const source = prunedSource();
    const voice = firstVoice(source);
    const model = layoutVoiceAs(notation, voice, matrixContext(source, width));
    expect(c1Offenders(voice.items, visibleNodesByEvent(model))).toEqual([]);
    const diagnostics = [...layoutDiagnostics(model), ...upstreamDiagnosticsForC2(source)];
    expect(c2Offenders(fallbackAnchors(model).map(anchorKey), diagnostics)).toEqual([]);
  });
});

/** 把整张矩阵（fixture + 合成用例）跑一遍，收集全部诊断，供 C3 的稳定性与码表断言复用。 */
function collectAllDiagnostics(): readonly RenderDiagnostic[] {
  const all: RenderDiagnostic[] = [];
  for (const name of fixtureNames) {
    const source = fixtureScore(name);
    all.push(...allDiagnosticsForC3(source));
    for (const width of WIDTH_KEYS) {
      const ctx = matrixContext(source, width);
      for (const voice of source.renderScore.voices) {
        const model = layoutVoiceForMatrix(voice, ctx);
        if (model !== undefined) all.push(...layoutDiagnostics(model));
      }
    }
  }
  for (const [, text] of [...MATRIX_CASES, ...D12_CASES.map(([l, t]) => [l, t] as const)]) {
    const source = matrixScoreFrom(text);
    all.push(...allDiagnosticsForC3(source));
    for (const width of WIDTH_KEYS) {
      for (const notation of VOICE_NOTATIONS) {
        all.push(...layoutDiagnostics(layoutVoiceAs(notation, firstVoice(source), matrixContext(source, width))));
      }
    }
  }
  return all;
}

describe('render matrix —— 确定性、anchorKey 稳定性、诊断码来源', () => {
  it.each([...VOICE_NOTATIONS])('%s：同输入两次 layout 逐字段相等', (notation) => {
    const source = matrixScoreFrom(DETERMINISM_SOURCE);
    const voice = firstVoice(source);
    const ctx = matrixContext(source, 'narrow');
    expect(layoutVoiceAs(notation, voice, ctx)).toEqual(layoutVoiceAs(notation, voice, ctx));
  });

  it('anchorKey 对同一 anchor 重复调用返回同一字符串，且 key 唯一决定 anchor', () => {
    const byKey = new Map<string, Anchor>();
    for (const diagnostic of collectAllDiagnostics()) {
      const key = anchorKey(diagnostic.anchor);
      expect(anchorKey(diagnostic.anchor)).toBe(key);
      const seen = byKey.get(key);
      if (seen === undefined) byKey.set(key, diagnostic.anchor);
      else expect(diagnostic.anchor).toEqual(seen);
    }
    expect(byKey.size).toBeGreaterThan(0);
  });

  it('全矩阵诊断的 code 都来自 RENDER_DIAGNOSTIC_CODES（禁止手写字符串）', () => {
    const codes = new Set(collectAllDiagnostics().map((diagnostic) => diagnostic.code));
    expect([...codes].filter((code) => !CODE_VALUES.includes(code))).toEqual([]);
    expect(codes.size).toBeGreaterThan(10);
  });
});
