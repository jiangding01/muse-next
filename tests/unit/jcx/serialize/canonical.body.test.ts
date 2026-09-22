/**
 * canonical body 回归（M1.7 T4，方案 v1.1 §3 / 决策 1–4 / 2026-09-15 用户裁决①–④）。
 *
 * 全部用例走**真实链路** `loadJcx(源文本).score → serializeCanonical`：断言的是
 * 「解析出来的事实能不能原样写回」，而不是「渲染函数对我编的对象做了什么」。
 * 唯一手工构造 Domain 的是「`L:` 变化点落在 `w:` 覆盖的正文中间」那一例——
 * 源文本里 `L:` 是整行粒度，这种输入**解析不出来**，只能直接造 Voice 验证
 * 裁决①的降级路径。
 *
 * 每个用例都带 **re-parse 前哨**（`roundTrip`）：对 canonical 文本再 `loadJcx`，
 * 断言每个声部的「事件 kind 序列」与「durationRaw 序列」和原 Domain 一致。
 * 这是 T6 完整 L2 投影的前哨，不做完整投影（relation/歌词/引用归一化留给 T6）。
 *
 * 入口仍是内部的 `serializeCanonical`：公开的
 * `serializeJcx(score, {mode:'canonical'})` 要到 T5（歌词 + 组装）才开放。
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { MusicEvent, Score, UnitLengthChange, Voice } from '../../../../src/domain';
import { loadJcx } from '../../../../src/formats/jcx';
import { serializeCanonical } from '../../../../src/formats/jcx/serialize/canonical';

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function fixtureSource(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, `${name}.jcx`), 'utf8');
}

function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** 事件的时值原文；组事件的时值是成员事实，不在事件级重复。 */
function durationRawOf(event: MusicEvent): string {
  switch (event.kind) {
    case 'note':
      return event.note.durationRaw ?? '';
    case 'rest':
      return event.rest.durationRaw ?? '';
    case 'tabNote':
      return event.note.durationRaw ?? '';
    default:
      return '';
  }
}

interface VoiceProfile {
  readonly id: string;
  readonly kinds: string;
  readonly durations: string;
}

function profileOf(score: Score): VoiceProfile[] {
  return score.voices.map((voice) => ({
    id: voice.id,
    kinds: voice.events.map((event) => event.kind).join(','),
    durations: voice.events.map(durationRawOf).join(','),
  }));
}

interface RoundTrip {
  readonly text: string;
  readonly lines: readonly string[];
  /** 第一条 `[V:` 行起的 body 区（含 `[V:n]` 与 `L:` 行）。 */
  readonly body: readonly string[];
  readonly score: Score;
}

/** canonical 一次，并当场做 re-parse 前哨（事件 kind 序列 + durationRaw 序列）。 */
function roundTrip(source: string): RoundTrip {
  const { score } = loadJcx(source);
  const result = serializeCanonical(score, { mode: 'canonical' });
  const lines = linesOf(result.text);
  const start = lines.findIndex((line) => line.startsWith('[V:'));
  expect(profileOf(loadJcx(result.text).score)).toEqual(profileOf(score));
  return {
    text: result.text,
    lines,
    body: start === -1 ? [] : lines.slice(start),
    score,
  };
}

function fixtureTrip(name: string): RoundTrip {
  return roundTrip(fixtureSource(name));
}

/** 测试用的最小文档骨架：描述头固定，只换正文。 */
function doc(body: string, unitLength = '1/4'): string {
  return `%MUSE2\nX:1\nT:t\nM:4/4\nL:${unitLength}\nK:C\nV:1\n${body}\n`;
}

