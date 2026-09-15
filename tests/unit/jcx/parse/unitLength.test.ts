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
function parseFixture(name: string): Score {
  const src = readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
  return parseJcxDocument(buildAst(lexJcx(src))).score;
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

describe('一条全局 L: 影响多个声部（body-field-l-two-voices fixture）', () => {
  const score = parseFixture('body-field-l-two-voices');
  const first = voiceOf(score, voiceId(1));
  const second = voiceOf(score, voiceId(2));

  it('每个受影响的声部各记一条，beforeEventId 各自不同', () => {
    expect(changes(first)).toEqual(['v1:e5 1/8 1/8']);
    expect(changes(second)).toEqual(['v2:e5 1/8 1/8']);
  });

  it('两条 change 同源于同一行 L:（origin 相同）', () => {
    expect(first.unitLengthChanges[0]?.origin).toBe(second.unitLengthChanges[0]?.origin);
  });
});

describe('没有 body L: 的文件不产生 change', () => {
  it.each(['minimal', 'lyrics', 'tab'])('%s', (name) => {
    for (const voice of parseFixture(name).voices) {
      expect(voice.unitLengthChanges).toEqual([]);
    }
  });
});
