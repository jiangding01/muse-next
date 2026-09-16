/**
 * T1 —— `RenderInput → RenderScore` 的单元测试（M2 方案 v1.1.1 §6 T1 验收）。
 *
 * 语料策略：**真实语料不进仓库**。本文件的 `.jcx` 全部是就地自造的最小文本，经
 * `loadJcx` 走完整条正式管线得到 `{ score, index }`——这样 `index` 与 `score` 天然同源，
 * 与生产路径（store → `ScoreView`）一致；另有一组用 `tests/fixtures/jcx/**` 全量 glob
 * 的冒烟断言。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DomainIndex, EventId, NoteRef, Score, Tie } from '../../../src/domain/index';
import { relationId as makeRelationId, voiceId as makeVoiceId } from '../../../src/domain/index';
import { loadJcx } from '../../../src/formats/jcx';
import {
  RENDER_DIAGNOSTIC_CODES,
  collectRenderDiagnostics,
  renderDiagnostic,
} from '../../../src/notation/model/diagnostics';
import type { RenderDiagnosticDraft } from '../../../src/notation/model/diagnostics';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { resolveRelation } from '../../../src/notation/model/relations';
import type {
  RenderDiagnostic,
  RenderDiagnosticCode,
  RenderScore,
} from '../../../src/notation/model/types';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';

const PRIMITIVES_FILE = resolve(__dirname, '../../../src/notation/layout/primitives.ts');

function render(source: string): {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly renderScore: RenderScore;
} {
  const { score, index } = loadJcx(source);
  return { score, index, renderScore: buildRenderScore({ score, index }) };
}

function codesOf(renderScore: RenderScore): readonly string[] {
  return renderScore.diagnostics.map((diagnostic) => diagnostic.code);
}

function withCode(renderScore: RenderScore, code: string): readonly RenderDiagnostic[] {
  return renderScore.diagnostics.filter((diagnostic) => diagnostic.code === code);
}

/**
 * 主用例语料：一次覆盖 T1 必交的**五个固定 code**。
 *
 * - `V:1` 无 `style` → `voice.style-absent`；正文里 `C2` 在 body `L:` 之前，`duration`
 *   不可知 → `duration.unresolved`；`L:1/16` 之后的 `a5` = `5/16` 不可表示 →
 *   `duration.unrepresentable`；`(3CDE` → 一条 `tuplet.timing-not-modeled`。
 * - `V:2` 写了我们不认识的 `style=foo` → `voice.style-unknown`；正文含 `Z` / `@` /
 *   混合方向八度 `C,'` 这三项 UNVERIFIED 事实（只保留，不解释）与一个未知 token。
 * - `V:3` 是已知 style + 可分解时值 → 一条诊断都不该有。
 */
const MAIN_SOURCE = `%MUSE2
X:1
T:T1 render model
K:C
V:1 name="No style"
V:2 style=foo
V:3 style=jianpu
[V:1]
C2
L:1/16
(3CDE a5 z2 |
[V:2]
Z2 @2 C,' %bogus%
[V:3]
(3CDE
`;

describe('buildRenderScore —— flat 一一对应（§2.6）', () => {
  const { score, renderScore } = render(MAIN_SOURCE);

  it('声部顺序与 Score.voices 一致，且 voice 是同一引用', () => {
    expect(renderScore.voices.map((voice) => voice.voiceId)).toEqual(
      score.voices.map((voice) => voice.id),
    );
    renderScore.voices.forEach((rendered, i) => {
      expect(rendered.voice).toBe(score.voices[i]);
    });
  });

  it('items 与 voice.events 一一对应、同序，event 是同一引用（不切小节、不合并）', () => {
    for (const rendered of renderScore.voices) {
      expect(rendered.items).toHaveLength(rendered.voice.events.length);
      rendered.items.forEach((item, i) => {
        const event = rendered.voice.events[i];
        expect(item.event).toBe(event);
        expect(item.eventId).toBe(event?.id);
        expect(item.sourceRef).toBe(event?.origin);
      });
    }
  });

  it('barline 事件仍留在流里（切点不被消费）', () => {
    const [voice] = renderScore.voices;
    expect(voice?.items.some((item) => item.event.kind === 'barline')).toBe(true);
  });

  it('Score 未被修改：renderScore.score 是同一引用', () => {
    expect(renderScore.score).toBe(score);
  });
});

