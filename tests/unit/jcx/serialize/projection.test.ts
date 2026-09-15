/**
 * L2 语义投影单测（M1.7 T6，方案 v1.1 §6 / §8 拍板 G）。
 *
 * round-trip 矩阵（`roundtrip.test.ts`）只能证明「两边投影相等」，证明不了
 * **投影本身没把差异吃掉**——一个恒返回 `{}` 的投影也能让矩阵全绿。本文件补的
 * 就是这一层：逐类断言投影确实**保留**了引用、未知字段与顺序，并且确实**只**
 * 归一化了该归一化的两项（directive `trimStart`、`offsetInLine` 归零）。
 *
 * 用例尽量走真实链路 `loadJcx(源文本).score`；只有「悬空引用」一例必须手工改造
 * Domain——parse 层不会产出指向不存在事件的引用，而投影对悬空引用的处理
 * （显式 `{ unresolved: true }`，不抛异常）是必须被钉住的契约。
 */

import { describe, expect, it } from 'vitest';

import type { Score, Voice } from '../../../../src/domain';
import { eventId, voiceId } from '../../../../src/domain';
import { loadJcx } from '../../../../src/formats/jcx';
import {
  firstProjectionDifference,
  projectScore,
  projectionEquals,
} from '../../../../src/formats/jcx/serialize';

function scoreOf(source: string): Score {
  return loadJcx(source).score;
}

const HEADER = 'X:1\nT:t\nM:4/4\nL:1/8\nK:C\nV:1\n';

describe('引用归一化（拍板 G：归一化而非删除）', () => {
  it('tie / slur / tuplet / brokenRhythm 的端点都变成 (voiceIndex, eventIndex)', () => {
    const projected = projectScore(scoreOf(`${HEADER}C-C (D E) (3FGA B>c\n`));
    const voice = projected.voices[0];

    expect(voice?.ties).toHaveLength(1);
    expect(voice?.ties[0]?.from).toEqual({ voiceIndex: 0, eventIndex: 0, memberIndex: null });
    expect(voice?.ties[0]?.to).toEqual({ voiceIndex: 0, eventIndex: 1, memberIndex: null });

    expect(voice?.slurs[0]?.status).toBe('closed');
    expect(voice?.slurs[0]?.from).toEqual({ voiceIndex: 0, eventIndex: 2, memberIndex: null });
    expect(voice?.slurs[0]?.to).toEqual({ voiceIndex: 0, eventIndex: 3, memberIndex: null });

    expect(voice?.tuplets[0]?.raw).toBe('(3');
    expect(voice?.tuplets[0]?.members).toEqual([
      { voiceIndex: 0, eventIndex: 4, memberIndex: null },
      { voiceIndex: 0, eventIndex: 5, memberIndex: null },
      { voiceIndex: 0, eventIndex: 6, memberIndex: null },
    ]);

    expect(voice?.brokenRhythms[0]?.raw).toBe('>');
    expect(voice?.brokenRhythms[0]?.from).toEqual({
      voiceIndex: 0,
      eventIndex: 7,
      memberIndex: null,
    });
    expect(voice?.brokenRhythms[0]?.to).toEqual({
      voiceIndex: 0,
      eventIndex: 8,
      memberIndex: null,
    });

    // 投影结果里不残留任何 id / origin 字符串。
    const dumped = JSON.stringify(projected);
    expect(dumped).not.toContain('v1:e');
    expect(dumped).not.toContain('origin');
  });

  it('和弦内 tie 的 NoteRef 带 memberIndex；未配对 tie 的 to 为 null', () => {
    const projected = projectScore(scoreOf(`${HEADER}[C-E-G] [CEG] D-\n`));
    const ties = projected.voices[0]?.ties ?? [];

    expect(ties.filter((tie) => tie.status === 'resolved').length).toBeGreaterThan(0);
    for (const tie of ties) {
      if (tie.status === 'resolved') {
        expect(tie.from).toMatchObject({ voiceIndex: 0 });
        expect(tie.to).not.toBeNull();
      }
    }
    expect(ties.some((tie) => 'memberIndex' in tie.from && tie.from.memberIndex !== null)).toBe(
      true,
    );
    const unresolved = ties.filter((tie) => tie.status === 'unresolved');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.to).toBeNull();
  });

  it('unitLengthChanges.beforeEventId 与 LyricLine.bodyRange 的首尾都被归一化', () => {
    const projected = projectScore(
      scoreOf(`${HEADER}C D\nw: do re\nL:1/4\nE F\nw: mi fa\n`),
    );
    const voice = projected.voices[0];

    expect(voice?.unitLengthChanges).toHaveLength(1);
    expect(voice?.unitLengthChanges[0]?.raw).toBe('1/4');
    expect(voice?.unitLengthChanges[0]?.beforeEvent).toEqual({
      voiceIndex: 0,
      eventIndex: 2,
      memberIndex: null,
    });

    expect(voice?.lyricLines).toHaveLength(2);
    expect(voice?.lyricLines[0]?.bodyRange).toEqual({
      first: { voiceIndex: 0, eventIndex: 0, memberIndex: null },
      last: { voiceIndex: 0, eventIndex: 1, memberIndex: null },
    });
    expect(voice?.lyricLines[0]?.syllables[0]?.target).toEqual({
      voiceIndex: 0,
      eventIndex: 0,
      memberIndex: null,
    });
  });

  it('找不到目标 id 时记为 { unresolved: true }，不抛异常', () => {
    const score = scoreOf(`${HEADER}C-C\n`);
    const voice = score.voices[0];
    expect(voice).toBeDefined();
    if (voice === undefined) return;

    // 把 tie 的一端指向一个本 Score 内不存在的事件（越界下标）。
    const dangling = eventId(voiceId(1), 99);
    const tie = voice.ties[0];
    expect(tie?.status).toBe('resolved');
    if (tie === undefined || tie.status !== 'resolved') return;

    const patchedVoice: Voice = { ...voice, ties: [{ ...tie, to: { eventId: dangling } }] };
    const patched: Score = { ...score, voices: [patchedVoice] };

    const projected = projectScore(patched);
    expect(projected.voices[0]?.ties[0]?.to).toEqual({ unresolved: true });
    expect(projected.voices[0]?.ties[0]?.from).toEqual({
      voiceIndex: 0,
      eventIndex: 0,
      memberIndex: null,
    });
  });
});

