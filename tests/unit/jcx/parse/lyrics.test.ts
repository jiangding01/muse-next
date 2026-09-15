import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { buildAst } from '../../../../src/formats/jcx/ast';
import { lexJcx } from '../../../../src/formats/jcx/lexer';
import type { JcxDiagnostic } from '../../../../src/formats/jcx/lexer/diagnostics';
import { parseJcxDocument } from '../../../../src/formats/jcx/parse';
import type { Score, Voice, VoiceId } from '../../../../src/domain';
import { voiceId } from '../../../../src/domain';

/**
 * M1.6 T8：全部走 `lexJcx → buildAst → parseJcxDocument` 真实链路（同 scan.test.ts /
 * segments.test.ts 的既有约定），只对投影断言：音节 `[text, kind, targetIndex]`、
 * `verseIndex`、诊断 code。不做整树快照，`origin` / `span` 一律排除。
 *
 * `targetIndex` 直接取 `NoteRef.eventId` 的数字后缀（`eventId` 形态见
 * `src/domain/ids.ts`：`${voiceId}:e${该声部事件流下标}`）——它是该声部事件流里的绝对
 * 下标（含 grace/rest/barline 等不可唱事件），不是「可唱事件」内部的下标。这样断言能
 * 同时证明「音节顺序对应正确的可唱事件」与「grace/rest 确实被跳过、没有被错误计数」。
 *
 * `lyrics.jcx` 里每条 `w:` 行各自绑定到独立的 bodyLine（`verseIndex` 均为 0，因为
 * 「多段」只在同一 bodyLine 被连续多条 `w:` 绑定时才递增，见 `lyrics-multi-verse`
 * 用例），因此这里按 `voice.lyricLines` 的出现顺序取行，而不是按 `verseIndex` 取。
 */
function fixtureSource(name: string): string {
  return readFileSync(resolve(__dirname, `../../../fixtures/jcx/${name}.jcx`), 'utf-8');
}

function parseFixture(name: string): { score: Score; diagnostics: readonly JcxDiagnostic[] } {
  const result = parseJcxDocument(buildAst(lexJcx(fixtureSource(name))));
  return { score: result.score, diagnostics: result.diagnostics };
}

function voiceOf(score: Score, id: VoiceId): Voice {
  const voice = score.voices.find((candidate) => candidate.id === id);
  if (voice === undefined) {
    throw new Error(`fixture 里找不到声部 ${id}`);
  }
  return voice;
}

/** `eventId` 的数字后缀（该声部事件流里的绝对下标）；`target` 缺失时为 `null`。 */
function targetIndex(target: { readonly eventId: string } | undefined): number | null {
  if (target === undefined) {
    return null;
  }
  const match = /:e(\d+)$/.exec(target.eventId);
  if (match === null) {
    throw new Error(`意料之外的 eventId 形态：${target.eventId}`);
  }
  return Number(match[1]);
}

function projectAt(voice: Voice, index: number): Array<[string, string, number | null]> {
  const line = voice.lyricLines[index];
  if (line === undefined) {
    throw new Error(`声部里找不到第 ${index} 条歌词行`);
  }
  return line.syllables.map((s) => [s.text, s.kind, targetIndex(s.target)]);
}

function parseCodes(diagnostics: readonly JcxDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.code.startsWith('jcx.parse.lyrics.')).map((d) => d.code);
}