describe('buildRenderScore —— UnknownEvent 原位保留（§4.1 A）', () => {
  const { renderScore } = render(MAIN_SOURCE);
  const voice = renderScore.voices[1];

  it('未知 token 在 items 中占位，不被吞掉', () => {
    const unknowns = (voice?.items ?? []).filter((item) => item.event.kind === 'unknown');
    expect(unknowns.length).toBeGreaterThan(0);
  });

  it('未知事件在原位置：items 的下标与 voice.events 的下标相同', () => {
    const items = voice?.items ?? [];
    const events = voice?.voice.events ?? [];
    const fromItems = items.flatMap((item, i) => (item.event.kind === 'unknown' ? [i] : []));
    const fromEvents = events.flatMap((event, i) => (event.kind === 'unknown' ? [i] : []));
    expect(fromItems).toEqual(fromEvents);
  });

  it('未知事件本身不产生 duration 诊断（它本就没有时值）', () => {
    const unknownIds = (voice?.items ?? [])
      .filter((item) => item.event.kind === 'unknown')
      .map((item) => item.eventId);
    const hit = renderScore.diagnostics.filter(
      (diagnostic) =>
        diagnostic.anchor.kind === 'event' && unknownIds.includes(diagnostic.anchor.eventId),
    );
    expect(hit).toEqual([]);
  });
});

describe('buildRenderScore —— 五个固定 code 及其 anchor 分支（§0d-3 / §3.0）', () => {
  const { renderScore } = render(MAIN_SOURCE);

  it('五个固定 code 全部出现', () => {
    expect(new Set(codesOf(renderScore))).toEqual(
      new Set([
        RENDER_DIAGNOSTIC_CODES.durationUnresolved,
        RENDER_DIAGNOSTIC_CODES.durationUnrepresentable,
        RENDER_DIAGNOSTIC_CODES.tupletTimingNotModeled,
        RENDER_DIAGNOSTIC_CODES.voiceStyleAbsent,
        RENDER_DIAGNOSTIC_CODES.voiceStyleUnknown,
      ]),
    );
  });

  it('产出的 code 是常量表的子集，且正常输入下不出现 relation.endpoint-missing', () => {
    const table: readonly string[] = Object.values(RENDER_DIAGNOSTIC_CODES);
    expect(table).toHaveLength(6);
    for (const code of codesOf(renderScore)) {
      expect(table).toContain(code);
    }
    expect(codesOf(renderScore)).not.toContain(RENDER_DIAGNOSTIC_CODES.relationEndpointMissing);
  });

  it('duration 缺失 → event 级 anchor（L: 不可知，不反推时值）', () => {
    const hits = withCode(renderScore, RENDER_DIAGNOSTIC_CODES.durationUnresolved);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.anchor.kind).toBe('event');
    expect(hits[0]?.level).toBe('warning');
  });

  it('duration 不可表示（5/16）→ event 级 anchor', () => {
    const hits = withCode(renderScore, RENDER_DIAGNOSTIC_CODES.durationUnrepresentable);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.anchor.kind).toBe('event');
    expect(hits[0]?.level).toBe('warning');
  });

  it('style 缺席与 style 未知是两条不同 code、各自 voice 级 anchor，不得合并', () => {
    const absent = withCode(renderScore, RENDER_DIAGNOSTIC_CODES.voiceStyleAbsent);
    const unknown = withCode(renderScore, RENDER_DIAGNOSTIC_CODES.voiceStyleUnknown);
    expect(absent).toHaveLength(1);
    expect(unknown).toHaveLength(1);
    expect(absent[0]?.anchor).toEqual({ kind: 'voice', voiceId: 'v1' });
    expect(unknown[0]?.anchor).toEqual({ kind: 'voice', voiceId: 'v2' });
    expect(absent[0]?.level).toBe('info');
    expect(unknown[0]?.level).toBe('warning');
    expect(unknown[0]?.message).toContain('foo');
  });

  it('已知 style 的声部不产生 style 诊断', () => {
    const styled = renderScore.voices[2];
    expect(styled?.voice.style).toBe('jianpu');
    const hits = renderScore.diagnostics.filter(
      (diagnostic) =>
        diagnostic.anchor.kind === 'voice' && diagnostic.anchor.voiceId === styled?.voiceId,
    );
    expect(hits).toEqual([]);
  });

  it('每条诊断的 code 都是 muse.render. 前缀', () => {
    for (const code of codesOf(renderScore)) {
      expect(code.startsWith('muse.render.')).toBe(true);
    }
  });
});