describe('canonical body —— 事件形态（spec §13–§26，逐字段重建）', () => {
  it('note：accidental + 大小写字母 + octaveRaw + durationRaw，不由 Rational 反算', () => {
    const { body } = fixtureTrip('scan-pitch-kinds');
    expect(body[1]).toBe('^C,2 _b\'/ =D3/ E// z2 Z4 @2 |');
    expect(body).toContain('C D C,\' C\'\' c,, C/3 |');
  });

  it('rest：variant 原字符 + durationRaw（z / Z / @ 三分不合并）', () => {
    const { body } = fixtureTrip('rest-z-upper');
    expect(body.join('\n')).toContain('G2 Z2 |');
  });

  it('rest：TAB 模式的 `*` / `/` 分隔符包含在 durationRaw 内', () => {
    const { body } = fixtureTrip('rest-tab-duration');
    expect(body[1]).toBe('z*2 z/ z// a1*2 |');
  });

  it('chord：`[` + 成员 + `]`，成员之间不插空格', () => {
    const { body } = fixtureTrip('chord-duration');
    expect(body[1]).toBe('[CEG] 2 [DFA] /2 [ce] 4 |');
    // `[]2` 的空和弦仍是一个 chord 事件，不塌成 unknown。
    expect(body[2]).toBe('[CE] 2 [] 2 |');
  });

  it('grace：`{` / 后倚音 `{@`，成员保留各自的 durationRaw', () => {
    const { body } = fixtureTrip('grace');
    expect(body[1]).toBe('{G} A2 {ab} c2 |');
    expect(body[2]).toBe('{@d} e2 f2 |');
  });

  it('barline：raw 原样（含 `|:` `::` `[|` `|]` 与跳房子 `[1`）', () => {
    const { body } = fixtureTrip('barline-variants');
    expect(body.join(' ')).toContain('|:');
    expect(body.join(' ')).toContain('::');
    expect(body.join(' ')).toContain('|]');
  });

  it('decoration：simple 按 `!name!` 重建，complex 写 raw', () => {
    expect(fixtureTrip('decoration-simple').body[1]).toBe('!TRILL! C !DOWNBOW! D !st! E !sanpie! F |');
    expect(fixtureTrip('decoration-complex').body[1]).toContain("!$f'Maestro'$s'40'\\070!");
  });

  it('chordSymbol：raw 含两侧引号，空和弦符号 `""` 与 `"^x"` 原样', () => {
    const { body } = fixtureTrip('scan-pitch-kinds');
    expect(body[3]).toContain('"C" "" "^x"');
  });

  it('chordSymbol：斜杠低音原样写回', () => {
    expect(fixtureTrip('chord-slash-bass').body[1]).toBe('"D/#F" D E F G |');
  });

  it('tabNote / tabGroup：弦号 → a..f，fret 的 `x` 原样，stroke 前缀在最前', () => {
    const { body } = fixtureTrip('scan-tab-kinds');
    expect(body[1]).toBe('a1*2 ax Va1 c10/ ax// z*2 [ax/bx/] [a1*2bx] a1/2 |');
  });

  it('UnknownEvent：raw 原样（`|||2` 的落单 `2` 不被丢弃、不被解释）', () => {
    const { body } = roundTrip(doc('|||2 C'));
    expect(body.join('\n')).toContain('2 C');
    const unknown = fixtureTrip('scan-pitch-kinds').score.voices[0]?.events.filter(
      (event) => event.kind === 'unknown',
    );
    expect(unknown?.some((event) => event.kind === 'unknown' && event.raw === '2')).toBe(true);
  });

  it('未知 token（`#` / `?` / 行内 `%%`）原样写回', () => {
    const { body } = fixtureTrip('unknown-body-token');
    expect(body[1]).toBe('C D # E F |');
    expect(body[2]).toBe('G ? A %% B |');
  });
});

