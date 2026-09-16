/**
 * canonical serializer 的 defensive branch 直测 + 11 个 `jcx.serialize.*` code
 * 覆盖表（M1.8 T2(b)/(3)，方案 v1.1 §4 T2 / §0a 第 3 条）。
 *
 * ## 为什么这一半必须手造 Domain
 *
 * `roundtrip.test.ts` 的矩阵只喂得进**文本**。三个 code 的触发条件是
 * 「Domain 自相矛盾」，而 parse 层的不变量恰恰保证真实文本产不出这种 Domain：
 *
 * | code | 触发条件 | 为什么 `loadJcx` 到不了 |
 * | --- | --- | --- |
 * | `lyric-range-unresolved` | `LyricLine.bodyRange` 的首/末 `EventId` 不在本声部事件流里，或首尾颠倒 | `scripts/jcx/lib/parseInvariants.ts` 断言⑤（`checkFactualEventRefs`）：`bodyRange` 的首末必须存在于本声部且首不晚于末，`tests/unit/jcx/parse/invariants.test.ts` 对全体 fixture、`corpus-lex-test.ts` 对全体语料都在跑 |
 * | `unit-length-unresolved` | `UnitLengthChange.beforeEventId` 不在本声部事件流里 | 同断言⑤ |
 * | `unit-length-unrecoverable` | 声部开头需要把单位音长复位到描述头的值，但 `Score.unitLength` 缺省 | `Score.unitLength` 只有在**全文一条 `L:` 都没有**时才缺省（正文区首条 `L:` 会成为描述头的值，见 `parse/header.ts` 的 `unitLengthScope`）；而那时全体 `unitLengthChanges` 为空，声部间传递的生效值恒为 `undefined`，判据 `!sameUnitLength(undefined, undefined)` 永远为假 |
 *
 * 方案 §6 第 11 条禁止「为 serializer-only defensive branch 伪造文本 fixture」：
 * 造一个能触发它们的 `.jcx` 等于承认 parse 会产出这种 Domain，那是假证据。因此
 * 这里的输入统一是「`loadJcx` 一份正常文档 → 只替换那一个字段」，被替换的字段与
 * 替换值都写在用例里，不藏在夹具中。
 *
 * ## 每个用例的三条断言
 *
 * 1. 该 code 确实出现（正向，不是「没崩就算过」）；
 * 2. 输出确定（同一输入连跑两次文本逐字相等），畸形 Domain 不得引入不确定性；
 * 3. 内容不静默丢失：要么写进文本，要么带着 warning 被显式丢弃——两者必居其一。
 *
 * 末尾的「11 个 code 覆盖表」对 `src` 里全部 11 个 `jcx.serialize.*` code 各有一个
 * 直接正向用例。其中 8 个在 `canonical.header/body/lyrics.test.ts`、
 * `encodeJcx.test.ts` 里已有更细的用例，这里只做**最小场景重现**，目的是让
 * 「11 个 code 全部被显式断言过」这件事在一个文件里可查，而不是靠 grep 拼凑。
 */

import { describe, expect, it } from 'vitest';

import type { LyricLine, Score, UnitLengthChange, Voice } from '../../../../src/domain';
import { eventId, voiceId } from '../../../../src/domain';
import { loadJcx } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';

/** 最小文档骨架：描述头固定，只换正文与 `L:`（与 `canonical.lyrics.test.ts` 同款）。 */
function doc(body: string, unitLength = '1/4'): string {
  return `%MUSE2\nX:1\nT:t\nM:4/4\nL:${unitLength}\nK:C\nV:1\n${body}\n`;
}

/** 取出一份正常文档的单声部；失败直接断言，不让 `undefined` 漏进用例主体。 */
function singleVoice(source: string): { readonly score: Score; readonly voice: Voice } {
  const { score } = loadJcx(source);
  const voice = score.voices[0];
  expect(voice).toBeDefined();
  if (voice === undefined) {
    throw new Error('fixture 文档必须至少有一个声部');
  }
  return { score, voice };
}

function canonicalOf(score: Score): ReturnType<typeof serializeJcx> {
  return serializeJcx(score, { mode: 'canonical' });
}

function codesOf(score: Score): readonly string[] {
  return canonicalOf(score).diagnostics.map((d) => d.code);
}

/** 断言②：同一份（哪怕是畸形的）Domain 连跑两次，输出逐字相等。 */
function expectDeterministic(score: Score): string {
  const first = canonicalOf(score);
  const second = canonicalOf(score);
  expect(second.text).toBe(first.text);
  expect(second.diagnostics.map((d) => d.code)).toEqual(first.diagnostics.map((d) => d.code));
  return first.text;
}

