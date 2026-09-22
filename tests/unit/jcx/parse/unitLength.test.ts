import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import { parseJcxDocument } from '../../../../src/formats/jcx/parse';
import type { Score, Voice, VoiceId } from '../../../../src/domain';
import { voiceId } from '../../../../src/domain';

/**
 * M1.7 T0：`Voice.unitLengthChanges`（body 区 `L:` 在各声部事件序列上的生效位置）。
 *
 * 全部走 `lexJcx → buildAst → parseJcxDocument` 真实链路，只对投影断言
 * `[beforeEventId, raw, unitLength]`，`origin` 只在「同一条 `L:` 产生多条 change」
 * 的用例里断言其同源性。
 */
function parseFixtureFull(name: string) {
  const src = readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
  return parseJcxDocument(buildAst(lexJcx(src)));
}

function parseFixture(name: string): Score {
  return parseFixtureFull(name).score;
}

function voiceOf(score: Score, id: VoiceId): Voice {
  const voice = score.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) {
    throw new Error(`fixture 里找不到声部 ${id}`);
  }
  return voice;
}

function changes(voice: Voice): string[] {
  return voice.unitLengthChanges.map(
    (change) =>
      `${change.beforeEventId} ${change.raw} ${String(change.unitLength.num)}/${String(change.unitLength.den)}`,
  );
}

describe('body 区 L: 落到事件序列（body-field-l fixture）', () => {
  const score = parseFixture('body-field-l');
  const voice = voiceOf(score, voiceId(1));

  it('变化记在「变化后第一个事件」上，带 L: 的值原文', () => {
    expect(changes(voice)).toEqual(['v1:e10 1/8 1/8']);
  });

  it('beforeEventId 指向的事件确实在该声部里，且描述头的 L: 不产生 change', () => {
    expect(voice.events.map((event) => event.id)).toContain('v1:e10');
    expect(score.unitLength).toEqual({ num: 1, den: 4 });
    expect(voice.unitLengthChanges).toHaveLength(1);
  });
});

describe('无描述头 L: 时的 body L:（scan-unit-length-scope fixture）', () => {
  it('从「单位音长未知」变成 1/4 同样记一条 change', () => {
    const voice = voiceOf(parseFixture('scan-unit-length-scope'), voiceId(1));
    expect(changes(voice)).toEqual(['v1:e4 1/4 1/4']);
  });
});

describe('body L: 只作用于它所在的声部，不泄漏到其它声部（body-field-l-two-voices fixture，spec §8.5 U06 已裁决）', () => {
  // fixture 里的 `L:1/8` 出现在 `[V:2]GABc|` 之后、`[V:1]cdef|` 之前，
  // 即此刻 currentVoiceId = V2：按 U06 裁决它只归属 V2，V1 全程保持 header 的 1/4，
  // 这与 M1.7 T0 当初「按 AST 行序全局推进」把它泄漏进 V1 的（已裁定为 bug 的）
  // 旧行为相反——旧版本此处曾断言两个声部各记一条，是钉住泄漏的用例，现已翻转。
  const score = parseFixture('body-field-l-two-voices');
  const first = voiceOf(score, voiceId(1));
  const second = voiceOf(score, voiceId(2));

  it('V1 不受影响：全程 1/4，没有 change', () => {
    expect(changes(first)).toEqual([]);
  });

  it('V2 记一条 change：从 header 的 1/4 变成 1/8', () => {
    expect(changes(second)).toEqual(['v2:e5 1/8 1/8']);
  });

  it('body-scope info 发两条：本行归属 V2 一条 + V2 跨段续上时再一条', () => {
    const { diagnostics } = parseFixtureFull('body-field-l-two-voices');
    const bodyScope = diagnostics.filter((d) => d.code === 'jcx.parse.unit-length.body-scope');
    expect(bodyScope).toHaveLength(2);
    expect(bodyScope.every((d) => d.severity === 'info')).toBe(true);
    expect(bodyScope[0]?.message).toContain('声部 v2');
    expect(bodyScope[1]?.message).toContain('INFERRED');
  });
});

describe('声部作用域基础用例（unit-length-voice-scope fixture，spec §8.5 U06 已裁决）', () => {
  // 头 L:1/8；[V:1]（TAB）内先有 L:1/4 再有事件，[V:2]（jianpu）没有自己的 L:。
  const score = parseFixture('unit-length-voice-scope');
  const v1 = voiceOf(score, voiceId(1));
  const v2 = voiceOf(score, voiceId(2));

  it('v1 的事件按 1/4（绑定的 body L:），v2 的事件按 1/8（header，不受 v1 的 L: 影响）', () => {
    const durationOf = (voice: Voice) =>
      voice.events
        .filter((event): event is Extract<typeof event, { kind: 'tabNote' | 'note' }> =>
          event.kind === 'tabNote' || event.kind === 'note',
        )
        .map((event) => event.note.duration);
    expect(durationOf(v1)).toEqual([{ num: 1, den: 4 }, { num: 1, den: 4 }]);
    // C2/D2 = 2 × unitLength；v2 unitLength 仍是 header 的 1/8，故算出 1/4。
    expect(durationOf(v2)).toEqual([{ num: 1, den: 4 }, { num: 1, den: 4 }]);
  });

  it('v1 的 unitLengthChanges 有一条，v2 为空', () => {
    expect(changes(v1)).toEqual(['v1:e0 1/4 1/4']);
    expect(changes(v2)).toEqual([]);
  });
});

describe('声部作用域跨段持续（unit-length-voice-scope-interleaved fixture，INFERRED）', () => {
  // [V:1] L:1/4 … [V:2] … [V:1] …：V1 被 [V:2] 打断后再切回，L:1/4 应按声部持续。
  const score = parseFixture('unit-length-voice-scope-interleaved');
  const v1 = voiceOf(score, voiceId(1));
  const v2 = voiceOf(score, voiceId(2));

  it('v1 切回之后的后段仍按 1/4，v2 全程 1/8', () => {
    const v1Notes = v1.events.filter(
      (event): event is Extract<typeof event, { kind: 'tabNote' }> => event.kind === 'tabNote',
    );
    expect(v1Notes.map((event) => event.note.duration)).toEqual([
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 4 },
      { num: 1, den: 4 },
    ]);
    expect(changes(v2)).toEqual([]);
  });

  it('v1 只有一条 unitLengthChanges（跨段持续，不是「按段重置」再记一条）', () => {
    expect(changes(v1)).toEqual(['v1:e0 1/4 1/4']);
  });

  it('跨段持续按声部发一条 body-scope info（INFERRED，第二条诊断）', () => {
    const { diagnostics } = parseFixtureFull('unit-length-voice-scope-interleaved');
    const bodyScope = diagnostics.filter((d) => d.code === 'jcx.parse.unit-length.body-scope');
    expect(bodyScope).toHaveLength(2);
    expect(bodyScope[0]?.message).toContain('声部 v1');
    expect(bodyScope[1]?.message).toContain('INFERRED');
    expect(bodyScope[1]?.severity).toBe('info');
  });
});

describe('没有 body L: 的文件不产生 change', () => {
  it.each(['minimal', 'lyrics', 'tab'])('%s', (name) => {
    for (const voice of parseFixture(name).voices) {
      expect(voice.unitLengthChanges).toEqual([]);
    }
  });
});