describe('canonical body —— relation 反写（决策 1、4，marker 叠加顺序）', () => {
  it('tie：整组成员各一条时折叠成事件级 `-`（`[C-E-][EC]` → `[CE]- [EC]`）', () => {
    const { body, score } = fixtureTrip('tie-chord-members');
    expect(body[1]).toBe('[CE]- [EC] [CD-] D [C-D] E |');
    // 折叠不改变关系：重解析后 tie 的端点集合一致。
    const before = score.voices[0]?.ties.map((tie) => tie.status).sort();
    const after = loadJcx(serializeCanonical(score, { mode: 'canonical' }).text)
      .score.voices[0]?.ties.map((tie) => tie.status)
      .sort();
    expect(after).toEqual(before);
  });

  it('tie：成员级 `-` 写在该成员之后、括号内（部分成员 tie 不折叠）', () => {
    expect(fixtureTrip('tie-partial-members').body[1]).toBe('[C-E-G-] [CE] [CE]- D |');
  });

  it('tie：unresolved（行尾无对端）只写存在的一端', () => {
    const { body, score } = fixtureTrip('tie-chord-members');
    expect(score.voices[0]?.ties.some((tie) => tie.status === 'unresolved')).toBe(true);
    expect(body[body.length - 1]).toBe('C D- E A-');
  });

  it('slur：`(` 紧贴 from 之前、`)` 紧贴 to 之后，嵌套按栈还原', () => {
    const { body } = fixtureTrip('slur-cross-line');
    expect(body[1]).toBe('(C D) (C |');
    expect(body[2]).toBe('"G" D) (C (E F) G) |');
  });

  it('slur：unclosed 只写 `(`，不补 `)`', () => {
    const { body, score } = fixtureTrip('slur-cross-line');
    expect(score.voices[0]?.slurs.some((slur) => slur.status === 'unclosed')).toBe(true);
    expect(body[body.length - 1]).toBe('(A B c) d (e |');
  });

  it('tuplet：写 `Tuplet.raw` 原拼写（`(3:0:3` 不由 p/q/r 反拼），紧贴首成员之前', () => {
    const { body, score } = fixtureTrip('tuplet-incomplete');
    expect(score.voices[0]?.tuplets.map((tuplet) => tuplet.raw)).toEqual([
      '(3',
      '(3:2:3',
      '(3:0:3',
      '(3',
    ]);
    expect(body[1]).toBe('(3C D E (3:2:3F G A |');
    expect(body[2]).toBe('(3:0:3c d e (3f g |');
  });

  it('tuplet：incomplete 同样写回；成员数为 0 时追加到 body 末尾（裁决③）', () => {
    const { body, score } = roundTrip(doc('C D E (3'));
    const tuplets = score.voices[0]?.tuplets ?? [];
    expect(tuplets).toHaveLength(1);
    expect(tuplets[0]?.status).toBe('incomplete');
    expect(tuplets[0]?.members).toEqual([]);
    expect(body[body.length - 1]).toBe('C D E (3');
    // 重解析后仍是一条 0 成员的 incomplete tuplet，没有静默丢 relation。
    const again = loadJcx(serializeCanonical(score, { mode: 'canonical' }).text).score.voices[0];
    expect(again?.tuplets).toHaveLength(1);
    expect(again?.tuplets[0]?.members).toEqual([]);
  });

  it('两个 tuplet 共享同一首成员：按数组顺序追加，重解析后 raw 序列不反转', () => {
    const { body, score } = roundTrip(doc('(3(3:2:3C D E F G A |'));
    const raws = score.voices[0]?.tuplets.map((tuplet) => tuplet.raw);
    expect(raws).toEqual(['(3', '(3:2:3']);
    expect(body[1]).toBe('(3(3:2:3C D E F G A |');
    const again = loadJcx(serializeCanonical(score, { mode: 'canonical' }).text).score;
    expect(again.voices[0]?.tuplets.map((tuplet) => tuplet.raw)).toEqual(raws);
    expect(again.voices[0]?.tuplets.map((tuplet) => tuplet.members.length)).toEqual(
      score.voices[0]?.tuplets.map((tuplet) => tuplet.members.length),
    );
  });

  it('TAB 关系：`-S-` / `-H-` / `-P-` 替代两端之间的空格', () => {
    expect(fixtureTrip('tab-relations').body[1]).toBe(
      'a1-S-a3 b8-H-b9 c5-P-c3 d2- d2 {a1-S-a3} a2 {b5-P-} b7 a4 |',
    );
  });

  it('TAB 关系：起点是组末成员、终点在组外 → 写在组尾（`{d8-S-}d10`）', () => {
    expect(fixtureTrip('tab-relation-grace-exit').body[1]).toBe(
      '{d8-S-} d10*6 {b8-H-b9-P-} b8 |',
    );
  });

  it('TAB 关系：起点是组内非末成员、终点在组外 → 降级为事件级并告警', () => {
    const { score } = loadJcx(fixtureSource('tab-relation-group-endpoints'));
    const result = serializeCanonical(score, { mode: 'canonical' });
    expect(
      result.diagnostics.filter((d) => d.code === 'jcx.serialize.tab-relation-member-position'),
    ).toHaveLength(2);
    expect(result.text).toContain('[b3c5]-H-b7');
  });

  it('brokenRhythm：raw 替代两端之间的空格（`C2>D2`、`<` 的三种长度）', () => {
    const { body, score } = fixtureTrip('broken-rhythm-pairs');
    expect(score.voices[0]?.brokenRhythms.map((broken) => broken.raw)).toEqual([
      '>',
      '>>',
      '>>>',
      '<',
      '<<',
      '<<<',
      '>',
    ]);
    expect(body[1]).toBe('C2>D2 E2>>F2 G2>>>A2 |');
    expect(body[2]).toBe('c2<d2 e2<<f2 g2<<<a2 |');
  });

  it('brokenRhythm：durationRaw 原样（时值不由 Rational 反算）', () => {
    const { score } = fixtureTrip('broken-rhythm-pairs');
    const first = score.voices[0]?.events[0];
    // duration 已被 T7 改写成 3/2 × unitLength，durationRaw 仍是源文本的 `2`。
    expect(first?.kind === 'note' && first.note.durationRaw).toBe('2');
    expect(first?.kind === 'note' && first.note.duration).toEqual({ num: 3, den: 8 });
  });

  it('marker 叠加顺序：tuplet → slur( → 事件 → tie → slur) → 分隔符', () => {
    const { body } = roundTrip(doc('(3(C-D E) F'));
    expect(body[1]).toBe('(3(C- D E) F');
  });
});