describe('buildRenderScore —— tuplet 与时值分解彻底分离（§2.6.1，P1-C）', () => {
  const { score, renderScore } = render(MAIN_SOURCE);
  const tupletHits = withCode(renderScore, RENDER_DIAGNOSTIC_CODES.tupletTimingNotModeled);
  const tuplets = score.voices.flatMap((voice) => voice.tuplets);

  it('每个 Tuplet relation 恰好一条 relation 级诊断（两个声部各一个 tuplet）', () => {
    expect(tuplets.length).toBe(2);
    expect(tupletHits).toHaveLength(tuplets.length);
    expect(
      tupletHits.map((hit) => (hit.anchor.kind === 'relation' ? hit.anchor.relationId : null)),
    ).toEqual(tuplets.map((tuplet) => tuplet.id));
    expect(tupletHits.map((hit) => hit.level)).toEqual(tuplets.map(() => 'info'));
  });

  it('诊断挂在关系上，不挂在任何成员上（反向断言：member 不因 tuplet 产生 duration 诊断）', () => {
    const memberIds: readonly EventId[] = tuplets.flatMap((tuplet) => [...tuplet.members]);
    expect(memberIds.length).toBeGreaterThan(0);

    const durationCodes: readonly string[] = [
      RENDER_DIAGNOSTIC_CODES.durationUnresolved,
      RENDER_DIAGNOSTIC_CODES.durationUnrepresentable,
    ];
    const hits = renderScore.diagnostics.filter(
      (diagnostic) =>
        diagnostic.anchor.kind === 'event' &&
        memberIds.includes(diagnostic.anchor.eventId) &&
        durationCodes.includes(diagnostic.code),
    );
    expect(hits).toEqual([]);
  });

  it('不按 p/q 推算 effective duration：成员 duration 保持字面值（1/16）', () => {
    const items = renderScore.voices[2]?.items ?? [];
    for (const item of items) {
      if (item.event.kind !== 'note') continue;
      expect(item.event.note.duration).toEqual({ num: 1, den: 16 });
    }
  });
});

describe('buildRenderScore —— grace 不占时值（spec §21）', () => {
  /** 装饰音成员带一个**不可表示**的 5/16 与一个正常 1/16：都不该被检查。 */
  const GRACE_TIMED = `%MUSE2
X:1
L:1/16
K:C
V:1 style=jianpu
[V:1]
{a5b}c2
`;
  /** 无 `L:`，装饰音成员与主音的 duration 全部不可知：诊断只允许落在主音上。 */
  const GRACE_UNTIMED = `%MUSE2
X:1
K:C
V:1 style=jianpu
[V:1]
{ab}c
`;

  it('grace 事件原位保留在 items 里，成员一个不少', () => {
    const { renderScore } = render(GRACE_TIMED);
    const items = renderScore.voices[0]?.items ?? [];
    expect(items.map((item) => item.event.kind)).toEqual(['grace', 'note']);
    const grace = items[0]?.event;
    expect(grace?.kind).toBe('grace');
    if (grace?.kind !== 'grace') return;
    expect(grace.members).toHaveLength(2);
    expect(grace.members[0]?.duration).toEqual({ num: 5, den: 16 });
  });

  it('grace 及其 members 不产生任何 duration 诊断（members 根本不被遍历）', () => {
    const { renderScore } = render(GRACE_TIMED);
    expect(renderScore.diagnostics).toEqual([]);
  });

  it('duration 全不可知时，诊断只落在主音上，grace 事件一条都不发', () => {
    const { renderScore } = render(GRACE_UNTIMED);
    const items = renderScore.voices[0]?.items ?? [];
    const graceId = items.find((item) => item.event.kind === 'grace')?.eventId;
    const noteId = items.find((item) => item.event.kind === 'note')?.eventId;
    expect(graceId).toBeDefined();

    expect(
      renderScore.diagnostics.map((diagnostic) =>
        diagnostic.anchor.kind === 'event' ? diagnostic.anchor.eventId : null,
      ),
    ).toEqual([noteId]);
    expect(codesOf(renderScore)).toEqual([RENDER_DIAGNOSTIC_CODES.durationUnresolved]);
  });
});

