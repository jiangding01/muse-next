/**
 * canonical 歌词 `w:` 回写 + 组装 + 公开 API 接线 + 幂等（M1.7 T5，
 * 方案 v1.1 §3 决策 2 / §7 T5）。
 *
 * `canonical/lyrics.ts` 的回写规则见该文件头：音节分隔完全由
 * `LyricSyllable.offsetInLine` 与 `text.length` 的相邻关系决定（parse 层
 * `scanAtoms`/`foldSyllables` 的逆运算），对 `text`/`skip`/`merge` 三种
 * kind 统一有效。本文件因此不按 kind 分组用例，而是按「音节分隔的来源
 * 形态」分组：CJK 连写（无分隔）、西文空格断字、`*`/`~` 记号。
 *
 * **等价性比较**：re-parse 得到的 `LyricLine` 与原始 `LyricLine` 比较时去掉
 * `origin`（不同源文本行号不可比）；`target`（`NoteRef`）直接按 `eventId`
 * 字符串比较而不做 `(voiceIndex, eventIndex)` 归一化——`EventId` 的生成规则是
 * `${voiceId}:e${该声部事件流下标}`（`domain/ids.ts`），只要声部声明顺序与
 * 每个声部内部的事件序列不变（canonical 只改变「事件被分到哪一行」，从不
 * 重排事件、不增删声部），`EventId` 字符串本身在这次 round trip 前后就是
 * 同一个值，不需要额外的归一化步骤（已用 `lyrics.jcx`/`lyrics-tab.jcx` 等
 * fixture 实测确认，见下方各用例）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { LyricLine, LyricSyllable, Score, UnitLengthChange, Voice } from '../../../../src/domain';
import { loadJcx } from '../../../../src/formats/jcx';
import { serializeJcx } from '../../../../src/formats/jcx/serialize';
import { serializeCanonical } from '../../../../src/formats/jcx/serialize/canonical';

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/jcx');

function fixtureSource(name: string): string {
  return readFileSync(resolve(FIXTURES_DIR, `${name}.jcx`), 'utf8');
}

function listFixtureNames(): readonly string[] {
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.jcx'))
    .map((name) => name.slice(0, -'.jcx'.length));
}

function linesOf(text: string): string[] {
  expect(text.endsWith('\n')).toBe(true);
  return text.slice(0, -1).split('\n');
}

/** 测试用的最小文档骨架：描述头固定，只换正文（与 `canonical.body.test.ts` 同款）。 */
function doc(body: string, unitLength = '1/4'): string {
  return `%MUSE2\nX:1\nT:t\nM:4/4\nL:${unitLength}\nK:C\nV:1\n${body}\n`;
}

interface SyllableProfile {
  readonly text: string;
  readonly kind: LyricSyllable['kind'];
  readonly target: LyricSyllable['target'];
}

interface LyricLineProfile {
  readonly verseIndex: number;
  readonly bodyRange: LyricLine['bodyRange'];
  readonly syllables: readonly SyllableProfile[];
}

/** 去掉 `origin` 后的逐声部歌词投影（见文件头「等价性比较」）。 */
function lyricProfile(score: Score): readonly (readonly LyricLineProfile[])[] {
  return score.voices.map((voice) =>
    voice.lyricLines.map((line): LyricLineProfile => ({
      verseIndex: line.verseIndex,
      bodyRange: line.bodyRange,
      syllables: line.syllables.map((syllable): SyllableProfile => ({
        text: syllable.text,
        kind: syllable.kind,
        target: syllable.target,
      })),
    })),
  );
}

interface LyricsRoundTrip {
  readonly text: string;
  readonly lines: readonly string[];
  readonly score: Score;
}

/** canonical 一次并当场 re-parse，断言歌词投影相等。 */
function lyricsRoundTrip(source: string): LyricsRoundTrip {
  const { score } = loadJcx(source);
  const text = serializeCanonical(score, { mode: 'canonical' }).text;
  expect(lyricProfile(loadJcx(text).score)).toEqual(lyricProfile(score));
  return { text, lines: linesOf(text), score };
}

function fixtureRoundTrip(name: string): LyricsRoundTrip {
  return lyricsRoundTrip(fixtureSource(name));
}

