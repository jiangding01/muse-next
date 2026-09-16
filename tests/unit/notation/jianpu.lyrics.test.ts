/**
 * T5.2-A —— 简谱歌词布局的 real-world 回归（M2 方案 v1.1.1 §3.2 / §24）。
 *
 * 起因是真实成品 JCX 的人工 smoke：歌词严重堆叠。两个独立成因，本文件各自钉死：
 *
 * 1. **`kind === 'skip'`（`*`）被画了出来**。`*` 在 parse 层已经消耗掉一个可唱事件位却
 *    **不绑 `target`**（`formats/jcx/parse/body/lyrics.ts`：`singable[index]` 取位后
 *    只 push 一个无 `target` 的 skip 音节），于是渲染层把它们当成「没有对齐目标」的音节
 *    丢进「行尾顺排」队列，一行几十个 `*` 顺排开来堆成星号矩阵。
 * 2. **歌词基线是全局的、不是行谱局部的**。旧实现把所有 `w:` 行一律排到**最后一行谱
 *    下方**，`row` 取 `lyricLines` 的数组下标；一首十几行谱的歌于是把全部歌词压在文末，
 *    行谱本身也没有为歌词留出高度。
 *
 * 所有 fixture **一律自造**（无意义音节 `la` / `ti` / `na` …），不使用任何真实语料文本。
 * 断言全部是结构断言：零 SVG 快照、零宿主字体依赖，`TextMeasurer` 显式注入（§2.8）。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';

const measurer = createDeterministicTextMeasurer();

/** 宽到不会换行；窄到必然把两个 measure 拆成两行谱（每 measure 4×24 + 12 = 108u）。 */
const WIDE = 100000;
const NARROW = 150;

/** 自造谱：两个 measure、八个可唱事件，歌词一律用无意义音节。 */
function source(body: string): string {
  return `%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1 style=jianpu\n${body}\n`;
}

function layout(body: string, availableWidth = NARROW): JianpuLayout {
  const loaded = loadJcx(source(body));
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return layoutJianpu(voice, {
    score: loaded.score,
    index: loaded.index,
    measurer,
    availableWidth,
  });
}

/** 事件 id → 该事件节点所在行谱与列左边界，用来独立复算歌词应当落在哪里。 */
function noteColumns(result: JianpuLayout): ReadonlyMap<number, { x: number; systemIndex: number }> {
  const columns = new Map<number, { x: number; systemIndex: number }>();
  result.nodes
    .filter((node) => node.kind === 'note')
    .forEach((node, index) => {
      columns.set(index, { x: node.x, systemIndex: node.systemIndex });
    });
  return columns;
}

function codesOf(result: JianpuLayout): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

// `CDEF|GABc|` = 8 个可唱事件；NARROW 下恰好拆成两行谱，每行谱 4 个。
const TWO_SYSTEMS = 'CDEF|GABc|';

// ---------------------------------------------------------------------------
// 1. `*`（skip）不可见，但仍消耗对齐位
// ---------------------------------------------------------------------------

describe('skip（`*`）不产生可见节点，但对齐位照旧被消耗（T5.2-A 成因 1）', () => {
  it('`text * text`：两个 text 可见、skip 不可见，且 skip 之后的音节对齐不错位', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la * li`);
    const notes = noteColumns(result);

    expect(result.lyrics.map((lyric) => lyric.text.text)).toEqual(['la', 'li']);
    expect(result.lyrics.every((lyric) => lyric.syllableKind !== 'skip')).toBe(true);
    // `*` 吃掉第 2 个可唱事件（D），因此 `li` 落在**第 3 个**音符（E）的列上，不是第 2 个。
    expect(result.lyrics[0]?.text.x).toBe(notes.get(0)?.x);
    expect(result.lyrics[1]?.text.x).toBe(notes.get(2)?.x);
    expect(result.lyrics.every((lyric) => lyric.aligned)).toBe(true);
  });

  it('一行里多个 `*` → 零个可见 `*` 节点，且不产生 target-missing 诊断', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: * * la * * li * *`);
    expect(result.lyrics.filter((lyric) => lyric.syllableKind === 'skip')).toHaveLength(0);
    expect(result.lyrics.map((lyric) => lyric.text.text)).toEqual(['la', 'li']);
    // 旧实现会把 6 个无 target 的 `*` 丢进行尾顺排队列并发这条诊断；现在一条都不该有。
    expect(codesOf(result)).not.toContain(CODES.lyricTargetMissing);
  });

  it('确定性：同一输入两次布局逐字段相等', () => {
    const body = `${TWO_SYSTEMS}\nw: * la * li * lo`;
    expect(layout(body).lyrics).toEqual(layout(body).lyrics);
  });
});