describe('canonical body —— 行边界（决策 2 / 裁决①④）', () => {
  it('无歌词区间：小节线之后断行', () => {
    const { body } = roundTrip(doc('CDEF|GABc|cB'));
    expect(body).toEqual(['[V:1]', 'C D E F |', 'G A B c |', 'c B']);
  });

  it('bodyRange：每条 w: 覆盖的事件区间独占一行', () => {
    const { body, score } = fixtureTrip('lyrics');
    expect(score.voices[0]?.lyricLines).toHaveLength(4);
    expect(body).toEqual([
      '[V:1]',
      'C D E F |',
      'w: la li lu la',
      '{G} A B z C |',
      'w: la * lu',
      '[CEG] A |',
      'w: la~li lu',
      'A B C |',
      'w: la-li lu_x y|z',
    ]);
  });

  it('多 verse 共用同一 bodyRange 时只产生一条事件行，各 verse 的 w: 按 verseIndex 顺序紧随其后（裁决④）', () => {
    const { body, score } = fixtureTrip('lyrics-multi-verse');
    const ranges = score.voices[0]?.lyricLines.map((line) => line.bodyRange);
    expect(ranges).toHaveLength(2);
    expect(ranges?.[0]).toEqual(ranges?.[1]);
    expect(body).toEqual(['[V:1]', 'C D E F |', 'w: la li lu la', 'w: ma mi mu ma']);
  });

  it('inline 尾随正文的 bodyRange 同样成行，w: 紧随其后', () => {
    expect(fixtureTrip('lyrics-inline-trailing').body).toEqual(['[V:1]', 'C D', 'w: la li']);
  });

  it('body 行带出「行 → 事件区间」映射，供 T5 放置 w: 行', () => {
    const { score } = loadJcx(fixtureSource('lyrics'));
    const result = serializeCanonical(score, { mode: 'canonical' });
    const eventLines = result.bodyLines.filter((line) => line.range !== null);
    expect(eventLines).toHaveLength(4);
    const first = score.voices[0]?.lyricLines[0]?.bodyRange;
    expect(eventLines[0]?.range).toEqual(first);
    expect(eventLines[0]?.lyricRangeEnd).toEqual(first);
  });

  it('inline 模式：每个声部 body 前写独占一行的 [V:n]', () => {
    const { lines } = fixtureTrip('body-field-l-two-voices');
    expect(lines.filter((line) => line.startsWith('[V:'))).toEqual(['[V:1]', '[V:2]']);
  });
});

