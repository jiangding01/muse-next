/**
 * M2.5 T9b —— `renderer/components/notation/systemSlices.ts`：按 system 切片与 overlay 的纯映射（用户裁决 C–I / 2 / 4 / 5 / 6）。
 *
 * 只在 node 环境测 SvgNode / 切片数据（不跑 React / VexFlow）：每个 system 只含本 system 的几何、viewBox = 层 box、
 * 三种记谱的 chordSymbol 一律不输出（含不拥有 overlay 的被去重事件）、Staff 平移与拍号语义、tuplet / L: 标记归属、
 * overlay 的变换 / 文本基线 / 唯一 event anchor、chordToSvg 内部零 anchor 的回归。
 */
import { describe, expect, it } from 'vitest';

import { eventId, voiceId } from '../../../src/domain';
import { layoutChord } from '../../../src/notation/chord/layoutChord';
import { chordToSvg } from '../../../src/notation/chord/toSvg';
import type { JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import { CHORD_METRICS, SYSTEM_METRICS } from '../../../src/notation/layout/metrics';
import { anchorKey } from '../../../src/notation/model/types';
import type { StaffLayout } from '../../../src/notation/staff/staffTypes';
import type { SvgNode } from '../../../src/notation/svg/node';
import type { ScoreLayout, VoiceLayoutEntry } from '../../../src/notation/system/composeLayout';
import type { TabLayout } from '../../../src/notation/tab/layoutTab';
import {
  jianpuSystemSvg, staffSystemSlice, systemOverlaySvg, tabSystemSvg,
} from '../../../src/renderer/components/notation/systemSlices';
import { compose, tabScoreOf } from '../notation/system.composeLayout.helpers';
import type { Source } from '../notation/system.composeLayout.helpers';
import { matrixScoreFrom } from '../notation/renderMatrix.helpers';
import { externalMeasurer as measurer, screen } from '../notation/systemExternal.helpers';

const G = 'G=1;3(3),2(2),0,0,0,3(4)';
const AM = 'Am=1;X,0,2(2),2(3),1(1),0';
const TAB = '"Am"Va0 [a0b1] {d8-S-}d10 a5-S-a7 a1 a2 a3|a0/4 a1/4 a2/4 a3/4 a0 a1 a2 a3 a4 a5 a6|a0 a1 a2 a3 a4 a5 a6 a7|';

/** 一个 bracket group：简谱（和弦 / tuplet / 跨小节 tie / 歌词）+ TAB（和弦 / 扫弦 / 滑音 / 倚音）；另一个 group 是 Staff。 */
const source: Source = matrixScoreFrom([
  '%MUSE2', `%%gchord ${G}`, `%%gchord ${AM}`, 'X:1', 'M:4/4', 'L:1/8',
  'V:1 bracket=2 style=jianpu', 'V:2 style=tab', 'V:3 style=staff', 'K:C',
  '[V:1]"G"C D (3EFG A B c-|c D E F G A B c|C D E F G A B c|', 'w: la li lo lu le',
  `[V:2]${TAB}`,
  '[V:3]"C"C D E F G A B c-|c D E F G A B c|', '',
].join('\n'));

function walk(node: SvgNode): SvgNode[] {
  return [node, ...(node.children ?? []).flatMap(walk)];
}
const attrValues = (node: SvgNode, name: string): string[] =>
  walk(node).flatMap((n) => (n.attrs[name] === undefined ? [] : [String(n.attrs[name])]));
const classCount = (node: SvgNode, cls: string): number =>
  walk(node).filter((n) => String(n.attrs.class ?? '').split(' ').includes(cls)).length;

function entry<N extends VoiceLayoutEntry['notation']>(layout: ScoreLayout, notation: N): Extract<VoiceLayoutEntry, { notation: N }> {
  const found = layout.voiceLayouts.find((e): e is Extract<VoiceLayoutEntry, { notation: N }> => e.notation === notation);
  if (found === undefined) throw new Error(`no ${notation}`);
  return found;
}

const eventIdsOf = (nodes: readonly { readonly anchor: { readonly kind: string; readonly eventId?: string } }[]): string[] =>
  nodes.flatMap((n) => (n.anchor.kind === 'event' && n.anchor.eventId !== undefined ? [n.anchor.eventId] : []));

describe('T9b 简谱 / TAB 切片：只含本 system，viewBox = 层 box，chordSymbol 不输出', () => {
  const narrow = compose(source, screen(220));
  const jianpu: JianpuLayout = entry(narrow, 'jianpu').layout;
  const tab: TabLayout = entry(narrow, 'tab').layout;

  it('多个 system；简谱每个 system 的事件 = 本 system 非 chordSymbol 节点（不漏、不泄漏）', () => {
    expect(jianpu.systems.length).toBeGreaterThan(1);
    const seen: string[] = [];
    for (const system of jianpu.systems) {
      const svg = jianpuSystemSvg(jianpu, system.index);
      const { origin, width, height } = system.box;
      expect(svg.attrs.viewBox).toBe(`${String(origin.x)} ${String(origin.y)} ${String(width)} ${String(height)}`);
      expect([svg.attrs.width, svg.attrs.height]).toEqual([width, height]);
      const own = jianpu.nodes.filter((n) => n.systemIndex === system.index && n.kind !== 'chordSymbol');
      expect(new Set(attrValues(svg, 'data-event-id'))).toEqual(new Set(eventIdsOf(own)));
      expect(classCount(svg, 'jianpu-lyric-group')).toBe(jianpu.lyrics.filter((l) => l.systemIndex === system.index).length);
      expect(classCount(svg, 'jianpu-arc-group')).toBe(jianpu.arcs.filter((a) => a.systemIndex === system.index).length);
      expect(classCount(svg, 'jianpu-beam-group')).toBe(jianpu.beams.filter((b) => b.systemIndex === system.index).length);
      seen.push(...attrValues(svg, 'data-event-id'));
    }
    expect(new Set(seen)).toEqual(new Set(eventIdsOf(jianpu.nodes.filter((n) => n.kind !== 'chordSymbol'))));
    expect(jianpu.arcs.some((a) => a.segment !== 'whole')).toBe(true);
  });

  it('TAB 每个 system 的节点 / 弦线 / 关系 / 扫弦 / beam 只来自本 system', () => {
    expect(tab.systems.length).toBeGreaterThan(1);
    for (const system of tab.systems) {
      const svg = tabSystemSvg(tab, system.index);
      const { origin, width, height } = system.box;
      expect(svg.attrs.viewBox).toBe(`${String(origin.x)} ${String(origin.y)} ${String(width)} ${String(height)}`);
      const own = <T extends { readonly systemIndex: number }>(items: readonly T[]): T[] => items.filter((i) => i.systemIndex === system.index);
      const nodeIds = eventIdsOf(own(tab.nodes).filter((n) => n.kind !== 'chordSymbol'));
      const strokeIds = eventIdsOf(own(tab.strokes));
      expect(new Set(attrValues(svg, 'data-event-id'))).toEqual(new Set([...nodeIds, ...strokeIds]));
      expect(classCount(svg, 'tab-staff-lines')).toBe(own(tab.staffLines).length);
      expect(classCount(svg, 'tab-relation-group')).toBe(own(tab.relations).length);
      expect(classCount(svg, 'tab-stroke-group')).toBe(own(tab.strokes).length);
      expect(classCount(svg, 'tab-beam-group')).toBe(own(tab.beams).length);
      expect(attrValues(svg, 'data-system-index').every((v) => v === String(system.index))).toBe(true);
    }
    expect(tab.strokes.length + tab.relations.length).toBeGreaterThan(0);
  });

  it('chordSymbol 全部不输出；layout 本身不被修改（nodes 数量不变）', () => {
    const before = JSON.stringify(narrow.voiceLayouts);
    const chordIds = new Set(eventIdsOf([...jianpu.nodes, ...tab.nodes].filter((n) => n.kind === 'chordSymbol')));
    expect(chordIds.size).toBe(2);
    const rendered = [...jianpu.systems.map((s) => jianpuSystemSvg(jianpu, s.index)), ...tab.systems.map((s) => tabSystemSvg(tab, s.index))];
    for (const svg of rendered) expect(attrValues(svg, 'data-event-id').filter((id) => chordIds.has(id))).toEqual([]);
    expect(JSON.stringify(narrow.voiceLayouts)).toBe(before);
  });

  it('不拥有 overlay 的 chordSymbol（跨声部同名被去重）同样不输出', () => {
    const dup = tabScoreOf(['"G"a0 a1 a2 a3 a4 a5 a6 a7|', '"G"a0 a1 a2 a3 a4 a5 a6 a7|']);
    const layout = compose(dup);
    const overlays = layout.composed.systems.flatMap((s) => s.chordOverlays);
    expect(overlays).toHaveLength(1);
    const tabs = layout.voiceLayouts.flatMap((e) => (e.notation === 'tab' ? [e.layout] : []));
    const chordNodes = tabs.flatMap((l) => l.nodes.filter((n) => n.kind === 'chordSymbol'));
    expect(chordNodes).toHaveLength(2);
    const nonCarrier = eventIdsOf(chordNodes).filter((id) => id !== overlays[0]?.anchor.eventId);
    expect(nonCarrier).toHaveLength(1);
    for (const l of tabs) {
      expect(attrValues(tabSystemSvg(l, 0), 'data-event-id').filter((id) => eventIdsOf(chordNodes).includes(id))).toEqual([]);
    }
  });
});

describe('T9b 简谱 tuplet / L: 标记的归属（裁决 2）', () => {
  const layout = compose(source, screen(220));
  const jianpu: JianpuLayout = entry(layout, 'jianpu').layout;
  const first = jianpu.systems[0];
  const second = jianpu.systems[1];
  if (first === undefined || second === undefined) throw new Error('systems');

  it('tuplet 按括号 y 所在层 box 恰好归属一个 system', () => {
    expect(jianpu.tuplets).toHaveLength(1);
    const counts = jianpu.systems.map((s) => classCount(jianpuSystemSvg(jianpu, s.index), 'jianpu-tuplet-bracket'));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('tuplet 括号 y 不落在任何层 box → RangeError；落在两个层 box（人为重叠）→ RangeError', () => {
    const [bracket] = jianpu.tuplets;
    if (bracket === undefined) throw new Error('tuplet');
    expect(() => jianpuSystemSvg({ ...jianpu, tuplets: [{ ...bracket, y: -9999 }] }, first.index)).toThrow(RangeError);
    const overlapped = { ...jianpu, systems: [first, { ...second, box: first.box }] };
    expect(() => jianpuSystemSvg(overlapped, first.index)).toThrow(RangeError);
  });

  it('L: 标记经 anchor.eventId → 节点 systemIndex 归属；事件找不到 → RangeError', () => {
    const target = jianpu.nodes.find((n) => n.systemIndex === second.index && n.anchor.kind === 'event');
    const anchor = target?.anchor;
    if (anchor?.kind !== 'event') throw new Error('node');
    const mark = { anchor, raw: '1/16', segment: { x1: 0, y1: first.box.origin.y + 5, x2: 0, y2: first.box.origin.y + 9 } };
    const withMark: JianpuLayout = { ...jianpu, unitLengthMarks: [mark] };
    expect(classCount(jianpuSystemSvg(withMark, second.index), 'jianpu-unit-length-mark')).toBe(1);
    expect(classCount(jianpuSystemSvg(withMark, first.index), 'jianpu-unit-length-mark')).toBe(0);
    const missing: JianpuLayout = { ...jianpu, unitLengthMarks: [{ ...mark, anchor: { ...anchor, eventId: eventId(voiceId(9), 999) } }] };
    expect(() => jianpuSystemSvg(missing, first.index)).toThrow(RangeError);
  });

  it('声部头部标签非空时不静默丢弃：RangeError（默认路径恒为空）', () => {
    expect(jianpu.labels).toEqual([]);
    const label = {
      anchor: { kind: 'voice' as const, voiceId: jianpu.voiceId },
      kind: 'key' as const,
      text: { text: 'K: C', x: 0, y: 0, fontSize: 12 },
    };
    expect(() => jianpuSystemSvg({ ...jianpu, labels: [label] }, first.index)).toThrow(RangeError);
  });
});

/** 3/4 拍的 Staff 声部：拍号 ≠ renderStaff 的缺省 4/4；含 tuplet 与跨小节 tie，窄宽度下分成多个 system。 */
const staff34: Source = matrixScoreFrom([
  'X:1', 'M:3/4', 'L:1/8', 'V:1 style=staff', 'K:C',
  '[V:1]"C"C2 D2 E2|(3FGA B2 c2-|c2 B2 A2|G2 (3FED C2|C6|', '',
].join('\n'));

describe('T9b Staff 切片（裁决 H / I / 6）', () => {
  const layout = compose(staff34, screen(120));
  const staff: StaffLayout = entry(layout, 'staff').layout;

  it('只含本 system；stave 平移到层内（x − S.origin.x，y = 0）；宽高 = 层 box；chordSymbol 已去掉', () => {
    expect(staff.systems.length).toBeGreaterThan(1);
    for (const system of staff.systems) {
      const slice = staffSystemSlice(staff, system.index);
      const own = staff.staves.filter((s) => s.systemIndex === system.index);
      const local = own.map((s) => [s.measureIndex, s.x - system.box.origin.x, 0, s.width]);
      expect(slice.staves.map((s) => [s.measureIndex, s.x, s.y, s.width])).toEqual(local);
      expect([slice.width, slice.height, slice.clef, slice.systemIndex]).toEqual([system.box.width, system.box.height, staff.clef, system.index]);
      expect(slice.nodes).toEqual(staff.nodes.filter((n) => n.systemIndex === system.index && n.kind !== 'chordSymbol'));
      expect(slice.ties).toEqual(staff.ties.filter((t) => t.systemIndex === system.index));
      expect(slice.tuplets).toEqual(staff.tuplets.filter((t) => t.systemIndex === system.index));
    }
    expect(staff.nodes.some((n) => n.kind === 'chordSymbol')).toBe(true);
    expect(staff.ties.length).toBeGreaterThan(0);
  });

  it('tuplet 只属于目标 system、原样筛选不重拆：各 system 切片的 tuplet 并起来恰为 layout 的全部 tuplet', () => {
    expect(staff.tuplets.length).toBeGreaterThanOrEqual(2);
    const owners = new Set(staff.tuplets.map((t) => t.systemIndex));
    expect(owners.size).toBeGreaterThan(1);
    const sliced = staff.systems.flatMap((system) => {
      const slice = staffSystemSlice(staff, system.index);
      for (const t of slice.tuplets) expect(t.systemIndex).toBe(system.index);
      return slice.tuplets;
    });
    expect(sliced).toEqual(staff.tuplets);
    sliced.forEach((t, i) => expect(t).toBe(staff.tuplets[i]));
  });

  it('层 box 向左扩展（origin.x < 0，和弦左墨迹）时，stave x 平移为 x − origin.x（语料与上面夹具的 origin.x 都恰为 0）', () => {
    const target = staff.systems[0];
    if (target === undefined) throw new Error('system');
    const shifted: StaffLayout = {
      ...staff,
      systems: staff.systems.map((s) => ({ ...s, box: { ...s.box, origin: { x: -40, y: s.box.origin.y } } })),
    };
    const own = staff.staves.filter((s) => s.systemIndex === target.index);
    expect(own.length).toBeGreaterThan(0);
    expect(staffSystemSlice(shifted, target.index).staves.map((s) => s.x)).toEqual(own.map((s) => s.x + 40));
  });

  it('timeSignature 取整份 StaffLayout 首个有效拍号，不按本 system 重新查找', () => {
    const [first, second] = staff.systems;
    if (first === undefined || second === undefined) throw new Error('system');
    const stripped: StaffLayout = {
      ...staff,
      staves: staff.staves.map((s) => {
        if (s.systemIndex === first.index) return s;
        const { timeSignature: _drop, ...rest } = s;
        return rest;
      }),
    };
    expect(stripped.staves.filter((s) => s.systemIndex === second.index).some((s) => s.timeSignature !== undefined)).toBe(false);
    // 3/4 ≠ renderStaff 缺省的 4/4：若改成「本 system 查找、找不到再退回 4/4」，这里会得到 4/4 而失败。
    expect(staffSystemSlice(stripped, second.index).timeSignature).toEqual({ numerator: 3, denominator: 4 });
  });

  it('systemIndex 不连续也能切（按 System.index 查，不当数组下标）；缺少层 box → RangeError', () => {
    const shift = (i: number): number => i * 10 + 7;
    const relabeled: StaffLayout = {
      ...staff,
      systems: staff.systems.map((s) => ({ ...s, index: shift(s.index) })),
      staves: staff.staves.map((s) => ({ ...s, systemIndex: shift(s.systemIndex) })),
      nodes: staff.nodes.map((n) => ({ ...n, systemIndex: shift(n.systemIndex) })),
      ties: staff.ties.map((t) => ({ ...t, systemIndex: shift(t.systemIndex) })),
      tuplets: staff.tuplets.map((t) => ({ ...t, systemIndex: shift(t.systemIndex) })),
    };
    const target = staff.systems[1];
    if (target === undefined) throw new Error('system');
    expect(staffSystemSlice(relabeled, shift(target.index)).staves).toHaveLength(staff.staves.filter((s) => s.systemIndex === target.index).length);
    expect(() => staffSystemSlice(staff, 999)).toThrow(RangeError);
  });
});

describe('T9b 和弦 overlay（裁决 F / G / 4 / 5）', () => {
  const layout = compose(source);
  const system = layout.composed.systems[0];
  if (system === undefined) throw new Error('system');
  const score = source.renderScore.score;

  it('每块 overlay 的子树恰好一个 data-anchor-key，且是 ChordDiagramOverlay.anchor 的 event key', () => {
    const svg = systemOverlaySvg(system, score, measurer);
    if (svg === undefined) throw new Error('overlay');
    expect(svg.attrs.viewBox).toBe(`0 0 ${String(system.box.width)} ${String(system.box.height)}`);
    expect(svg.children).toHaveLength(system.chordOverlays.length);
    system.chordOverlays.forEach((overlay, i) => {
      const group = svg.children?.[i];
      if (group === undefined) throw new Error('group');
      expect(attrValues(group, 'data-anchor-key')).toEqual([anchorKey(overlay.anchor)]);
      expect(group.attrs['data-event-id']).toBe(overlay.anchor.eventId);
    });
    expect(attrValues(svg, 'data-anchor-key')).toHaveLength(system.chordOverlays.length);
  });

  it('带图：translate(x − chordDiagramWidth/2, y)，子节点 = layoutChord(chordShapes[shapeIndex], 108, showFinger)', () => {
    const diagram = system.chordOverlays.find((o) => o.shapeIndex !== undefined);
    if (diagram?.shapeIndex === undefined) throw new Error('diagram overlay');
    const group = systemOverlaySvg({ ...system, chordOverlays: [diagram] }, score, measurer)?.children?.[0];
    expect(group?.attrs.transform).toBe(`translate(${String(diagram.x - SYSTEM_METRICS.chordDiagramWidth / 2)} ${String(diagram.y)})`);
    const shape = score.chordShapes[diagram.shapeIndex];
    if (shape === undefined) throw new Error('shape');
    const expected = chordToSvg(layoutChord(shape, { showFinger: score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth }));
    expect(group?.children).toEqual(expected.children);
  });

  it('shapeIndex 直接取 chordShapes[shapeIndex]（不按名重查）；showFinger 原样透传', () => {
    const named = system.chordOverlays[0];
    if (named === undefined) throw new Error('overlay');
    const forced = { ...named, displayText: 'G', shapeIndex: 1 };
    const textsOf = (finger: boolean | undefined): string[] => {
      const s = finger === undefined ? score : { ...score, showFinger: finger };
      const group = systemOverlaySvg({ ...system, chordOverlays: [forced] }, s, measurer)?.children?.[0];
      return group === undefined ? [] : walk(group).flatMap((n) => (n.text === undefined ? [] : [`${String(n.attrs.class)}:${n.text}`]));
    };
    expect(textsOf(undefined)).toContain('chord-name:Am');
    expect(textsOf(undefined).some((t) => t.startsWith('finger-number:'))).toBe(true);
    expect(textsOf(false).some((t) => t.startsWith('finger-number:'))).toBe(false);
  });

  it('只画名：以 overlay.x 居中、基线 overlay.y + CHORD_METRICS.nameY，文本 = displayText；无和弦 → undefined', () => {
    const named = system.chordOverlays[0];
    if (named === undefined) throw new Error('overlay');
    const { shapeIndex: _drop, ...nameOnly } = named;
    const group = systemOverlaySvg({ ...system, chordOverlays: [{ ...nameOnly, displayText: 'X7' }] }, score, measurer)?.children?.[0];
    const [text] = group?.children ?? [];
    const expectedAttrs = { x: named.x, y: named.y + CHORD_METRICS.nameY, 'text-anchor': 'middle', 'font-size': CHORD_METRICS.nameFontSize };
    expect(text).toMatchObject({ tag: 'text', text: 'X7', attrs: expectedAttrs });
    expect(group?.attrs.transform).toBeUndefined();
    expect(systemOverlaySvg({ ...system, chordOverlays: [] }, score, measurer)).toBeUndefined();
  });

  it('回归：chordToSvg 输出内部零 data-anchor-key（overlay 的 event anchor 不会被抢）', () => {
    for (const shape of score.chordShapes) {
      const svg = chordToSvg(layoutChord(shape, { showFinger: score.showFinger, measurer, width: SYSTEM_METRICS.chordDiagramWidth }));
      expect(attrValues(svg, 'data-anchor-key')).toEqual([]);
    }
  });
});