// ---------------------------------------------------------------------------
// 2. 行谱局部的歌词基线
// ---------------------------------------------------------------------------

describe('歌词基线是行谱局部的（T5.2-A 成因 2）', () => {
  it('每个可见音节的 systemIndex 等于它对齐的那个音符所在的行谱', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te`);
    const notes = noteColumns(result);
    expect(result.systems.length).toBe(2);
    expect(result.lyrics).toHaveLength(8);
    result.lyrics.forEach((lyric, index) => {
      expect(lyric.systemIndex).toBe(notes.get(index)?.systemIndex);
      expect(lyric.text.x).toBe(notes.get(index)?.x);
    });
    // 前 4 个在第 0 行谱、后 4 个在第 1 行谱：歌词跟着音符换行，不再全部堆到文末。
    expect(result.lyrics.map((lyric) => lyric.systemIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1]);
  });

  it('同一 verse、同一行谱内 y 完全相等；不同行谱的同一 verse y 必不相同', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te`);
    const yBySystem = new Map<number, Set<number>>();
    for (const lyric of result.lyrics) {
      const ys = yBySystem.get(lyric.systemIndex) ?? new Set<number>();
      yBySystem.set(lyric.systemIndex, ys);
      ys.add(lyric.text.y);
    }
    expect([...yBySystem.values()].map((ys) => ys.size)).toEqual([1, 1]);
    expect(yBySystem.get(0)).not.toEqual(yBySystem.get(1));
  });

  it('跨行谱的音节，其 x / y 落在目标行谱自己的几何范围内', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te`);
    for (const lyric of result.lyrics) {
      const system = result.systems[lyric.systemIndex];
      expect(system).toBeDefined();
      if (system === undefined) continue;
      expect(lyric.text.y).toBeGreaterThan(system.box.origin.y);
      expect(lyric.text.y).toBeLessThanOrEqual(system.box.origin.y + system.box.height);
      expect(lyric.text.x).toBeGreaterThanOrEqual(system.box.origin.x);
      expect(lyric.text.x).toBeLessThanOrEqual(system.box.origin.x + system.box.width);
    }
  });

  it('多段歌词：同一行谱内 verse0 / verse1 相差恰好一个 lyricLineGap 且不重叠', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te\nw: na ne ni no nu nv nw nx`);
    for (const system of result.systems) {
      const rows = result.lyrics.filter((lyric) => lyric.systemIndex === system.index);
      const verse0 = rows.find((lyric) => lyric.verseIndex === 0);
      const verse1 = rows.find((lyric) => lyric.verseIndex === 1);
      expect(verse0).toBeDefined();
      expect(verse1).toBeDefined();
      if (verse0 === undefined || verse1 === undefined) continue;
      expect(verse1.text.y - verse0.text.y).toBe(JIANPU_METRICS.lyricLineGap);
      // 行距不小于字号 → 两行文本的纵向范围不相交。
      expect(verse1.text.y - verse0.text.y).toBeGreaterThanOrEqual(JIANPU_METRICS.lyricFontSize);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 行谱高度与纵向不相交
// ---------------------------------------------------------------------------

describe('行谱高度包含歌词行（T5.2-A 成因 2 的几何后果）', () => {
  it('相邻行谱的垂直范围不相交，间隔恰为 systemGap', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te\nw: na ne ni no nu nv nw nx`);
    for (let i = 1; i < result.systems.length; i += 1) {
      const previous = result.systems[i - 1];
      const current = result.systems[i];
      if (previous === undefined || current === undefined) continue;
      const bottom = previous.box.origin.y + previous.box.height;
      expect(current.box.origin.y).toBeGreaterThanOrEqual(bottom);
      expect(current.box.origin.y - bottom).toBe(JIANPU_METRICS.systemGap);
    }
  });

  it('行谱高度随该行谱的歌词行数单调增长（同一谱面，只加 `w:` 行）', () => {
    const none = layout(TWO_SYSTEMS);
    const one = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te`);
    const two = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te\nw: na ne ni no nu nv nw nx`);
    const heightOf = (result: JianpuLayout): number => result.systems[0]?.box.height ?? 0;

    expect(heightOf(none)).toBe(JIANPU_METRICS.systemHeight);
    expect(heightOf(one)).toBeGreaterThan(heightOf(none));
    expect(heightOf(two)).toBeGreaterThan(heightOf(one));
    expect(heightOf(two) - heightOf(one)).toBe(JIANPU_METRICS.lyricLineGap);
    // 横向排布与行高无关：加歌词不改变换行结果。
    expect(none.systems.length).toBe(two.systems.length);
    expect(none.nodes.map((node) => node.x)).toEqual(two.nodes.map((node) => node.x));
  });

  it('只有真正出现歌词的行谱才长高（歌词只在第 0 行谱时，第 1 行谱保持基准高度）', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu`);
    expect(result.lyrics.every((lyric) => lyric.systemIndex === 0)).toBe(true);
    expect(result.systems[0]?.box.height).toBeGreaterThan(JIANPU_METRICS.systemHeight);
    expect(result.systems[1]?.box.height).toBe(JIANPU_METRICS.systemHeight);
  });
});