describe('defensive branch: jcx.serialize.lyric-range-unresolved', () => {
  it('bodyRange 指向本声部不存在的 EventId：发 warning、按无强制断行处理、输出确定', () => {
    const { score, voice } = singleVoice(doc('CDEF|'));
    const first = voice.events[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      return;
    }
    const origin = voice.origins[0] ?? 'L1';
    // 末事件指向 `v1:e99`——形态合法（`domain/ids.ts` 的 `eventId` 生成，不用 `as`
    // 伪造类型），但这个下标在只有 5 个事件的声部里不存在。
    const line: LyricLine = {
      verseIndex: 0,
      syllables: [
        { text: 'la', kind: 'text', target: { eventId: first.id }, origin, offsetInLine: 0 },
      ],
      bodyRange: { firstEventId: first.id, lastEventId: eventId(voiceId(1), 99) },
    };
    const patched: Score = { ...score, voices: [{ ...voice, lyricLines: [line] }] };

    expect(codesOf(patched)).toContain('jcx.serialize.lyric-range-unresolved');
    const text = expectDeterministic(patched);
    // 不静默丢失：这条 `w:` 确实没被写出（它的位置无从确定），但它带着 warning
    // 被丢弃，且正文事件一个都没少。
    expect(text).not.toContain('w: la');
    expect(text).toContain('C D E F |');
    expect(loadJcx(text).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('bodyRange 首尾颠倒（end < start）：同一条 warning，不按倒序猜区间', () => {
    const { score, voice } = singleVoice(doc('CDEF|'));
    const first = voice.events[0];
    const third = voice.events[2];
    expect(first).toBeDefined();
    expect(third).toBeDefined();
    if (first === undefined || third === undefined) {
      return;
    }
    const origin = voice.origins[0] ?? 'L1';
    const line: LyricLine = {
      verseIndex: 0,
      syllables: [
        { text: 'la', kind: 'text', target: { eventId: third.id }, origin, offsetInLine: 0 },
      ],
      bodyRange: { firstEventId: third.id, lastEventId: first.id },
    };
    const patched: Score = { ...score, voices: [{ ...voice, lyricLines: [line] }] };

    expect(codesOf(patched)).toContain('jcx.serialize.lyric-range-unresolved');
    expectDeterministic(patched);
  });
});

describe('defensive branch: jcx.serialize.unit-length-unresolved', () => {
  it('unitLengthChanges 的 beforeEventId 定位不到：发 warning、该条 L: 不重放、输出确定', () => {
    const { score, voice } = singleVoice(doc('CDEF|'));
    const change: UnitLengthChange = {
      beforeEventId: eventId(voiceId(1), 99),
      unitLength: { num: 1, den: 8 },
      raw: '1/8',
      origin: voice.origins[0] ?? 'L1',
    };
    const patched: Score = { ...score, voices: [{ ...voice, unitLengthChanges: [change] }] };

    expect(codesOf(patched)).toContain('jcx.serialize.unit-length-unresolved');
    const text = expectDeterministic(patched);
    // 定位不到就不重放：正文里不得凭空多出一行 `L: 1/8`——那会改写它前后所有
    // 事件的单位音长，是真改语义。描述头那一行 `L: 1/4` 不受影响。
    expect(text).toContain('L: 1/4\n');
    expect(text).not.toContain('L: 1/8');
    expect(text).toContain('C D E F |');
  });
});

describe('defensive branch: jcx.serialize.unit-length-unrecoverable', () => {
  /**
   * 构造：两个声部，声部 1 在首事件处有一条 `L: 1/8` 变化（于是它的 outgoing 是
   * 1/8），而 `Score.unitLength` 被去掉。轮到声部 2 时「上一个声部留下的生效值」
   * 是 1/8、「描述头的值」不存在，canonical 无值可写。
   */
  function buildScore(): Score {
    const { score } = loadJcx(doc('CD|', '1/4'));
    const base = score.voices[0];
    expect(base).toBeDefined();
    if (base === undefined) {
      throw new Error('fixture 文档必须至少有一个声部');
    }
    const first = base.events[0];
    expect(first).toBeDefined();
    if (first === undefined) {
      throw new Error('fixture 文档必须至少有一个事件');
    }
    const origin = base.origins[0] ?? 'L1';
    const voice1: Voice = {
      ...base,
      unitLengthChanges: [
        {
          beforeEventId: first.id,
          unitLength: { num: 1, den: 8 },
          raw: '1/8',
          origin,
        },
      ],
    };
    const voice2: Voice = { ...base, id: voiceId(2), unitLengthChanges: [] };
    // `Score.unitLength` 是可选字段，用解构去掉而不是写 `undefined`：
    // `sameUnitLength` 判的是「缺省」，两者在这里等价，解构更贴近 parse 的产物形态。
    const { unitLength: _dropped, ...withoutUnitLength } = score;
    return { ...withoutUnitLength, voices: [voice1, voice2] };
  }

  it('描述头无 L: 却需要复位单位音长：发 warning、不猜值、输出确定', () => {
    const patched = buildScore();
    expect(patched.unitLength).toBeUndefined();

    expect(codesOf(patched)).toContain('jcx.serialize.unit-length-unrecoverable');
    const text = expectDeterministic(patched);
    // 不猜值：声部 2 的 body 开头没有凭空补出来的 `L:` 行。
    const lines = text.split('\n');
    const voice2At = lines.indexOf('[V:2]');
    expect(voice2At).toBeGreaterThan(-1);
    expect(lines[voice2At + 1]?.startsWith('L:')).toBe(false);
    // 内容不丢：两个声部的事件都写了出来。
    expect(lines.filter((line) => line === 'C D |')).toHaveLength(2);
    // 声部 1 自己那条 `L: 1/8` 照常重放（unrecoverable 只影响声部 2 的复位）。
    expect(text).toContain('L: 1/8');
  });

  it('前提核对：描述头有 L: 时同一份 Domain 改走「补写一行 L:」分支，不发 warning', () => {
    const patched = buildScore();
    const withHeader: Score = { ...patched, unitLength: { num: 1, den: 4 } };

    expect(codesOf(withHeader)).not.toContain('jcx.serialize.unit-length-unrecoverable');
    const lines = expectDeterministic(withHeader).split('\n');
    const voice2At = lines.indexOf('[V:2]');
    expect(lines[voice2At + 1]).toBe('L: 1/4');
  });
});

describe('11 个 jcx.serialize.* code 的覆盖表（每个 code 一个直接正向用例）', () => {
  /**
   * 与 `grep -rho "jcx\.serialize\.[a-z-]*" src | sort -u` 的结果同集合。
   * 新增 code 时这张表会先于 grep 暴露缺口：下面的「每个 code 都被断言过」用例
   * 要求表里每一项在本 describe 里都有一个同名 `it`。
   */
  const ALL_CODES: readonly string[] = [
    'jcx.serialize.ignored-field-dropped',
    'jcx.serialize.ignored-field-unencodable',
    'jcx.serialize.lyric-line-split',
    'jcx.serialize.lyric-line-unplaceable',
    'jcx.serialize.lyric-range-shadowed',
    'jcx.serialize.lyric-range-unresolved',
    'jcx.serialize.tab-relation-member-position',
    'jcx.serialize.unencodable-replaced',
    'jcx.serialize.unit-length-unrecoverable',
    'jcx.serialize.unit-length-unresolved',
    'jcx.serialize.voice-value-unencodable',
  ];

  /** 每个 code 一个最小场景；返回值是该场景实际产出的 code 列表。 */
  const SCENARIOS: Readonly<Record<string, () => readonly string[]>> = {
    'jcx.serialize.ignored-field-dropped': () => {
      const { score } = loadJcx(doc('CD|'));
      return codesOf({ ...score, ignoredFields: [{ name: 'L', rawValue: 'a\nb', origin: 'L7' }] });
    },
    'jcx.serialize.ignored-field-unencodable': () => {
      const { score } = loadJcx(doc('CD|'));
      return codesOf({ ...score, ignoredFields: [{ name: 'L', rawValue: 'a]b', origin: 'L7' }] });
    },
    'jcx.serialize.lyric-line-split': () => {
      const { score, voice } = singleVoice(doc('CDEF|', '1/4'));
      const target = voice.events[2];
      const first = voice.events[0];
      const last = voice.events[voice.events.length - 1];
      if (target === undefined || first === undefined || last === undefined) {
        return [];
      }
      const origin = voice.origins[0] ?? 'L1';
      const line: LyricLine = {
        verseIndex: 0,
        syllables: [
          { text: 'la', kind: 'text', target: { eventId: first.id }, origin, offsetInLine: 0 },
        ],
        bodyRange: { firstEventId: first.id, lastEventId: last.id },
      };
      const change: UnitLengthChange = {
        beforeEventId: target.id,
        unitLength: { num: 1, den: 8 },
        raw: '1/8',
        origin,
      };
      return codesOf({
        ...score,
        voices: [{ ...voice, lyricLines: [line], unitLengthChanges: [change] }],
      });
    },
    'jcx.serialize.lyric-line-unplaceable': () => {
      // 唯一一个从文本就能到达的：声部 2 零事件，它的 `w:` 行没有位置可挂。
      // 正因为它会让 L2 投影不相等（歌词行整条消失），它不适合做矩阵 fixture，
      // 见 `canonical.boundary.test.ts` 文件头「未入库的候选」第 3 条。
      const { score } = loadJcx(
        '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:2]\nw: la li\n[V:1]CD|\n',
      );
      return codesOf(score);
    },
    'jcx.serialize.lyric-range-shadowed': () => {
      const { score, voice } = singleVoice(doc('CDEFG|'));
      const first = voice.events[0];
      const third = voice.events[2];
      const last = voice.events[voice.events.length - 1];
      if (first === undefined || third === undefined || last === undefined) {
        return [];
      }
      const origin = voice.origins[0] ?? 'L1';
      const lineA: LyricLine = {
        verseIndex: 0,
        syllables: [
          { text: 'la', kind: 'text', target: { eventId: first.id }, origin, offsetInLine: 0 },
        ],
        bodyRange: { firstEventId: first.id, lastEventId: last.id },
      };
      const lineB: LyricLine = {
        verseIndex: 0,
        syllables: [
          { text: 'ma', kind: 'text', target: { eventId: third.id }, origin, offsetInLine: 0 },
        ],
        bodyRange: { firstEventId: third.id, lastEventId: last.id },
      };
      return codesOf({ ...score, voices: [{ ...voice, lyricLines: [lineA, lineB] }] });
    },
    'jcx.serialize.lyric-range-unresolved': () => {
      const { score, voice } = singleVoice(doc('CDEF|'));
      const first = voice.events[0];
      if (first === undefined) {
        return [];
      }
      const origin = voice.origins[0] ?? 'L1';
      const line: LyricLine = {
        verseIndex: 0,
        syllables: [
          { text: 'la', kind: 'text', target: { eventId: first.id }, origin, offsetInLine: 0 },
        ],
        bodyRange: { firstEventId: first.id, lastEventId: eventId(voiceId(1), 99) },
      };
      return codesOf({ ...score, voices: [{ ...voice, lyricLines: [line] }] });
    },
    'jcx.serialize.tab-relation-member-position': () => {
      const { score } = loadJcx(
        '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/8\nK:C\nV:1 style=tab clef=standardtab\n' +
          // `[b3c5]-H-b7` 的 from 端是两成员组的第 0 个成员（不在组尾），
          // marker 只能写在组尾，落位无法无损表达。
          '[V:1]a1-S-[a3c5] [b3c5]-H-b7 |\n',
      );
      return codesOf(score);
    },
    'jcx.serialize.unencodable-replaced': () => {
      // canonical 恒 UTF-8，编不出的字符不存在；这个 code 只能从 preserve +
      // GB18030 + 孤立代理项这条分支到达（与 canonical 共用同一个 `encodeJcx`）。
      const loaded = loadJcx('%MUSE2\nX:1\nT:\uD800\nM:4/4\nL:1/4\nK:C\nV:1\nCD|\n');
      return serializeJcx(loaded, {
        mode: 'preserve',
        encoding: 'gb18030',
        onUnencodable: 'replace',
      }).diagnostics.map((d) => d.code);
    },
    'jcx.serialize.unit-length-unrecoverable': () => {
      const { score } = loadJcx(doc('CD|', '1/4'));
      const base = score.voices[0];
      if (base === undefined) {
        return [];
      }
      const first = base.events[0];
      if (first === undefined) {
        return [];
      }
      const origin = base.origins[0] ?? 'L1';
      const voice1: Voice = {
        ...base,
        unitLengthChanges: [
          { beforeEventId: first.id, unitLength: { num: 1, den: 8 }, raw: '1/8', origin },
        ],
      };
      const { unitLength: _dropped, ...withoutUnitLength } = score;
      return codesOf({
        ...withoutUnitLength,
        voices: [voice1, { ...base, id: voiceId(2), unitLengthChanges: [] }],
      });
    },
    'jcx.serialize.unit-length-unresolved': () => {
      const { score, voice } = singleVoice(doc('CDEF|'));
      const change: UnitLengthChange = {
        beforeEventId: eventId(voiceId(1), 99),
        unitLength: { num: 1, den: 8 },
        raw: '1/8',
        origin: voice.origins[0] ?? 'L1',
      };
      return codesOf({ ...score, voices: [{ ...voice, unitLengthChanges: [change] }] });
    },
    'jcx.serialize.voice-value-unencodable': () => {
      const { score, voice } = singleVoice(doc('CD|'));
      // 值同时含空白与 `"`：加引号会被 `"` 提前截断，不加引号会被空白截断，
      // JCX 的 `V:` 属性语法没有转义机制（不猜），原样输出 + warning。
      return codesOf({ ...score, voices: [{ ...voice, name: 'a "b" c' }] });
    },
  };

  it.each(ALL_CODES)('%s 有直接正向用例', (code) => {
    const scenario = SCENARIOS[code];
    expect(scenario).toBeDefined();
    if (scenario === undefined) {
      return;
    }
    expect(scenario()).toContain(code);
  });

  it('覆盖表与场景表同集合（新增 code 时先在这里暴露缺口）', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ALL_CODES].sort());
    expect(ALL_CODES.length).toBe(11);
    expect(new Set(ALL_CODES).size).toBe(ALL_CODES.length);
  });
});
