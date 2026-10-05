/**
 * M2.5 T9b.S —— notation 层 Staff 纵向公式 ↔ VexFlow 结构几何的一致性（node 环境，无 DOM）。
 *
 * 只比对**与字体无关**的结构量：谱线 y、符头中心 y、符干方向与末端。node 下没有 canvas，字形度量为空，所以升降号 /
 * 符尾 / tie / 附点的包络常量（`STAFF_METRICS.verticalInk`）不在这里验证——它们按浏览器实测标定，见 metrics 注释。
 * 生产代码不读这里的任何结果（不做 renderer → notation 的反馈）。
 */
import { describe, expect, it } from 'vitest';
import { Formatter, Stave, StaveNote, VexFlow, Voice, VoiceMode } from 'vexflow/bravura';

import { STAFF_METRICS } from '../../../src/notation/layout/metrics';
import type { StaffClef, StaffPitch } from '../../../src/notation/staff/staffTypes';
import { staffLineOffset, staffPosition, staffStemTip } from '../../../src/notation/staff/staffVerticalDemand';
import { staffBaseHitBand, staffStaveOptions } from '../../../src/renderer/integrations/vexflow/renderStaff';
import { vexKey } from '../../../src/renderer/integrations/vexflow/vexEncoding';

const STAVE_Y = 37;
const T = STAFF_METRICS.staffTopOffset;

function pitch(text: string): StaffPitch {
  const letter = text[0];
  if (letter !== 'C' && letter !== 'D' && letter !== 'E' && letter !== 'F' && letter !== 'G' && letter !== 'A' && letter !== 'B') throw new Error(text);
  return { letter, octave: Number(text.slice(1)), mixedOctave: false };
}

function formatted(clef: StaffClef, pitches: readonly StaffPitch[], duration: string): { readonly stave: Stave; readonly note: StaveNote } {
  const stave = new Stave(0, STAVE_Y, 400, staffStaveOptions());
  const note = new StaveNote({ keys: pitches.map(vexKey), duration, clef, autoStem: true });
  const voice = new Voice({ numBeats: 4, beatValue: 4 });
  voice.setMode(VoiceMode.SOFT);
  voice.addTickables([note]);
  voice.setStave(stave);
  new Formatter().joinVoices([voice]).formatToStave([voice], stave);
  note.setStave(stave);
  return { stave, note };
}

describe('线距真源：STAFF_METRICS.lineGap 显式传给 VexFlow', () => {
  it('stave 线距 / 第一线 / 第五线与 metrics 一致；下方基础余量 = 24', () => {
    const stave = new Stave(0, STAVE_Y, 400, staffStaveOptions());
    expect(stave.getSpacingBetweenLines()).toBe(STAFF_METRICS.lineGap);
    expect(stave.getYForLine(0)).toBe(STAVE_Y + T);
    expect(stave.getYForLine(STAFF_METRICS.lineCount - 1)).toBe(STAVE_Y + T + 4 * STAFF_METRICS.lineGap);
    expect(STAFF_METRICS.systemHeight - T - 4 * STAFF_METRICS.lineGap).toBe(24);
  });

  it('VexFlow 字形设计线距 = lineGap（Bravura 符头按这个线距绘制，二者不一致会让符头与谱线错位）', () => {
    expect(VexFlow.STAVE_LINE_DISTANCE).toBe(STAFF_METRICS.lineGap);
  });
});

describe('符头中心 y 与符干末端：公式 = VexFlow', () => {
  const cases: readonly (readonly [StaffClef, readonly string[]])[] = [
    ['treble', ['C8']], ['treble', ['E6']], ['treble', ['B4']], ['treble', ['A4']], ['treble', ['A3']], ['treble', ['C2']],
    ['bass', ['C5']], ['bass', ['G2']], ['bass', ['C1']], ['bass', ['D3']],
    ['alto', ['C6']], ['alto', ['C4']], ['alto', ['C3']],
    ['tenor', ['C6']], ['tenor', ['C4']], ['tenor', ['A2']],
    ['treble', ['A3', 'A5']], ['treble', ['C3', 'C6']], ['treble', ['E4', 'C7']], ['treble', ['A3', 'C6']], ['bass', ['C2', 'E4']],
  ];

  it.each(cases.flatMap(([clef, keys]) => ['q', 'h', '8', '16'].map((duration) => [clef, keys.join('+'), duration] as const)))('%s %s %s', (clef, keys, duration) => {
    const pitches = keys.split('+').map(pitch);
    const { note } = formatted(clef, pitches, duration);
    const positions = pitches.map((p) => staffPosition(p, clef));
    expect(note.getYs()).toEqual(positions.map((p) => STAVE_Y + T + staffLineOffset(p)));
    const base = duration === 'q' ? 'quarter' : duration === 'h' ? 'half' : duration === '8' ? 'eighth' : 'sixteenth';
    const tip = staffStemTip(positions, base);
    if (tip === undefined) throw new Error('stem expected');
    expect(note.getStemExtents().topY).toBe(STAVE_Y + T + tip);
    const up = tip < Math.min(...positions.map(staffLineOffset));
    expect(note.getStemDirection()).toBe(up ? 1 : -1);
  });

  it('全音符无符干：两边都不画', () => {
    const { note } = formatted('treble', [pitch('B4')], 'w');
    expect(note.hasStem()).toBe(false);
    expect(staffStemTip([staffPosition(pitch('B4'), 'treble')], 'whole')).toBeUndefined();
  });
});

describe('文本 tickable 热区 = 基础 Staff box（L-1）', () => {
  it('第一线在 staffTopOffset 时热区 = [0, systemHeight]；动态内缩 64 时 = [64, 64 + systemHeight]', () => {
    expect(staffBaseHitBand(T)).toEqual({ y: 0, height: STAFF_METRICS.systemHeight });
    expect(staffBaseHitBand(64 + T)).toEqual({ y: 64, height: STAFF_METRICS.systemHeight });
  });

  it('VexFlow stave 的第一线喂进去，热区上下沿 = stave 内容顶 / 内容顶 + 96，覆盖整个五线谱', () => {
    const stave = new Stave(0, STAVE_Y, 400, staffStaveOptions());
    const band = staffBaseHitBand(stave.getYForLine(0));
    expect(band.y).toBe(STAVE_Y);
    expect(band.y + band.height).toBeGreaterThan(stave.getYForLine(STAFF_METRICS.lineCount - 1));
  });
});