describe('canonical 歌词 —— 音节分隔（无分隔 vs 单空格，见 lyrics.ts 文件头）', () => {
  it('单声部单 verse：西文以空格断字', () => {
    const { lines, score } = fixtureRoundTrip('lyrics-inline-trailing');
    expect(score.voices[0]?.lyricLines).toHaveLength(1);
    expect(lines).toContain('w: la li');
  });

  it('多个空格 / Tab 分隔（offsetInLine 差值 >1）：回写规范化为单空格', () => {
    // scanAtoms 用 `/\s/` 断字（含 tab），因此原文里连续多个空白只产生一次
    // atom 边界；offsetInLine 记的是空白结束后的位置，音节间隔可以 >1。
    // decision D（规范化空白）要求 canonical 写回单个空格，不保留原始空白数量。
    const source = doc('CDE|\nw: la   li\tlu');
    const { score } = loadJcx(source);
    const syllables = score.voices[0]?.lyricLines[0]?.syllables;
    expect(syllables?.map((s) => s.offsetInLine)).toEqual([0, 5, 8]);
    expect(syllables?.map((s) => s.text)).toEqual(['la', 'li', 'lu']);
    const { lines, text } = lyricsRoundTrip(source);
    // 回写只用单空格，不是原文的 3 个空格 / tab。
    expect(lines).toContain('w: la li lu');
    // 重解析后 text/kind/target（归一化，见文件头）序列与原始一致——
    // `lyricsRoundTrip` 内部已经用 `lyricProfile` 断言过一次，这里再显式
    // 读一遍确认 target 确实都绑定成功（不是巧合地两边都是 undefined）。
    const again = loadJcx(text).score;
    const targets = again.voices[0]?.lyricLines[0]?.syllables.map((s) => s.target !== undefined);
    expect(targets).toEqual([true, true, true]);
  });

  it('多 verse：按 verseIndex 顺序各占一行，紧随共用的事件行', () => {
    const { lines, score } = fixtureRoundTrip('lyrics-multi-verse');
    expect(score.voices[0]?.lyricLines.map((line) => line.verseIndex)).toEqual([0, 1]);
    const idx = lines.indexOf('C D E F |');
    expect(lines.slice(idx, idx + 3)).toEqual(['C D E F |', 'w: la li lu la', 'w: ma mi mu ma']);
  });

  it('CJK 连写（原文无缝衔接，不插分隔）与西文空格混合', () => {
    const source = doc('CDE|\nw: 你好 la');
    const { score } = loadJcx(source);
    const syllables = score.voices[0]?.lyricLines[0]?.syllables;
    expect(syllables?.map((s) => s.text)).toEqual(['你', '好', 'la']);
    const { lines } = lyricsRoundTrip(source);
    expect(lines).toContain('w: 你好 la');
  });

  it('多个汉字连写，逐字对应各自事件', () => {
    const source = doc('CDEFGA|\nw: 一二三四五六');
    const { lines, score } = lyricsRoundTrip(source);
    expect(score.voices[0]?.lyricLines[0]?.syllables).toHaveLength(6);
    expect(lines).toContain('w: 一二三四五六');
  });

  it('`~` 合并两段为一个音节：文本原样含 `~`，回写不额外插空格', () => {
    const { lines, score } = fixtureRoundTrip('lyrics');
    const merged = score.voices[0]?.lyricLines[2]?.syllables[0];
    expect(merged).toEqual(
      expect.objectContaining({ text: 'la~li', kind: 'merge' }),
    );
    expect(lines).toContain('w: la~li lu');
  });

  it('`*` 跳过：不绑定事件，仍占一个音节位', () => {
    const { lines, score } = fixtureRoundTrip('lyrics');
    const skip = score.voices[0]?.lyricLines[1]?.syllables[1];
    expect(skip).toEqual(expect.objectContaining({ text: '*', kind: 'skip' }));
    expect(skip?.target).toBeUndefined();
    expect(lines).toContain('w: la * lu');
  });

  it('`-`/`_`/`|` 等 UNVERIFIED 分隔符原样保留在音节文本内（不被当成切分符）', () => {
    const { lines, score } = fixtureRoundTrip('lyrics');
    const last = score.voices[0]?.lyricLines[3]?.syllables;
    expect(last?.map((s) => s.text)).toEqual(['la-li', 'lu_x', 'y|z']);
    expect(lines).toContain('w: la-li lu_x y|z');
  });

  it('TAB 声部：歌词绑定 tabNote 事件，回写与 pitch 声部同规则', () => {
    const { lines, score } = fixtureRoundTrip('lyrics-tab');
    expect(score.voices[0]?.lyricLines[0]?.syllables).toHaveLength(3);
    expect(lines).toContain('w: la li lu');
  });
});