describe('buildRenderScore —— UNVERIFIED 事实只保留不解释（R2 / §7-1）', () => {
  const { renderScore } = render(MAIN_SOURCE);
  const items = renderScore.voices[1]?.items ?? [];

  it('Z 与 @ 保留原 variant，未被赋多小节 / 隐藏语义', () => {
    const variants = items.flatMap((item) =>
      item.event.kind === 'rest' ? [item.event.rest.variant] : [],
    );
    expect(variants).toEqual(['Z', '@']);
  });

  it('混合方向八度 C,\' 只留 octaveRaw，不做抵消', () => {
    const note = items.find((item) => item.event.kind === 'note')?.event;
    expect(note?.kind).toBe('note');
    if (note?.kind !== 'note') return;
    expect(note.note.pitch.octaveRaw).toBe(",'");
    expect(note.note.pitch.octaveShift).toBeUndefined();
  });

  it('tuplet 的 q 省略（即 0）时不产生任何时值缩放，只保留字面值', () => {
    const { score } = render(MAIN_SOURCE);
    const tuplet = score.voices[0]?.tuplets[0];
    expect(tuplet?.p).toBe(3);
    expect(tuplet?.q).toBeUndefined();
  });
});

describe('buildRenderScore —— 确定性', () => {
  it('同一 RenderInput 两次构建逐字段相等（含诊断 id 与次序）', () => {
    const { score, index } = loadJcx(MAIN_SOURCE);
    const first = buildRenderScore({ score, index });
    const second = buildRenderScore({ score, index });
    expect(first).toEqual(second);
    expect(first.diagnostics.map((diagnostic) => diagnostic.id)).toEqual(
      second.diagnostics.map((diagnostic) => diagnostic.id),
    );
  });
});

/** 手造一条 resolved tie，用来把任意 `NoteRef` 喂给 `resolveRelation`。 */
function fakeTie(from: NoteRef, to: NoteRef): Tie {
  return {
    id: makeRelationId(makeVoiceId(1), 'tie', 9),
    kind: 'tie',
    status: 'resolved',
    origins: [],
    from,
    to,
  };
}