// ---------------------------------------------------------------------------
// 4. rest 排除 与 target 缺失的行尾顺排
// ---------------------------------------------------------------------------

describe('rest 不占歌词位；target 缺失的音节按行谱分段顺排', () => {
  it('rest 既不占对齐位也不产生歌词节点（spec §24.2 INFERRED，Domain 事实）', () => {
    const result = layout('Cz DE|', WIDE);
    const notes = result.nodes.filter((node) => node.kind === 'note');
    const rest = result.nodes.find((node) => node.kind === 'rest');
    const withLyrics = layout('Cz DE|\nw: la li lo', WIDE);

    expect(notes).toHaveLength(3);
    expect(rest).toBeDefined();
    expect(withLyrics.lyrics).toHaveLength(3);
    expect(withLyrics.lyrics.map((lyric) => lyric.text.x)).toEqual(notes.map((node) => node.x));
    expect(withLyrics.lyrics.every((lyric) => lyric.aligned)).toBe(true);
    // 休止那一列上没有任何歌词节点——不产生错误占位。
    expect(withLyrics.lyrics.some((lyric) => lyric.text.x === rest?.x)).toBe(false);
  });

  it('音节多于可唱事件时，溢出的音节落在**最后一个已对齐音节所在行谱**的行尾，不倒灌回第 0 行谱', () => {
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te px py`);
    const unaligned = result.lyrics.filter((lyric) => !lyric.aligned);
    const alignedInLast = result.lyrics.filter((lyric) => lyric.aligned && lyric.systemIndex === 1);
    const lastAligned = alignedInLast[alignedInLast.length - 1];

    expect(unaligned.map((lyric) => lyric.text.text)).toEqual(['px', 'py']);
    expect(unaligned.every((lyric) => lyric.systemIndex === 1)).toBe(true);
    expect(codesOf(result)).toContain(CODES.lyricTargetMissing);

    // 从该行谱最后一个已对齐音节右侧起，x 单调递增且互不重叠。
    const width = (text: string): number =>
      measurer.measure(text, { fontSize: JIANPU_METRICS.lyricFontSize }).width;
    const [px, py] = unaligned;
    expect(px?.text.x).toBeGreaterThanOrEqual((lastAligned?.text.x ?? 0) + width('te'));
    expect((py?.text.x ?? 0) - (px?.text.x ?? 0)).toBeGreaterThanOrEqual(width('px'));
    // 纵向仍在自己那一行谱的歌词基线上。
    expect(px?.text.y).toBe(lastAligned?.text.y);
  });

  it('target 缺失的 fallback 是确定性的（两次布局逐字段相等）', () => {
    const body = `${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te px py pz`;
    expect(layout(body).lyrics).toEqual(layout(body).lyrics);
  });

  it('整行都对不齐时，用 `LyricLine.bodyRange` 落到该段正文所在的行谱，不打回第 0 行谱', () => {
    // 第三条正文行全是休止 → 零可唱事件 → 它的 `w:` 整行都没有 `target`；
    // 但 `bodyRange` 记的是该行**产生的全部事件**（含 rest / barline），照样解析得出行谱。
    const result = layout(`${TWO_SYSTEMS}\nw: la li lo lu ta ti tu te\nzzzz|\nw: pa pe`);
    const orphans = result.lyrics.filter((lyric) => lyric.text.text === 'pa' || lyric.text.text === 'pe');
    const rests = result.nodes.filter((node) => node.kind === 'rest');
    const restSystem = rests[0]?.systemIndex;

    expect(result.systems.length).toBe(3);
    expect(restSystem).toBe(2);
    expect(orphans).toHaveLength(2);
    expect(orphans.every((lyric) => !lyric.aligned)).toBe(true);
    // 关键：既不在第 0 行谱，也不在文末某条全局基线上，而是在休止所在的那一行谱。
    expect(orphans.map((lyric) => lyric.systemIndex)).toEqual([2, 2]);
    const system = result.systems[2];
    expect(system).toBeDefined();
    if (system === undefined) return;
    for (const lyric of orphans) {
      expect(lyric.text.y).toBeGreaterThan(system.box.origin.y);
      expect(lyric.text.y).toBeLessThanOrEqual(system.box.origin.y + system.box.height);
    }
    expect(codesOf(result)).toContain(CODES.lyricTargetMissing);
  });

  it('游标按 (行谱, verse) 维护：分属不同正文行的两条 verse 0 `w:` 溢出到同一条基线也不重叠', () => {
    // 两条正文行各带一条 `w:`；`verseIndex` 在 parse 层按绑定的正文行重置，故**都是 0**。
    // WIDE 下三个 measure 同属第 0 行谱 → 两组溢出音节共享同一条 verse 0 基线。
    const result = layout('CD|\nw: la li lo\nEF|\nw: pa pe pi', WIDE);
    const unaligned = result.lyrics.filter((lyric) => !lyric.aligned);
    const width = (text: string): number =>
      measurer.measure(text, { fontSize: JIANPU_METRICS.lyricFontSize }).width;

    expect(result.systems.length).toBe(1);
    expect(new Set(result.lyrics.map((lyric) => lyric.verseIndex))).toEqual(new Set([0]));
    expect(unaligned.map((lyric) => lyric.text.text)).toEqual(['lo', 'pi']);
    expect(unaligned.every((lyric) => lyric.systemIndex === 0)).toBe(true);

    // 同一条基线 → y 相同；x 严格递增且不重叠（若游标按 `w:` 行各自维护，两者会撞在一起）。
    const [lo, pi] = unaligned;
    expect(lo?.text.y).toBe(pi?.text.y);
    expect((pi?.text.x ?? 0) - (lo?.text.x ?? 0)).toBeGreaterThanOrEqual(width('lo'));
    const aligned = result.lyrics.filter((lyric) => lyric.aligned);
    for (const placed of aligned) {
      expect(Math.abs(placed.text.x - (lo?.text.x ?? 0))).toBeGreaterThanOrEqual(
        Math.min(width(placed.text.text), width('lo')),
      );
    }
  });

  it('后一条 `w:` 整行都对不齐时，接着同一条基线已有内容的右侧走，而不是从 x = 0 重来', () => {
    // 这一条才是「游标按 (行谱, verse) 而不是按 `w:` 行」的判别用例：第二条 `w:` 绑定的
    // 正文全是休止 → 它一个音节都对不齐，若游标随 `w:` 行重置就会从 x = 0 起排，
    // 与第一条 `w:` 的 verse 0 歌词撞在同一条基线的同一段 x 上。
    const result = layout('CD|\nw: la li\nzz|\nw: pa pe', WIDE);
    const width = (text: string): number =>
      measurer.measure(text, { fontSize: JIANPU_METRICS.lyricFontSize }).width;
    const byText = new Map(result.lyrics.map((lyric) => [lyric.text.text, lyric]));
    const li = byText.get('li');
    const pa = byText.get('pa');
    const pe = byText.get('pe');

    expect(result.systems.length).toBe(1);
    expect(new Set(result.lyrics.map((lyric) => lyric.verseIndex))).toEqual(new Set([0]));
    expect(pa?.aligned).toBe(false);
    expect(pe?.aligned).toBe(false);
    // 同一条基线（同行谱、同 verse）。
    expect(pa?.text.y).toBe(li?.text.y);
    expect(pe?.text.y).toBe(li?.text.y);
    // 接着 `li` 的右侧走，**不是** 0。
    expect(pa?.text.x).not.toBe(0);
    expect(pa?.text.x ?? 0).toBeGreaterThanOrEqual((li?.text.x ?? 0) + width('li'));
    expect((pe?.text.x ?? 0) - (pa?.text.x ?? 0)).toBeGreaterThanOrEqual(width('pa'));
  });
});

// ---------------------------------------------------------------------------
// 5. row = verseIndex（行谱局部），不是 lyricLines 的数组下标
// ---------------------------------------------------------------------------

describe('歌词行号取 `verseIndex`，不取 `lyricLines` 的数组下标', () => {
  it('多条 verse 0 的 `w:` 落在同一行谱时只占一条基线，不形成逐行下排的瀑布', () => {
    // 四条正文行、四条 `w:`，每条各自绑定不同正文行 → `verseIndex` 全是 0。
    // 旧实现按数组下标取行号，会排出四条基线（真实语料里就是 24 条）。
    const result = layout('CD|\nw: la li\nEF|\nw: pa pe\nGA|\nw: ta ti\nBc|\nw: na ne', WIDE);
    const verseZero = result.lyrics.filter(
      (lyric) => lyric.systemIndex === 0 && lyric.verseIndex === 0,
    );

    expect(result.systems.length).toBe(1);
    expect(verseZero).toHaveLength(8);
    expect(new Set(verseZero.map((lyric) => lyric.text.y)).size).toBe(1);
    // 行谱只为 1 行歌词长高，不为 4 行。
    expect(result.systems[0]?.box.height).toBe(
      JIANPU_METRICS.systemHeight + JIANPU_METRICS.lyricFirstOffset + JIANPU_METRICS.lyricLineGap,
    );
  });
});