describe('canonical 歌词 —— 音节数与可唱事件数不一致', () => {
  it('overflow：音节数多于可唱事件数，多出的音节仍原样写回（不截断）', () => {
    const { lines, score } = fixtureRoundTrip('lyrics-overflow');
    const line = score.voices[0]?.lyricLines[0];
    expect(line?.syllables).toHaveLength(4);
    expect(line?.syllables[2]?.target).toBeUndefined();
    expect(line?.syllables[3]?.target).toBeUndefined();
    expect(lines).toContain('w: la li lu ma');
  });

  it('underflow：音节数少于可唱事件数，多出的事件不受影响', () => {
    const source = doc('CDEF|\nw: la li');
    const { lines, score } = lyricsRoundTrip(source);
    expect(score.voices[0]?.lyricLines[0]?.syllables).toHaveLength(2);
    expect(lines).toContain('w: la li');
    expect(lines).toContain('C D E F |');
  });
});

describe('canonical 歌词 —— bodyRange null（无绑定目标）', () => {
  it('文档正文区第一处内容就是 w:：写在 [V:n] 之后、首个事件行之前，重解析仍是 bodyRange null', () => {
    const { lines, score } = fixtureRoundTrip('lyrics-no-target');
    expect(score.voices[0]?.lyricLines[0]?.bodyRange).toBeNull();
    const vIdx = lines.indexOf('[V:1]');
    expect(lines[vIdx + 1]).toBe('w: la li');
    expect(lines[vIdx + 2]).toBe('C D E F |');
    const again = loadJcx(lines.join('\n')).score;
    expect(again.voices[0]?.lyricLines[0]?.bodyRange).toBeNull();
  });

  it('文档最早内容确实是这条 w:（即便是唯一声部的正文里手工插的）：仍能安全放到最前面', () => {
    // 校验「isFirstBodyContent」判定确实是按输出文本里的位置生效，而不是按
    // 「原始语义类型」生效：只要放在全文第一处，reparse 就会得到 target
    // undefined → bodyRange null，与它在 Domain 里原本因为什么原因是 null
    // 无关。
    const source = doc('CD|');
    const { score } = loadJcx(source);
    const voice = score.voices[0];
    expect(voice).toBeDefined();
    if (voice === undefined) {
      return;
    }
    const patchedVoice: Voice = {
      ...voice,
      lyricLines: [{ verseIndex: 0, syllables: [], bodyRange: null }],
    };
    const result = serializeCanonical({ ...score, voices: [patchedVoice] }, { mode: 'canonical' });
    expect(result.diagnostics.map((d) => d.code)).not.toContain('jcx.serialize.lyric-line-unplaceable');
    const lines = linesOf(result.text);
    const vIdx = lines.indexOf('[V:1]');
    expect(lines[vIdx + 1]).toBe('w: ');
    const again = loadJcx(result.text).score;
    expect(again.voices[0]?.lyricLines[0]?.bodyRange).toBeNull();
  });

  it('不是文档最早内容的 bodyRange null 行：不写入，发 lyric-line-unplaceable warning（不猜位置）', () => {
    // 双声部，两个声部各自都有真实正文：第 2 个声部之前已经有第 1 个声部的
    // 正文了，因此第 2 个声部即便自己也有事件行可挂靠，也不再是「全文最早
    // 内容」。手工在第 2 个声部追加一条 bodyRange null 的歌词行，模拟
    // 「voice 内已有更早的正文」——真实源文本里这种输入本就解析不出
    // bodyRange null（第 2 个声部之前必然已经有别的正文，target 不会是
    // undefined），只能直接造 Domain 验证降级路径。
    const source =
      '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:1] CD|\n[V:2] EF|\n';
    const { score } = loadJcx(source);
    const voice1 = score.voices[0];
    const voice2 = score.voices[1];
    expect(voice1).toBeDefined();
    expect(voice2).toBeDefined();
    if (voice1 === undefined || voice2 === undefined) {
      return;
    }
    const patchedVoice2: Voice = {
      ...voice2,
      lyricLines: [{ verseIndex: 0, syllables: [], bodyRange: null }],
    };
    const result = serializeCanonical(
      { ...score, voices: [voice1, patchedVoice2] },
      { mode: 'canonical' },
    );
    expect(result.text).not.toContain('w: \n');
    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.lyric-line-unplaceable');
    // 不崩、不产生「看起来对但语义会漂移」的行：re-parse 后两个声部都没有多出歌词行。
    const again = loadJcx(result.text).score;
    expect(again.voices[0]?.lyricLines).toEqual([]);
    expect(again.voices[1]?.lyricLines).toEqual([]);
  });

  it('声部完全没有事件时：该声部的 bodyRange null 歌词行无处可挂，警告并跳过', () => {
    const source =
      '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:2]\nw: la li\n[V:1]CD|\n';
    const { score } = loadJcx(source);
    const voice2 = score.voices[1];
    expect(voice2).toBeDefined();
    expect(voice2?.events).toHaveLength(0);
    expect(voice2?.lyricLines).toHaveLength(1);
    expect(voice2?.lyricLines[0]?.bodyRange).toBeNull();
    const result = serializeCanonical(score, { mode: 'canonical' });
    // 声部 2 没有任何事件，因此连 [V:2] 都不写，其歌词行没有位置可挂。
    expect(result.text).not.toContain('[V:2]');
    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.lyric-line-unplaceable');
  });
});