describe('relations —— 端点解析与 B 类悬空（endpoint-missing）', () => {
  /** `[CE]` 是一个两成员的 chord，后面跟一个没有 members 的单音。 */
  const CHORD_SOURCE = '%MUSE2\nX:1\nK:C\nV:1\n[V:1]\n[CE]G\n';

  function chordAndNote(): {
    readonly index: DomainIndex;
    readonly chordId: EventId;
    readonly noteId: EventId;
  } {
    const { index, renderScore } = render(CHORD_SOURCE);
    const items = renderScore.voices[0]?.items ?? [];
    const chordId = items.find((item) => item.event.kind === 'chord')?.eventId;
    const noteId = items.find((item) => item.event.kind === 'note')?.eventId;
    if (chordId === undefined || noteId === undefined) {
      throw new Error('用例语料应当产生一个 chord 与一个 note');
    }
    return { index, chordId, noteId };
  }

  it('正常输入下零悬空端点：A 类恢复状态不进 dangling', () => {
    const { score, index } = render('%MUSE2\nX:1\nK:C\nV:1\n[V:1]\nC-\n(DEF\n');
    const voice = score.voices[0];
    const relations = [...(voice?.ties ?? []), ...(voice?.slurs ?? [])];
    expect(relations.length).toBeGreaterThan(0);
    for (const relation of relations) {
      expect(resolveRelation(index, relation).dangling).toEqual([]);
    }
  });

  it('memberIndex 合法（chord 的 #0 / #1）→ 全部 resolved，零 dangling（正向对照）', () => {
    const { index, chordId } = chordAndNote();
    const resolvedRelation = resolveRelation(
      index,
      fakeTie({ eventId: chordId, memberIndex: 0 }, { eventId: chordId, memberIndex: 1 }),
    );
    expect(resolvedRelation.dangling).toEqual([]);
    expect(resolvedRelation.resolved).toHaveLength(2);
    expect(resolvedRelation.resolved[0]?.event.kind).toBe('chord');
  });

  it('event 存在但 memberIndex 越界 → dangling，reason 为 member-index-invalid', () => {
    const { index, chordId } = chordAndNote();
    const resolvedRelation = resolveRelation(
      index,
      fakeTie({ eventId: chordId, memberIndex: 99 }, { eventId: chordId }),
    );
    expect(resolvedRelation.dangling).toEqual([
      { role: 'from', ref: { eventId: chordId, memberIndex: 99 }, reason: 'member-index-invalid' },
    ]);
    // 不带 memberIndex 的那一端指整块，照常 resolved。
    expect(resolvedRelation.resolved.map((endpoint) => endpoint.role)).toEqual(['to']);
  });

  it('事件本就没有 members 却带 memberIndex → 同样无效，不得当成整块悄悄放行', () => {
    const { index, noteId } = chordAndNote();
    const resolvedRelation = resolveRelation(
      index,
      fakeTie({ eventId: noteId, memberIndex: 0 }, { eventId: noteId }),
    );
    expect(resolvedRelation.dangling.map((endpoint) => endpoint.reason)).toEqual([
      'member-index-invalid',
    ]);
  });

  it('无效 memberIndex 经 buildRenderScore 发出 relation.endpoint-missing（warning）', () => {
    const { score, index } = loadJcx(CHORD_SOURCE);
    const voice = score.voices[0];
    if (voice === undefined) throw new Error('用例语料应当产生一个声部');
    const chordId = voice.events.find((event) => event.kind === 'chord')?.id;
    if (chordId === undefined) throw new Error('用例语料应当产生一个 chord');

    const patched: Score = {
      ...score,
      voices: [{ ...voice, ties: [fakeTie({ eventId: chordId, memberIndex: 7 }, { eventId: chordId })] }],
    };

    const hits = buildRenderScore({ score: patched, index }).diagnostics.filter(
      (diagnostic) => diagnostic.code === RENDER_DIAGNOSTIC_CODES.relationEndpointMissing,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('warning');
    expect(hits[0]?.anchor.kind).toBe('relation');
    expect(hits[0]?.message).toContain('成员 #7');
  });

  it('index 里查不到端点时给出 dangling，并发一条 relation.endpoint-missing（warning）', () => {
    const { score, index } = loadJcx('%MUSE2\nX:1\nK:C\nV:1\n[V:1]\n(3CDE\n');
    const missing = score.voices[0]?.tuplets[0]?.members[0];
    if (missing === undefined) {
      throw new Error('用例语料应当产生一个含成员的 tuplet');
    }

    const trimmed = new Map(index.eventById);
    trimmed.delete(missing);
    const broken: DomainIndex = { ...index, eventById: trimmed };

    const renderScore = buildRenderScore({ score, index: broken });
    const hits = renderScore.diagnostics.filter(
      (diagnostic) => diagnostic.code === RENDER_DIAGNOSTIC_CODES.relationEndpointMissing,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.level).toBe('warning');
    expect(hits[0]?.anchor.kind).toBe('relation');
    // 与 tuplet 的时值诊断是两条不同 code，不合并。
    expect(withCode(renderScore, RENDER_DIAGNOSTIC_CODES.tupletTimingNotModeled)).toHaveLength(1);
  });
});

describe('diagnostics —— ordinal 递增与确定性（T0 /check 留下的 P2）', () => {
  const draft = (code: RenderDiagnosticCode): RenderDiagnosticDraft => ({
    code,
    level: 'info',
    message: code,
    anchor: { kind: 'document' },
  });

  it('renderDiagnostic 把 ordinal 写进 id，且同输入同输出', () => {
    const one = renderDiagnostic(draft('muse.render.x.y'), 3);
    expect(one.id).toBe('document|muse.render.x.y#3');
    expect(renderDiagnostic(draft('muse.render.x.y'), 3)).toEqual(one);
  });

  it('同 (anchor, code) 重复出现时 ordinal 从 0 起逐条递增', () => {
    const collected = collectRenderDiagnostics([
      draft('muse.render.x.y'),
      draft('muse.render.x.y'),
      draft('muse.render.z.w'),
      draft('muse.render.x.y'),
    ]);
    expect(collected.map((diagnostic) => diagnostic.id)).toEqual([
      'document|muse.render.x.y#0',
      'document|muse.render.x.y#1',
      'document|muse.render.z.w#0',
      'document|muse.render.x.y#2',
    ]);
  });

  it('不同 anchor 各自独立计数', () => {
    const voiceDraft: RenderDiagnosticDraft = {
      ...draft('muse.render.x.y'),
      anchor: { kind: 'voice', voiceId: makeVoiceId(1) },
    };
    const collected = collectRenderDiagnostics([draft('muse.render.x.y'), voiceDraft]);
    expect(collected.map((diagnostic) => diagnostic.id)).toEqual([
      'document|muse.render.x.y#0',
      'voice:v1|muse.render.x.y#0',
    ]);
  });

  it('两次收集结果逐字段相等', () => {
    const drafts = [draft('muse.render.x.y'), draft('muse.render.x.y')];
    expect(collectRenderDiagnostics(drafts)).toEqual(collectRenderDiagnostics(drafts));
  });
});

describe('layout/primitives —— 导出名单（§2.7 / §0d-1）', () => {
  const source = readFileSync(PRIMITIVES_FILE, 'utf8');
  const exported = [...source.matchAll(/export\s+interface\s+(\w+)/g)].map((m) => m[1]);

  it('只导出 Point / Box / TimeSlot / System', () => {
    expect(new Set(exported)).toEqual(new Set(['Point', 'Box', 'TimeSlot', 'System']));
  });

  it('不含 Anchor（它在 model/types.ts）、不含万能基类 LayoutItemBase', () => {
    expect(/export\s+(?:type|interface)\s+(?:Anchor|DiagnosticAnchor|LayoutItemBase)\b/.test(source)).toBe(
      false,
    );
  });
});

describe('buildRenderScore —— 全量 fixture 冒烟', () => {
  // 运行时 glob 全量，**不硬编码 fixture 数量**（P2-7）。名单与字节读取复用
  // `roundtrip.helpers`：它已把路径分隔符归一化为 `/`，避免 Windows CI 上
  // 按名字点名 fixture 的用例跨平台不一致（CI run 35054050143 实测过这个坑）。
  it('fixture 目录非空（避免目录读空导致的假绿）', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  it.each(fixtureNames)(
    '%s：loadJcx → buildRenderScore 不抛异常，items 总数 == events 总数',
    (name) => {
      const { score, index } = loadJcx(fixtureBytes(name));
      const renderScore = buildRenderScore({ score, index });

      const events = score.voices.reduce((sum, voice) => sum + voice.events.length, 0);
      const items = renderScore.voices.reduce((sum, voice) => sum + voice.items.length, 0);
      expect(items).toBe(events);
      expect(renderScore.score).toBe(score);
    },
  );

  it('至少有一个 fixture 真的产生了事件（非空断言）', () => {
    const total = fixtureNames.reduce((sum, name) => {
      const { score, index } = loadJcx(fixtureBytes(name));
      return (
        sum +
        buildRenderScore({ score, index }).voices.reduce(
          (inner, voice) => inner + voice.items.length,
          0,
        )
      );
    }, 0);
    expect(total).toBeGreaterThan(0);
  });
});
