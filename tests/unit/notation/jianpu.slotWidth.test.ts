/**
 * 简谱延音线槽宽修复的回归用例（用户裁决方案，2026-09-17）。
 *
 * `spacing.ts` 的 `timedSlotWidth` 把槽宽夹在 `SLOT_SPACING_METRICS.maxSlotWidth`
 * 以内，但简谱用延音线条数表达长时值，条数一多水平延展会超过这个上界，右侧溢出压到
 * 下一个槽上。`jianpuSlotWidths.ts` 只加宽（不缩窄）简谱自己排布出的槽宽。这里只用
 * 合成 fixture（不引用任何真实语料的文件名 / 标题 / 歌词 / 作者 / 本地路径），涉及
 * 已确认存在的真实语料样本一律写 `corpus#10`。
 */
import { describe, expect, it } from 'vitest';

import { loadJcx } from '../../../src/formats/jcx';
import { SLOT_SPACING_METRICS, JIANPU_METRICS } from '../../../src/notation/layout/metrics';
import { spaceItems, timedSlotWidth } from '../../../src/notation/layout/spacing';
import { splitMeasures } from '../../../src/notation/layout/systems';
import { buildRenderScore } from '../../../src/notation/model/buildRenderScore';
import type { RenderVoice } from '../../../src/notation/model/types';
import { layoutJianpu } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuContext, JianpuLayout } from '../../../src/notation/jianpu/layoutJianpu';
import type { JianpuNode } from '../../../src/notation/jianpu/jianpuGlyphs';
import {
  requiredDashExtent,
  widenForJianpuGlyphs,
} from '../../../src/notation/jianpu/jianpuSlotWidths';
import { createDeterministicTextMeasurer } from '../../../src/notation/layout/textMeasurer';

const measurer = createDeterministicTextMeasurer();
const WIDE = 100000;

function header(body: string, fields = 'M:4/4\nL:1/4\nK:C\n'): string {
  return `%MUSE2\nX:1\n${fields}V:1\n${body}\n`;
}

function prepare(text: string, availableWidth: number): { readonly voice: RenderVoice; readonly ctx: JianpuContext } {
  const loaded = loadJcx(text);
  const rendered = buildRenderScore({ score: loaded.score, index: loaded.index });
  const voice = rendered.voices[0];
  if (voice === undefined) throw new Error('fixture 必须至少有一个声部');
  return {
    voice,
    ctx: { score: loaded.score, index: loaded.index, measurer, availableWidth },
  };
}

function layout(text: string, availableWidth = WIDE): JianpuLayout {
  const prepared = prepare(text, availableWidth);
  return layoutJianpu(prepared.voice, prepared.ctx);
}

function hasDuration(node: JianpuNode): node is JianpuNode & { readonly kind: 'note' | 'rest' } {
  return node.kind === 'note' || node.kind === 'rest';
}

// ---------------------------------------------------------------------------
// requiredDashExtent —— 纯几何推导，不硬编码
// ---------------------------------------------------------------------------