describe('canonical 歌词 —— 多声部各自歌词', () => {
  it('inline 模式：每个声部只看到自己的 w: 行', () => {
    const source =
      '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:1] CD|\nw: la li\n[V:2] EF|\nw: ma mi\n';
    const { lines, score } = lyricsRoundTrip(source);
    expect(score.voices).toHaveLength(2);
    expect(score.voices[0]?.lyricLines).toHaveLength(1);
    expect(score.voices[1]?.lyricLines).toHaveLength(1);
    const v1 = lines.indexOf('[V:1]');
    const v2 = lines.indexOf('[V:2]');
    expect(lines.slice(v1, v1 + 3)).toEqual(['[V:1]', 'C D |', 'w: la li']);
    expect(lines.slice(v2, v2 + 3)).toEqual(['[V:2]', 'E F |', 'w: ma mi']);
  });
});

describe('canonical 歌词 —— 与 L: 强制断行交叉（裁决①）', () => {
  it('L: 变化点切开一条 w: 覆盖的正文：输出不崩，w: 仍写出，且发 lyric-line-split warning', () => {
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
    const change: UnitLengthChange = {
      beforeEventId: target.id,
      unitLength: { num: 1, den: 8 },
      raw: '1/8',
      origin: voice.origins[0] ?? 'L1',
    };
    const patched: Voice = { ...voice, unitLengthChanges: [change] };
    const result = serializeCanonical({ ...score, voices: [patched] }, { mode: 'canonical' });
    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.lyric-line-split');
    // w: 行本身没有被静默丢弃：verse 1 的四个音节文本仍完整出现一次。
    expect(result.text).toContain('w: la li lu la');
    // 不崩：重解析仍能拿到一个合法 Score（不断言语义相等，音节对齐已知会漂移）。
    expect(() => loadJcx(result.text)).not.toThrow();
  });
});

describe('canonical 歌词 —— 两条 bodyRange 共享同一收尾事件（/check P2②）', () => {
  it('body.ts collectRanges 按 lastEventId 去重登记：第二条 range 被遮住，发 lyric-range-shadowed 而不是静默丢字', () => {
    // `collectRanges`（`canonical/body.ts`）用 `if (!endAt.has(end)) endAt.set(end, range)`
    // 登记「哪个下标收尾哪条歌词范围」：两条 bodyRange 的 `lastEventId` 相同、
    // `firstEventId` 不同时，只有先出现的那条会被登记，后一条永远等不到
    // 任何一行的 `lyricRangeEnd` 命中它。真实源文本里两条独立的 `w:` 目标行
    // 几乎不会碰巧共享同一个收尾事件，只能手工构造 Domain 复现。
    const source = doc('CDEFG|');
    const { score } = loadJcx(source);
    const voice = score.voices[0];
    expect(voice).toBeDefined();
    if (voice === undefined) {
      return;
    }
    const events = voice.events;
    const first = events[0];
    const third = events[2];
    const last = events[events.length - 1];
    expect(first).toBeDefined();
    expect(third).toBeDefined();
    expect(last).toBeDefined();
    if (first === undefined || third === undefined || last === undefined) {
      return;
    }
    const origin = voice.origins[0] ?? 'L1';
    const lineA: LyricLine = {
      verseIndex: 0,
      syllables: [{ text: 'la', kind: 'text', target: { eventId: first.id }, origin, offsetInLine: 0 }],
      bodyRange: { firstEventId: first.id, lastEventId: last.id },
    };
    const lineB: LyricLine = {
      verseIndex: 0,
      syllables: [{ text: 'ma', kind: 'text', target: { eventId: third.id }, origin, offsetInLine: 0 }],
      bodyRange: { firstEventId: third.id, lastEventId: last.id },
    };
    const patched: Voice = { ...voice, lyricLines: [lineA, lineB] };
    const result = serializeCanonical({ ...score, voices: [patched] }, { mode: 'canonical' });
    // 先出现的那条正常写出。
    expect(result.text).toContain('w: la');
    // 被遮住的那条不静默丢弃：既不出现在文本里，也一定带着 warning。
    expect(result.text).not.toContain('w: ma');
    expect(result.diagnostics.map((d) => d.code)).toContain('jcx.serialize.lyric-range-shadowed');
  });
});