describe('canonical body —— unitLengthChanges 重放（决策 3 / 裁决①）', () => {
  it('L: 行紧贴生效事件之前，生效事件另起一行', () => {
    const { body, score } = fixtureTrip('body-field-l');
    expect(score.voices[0]?.unitLengthChanges).toHaveLength(1);
    expect(body).toEqual([
      '[V:1]',
      'C2 D2 E2 F2 |',
      'G A B c |',
      'L: 1/8',
      'c2 B2 A2 G2 |',
      'F E D C |',
    ]);
  });

  it('裁决①：变化点即使不在小节线后也强制断行，L: 不会连带改写同一行的前序事件', () => {
    const { body } = roundTrip('%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nCD\nL:1/8\nEF|\n');
    expect(body).toEqual(['[V:1]', 'C D', 'L: 1/8', 'E F |']);
  });

  it('多声部：body L: 按声部作用域生效（spec §8.5 U06 已裁决），不再跨声部泄漏', () => {
    // fixture 里的 `L:1/8` 出现在 `[V:2]GABc|` 之后（此刻 currentVoiceId = V2），
    // 按 U06 裁决只归属 V2：V1 全程保持 header 的 1/4，没有 change，因此 canonical
    // 不必再像旧版本那样在 [V:2] 段开头补一行 `L: 1/4`——上一段（V1）从未离开
    // header 的值，序列化器天然不需要补写复位。
    const { body, score } = fixtureTrip('body-field-l-two-voices');
    expect(score.voices.map((voice) => voice.unitLengthChanges.length)).toEqual([0, 1]);
    expect(body).toEqual([
      '[V:1]',
      'C D E F |',
      'c d e f |',
      '[V:2]',
      'G A B c |',
      'L: 1/8',
      "g a b c' |",
    ]);
  });

  it('L: 变化点落在 w: 覆盖的正文中间：优先保证 L: 断行，并告警（裁决①）', () => {
    const { score } = loadJcx(fixtureSource('lyrics'));
    const voice = score.voices[0];
    expect(voice).toBeDefined();
    if (voice === undefined) {
      return;
    }
    const target = voice.events[2];
    expect(target).toBeDefined();
    if (target === undefined) {
      return;
    }
    // 源文本里 `L:` 是整行粒度，这种输入解析不出来，只能直接造事实验证降级路径。
    const change: UnitLengthChange = {
      beforeEventId: target.id,
      unitLength: { num: 1, den: 8 },
      raw: '1/8',
      origin: voice.origins[0] ?? 'L1',
    };
    const patched: Voice = { ...voice, unitLengthChanges: [change] };
    const result = serializeCanonical({ ...score, voices: [patched] }, { mode: 'canonical' });
    const lines = linesOf(result.text);
    const start = lines.findIndex((line) => line.startsWith('[V:'));
    expect(lines.slice(start, start + 4)).toEqual(['[V:1]', 'C D', 'L: 1/8', 'E F |']);
    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.lyric-line-split');
    // 该 verse 的 w: 行不会跟着断——`lyricRangeEnd` 只在被切开后仍完整保留、
    // 抵达 barline 的那半段收尾，w: 紧随「E F |」之后（音节对齐已经漂移，
    // 但不静默丢这条 w: 行）。
    expect(lines.slice(start, start + 5)).toEqual([
      '[V:1]',
      'C D',
      'L: 1/8',
      'E F |',
      'w: la li lu la',
    ]);
  });
});