describe('requiredDashExtent —— 从 JIANPU_METRICS 推导延音线水平延展', () => {
  it('7 条延音线（breve）的延展 = dashFirstOffset + 6×(dashLength+dashGap) + dashLength，且超过 maxSlotWidth', () => {
    const expected =
      JIANPU_METRICS.dashFirstOffset +
      6 * (JIANPU_METRICS.dashLength + JIANPU_METRICS.dashGap) +
      JIANPU_METRICS.dashLength;
    expect(requiredDashExtent(7)).toBe(expected);
    expect(requiredDashExtent(7)).toBeGreaterThan(SLOT_SPACING_METRICS.maxSlotWidth);
  });

  it('3 条延音线的延展不超过 maxSlotWidth（3/2、7/4 都落在这一档）', () => {
    expect(requiredDashExtent(3)).toBeLessThanOrEqual(SLOT_SPACING_METRICS.maxSlotWidth);
  });

  it('0 条延音线的延展为 0', () => {
    expect(requiredDashExtent(0)).toBe(0);
    expect(requiredDashExtent(-1)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// layoutJianpu 集成 —— breve 撑宽槽位、不与后续小节线相交
// ---------------------------------------------------------------------------

describe('widenForJianpuGlyphs 接入 layoutJianpu —— breve 不再右溢压线', () => {
  it('L:1/4 下 C8|：breve 节点的槽宽放得下全部 7 条延音线，紧随其后的 barline 不与之相交', () => {
    const result = layout(header('C8|'));
    const note = result.nodes[0];
    const barline = result.nodes[1];
    if (note === undefined || barline === undefined) throw new Error('缺少节点');
    if (note.kind !== 'note') throw new Error('第一个节点应是 note');
    if (barline.kind !== 'barline') throw new Error('第二个节点应是 barline');

    expect(note.duration.dashes).toHaveLength(7);
    // 槽宽不仅要放得下延音线 bbox，还要留出 `dashGap` 宽的尾部留白（用户裁决：
    // 留白复用 `dashGap`，不新增常量）——breve 期望槽宽 = 126u。
    expect(note.width).toBeGreaterThanOrEqual(
      requiredDashExtent(7) + JIANPU_METRICS.dashGap,
    );
    const maxDashX2 = Math.max(...note.duration.dashes.map((segment) => segment.x2));
    // 有留白后，延音线右端**严格**留在槽宽右界之内，不再贴边。
    expect(maxDashX2).toBeLessThan(note.x + note.width);
    // barline 紧随其后的槽起点因此也**严格**大于最靠右的延音线端点，不再贴线。
    expect(barline.x).toBeGreaterThan(maxDashX2);
  });

  it.each([
    ['C6|', { num: 3, den: 2 }],
    ['C7|', { num: 7, den: 4 }],
    ['C|', { num: 1, den: 4 }],
    ['C2|', { num: 1, den: 2 }],
    ['C4|', { num: 1, den: 1 }],
  ] as const)('L:1/4 下 %s：槽宽与修复前一致，等于 timedSlotWidth(该 duration)', (body, duration) => {
    const result = layout(header(body));
    const note = result.nodes[0];
    if (note === undefined || note.kind !== 'note') throw new Error('第一个节点应是 note');
    expect(note.width).toBe(timedSlotWidth(duration));
  });

  it('不含 breve 的 measure：widenForJianpuGlyphs 返回同一个对象引用（无变化即不重建）', () => {
    const { voice } = prepare(header('CDE|'), WIDE);
    const measures = splitMeasures(voice.items);
    const first = measures[0];
    if (first === undefined) throw new Error('缺少 measure');
    const spacing = spaceItems(first.items, first.startIndex);
    expect(widenForJianpuGlyphs(spacing, first.items)).toBe(spacing);
  });

  it('窄 availableWidth 下含 breve 的多小节 fixture：两次 layoutJianpu 确定性一致，breve measure 宽度 = 各槽宽之和，systems 不重叠', () => {
    const text = header('C8|CDE|C8|CDE|');
    const first = layout(text, 200);
    const second = layout(text, 200);
    expect(second).toEqual(first);

    // `widenForJianpuGlyphs` 的契约（独立于 layoutJianpu 直接验证）：加宽后的
    // measure 总宽仍然等于各槽宽之和 —— 加宽不破坏「宽度 = 槽宽累加」这条不变量。
    const { voice } = prepare(text, 200);
    const measures = splitMeasures(voice.items);
    const breveMeasure = measures[0];
    if (breveMeasure === undefined) throw new Error('缺少第一个 measure');
    const spacing = widenForJianpuGlyphs(
      spaceItems(breveMeasure.items, breveMeasure.startIndex),
      breveMeasure.items,
    );
    expect(spacing.width).toBe(spacing.slots.reduce((sum, slot) => sum + slot.slot.width, 0));
    expect(spacing.width).toBeGreaterThan(SLOT_SPACING_METRICS.maxSlotWidth);

    for (let i = 0; i < first.systems.length - 1; i += 1) {
      const current = first.systems[i];
      const next = first.systems[i + 1];
      if (current === undefined || next === undefined) continue;
      expect(current.box.origin.y + current.box.height).toBeLessThanOrEqual(next.box.origin.y);
    }
  });

  it('布局级不变量：所有 note/rest 节点的每条延音线端点 x2 都严格留在该节点自身槽宽右界之内（尾部留白）', () => {
    const text = header('C8|CDE|C6|C7|D2 E4|');
    const result = layout(text, 200);
    let sawDashes = false;
    for (const node of result.nodes) {
      if (!hasDuration(node)) continue;
      for (const segment of node.duration.dashes) {
        sawDashes = true;
        expect(segment.x2).toBeLessThan(node.x + node.width);
      }
    }
    expect(sawDashes).toBe(true);
  });
});