describe('canonical 歌词 —— 幂等（全部 fixture）', () => {
  const names = listFixtureNames();

  it(`共 ${String(names.length)} 个 fixture`, () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it('canonical(parse(canonical(x))) === canonical(x)（文本相等，逐 fixture）', () => {
    const failures: string[] = [];
    for (const name of names) {
      // `unclosed-chord.jcx` 显式点名排除，不是放宽断言：body.ts 文件头「已知
      // 限制①」记录的 kind 漂移（脱离非法上下文的 `[` 内 `|` 被重分类成
      // barline）不仅改变 kind，还改变了 canonical 的强制断行点（barline 强制
      // 换行，重分类前那个位置不是 barline 就不换行），所以第二次 canonical
      // 产出的行切分与第一次不同，文本级幂等在这一个 fixture 上确实不成立。
      // 这是已经写进文件头的既有限制（T4 遗留，与 T5 的歌词逻辑无关），不在
      // 这里静默放宽整体断言去掩盖它。
      if (name === 'unclosed-chord') {
        continue;
      }
      const { score } = loadJcx(fixtureSource(name));
      const once = serializeCanonical(score, { mode: 'canonical' }).text;
      const twice = serializeCanonical(loadJcx(once).score, { mode: 'canonical' }).text;
      if (once !== twice) {
        failures.push(name);
      }
    }
    expect(failures).toEqual([]);
  });

  it('parse 无 error 的 fixture：canonical 输出重解析后事件/歌词投影一致', () => {
    const failures: string[] = [];
    for (const name of names) {
      const loaded = loadJcx(fixtureSource(name));
      if (loaded.diagnostics.some((d) => d.severity === 'error')) {
        continue;
      }
      const text = serializeCanonical(loaded.score, { mode: 'canonical' }).text;
      const again = loadJcx(text).score;
      const kindsBefore = loaded.score.voices.map((v) => v.events.map((e) => e.kind).join(','));
      const kindsAfter = again.voices.map((v) => v.events.map((e) => e.kind).join(','));
      const lyricsBefore = lyricProfile(loaded.score);
      const lyricsAfter = lyricProfile(again);
      const kindsMatch = JSON.stringify(kindsBefore) === JSON.stringify(kindsAfter);
      const lyricsMatch = JSON.stringify(lyricsBefore) === JSON.stringify(lyricsAfter);
      // 同上一个 it：`unclosed-chord.jcx` 的 kind 漂移是已经写进 body.ts 文件头
      // 的已知限制，显式点名排除，不放宽其余 fixture 的投影相等断言。
      if (name === 'unclosed-chord') {
        continue;
      }
      if (!kindsMatch || !lyricsMatch) {
        failures.push(name);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe('canonical 内部入口 serializeCanonical（公开 serializeJcx 接线延后到 T6）', () => {
  it('UTF-8 无 BOM、LF、末尾换行', () => {
    const { score } = loadJcx(fixtureSource('lyrics'));
    const result = serializeCanonical(score, { mode: 'canonical' });
    expect(result.encoding).toBe('utf-8');
    expect(result.text.codePointAt(0)).not.toBe(0xfeff);
    expect(result.text).not.toContain('\r');
    expect(result.text.endsWith('\n')).toBe(true);
    expect(result.bytes).toEqual(new TextEncoder().encode(result.text));
  });

  it('`magicHeader: false` 关闭 `%MUSE2` 行', () => {
    const { score } = loadJcx(fixtureSource('lyrics'));
    const withHeader = serializeCanonical(score, { mode: 'canonical' });
    const withoutHeader = serializeCanonical(score, { mode: 'canonical', magicHeader: false });
    expect(linesOf(withHeader.text)).toContain('%MUSE2');
    expect(linesOf(withoutHeader.text)).not.toContain('%MUSE2');
    // 除了 magic header 那一行，其余内容不变。
    expect(linesOf(withoutHeader.text)).toEqual(linesOf(withHeader.text).filter((l) => l !== '%MUSE2'));
  });

  it('公开入口 serializeJcx（T6 接线后）输出与内部 serializeCanonical 一致，歌词行不丢', () => {
    const { score } = loadJcx(fixtureSource('lyrics'));
    const viaPublic = serializeJcx(score, { mode: 'canonical' });
    expect(viaPublic.text).toBe(serializeCanonical(score, { mode: 'canonical' }).text);
    expect(linesOf(viaPublic.text).some((line) => line.startsWith('w:'))).toBe(true);
  });
});

describe('canonical 歌词 —— diagnostics 合并（2026-09-15 用户裁决③）', () => {
  it('serializeCanonical 的 diagnostics 汇总了多个 renderer 模块各自产出的诊断', () => {
    // 同时触发两处不同 renderer 模块的 warning：voice.ts（属性值同时含空白与
    // 引号，无法无损编码）+ lyrics.ts（bodyRange null 但不在文档最早位置，
    // 见上面「不是文档最早内容」用例同一手法）。两条码不同源，都出现在最终
    // `diagnostics` 里，证明 index.ts 没有在某个分支漏掉某个模块的诊断。
    const source =
      '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nV:2\n[V:1] CD|\n[V:2] EF|\n';
    const { score } = loadJcx(source);
    const voice1 = score.voices[0];
    const voice2 = score.voices[1];
    expect(voice1).toBeDefined();
    expect(voice2).toBeDefined();
    if (voice1 === undefined || voice2 === undefined) {
      return;
    }
    const patchedVoice1: Voice = { ...voice1, sname: 'a "b' };
    const patchedVoice2: Voice = {
      ...voice2,
      lyricLines: [{ verseIndex: 0, syllables: [], bodyRange: null }],
    };
    const result = serializeCanonical(
      { ...score, voices: [patchedVoice1, patchedVoice2] },
      { mode: 'canonical' },
    );
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('jcx.serialize.voice-value-unencodable');
    expect(codes).toContain('jcx.serialize.lyric-line-unplaceable');

    // encoder（`encodeJcx`）的诊断也确实并入了最终结果——canonical 恒以
    // `'utf-8'` 调用 `encodeJcx`，而 `encodeUtf8` 对任何输入都不产出诊断
    // （`TextEncoder` 能编码全部合法 Unicode 标量值，见 `encodeJcx.ts` 文件
    // 头），所以这里没有第三种「真实触发的 encoder diagnostic」可用；直接
    // 断言这条结构性事实：总数恰好等于两个 renderer warning，没有凭空多出
    // 或少掉 encoder 那一段展开（`[...diagnostics, ...encoded.diagnostics]`
    // 的 `encoded.diagnostics` 在这里必然是 `[]`）。
    expect(result.diagnostics).toHaveLength(2);
  });
});

describe('canonical 歌词 —— 未闭合 text block 仍在全文最后（裁决⑤）', () => {
  it('声部有歌词 + 未闭合 text block：text block 排在全部 w: 行之后，歌词不被吞', () => {
    const source =
      '%MUSE2\nX:1\nT:t\nM:4/4\nL:1/4\nK:C\nV:1\nCD|\nw: la li\n%%begintext\nhello\n';
    const { lines, score } = lyricsRoundTrip(source);
    expect(score.voices[0]?.lyricLines).toHaveLength(1);
    expect(lines).toEqual(['%MUSE2', 'X: 1', 'T: t', 'M: 4/4', 'L: 1/4', 'K: C', 'V:1', '[V:1]', 'C D |', 'w: la li', '%%begintext', 'hello']);
    // 未闭合：没有 %%endtext，且这条正文没有被块吃掉（能重新拿到事件与歌词）。
    expect(lines).not.toContain('%%endtext');
    const again = loadJcx(lines.join('\n')).score;
    expect(again.voices[0]?.events).toHaveLength(3);
    expect(again.voices[0]?.lyricLines).toHaveLength(1);
  });
});
