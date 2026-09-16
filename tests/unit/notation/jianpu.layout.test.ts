/**
 * T4 —— 排布/换行 + Jianpu 布局（M2 方案 v1.1.1 §2.6 / §2.6.1 / §3.2 / §6 T4）。
 *
 * 主轴是**纯 Domain → Layout 的结构断言**：零 SVG 快照、零宿主字体依赖。`TextMeasurer`
 * 一律由本文件注入 T2 的 `createDeterministicTextMeasurer`（§2.8）。
 *
 * 用例里**不出现「拍」的假设**（P1-3）：`Rational` 是相对全音符的绝对音长，所有时值断言
 * 都写成 `1/4` / `1/8` 这样的绝对音长，不写「一拍」「半拍」。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import type { DomainIndex, Score } from '../../../src/domain';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';
import { SLOT_SPACING_METRICS } from '../../../src/notation/layout/metrics';
import { itemSlotWidth, spaceItems, timedSlotWidth } from '../../../src/notation/layout/spacing';
import { layoutSystems, splitMeasures } from '../../../src/notation/layout/systems';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import { RENDER_DIAGNOSTIC_CODES as CODES } from '../../../src/notation/model/diagnostics';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuContext, JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { pitchToNumber } from '../../../src/notation/jianpu/pitchToNumber';
import { fixtureBytes, fixtureNames } from '../jcx/serialize/roundtrip.helpers';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

function header(body: string, fields = 'M:4/4\nL:1/4\nK:C\n'): string {
  return `%MUSE2\nX:1\n${fields}V:1\n${body}\n`;
}

interface Prepared {
  readonly score: Score;
  readonly index: DomainIndex;
  readonly voice: RenderVoice;
  readonly ctx: JianpuContext;
}

function prepare(text: string, availableWidth = WIDE): Prepared {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return {
    score: loaded.score,
    index: loaded.index,
    voice,
    ctx: { score: loaded.score, index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): JianpuLayout {
  const prepared = prepare(text, availableWidth);
  return layoutJianpu(prepared.voice, { ...prepared.ctx, availableWidth });
}

function codesOf(result: JianpuLayout): readonly string[] {
  return result.diagnostics.map((diagnostic) => diagnostic.code);
}

// ---------------------------------------------------------------------------
// spacing.ts —— 列宽（§2.6 / §2.6.1）
// ---------------------------------------------------------------------------

describe('spacing —— 时值加权列宽（§2.6.1：以四分音符为基准的绝对音长，不涉及「拍」）', () => {
  it('1/4 取基准列宽；更短的绝对音长得到不更宽的列（夹在上下界之间）', () => {
    const quarter = timedSlotWidth({ num: 1, den: 4 });
    const eighth = timedSlotWidth({ num: 1, den: 8 });
    const whole = timedSlotWidth({ num: 1, den: 1 });
    expect(quarter).toBe(SLOT_SPACING_METRICS.quarterWidth);
    expect(eighth).toBeLessThanOrEqual(quarter);
    expect(whole).toBeGreaterThanOrEqual(quarter);
    expect(eighth).toBeGreaterThanOrEqual(SLOT_SPACING_METRICS.minSlotWidth);
    expect(whole).toBeLessThanOrEqual(SLOT_SPACING_METRICS.maxSlotWidth);
  });

  it('小节线等无时值事件取固定窄列，且不是降级（§2.6 表：切点事件仍被渲染）', () => {
    const { voice } = prepare(header('C|'));
    const barline = voice.items[1];
    if (barline === undefined) throw new Error('缺少 barline item');
    expect(itemSlotWidth(barline)).toEqual({
      width: SLOT_SPACING_METRICS.untimedSlotWidth,
      kind: 'untimed',
    });
  });

  it('duration 缺失 → 固定占位宽 + 该 measure 整体退等距（§2.6.1 R4，不反推时值）', () => {
    // 没有 `L:` 时 Domain 只留 durationRaw，`duration` 缺失。
    const { voice } = prepare('%MUSE2\nX:1\nK:C\nV:1\nCDE|\n');
    const measures = splitMeasures(voice.items);
    const first = measures[0];
    if (first === undefined) throw new Error('缺少 measure');
    const spacing = spaceItems(first.items, first.startIndex);
    expect(spacing.equidistant).toBe(true);
    for (const slot of spacing.slots) {
      expect(slot.widthKind).toBe('equidistant');
      expect(slot.slot.width).toBe(SLOT_SPACING_METRICS.equidistantSlotWidth);
    }
  });

  it('不可表示的 duration（1/12）按字面 duration 排布，**不**退等距（§2.6.1 收窄）', () => {
    const { voice } = prepare(header('C1/3 D|'));
    const measures = splitMeasures(voice.items);
    const first = measures[0];
    if (first === undefined) throw new Error('缺少 measure');
    const spacing = spaceItems(first.items, first.startIndex);
    expect(spacing.equidistant).toBe(false);
    expect(spacing.slots[0]?.widthKind).toBe('timed');
  });

  it('列序号在声部内单调递增，x 自 0 起累加（TimeSlot 契约）', () => {
    const { voice } = prepare(header('CDE|'));
    const spacing = spaceItems(voice.items, 0);
    expect(spacing.slots.map((slot) => slot.slot.index)).toEqual([0, 1, 2, 3]);
    expect(spacing.slots[0]?.slot.x).toBe(0);
    expect(spacing.width).toBe(
      spacing.slots.reduce((sum, slot) => sum + slot.slot.width, 0),
    );
  });
});

// ---------------------------------------------------------------------------
// systems.ts —— measure 切分与换行（§2.6 / D7）
// ---------------------------------------------------------------------------

describe('systems —— measure 切分（§2.6：切点 barline 事件不被消费）', () => {
  it('barline 仍留在 items 里并收尾它所结束的 measure', () => {
    const { voice } = prepare(header('CD|EF|'));
    const measures = splitMeasures(voice.items);
    expect(measures).toHaveLength(2);
    expect(measures.map((measure) => measure.items.length)).toEqual([3, 3]);
    for (const measure of measures) {
      expect(measure.items[measure.items.length - 1]?.event.kind).toBe('barline');
    }
    // 关键：切点没有被消费——两个 measure 的 item 总数等于原事件数。
    const total = measures.reduce((sum, measure) => sum + measure.items.length, 0);
    expect(total).toBe(voice.items.length);
  });

  it('末尾没有小节线时，剩余事件构成最后一个 measure；不产生空 measure', () => {
    const { voice } = prepare(header('CD|EF'));
    const measures = splitMeasures(voice.items);
    expect(measures).toHaveLength(2);
    expect(measures[1]?.items).toHaveLength(2);
    expect(splitMeasures([])).toHaveLength(0);
  });
});

describe('systems —— 贪心换行（D7：system 级连续布局 + 基本换行，不分页）', () => {
  const geometry = { availableWidth: 100, systemHeight: 10, systemGap: 2, originY: 0 };

  it('按可用宽度累加 measure 宽度，装不下就换行', () => {
    const { systems, placements } = layoutSystems([60, 60, 30], geometry);
    expect(placements.map((placement) => placement.systemIndex)).toEqual([0, 1, 1]);
    expect(placements.map((placement) => placement.x)).toEqual([0, 0, 60]);
    expect(systems).toHaveLength(2);
    expect(systems[1]?.box.origin.y).toBe(geometry.systemHeight + geometry.systemGap);
  });

  it('单个 measure 宽于容器时独占一行、不再拆（D7：需迭代求解的后移）', () => {
    const { systems, placements } = layoutSystems([500, 10], geometry);
    expect(placements.map((placement) => placement.systemIndex)).toEqual([0, 1]);
    expect(systems[0]?.box.width).toBe(500);
  });

  it('空输入返回零 system（「没有内容」不等于「有一行但空着」）', () => {
    expect(layoutSystems([], geometry).systems).toHaveLength(0);
  });

  it('容器变窄时 layoutJianpu 真的换行', () => {
    const wide = layout(header('CD|EF|GA|'), WIDE);
    const narrow = layout(header('CD|EF|GA|'), 1);
    expect(wide.systems).toHaveLength(1);
    expect(narrow.systems).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// pitchToNumber.ts —— 固定 C 映射与八度点（§3.2.0 P1 / §14.1 / §14.2）
// ---------------------------------------------------------------------------

describe('pitchToNumber —— 固定 C 大调映射（§3.2.0 前提 P1）', () => {
  it('C=1 D=2 E=3 F=4 G=5 A=6 B=7', () => {
    const digits = layout(header('CDEFGAB|')).nodes
      .filter((node) => node.kind === 'note')
      .map((node) => (node.kind === 'note' ? node.text.text : ''));
    expect(digits).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('改 K: 数字不变——**不随调号做首调移位**（§12.6.3，与常见简谱实现相反）', () => {
    const inC = layout(header('CDEFGAB|', 'M:4/4\nL:1/4\nK:C\n'));
    const inG = layout(header('CDEFGAB|', 'M:4/4\nL:1/4\nK:G\n'));
    const inEb = layout(header('CDEFGAB|', 'M:4/4\nL:1/4\nK:Eb\n'));
    const digits = (result: JianpuLayout): readonly string[] =>
      result.nodes.filter((node) => node.kind === 'note').map((node) => (node.kind === 'note' ? node.text.text : ''));
    expect(digits(inG)).toEqual(digits(inC));
    expect(digits(inEb)).toEqual(digits(inC));
  });

  it('八度点：小写字母上一个点，`,` 下一个点（§14.1 / §14.2）', () => {
    expect(pitchToNumber({ letter: 'C', register: 'upper', octaveRaw: '', octaveShift: 0 }))
      .toMatchObject({ number: 1, octaveDots: 0, mixedOctave: false });
    expect(pitchToNumber({ letter: 'C', register: 'lower', octaveRaw: '', octaveShift: 0 }))
      .toMatchObject({ octaveDots: 1, octaveDotDirection: 'above' });
    expect(pitchToNumber({ letter: 'C', register: 'upper', octaveRaw: ',', octaveShift: -1 }))
      .toMatchObject({ octaveDots: 1, octaveDotDirection: 'below' });
  });

  it('混合方向八度（`C,\'`，U23）：只按 register 画基准八度 + 诊断，**不抵消**', () => {
    const result = layout(header("C,' D|"));
    const note = result.nodes.find((node) => node.kind === 'note');
    expect(note?.kind === 'note' && note.pitch.mixedOctave).toBe(true);
    expect(note?.kind === 'note' && note.pitch.octaveDots).toBe(0);
    expect(note?.fallback).toBe(true);
    expect(codesOf(result)).toContain(CODES.jianpuOctaveMixed);
  });
});

// ---------------------------------------------------------------------------
// 时值分解（§2.6.1 / §3.2 时值行）
// ---------------------------------------------------------------------------

describe('时值装饰 —— 走 T0 的 {base, dots}（§2.6.1，用例中不出现「拍」的假设）', () => {
  function firstNote(text: string): { beams: number; dashes: number; dots: number } {
    const node = layout(text).nodes.find((item) => item.kind === 'note');
    if (node === undefined || node.kind !== 'note') throw new Error('缺少 note 节点');
    return {
      beams: node.duration.beams.length,
      dashes: node.duration.dashes.length,
      dots: node.duration.augmentationDots.length,
    };
  }

  it('绝对音长 1/4 → 无减时线、无延音线、无附点', () => {
    expect(firstNote(header('C|'))).toEqual({ beams: 0, dashes: 0, dots: 0 });
  });

  it('绝对音长 1/8 → 一条减时线；1/16 → 两条', () => {
    expect(firstNote(header('C|', 'M:4/4\nL:1/8\nK:C\n')).beams).toBe(1);
    expect(firstNote(header('C|', 'M:4/4\nL:1/16\nK:C\n')).beams).toBe(2);
  });

  it('绝对音长 1/2 → 一条延音线；1（全音符）→ 三条', () => {
    expect(firstNote(header('C2|')).dashes).toBe(1);
    expect(firstNote(header('C4|')).dashes).toBe(3);
  });

  it('绝对音长 3/8 → 四分音符 + 一个附点（dots 取能成立的最小值）', () => {
    expect(firstNote(header('C3/2|'))).toEqual({ beams: 0, dashes: 0, dots: 1 });
  });

  it('不可表示（1/12）→ **不画任何时值装饰**，不四舍五入到最近可表示时值', () => {
    const node = layout(header('C1/3 D|')).nodes.find((item) => item.kind === 'note');
    expect(node?.kind === 'note' && node.duration.unrepresentable).toBe(true);
    expect(node?.kind === 'note' && node.duration.beams).toHaveLength(0);
  });

  it('不可表示时该节点也是 fallback 节点（契约 C2：诊断由 T1 在 event 级发出）', () => {
    const prepared = prepare(header('C1/3 D|'));
    const rendered = layoutJianpu(prepared.voice, prepared.ctx);
    const node = rendered.nodes.find((item) => item.kind === 'note');
    expect(node?.fallback).toBe(true);
    // 该事件在 buildRenderScore 阶段已有 duration.unrepresentable 诊断，锚点是同一事件。
    const score = buildRenderScore({ score: prepared.score, index: prepared.index });
    const hit = score.diagnostics.find(
      (diagnostic) => diagnostic.code === CODES.durationUnrepresentable,
    );
    expect(hit?.anchor).toEqual(node?.anchor);
  });

  it('duration 缺失 → 不画时值装饰（固定宽占位由 spacing 给出）', () => {
    const node = layout('%MUSE2\nX:1\nK:C\nV:1\nC|\n').nodes.find((item) => item.kind === 'note');
    expect(node?.kind === 'note' && node.duration.beams).toHaveLength(0);
    expect(node?.fallback).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 休止三态 / 小节线 / tuplet / 关系（§3.2）
// ---------------------------------------------------------------------------

describe('休止三态（§15.1 / U24 / §15.3）', () => {
  const result = layout(header('z Z @|'));
  const rests = result.nodes.filter((node) => node.kind === 'rest');

  it('三者都画 `0` 并照常占位：`Z` 不画多小节休止、`@` **绝不隐藏**', () => {
    expect(rests).toHaveLength(3);
    for (const rest of rests) {
      expect(rest.kind === 'rest' && rest.text.text).toBe('0');
      expect(rest.width).toBeGreaterThan(0);
    }
    // 三个休止的绝对音长相同 → 列宽相同：`Z` 没有被赋予多小节宽度。
    expect(new Set(rests.map((rest) => rest.width)).size).toBe(1);
  });

  it('`Z` 与 `@` 各发各的 code（语义不同，不得合并）', () => {
    expect(codesOf(result)).toContain(CODES.restMultiMeasureNotModeled);
    expect(codesOf(result)).toContain(CODES.restInvisibleNotModeled);
  });
});

describe('小节线形态（spec §18；只有四种 CONFIRMED 写法，其余一律退普通线 + 诊断）', () => {
  function formsOf(result: JianpuLayout): readonly string[] {
    return result.nodes
      .filter((node) => node.kind === 'barline')
      .map((node) => (node.kind === 'barline' ? node.form : ''));
  }

  it('`|` / `|]` / `:|` / `|:` 四种 CONFIRMED 形态各自分类，无诊断', () => {
    const result = layout(header('C|D|]E:|F|:G'));
    expect(formsOf(result)).toEqual(['single', 'final', 'repeat-end', 'repeat-start']);
    expect(codesOf(result)).not.toContain(CODES.barlineUnrecognized);
  });

  it('`||` 与 `::` 是 DOC-ONLY 且语料 0（spec §18）→ 与表外组合同等对待：普通线 + 各一条诊断', () => {
    const result = layout(header('C||D::E|'));
    expect(formsOf(result)).toEqual(['unrecognized', 'unrecognized', 'single']);
    const hits = result.diagnostics.filter(
      (diagnostic) => diagnostic.code === CODES.barlineUnrecognized,
    );
    expect(hits).toHaveLength(2);
    // 退化成的普通线就是一根竖线，没有第二根、没有反复点——不给 DOC-ONLY 写法编字形。
    for (const node of result.nodes.filter((item) => item.kind === 'barline')) {
      if (node.kind === 'barline' && node.form === 'unrecognized') {
        expect(node.glyphs.lines).toHaveLength(1);
        expect(node.glyphs.repeatDots).toHaveLength(0);
        expect(node.fallback).toBe(true);
      }
    }
  });

  it('`[:]` / `[|` 等表外组合同样 unrecognized + 诊断', () => {
    expect(codesOf(layout(header('C[:]D|')))).toContain(CODES.barlineUnrecognized);
  });
});

describe('tuplet（§20 / U25，P1-C：与时值分解彻底分离）', () => {
  const result = layout(header('(3CDE|', 'M:4/4\nL:1/8\nK:C\n'));

  it('只额外画方括号 + p 数字，成员的减时线由各自 duration 决定、**不被缩放**', () => {
    expect(result.tuplets).toHaveLength(1);
    expect(result.tuplets[0]?.label).toBe('3');
    const notes = result.nodes.filter((node) => node.kind === 'note');
    expect(notes).toHaveLength(3);
    for (const note of notes) {
      // 绝对音长 1/8 → 一条减时线，与三连音身份无关。
      expect(note.kind === 'note' && note.duration.beams).toHaveLength(1);
    }
  });

  it('成员列宽等于同绝对音长的普通音符列宽（spacing 不按 p/q 缩放）', () => {
    const plain = layout(header('CDE|', 'M:4/4\nL:1/8\nK:C\n'));
    const widths = (item: JianpuLayout): readonly number[] =>
      item.nodes.filter((node) => node.kind === 'note').map((node) => node.width);
    expect(widths(result)).toEqual(widths(plain));
  });

  it('q 缺失（U25）另发诊断，不推算 effective duration', () => {
    expect(codesOf(result)).toContain(CODES.tupletRatioUnverified);
    expect(result.tuplets[0]?.complete).toBe(false);
  });
});

describe('tie / slur 的 A 类恢复状态（§22，parse 层如实记录的源文本事实）', () => {
  it('未闭合的 slur 画单端弧 + 诊断，不为缺失的对端造端点', () => {
    const result = layout(header('(CDE|'));
    expect(result.arcs.some((arc) => arc.open)).toBe(true);
    expect(codesOf(result)).toContain(CODES.slurUnclosed);
  });

  it('闭合的 slur 画两端弧，无恢复状态诊断', () => {
    const result = layout(header('(CDE)|'));
    const arc = result.arcs.find((item) => item.kind === 'slur');
    expect(arc?.open).toBe(false);
    expect(arc !== undefined && arc.x2 > arc.x1).toBe(true);
    expect(codesOf(result)).not.toContain(CODES.slurUnclosed);
  });
});

// ---------------------------------------------------------------------------
// 歌词 / 头部标签 / Unknown / 确定性
// ---------------------------------------------------------------------------

describe('歌词（§24：按 NoteRef 对齐到列 x，多段逐行下排）', () => {
  it('音节 x 等于其 target 事件所在列的左边界', () => {
    const result = layout(header('C D\nw: la li'));
    const notes = result.nodes.filter((node) => node.kind === 'note');
    expect(result.lyrics.map((lyric) => lyric.text.x)).toEqual(notes.map((node) => node.x));
    for (const lyric of result.lyrics) expect(lyric.aligned).toBe(true);
  });

  it('无对齐目标的音节按顺序落在行尾：x 单调递增、互不重叠，**不被钉在 0**', () => {
    const result = layout(header('C D\nw: la li lo lu'));
    const xs = result.lyrics.map((lyric) => lyric.text.x);
    const aligned = result.lyrics.map((lyric) => lyric.aligned);
    expect(aligned).toEqual([true, true, false, false]);
    const [la, li, lo, lu] = xs;
    expect(lo).toBeGreaterThan(li ?? 0);
    expect(lu).toBeGreaterThan(lo ?? 0);
    expect(li).toBeGreaterThan(la ?? -1);
    // 相邻音节的间距不小于前一个音节的文本宽度 → 互不重叠。
    const width = (text: string): number => measurer.measure(text, { fontSize: 12 }).width;
    expect((lo ?? 0) - (li ?? 0)).toBeGreaterThanOrEqual(width('li'));
    expect((lu ?? 0) - (lo ?? 0)).toBeGreaterThanOrEqual(width('lo'));
    expect(codesOf(result)).toContain(CODES.lyricTargetMissing);
  });

  it('整行都没有目标时从行起点 0 起顺排（§3.2：落在行尾，不伪造列位置）', () => {
    // `w:` 出现在任何正文之前 → 没有绑定目标（对照 fixture `lyrics-no-target.jcx`）。
    const result = layout('%MUSE2\nX:1\nM:4/4\nL:1/4\nK:C\nV:1\nV:1\nw: la li\nCDEF|\n');
    expect(result.lyrics.every((lyric) => !lyric.aligned)).toBe(true);
    expect(result.lyrics[0]?.text.x).toBe(0);
    expect(result.lyrics[1]?.text.x).toBeGreaterThan(0);
  });

  it('歌词里的 - / _ / | 原样输出 + 一条诊断（U31/U32，不做连字符语义）', () => {
    const result = layout(header('C D\nw: la- li'));
    expect(result.lyrics[0]?.text.text).toBe('la-');
    expect(codesOf(result)).toContain(CODES.lyricMarkerLiteral);
  });

  it('多段歌词按行下排：不同 verse 落在不同基线', () => {
    const result = layout(header('C D\nw: la li\nw: ta ti'));
    const rows = new Set(result.lyrics.map((lyric) => lyric.text.y));
    expect(rows.size).toBe(2);
    expect(new Set(result.lyrics.map((lyric) => lyric.verseIndex)).size).toBe(2);
  });
});

describe('头部标签（§3.2 调号 / 拍号；P1-2：永不生成 1=<tonic>）', () => {
  function keyLabel(text: string): string | undefined {
    return layout(text).labels.find((label) => label.kind === 'key')?.text.text;
  }

  it('全仓没有 `1=` 标签：所有标签文本都不含它', () => {
    for (const source of [header('C|'), header('C|', 'M:4/4\nL:1/4\nK:G\n')]) {
      for (const label of layout(source).labels) expect(label.text.text).not.toContain('1=');
    }
  });

  it('形态一：tonic 有值 → 画 `K: <值>`，无诊断', () => {
    const result = layout(header('C|', 'M:4/4\nL:1/4\nK:G\n'));
    expect(keyLabel(header('C|', 'M:4/4\nL:1/4\nK:G\n'))).toBe('K: G');
    expect(codesOf(result)).not.toContain(CODES.keyModeUnrecognized);
    expect(codesOf(result)).not.toContain(CODES.keyUnresolved);
  });

  it('形态二：tonic + 未知 mode → mode 原文一并显示 + info，**不假设 major**', () => {
    const source = header('C|', 'M:4/4\nL:1/4\nK:A Mix\n');
    expect(keyLabel(source)).toBe('K: A Mix');
    expect(codesOf(layout(source))).toContain(CODES.keyModeUnrecognized);
  });

  it('形态三：只有 raw → 原样转述 + warning，**不从 alter 反推主音**', () => {
    const source = header('C|', 'M:4/4\nL:1/4\nK:???\n');
    expect(keyLabel(source)).toBe('K: ???');
    expect(codesOf(layout(source))).toContain(CODES.keyUnresolved);
  });

  it('形态四：key 整个缺席 → 不画调号标签 + info（默认调号无证据，§8.7）', () => {
    const result = layout(header('C|', 'M:4/4\nL:1/4\n'));
    expect(result.labels.some((label) => label.kind === 'key')).toBe(false);
    expect(codesOf(result)).toContain(CODES.keyAbsent);
  });

  it('拍号：fraction 画 num/den；raw（`C`）原样显示 + info，**不换算成 4/4**', () => {
    expect(layout(header('C|')).labels.find((label) => label.kind === 'meter')?.text.text).toBe('4/4');
    const rawMeter = layout(header('C|', 'M:C\nL:1/4\nK:C\n'));
    expect(rawMeter.labels.find((label) => label.kind === 'meter')?.text.text).toBe('C');
    expect(codesOf(rawMeter)).toContain(CODES.meterRaw);
  });
});

describe('UnknownEvent（契约 C1 / C2）', () => {
  const result = layout(header('C ] D|'));

  it('恰好一个可见占位节点', () => {
    const unknown = result.nodes.filter((node) => node.kind === 'unknown');
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.width).toBeGreaterThan(0);
    expect(unknown[0]?.kind === 'unknown' && unknown[0].text.text).toBe(']');
  });

  it('该 fallback 节点至少关联一条诊断，且 anchor 指向同一事件', () => {
    const unknown = result.nodes.find((node) => node.kind === 'unknown');
    expect(unknown?.fallback).toBe(true);
    const hits = result.diagnostics.filter((diagnostic) => diagnostic.code === CODES.eventUnknown);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.anchor).toEqual(unknown?.anchor);
  });
});

describe('其余保守呈现路径各自有诊断（C2：fallback 节点至少一条诊断）', () => {
  it('简谱声部里的 TAB 事件 → 可见占位 + jianpu.event-out-of-scope，不静默丢弃', () => {
    const result = layout('%MUSE2\nX:1\nM:4/4\nL:1/8\nK:C\nV:1 style=tab\na1 b2|\n');
    const placeholders = result.nodes.filter((node) => node.kind === 'outOfScope');
    expect(placeholders).toHaveLength(2);
    for (const node of placeholders) {
      expect(node.width).toBeGreaterThan(0);
      expect(node.fallback).toBe(true);
    }
    expect(codesOf(result)).toContain(CODES.jianpuEventOutOfScope);
  });

  it('DecorationEvent → 统一文本占位 + decoration.placeholder（不做字形映射，U27–U30）', () => {
    const result = layout(header('!TRILL!C D|'));
    const node = result.nodes.find((item) => item.kind === 'decoration');
    expect(node?.kind === 'decoration' && node.text.text).toBe('TRILL');
    expect(node?.fallback).toBe(true);
    expect(codesOf(result)).toContain(CODES.decorationPlaceholder);
  });

  it('tuplet 成员不完整 → tuplet.incomplete，括号按已有成员范围画', () => {
    const result = layout(header('(3fg |', 'M:4/4\nL:1/8\nK:C\n'));
    expect(codesOf(result)).toContain(CODES.tupletIncomplete);
    expect(result.tuplets).toHaveLength(1);
    expect(result.tuplets[0]?.complete).toBe(false);
  });

  it('未解析的 tie → 单端弧 + tie.unresolved（A 类恢复状态，不造对端）', () => {
    const result = layout(header('C-|'));
    const arc = result.arcs.find((item) => item.kind === 'tie');
    expect(arc?.open).toBe(true);
    expect(codesOf(result)).toContain(CODES.tieUnresolved);
  });

  it('body 内 L: 变化 → 细标记 + unit-length.changed（不重新解释作用域，§8.5 U06）', () => {
    const result = layout(header('CD|\n L:1/8\nEF|'));
    expect(result.unitLengthMarks).toHaveLength(1);
    expect(codesOf(result)).toContain(CODES.unitLengthChanged);
  });
});

describe('确定性与全 fixture 冒烟（§7-10 / §6 T4）', () => {
  it('同一输入两次布局逐字段相等', () => {
    const source = header('(3CDE|F2 z|G,\' a3/2|');
    expect(layout(source)).toEqual(layout(source));
  });

  it('所有坐标有限且非 NaN', () => {
    const result = layout(header('C c, ^D z Z @ ] |'));
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.width)).toBe(true);
    }
  });

  it('全 fixture（运行时 glob，数量不写死）跑 loadJcx → buildRenderScore → layoutJianpu 零抛异常', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
    for (const name of fixtureNames) {
      const loaded = loadJcx(fixtureBytes(name));
      const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
      for (const voice of rendered.voices) {
        expect(() =>
          layoutJianpu(voice, {
            score: loaded.score,
            index: loaded.index,
            measurer,
            availableWidth: 600,
          }),
        ).not.toThrow();
      }
      // Domain 只读：布局全程没有换掉 score 引用。
      expect(rendered.score).toBe(loaded.score);
    }
  });
});