describe('lyrics fixture（spec §24：基本对齐 / * 跳过 / ~ 合并 / chord / grace / rest / -_| 保留）', () => {
  it('CDEF + "la li lu la" 逐音节对应 4 个 note 事件', () => {
    const { score } = parseFixture('lyrics');
    const voice = voiceOf(score, voiceId(1));
    expect(voice.lyricLines).toHaveLength(4);
    expect(voice.lyricLines.every((l) => l.verseIndex === 0)).toBe(true);
    expect(projectAt(voice, 0)).toEqual([
      ['la', 'text', 0],
      ['li', 'text', 1],
      ['lu', 'text', 2],
      ['la', 'text', 3],
    ]);
  });

  it('{G}A B z C + "la * lu"：grace 不占音节、rest 不算可唱事件、* 占位不赋词', () => {
    const { score } = parseFixture('lyrics');
    const voice = voiceOf(score, voiceId(1));
    // 事件流：grace(5) note A(6) note B(7) rest(8) note C(9)；可唱事件 = A/B/C，对应下标 6/7/9。
    // `*` 跳过音符本身不赋词，`target` 按实现省略（见 lyrics.ts `buildSyllables`），
    // 但它仍消费了 index=7（B）这个可唱事件的位置——下一个音节 lu 因此落在 index=9（C）。
    expect(projectAt(voice, 1)).toEqual([
      ['la', 'text', 6],
      ['*', 'skip', null],
      ['lu', 'text', 9],
    ]);
  });

  it('[CEG] A + "la~li lu"：~ 合并成一个音节，对应 chord 事件（不带 memberIndex）', () => {
    const { score } = parseFixture('lyrics');
    const voice = voiceOf(score, voiceId(1));
    const syllables = voice.lyricLines[2]?.syllables ?? [];
    expect(syllables.map((s) => [s.text, s.kind, targetIndex(s.target)])).toEqual([
      ['la~li', 'merge', 11],
      ['lu', 'text', 12],
    ]);
    expect(syllables[0]?.target?.memberIndex).toBeUndefined();
  });

  it('A B C + "la-li lu_x y|z"：-/_/| 原样保留在音节文本里，不做切分', () => {
    const { score } = parseFixture('lyrics');
    const voice = voiceOf(score, voiceId(1));
    expect(projectAt(voice, 3)).toEqual([
      ['la-li', 'text', 14],
      ['lu_x', 'text', 15],
      ['y|z', 'text', 16],
    ]);
  });

  it('诊断：~ 触发 doc-only-separator info、-/_/| 触发 unverified-separator info、全篇 aligned-by-documentation 只发一次', () => {
    const { diagnostics } = parseFixture('lyrics');
    const codes = parseCodes(diagnostics);
    expect(codes).toContain('jcx.parse.lyrics.doc-only-separator');
    expect(codes).toContain('jcx.parse.lyrics.unverified-separator');
    expect(codes.filter((c) => c === 'jcx.parse.lyrics.aligned-by-documentation')).toHaveLength(1);
    expect(codes.filter((c) => c === 'jcx.parse.lyrics.doc-only-separator')).toHaveLength(1);
    expect(codes.filter((c) => c === 'jcx.parse.lyrics.unverified-separator')).toHaveLength(1);
    for (const d of diagnostics.filter((x) => x.code.startsWith('jcx.parse.lyrics.'))) {
      expect(d.severity).toBe('info');
    }
  });

  it('诊断：目标行（{G}A B z C）含 rest 时发一次 rest-excluded info，其余没有 rest 的目标行不重复触发', () => {
    const { diagnostics } = parseFixture('lyrics');
    const restExcluded = diagnostics.filter((d) => d.code === 'jcx.parse.lyrics.rest-excluded');
    expect(restExcluded).toHaveLength(1);
    expect(restExcluded[0]?.severity).toBe('info');
  });
});

describe('lyrics-tab fixture（tab 声部：可唱事件同样覆盖 tabNote）', () => {
  it('a1 b2 c10 + "la li lu" 逐音节对应 3 个 tabNote 事件', () => {
    const { score } = parseFixture('lyrics-tab');
    const voice = voiceOf(score, voiceId(1));
    expect(projectAt(voice, 0)).toEqual([
      ['la', 'text', 0],
      ['li', 'text', 1],
      ['lu', 'text', 2],
    ]);
  });
});

describe('lyrics-inline-trailing fixture（P2 修复：[V:1] C D 这种同行尾随正文也能被紧跟的 w: 绑定）', () => {
  it('[V:1] C D + "la li"：紧跟的 w: 绑到同行尾随正文，而不是 undefined 或更早的行', () => {
    const { score } = parseFixture('lyrics-inline-trailing');
    const voice = voiceOf(score, voiceId(1));
    expect(voice.lyricLines).toHaveLength(1);
    expect(projectAt(voice, 0)).toEqual([
      ['la', 'text', 0],
      ['li', 'text', 1],
    ]);
  });
});

describe('lyrics-multi-verse fixture（spec §24.2 点 4：同一行多条 w: 是多段歌词；无 rest，rest-excluded 不触发）', () => {
  it('两条 w: 行绑定同一 bodyLine，verseIndex 按出现顺序递增', () => {
    const { score, diagnostics } = parseFixture('lyrics-multi-verse');
    const voice = voiceOf(score, voiceId(1));
    expect(voice.lyricLines).toHaveLength(2);
    expect(voice.lyricLines.map((l) => l.verseIndex)).toEqual([0, 1]);
    expect(projectAt(voice, 0)).toEqual([
      ['la', 'text', 0],
      ['li', 'text', 1],
      ['lu', 'text', 2],
      ['la', 'text', 3],
    ]);
    expect(projectAt(voice, 1)).toEqual([
      ['ma', 'text', 0],
      ['mi', 'text', 1],
      ['mu', 'text', 2],
      ['ma', 'text', 3],
    ]);
    expect(diagnostics.filter((d) => d.code === 'jcx.parse.lyrics.rest-excluded')).toHaveLength(0);
  });
});