describe('归一化规则（只归一化该归一化的）', () => {
  it('directive 的 rawValue 按 trimStart 归一，name 与顺序不动', () => {
    const projected = projectScore(
      scoreOf('X:1\n%%first    alpha\n%%second beta\nK:C\nV:1\nC\n'),
    );
    expect(projected.directives.map((d) => d.name)).toEqual(['first', 'second']);
    expect(projected.directives.map((d) => d.rawValue)).toEqual(['alpha', 'beta']);
  });

  it('LyricSyllable.offsetInLine 一律归零（行内偏移是排版事实）', () => {
    const score = scoreOf(`${HEADER}C D E\nw: do re mi\n`);
    const offsets = score.voices[0]?.lyricLines[0]?.syllables.map((s) => s.offsetInLine) ?? [];
    expect(new Set(offsets).size).toBeGreaterThan(1);

    const projected = projectScore(score);
    expect(projected.voices[0]?.lyricLines[0]?.syllables.map((s) => s.offsetInLine)).toEqual([
      0, 0, 0,
    ]);
  });
});

describe('事实字段一律保留（拍板 G：不排除 unknownFields）', () => {
  it('unknownFields / ignoredFields / unknownAttributes 保 name、rawValue 与顺序', () => {
    const projected = projectScore(
      scoreOf('X:1\nY:zeta\nY:alpha\nK:C\nV:1 play=1 zz=2\nQ:1/4=90\nC\n'),
    );

    expect(projected.unknownFields).toEqual([
      { name: 'Y', rawValue: 'zeta' },
      { name: 'Y', rawValue: 'alpha' },
    ]);
    expect(projected.ignoredFields).toEqual([{ name: 'Q', rawValue: '1/4=90' }]);
    expect(projected.voices[0]?.unknownAttributes).toEqual([
      { key: 'play', value: '1' },
      { key: 'zz', value: '2' },
    ]);
  });

  it('UnknownEvent 的 raw 与 tokenKind、多条 T: 的顺序都保留', () => {
    const projected = projectScore(scoreOf('X:1\nT:b\nT:a\nK:C\nV:1\nC ^ D\n'));
    expect(projected.titles).toEqual(['b', 'a']);
    const unknown = projected.voices[0]?.events.filter((e) => e.kind === 'unknown') ?? [];
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.raw).toBe('^');
    expect(unknown[0]?.tokenKind).toBe('accidental');
  });
});

describe('确定性与比较工具', () => {
  it('同一个 Score 投影两次结果相等（不含随机顺序、不含对象身份）', () => {
    const score = scoreOf(`${HEADER}C-C (D E) (3FGA B>c |\nw: a b c d e f\n`);
    const once = projectScore(score);
    const twice = projectScore(score);

    expect(twice).toEqual(once);
    expect(projectionEquals(once, twice)).toBe(true);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('firstProjectionDifference 报出第一处差异的字段路径', () => {
    const a = projectScore(scoreOf(`${HEADER}C D\n`));
    const b = projectScore(scoreOf(`${HEADER}C E\n`));

    expect(firstProjectionDifference(a, b)).toBe('$.voices[0].events[1].note.pitch.letter');
    expect(projectionEquals(a, b)).toBe(false);

    const shorter = projectScore(scoreOf(`${HEADER}C\n`));
    expect(firstProjectionDifference(a, shorter)).toBe('$.voices[0].events.length');
  });
});