describe('canonical body —— ignoredFields 重放（拍板 F / 裁决②）', () => {
  it('T/C/I/M/K/Q/X：写成 body 区字段行，重解析仍是 IgnoredField', () => {
    const { lines, score } = fixtureTrip('header-override');
    expect(score.ignoredFields).toEqual([{ name: 'K', rawValue: 'G', origin: 'L9' }]);
    // 位置：V: 声明之后、第一条 [V:n] 之前（body 区开头）。
    expect(lines[lines.indexOf('[V:1]') - 1]).toBe('K: G');
    const again = loadJcx(serializeCanonical(score, { mode: 'canonical' }).text).score;
    expect(again.ignoredFields.map((field) => [field.name, field.rawValue])).toEqual([['K', 'G']]);
    // 描述头的 K: 没有被 body 区那条覆盖。
    expect(again.key?.raw).toBe('C');
  });

  it('其余名字（L / w）写成 inline field，不会被提升为 unitLength / 歌词', () => {
    const { lines, score } = fixtureTrip('inline-field-ignored');
    expect(lines.slice(lines.indexOf('V:1') + 1, lines.indexOf('[V:1]'))).toEqual([
      '[L:1/8]',
      '[w:x y]',
    ]);
    const again = loadJcx(serializeCanonical(score, { mode: 'canonical' }).text).score;
    expect(again.ignoredFields.map((field) => [field.name, field.rawValue])).toEqual([
      ['L', '1/8'],
      ['w', 'x y'],
    ]);
    expect(again.unitLength).toEqual({ num: 1, den: 4 });
    expect(again.voices[0]?.lyricLines).toEqual([]);
  });

  it('值含换行时整条字段不输出（单行语法无法表达，禁止猜 escape）', () => {
    const { score } = loadJcx(fixtureSource('inline-field-ignored'));
    const patched: Score = {
      ...score,
      ignoredFields: [
        { name: 'K', rawValue: 'G\nT: fake', origin: 'L7' },
        { name: 'L', rawValue: 'a\nb', origin: 'L8' },
      ],
    };
    const result = serializeCanonical(patched, { mode: 'canonical' });
    expect(result.text).not.toContain('fake');
    expect(result.text).not.toContain('[L:a');
    expect(
      result.diagnostics.filter((d) => d.code === 'jcx.serialize.ignored-field-dropped'),
    ).toHaveLength(2);
    // 丢弃不等于制造假行：重解析后没有多出 ignoredFields / header 字段。
    expect(loadJcx(result.text).score.ignoredFields).toEqual([]);
  });

  it('inline field 的值含 `]` 时无法无损编码：原样输出 + warning，不猜 escape', () => {
    const { score } = loadJcx(fixtureSource('inline-field-ignored'));
    const patched: Score = {
      ...score,
      ignoredFields: [{ name: 'L', rawValue: 'a]b', origin: 'L7' }],
    };
    const result = serializeCanonical(patched, { mode: 'canonical' });
    expect(result.text).toContain('[L:a]b]');
    expect(result.diagnostics.map((d) => d.code)).toContain(
      'jcx.serialize.ignored-field-unencodable',
    );
  });
});

describe('canonical body —— 空正文与未闭合 text block', () => {
  it('声明了但没有任何事件的声部不写 [V:n]（空 body 不是事实）', () => {
    const { lines } = roundTrip('%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:1]CDEF|\n');
    expect(lines.filter((line) => line.startsWith('[V:'))).toEqual(['[V:1]']);
    expect(lines).toContain('V:2');
  });

  it('未闭合 text block 排在全文最后，否则会把正文吃进块内容', () => {
    const { lines, text } = fixtureTrip('text-block-unclosed');
    expect(lines.slice(-2)).toEqual(['%%begintext', '  tail note line']);
    expect(text).not.toContain('%%endtext');
    // 正文在块之前，重解析仍能拿到事件。
    expect(loadJcx(text).score.voices[0]?.events).toHaveLength(5);
  });
});