describe('lyrics-overflow fixture（音节多于可唱事件）', () => {
  it('多余音节 target 省略，且只发一次 warning', () => {
    const { score, diagnostics } = parseFixture('lyrics-overflow');
    const voice = voiceOf(score, voiceId(1));
    expect(projectAt(voice, 0)).toEqual([
      ['la', 'text', 0],
      ['li', 'text', 1],
      ['lu', 'text', null],
      ['ma', 'text', null],
    ]);
    const overflow = diagnostics.filter((d) => d.code === 'jcx.parse.lyrics.overflow');
    expect(overflow).toHaveLength(1);
    expect(overflow[0]?.severity).toBe('warning');
  });
});

describe('minimal fixture（无 w: 行）', () => {
  it('lyricLines 为空数组，不发任何 lyrics 诊断', () => {
    const { score, diagnostics } = parseFixture('minimal');
    const voice = voiceOf(score, voiceId(1));
    expect(voice.lyricLines).toEqual([]);
    expect(parseCodes(diagnostics)).toEqual([]);
  });
});

/**
 * M1.7 T0：`LyricLine.bodyRange` —— 该 `w:` 行绑定目标产生的**全部**事件的首尾 id
 * （含 grace / rest / barline），与音节 target 的可唱子序列无关。
 */
function bodyRangeOf(voice: Voice, index: number): string | null {
  const range = voice.lyricLines[index]?.bodyRange;
  if (range === undefined) {
    throw new Error(`fixture 里找不到第 ${index} 条歌词行`);
  }
  return range === null ? null : `${range.firstEventId}..${range.lastEventId}`;
}

describe('M1.7 T0：LyricLine.bodyRange（行边界事实）', () => {
  it('lyrics fixture：四条 w: 行各自覆盖一整条正文行，含 grace / rest / barline', () => {
    const voice = voiceOf(parseFixture('lyrics').score, voiceId(1));
    expect([0, 1, 2, 3].map((i) => bodyRangeOf(voice, i))).toEqual([
      // `CDEF|`：四个音 + 小节线。
      'v1:e0..v1:e4',
      // `{G}A B z C|`：首事件是 grace、末事件是 barline，两者都不可唱但都在范围内。
      'v1:e5..v1:e10',
      'v1:e11..v1:e13',
      'v1:e14..v1:e17',
    ]);
    // 范围首尾确实是不可唱事件，证明它不是「可唱事件范围」。
    expect(voice.events[5]?.kind).toBe('grace');
    expect(voice.events[10]?.kind).toBe('barline');
  });

  it('lyrics-multi-verse fixture：同一条正文行的多段歌词共用同一个范围', () => {
    const voice = voiceOf(parseFixture('lyrics-multi-verse').score, voiceId(1));
    expect(bodyRangeOf(voice, 0)).toBe('v1:e0..v1:e4');
    expect(bodyRangeOf(voice, 1)).toBe('v1:e0..v1:e4');
    expect(voice.lyricLines.map((line) => line.verseIndex)).toEqual([0, 1]);
  });

  it('lyrics-inline-trailing fixture：绑定 `[V:1] C D` 的同行尾随正文', () => {
    const voice = voiceOf(parseFixture('lyrics-inline-trailing').score, voiceId(1));
    expect(bodyRangeOf(voice, 0)).toBe('v1:e0..v1:e1');
  });

  it('lyrics-no-target fixture：没有绑定目标时 bodyRange 显式为 null，不伪造 EventId', () => {
    const voice = voiceOf(parseFixture('lyrics-no-target').score, voiceId(1));
    expect(bodyRangeOf(voice, 0)).toBeNull();
    expect(voice.lyricLines[0]?.syllables.map((s) => s.target)).toEqual([undefined, undefined]);
  });

  it('lyrics-tab fixture：TAB 声部的范围同样落在本声部的事件序列内', () => {
    const score = parseFixture('lyrics-tab').score;
    for (const voice of score.voices) {
      const ids = new Set(voice.events.map((event) => event.id));
      for (const line of voice.lyricLines) {
        expect(line.bodyRange).not.toBeNull();
        const range = line.bodyRange;
        expect(range === null ? null : ids.has(range.firstEventId)).toBe(true);
        expect(range === null ? null : ids.has(range.lastEventId)).toBe(true);
      }
    }
  });
});
